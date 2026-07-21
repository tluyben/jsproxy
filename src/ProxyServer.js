const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const DatabaseManager = require('./DatabaseManager');
const CertificateManager = require('./CertificateManager');
const { noop } = require('./PluginManager');
const { URL } = require('url');
const { tracer, trace, context: otelContext, propagation, SpanKind, SpanStatusCode } = require('./Telemetry');

class ProxyServer {
  constructor(logger, pluginManager) {
    this.logger = logger;
    this.pluginManager = pluginManager || noop;
    this.db = new DatabaseManager(logger);
    this.certManager = new CertificateManager(logger, this.db);

    // HA state — score-based port selection
    this.portScores   = new Map();  // `${mappingId}:${port}` -> 0..100
    this.portLastSeen = new Map();  // `${mappingId}:${port}` -> Date.now() when last successful
    this.rrCounters   = new Map();  // mappingId -> rotation counter (tie-break)
    this.bgChecks     = new Set();  // keys currently being TCP-probed

    // Proxies whose X-Forwarded-* headers we believe. Default: EMPTY — the secure
    // "edge" posture: the client IP is always the real socket peer and inbound
    // X-Forwarded-For / X-Forwarded-Proto are ignored for auth, so a client can't
    // spoof its IP or scheme. On INTERNAL hops that sit behind other trusted
    // proxies, set TRUSTED_PROXIES to a comma list of CIDRs/IPs or the keywords
    // `loopback` / `private` / `all` so the real client is resolved from the chain.
    this.trustedProxies = this._parseTrustedProxies(process.env.TRUSTED_PROXIES || '');

    // Optional preflight header rewrite. A user-supplied script, loaded once,
    // gets each request's headers BEFORE mapping/routing and returns either a
    // replacement header object or null to decline the request. Enables e.g.
    // routing CDN-fronted traffic by a forwarded hostname header. Configure with
    // PREFLIGHT_SCRIPT=/path/to/script.js or --preflight-script=/path/to/script.js
    this.preflight = this._loadPreflight();

    // proxyTimeout is the outbound (proxy → backend) socket idle timeout used
    // by the streamed HA / SSE path. Default 30s, override via the same env
    // var the buffered HA path consults so both paths agree on how long a
    // healthy-but-slow backend may take. The inbound timeout is kept ≥ the
    // outbound one so slow backends don't have the client-facing socket
    // drop out from underneath them (which surfaces as "socket hang up").
    const proxyTimeoutMs    = parseInt(process.env.HA_RESPONSE_TIMEOUT_MS || '30000', 10);
    const incomingTimeoutMs = Math.max(30000, proxyTimeoutMs);

    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      timeout: incomingTimeoutMs,
      proxyTimeout: proxyTimeoutMs,
      // xfwd is deliberately OFF. http-proxy's xfwd only covers the proxy.web /
      // proxy.ws paths; the buffered-HA, streaming-HA and plugin paths use raw
      // lib.request and never saw it, so X-Forwarded-For was set on only 2 of 5
      // paths. We instead append the real socket peer to X-Forwarded-For at a
      // single chokepoint (_handleRequest / handleWebSocket) that EVERY path
      // copies from — guaranteeing the client IP propagates identically down a
      // chain of jsproxy hops. Leaving xfwd on would double-append on proxy.web.
      // (X-Forwarded-Proto/Host are still set per-path; X-Forwarded-Port, which
      // was xfwd-only and never sent by the other 3 paths, is intentionally
      // dropped so all paths now emit an identical forwarded-header set.)
      xfwd: false
    });
    
    this.httpServer = null;
    this.httpsServer = null;
    // Set true once the HTTPS listener is actually bound (see start()); the
    // auto HTTP→HTTPS redirect only fires when TLS is genuinely being served.
    this.httpsEnabled = false;
    this.resolvedHttpsPort = null;  // numeric/string HTTPS port used in redirect URLs
    this._certWarming = new Set();  // domains with an in-flight background cert warm
    this.tcpServers = new Map();  // listen_port -> net.Server (raw TCP proxy, opt-in)
    this.setupProxyErrorHandling();
  }

  setupProxyErrorHandling() {
    this.proxy.on('proxyReq', (proxyReq, req, res, options) => {
      const originalHost = req.headers.host;
      if (originalHost) {
        proxyReq.setHeader('X-Forwarded-Host', originalHost);
        // back_host (when set on the mapping) overrides the Host sent upstream,
        // so a proxy hop can target a backend that routes on a different domain.
        // Falls back to the original Host when unset → unchanged behavior.
        proxyReq.setHeader('Host', req._proxyBackHost || originalHost);
      }
      const protocol = this.isClientHttps(req) ? 'https' : 'http';
      proxyReq.setHeader('X-Forwarded-Proto', protocol);

      // Our HTTP server already answered any Expect: 100-continue to the client
      // (Node's default before the request handler runs), so the handshake is
      // complete. Don't forward a stale Expect — a backend that re-negotiates
      // 100-continue has been observed to reject the request (404) and it can
      // surface a duplicate 100 to the client.
      proxyReq.removeHeader('Expect');

      // For HA streamed requests (SSE / large body), track whether the TCP
      // connect to the backend actually completed. The shared 'error' handler
      // uses this flag to distinguish a connect-phase failure (penalize) from
      // a post-connect failure (don't penalize — port is provably up).
      if (req._haStreamPort != null) {
        proxyReq.on('socket', (socket) => {
          if (socket.connecting) {
            socket.once('connect', () => { req._haStreamConnected = true; });
          } else {
            // Pooled / keepalive socket: already connected.
            req._haStreamConnected = true;
          }
        });
      }

      if (process.env.LOG_LEVEL === 'debug') {
        this.logger.debug('proxying request', {
          domain:  req._proxyDomain,
          method:  req.method,
          url:     req.url,
          target:  options.target,
        });
      }
    });

    this.proxy.on('proxyRes', (proxyRes, req, res) => {
      // Record backend status on the active span
      const span = req._span;
      if (span) {
        span.setAttribute('proxy.backend_status', proxyRes.statusCode);
        if (proxyRes.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `backend HTTP ${proxyRes.statusCode}` });
        }
      }

      // Keep HA port scores up to date for streamed requests (buffered requests
      // update scores inside _requestHA; streamed ones have no other hook).
      if (req._haStreamPort != null) {
        this.boostPort(req._proxyMappingId, req._haStreamPort);
      }

      if (proxyRes.statusCode >= 500) {
        this.logger.error('backend error response', {
          domain:         req._proxyDomain,
          method:         req.method,
          url:            req.url,
          backend_status: proxyRes.statusCode,
          mapping_id:     req._proxyMappingId,
        });
      } else if (process.env.LOG_LEVEL === 'debug') {
        this.logger.debug('backend response', {
          domain:         req._proxyDomain,
          method:         req.method,
          url:            req.url,
          backend_status: proxyRes.statusCode,
        });
      }

      if (req.method === 'GET' && process.env.CACHE_HEADERS === 'true') {
        const expiry = process.env.CACHE_EXPIRY;
        const infinite = !expiry || expiry === '-1';
        const cacheControl = infinite
          ? 'public, max-age=31536000, immutable'
          : `public, max-age=${parseInt(expiry, 10) * 60}`;
        proxyRes.headers['cache-control'] = cacheControl;
        if (infinite) {
          proxyRes.headers['expires'] = 'Thu, 31 Dec 2099 23:59:59 GMT';
        }
      }
    });

    this.proxy.on('error', (err, req, res) => {
      const domain = req?._proxyDomain || req?.headers?.host?.split(':')[0] || 'unknown';
      const span   = req?._span;
      if (span) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        if (err.address) span.setAttribute('proxy.backend_address', err.address);
        if (err.port)    span.setAttribute('proxy.backend_port',    String(err.port));
        if (err.code)    span.setAttribute('error.code',            err.code);
      }

      // Penalize the port so the next request picks a healthy backend — but
      // only when the failure happened before the TCP connect succeeded. A
      // post-connect error (read timeout, mid-response reset, etc.) means the
      // port is reachable; penalizing would falsely mark a healthy-but-slow
      // backend as down on every request.
      if (req?._haStreamPort != null && req?._proxyMappingId && !req._haStreamConnected) {
        this.penalizePort(req._proxyMappingId, req._haStreamPort);
      }

      const logProxyError = req?._proxyIsHA ? this.logger.warn.bind(this.logger) : this.logger.error.bind(this.logger);
      logProxyError('proxy error', {
        domain,
        method:     req?.method,
        url:        req?.url,
        mapping_id: req?._proxyMappingId,
        error:      err.message,
        error_code: err.code,
        address:    err.address,
        port:       err.port,
        errno:      err.errno,
        syscall:    err.syscall,
      });
      if (res && typeof res.writeHead === 'function') {
        if (!res.headersSent) {
          this._sendGatewayError(req, res, 502, 'Bad Gateway', `proxy-error:${err.code || 'unknown'}`);
        }
      } else if (res && typeof res.destroy === 'function') {
        // WebSocket upgrade: `res` is the raw client socket — there are no
        // response headers to send. Calling _sendGatewayError on it threw
        // `res.writeHead is not a function` as an UNHANDLED REJECTION, which
        // under Node's default policy kills the whole proxy process — one WS
        // client hitting a dead backend took every domain down. Just drop it.
        res.destroy();
      }
    });

    this.proxy.on('proxyReqError', (err, req, res) => {
      const domain = req?._proxyDomain || req?.headers?.host?.split(':')[0] || 'unknown';
      const logProxyReqError = req?._proxyIsHA ? this.logger.warn.bind(this.logger) : this.logger.error.bind(this.logger);
      logProxyReqError('proxy request error', {
        domain,
        method:     req?.method,
        url:        req?.url,
        mapping_id: req?._proxyMappingId,
        error:      err.message,
        error_code: err.code,
      });
      if (res && typeof res.writeHead === 'function') {
        if (!res.headersSent) {
          this._sendGatewayError(req, res, 502, 'Bad Gateway', `proxy-req-error:${err.code || 'unknown'}`);
        }
      } else if (res && typeof res.destroy === 'function') {
        res.destroy();
      }
    });
  }

  async initialize() {
    await this.db.initialize();
    const isProduction = process.env.NODE_ENV === 'production';
    const enableHttps = process.env.ENABLE_HTTPS !== 'false' && (isProduction || process.env.ENABLE_HTTPS === 'true');
    if (enableHttps) {
      await this.certManager.initialize();
    }
  }

  async start() {
    // Configure ports based on environment
    const isProduction = process.env.NODE_ENV === 'production';
    const httpPort = process.env.HTTP_PORT || (isProduction ? 80 : 8080);
    const httpsPort = process.env.HTTPS_PORT || (isProduction ? 443 : 8443);
    this.resolvedHttpsPort = httpsPort;
    const httpHost = process.env.HTTP_HOST || '0.0.0.0';
    const enableHttps = process.env.ENABLE_HTTPS !== 'false' && (isProduction || process.env.ENABLE_HTTPS === 'true');

    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res, false);
    });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleWebSocket(req, socket, head, false);
    });

    await new Promise((resolve) => {
      this.httpServer.listen(httpPort, httpHost, () => {
        this.logger.info(`HTTP server listening on ${httpHost}:${httpPort}`);
        resolve();
      });
    });

    if (enableHttps) {
      try {
        const defaultCert = await this.certManager.getDefaultCertificate();
        const sniCallback = await this.certManager.getSNICallback();
        
        const httpsOptions = {
          ...defaultCert,
          SNICallback: sniCallback
        };
        
        this.httpsServer = https.createServer(
          httpsOptions,
          (req, res) => {
            this.handleRequest(req, res, true);
          }
        );

        this.httpsServer.on('upgrade', (req, socket, head) => {
          this.handleWebSocket(req, socket, head, true);
        });

        this.httpsServer.on('tlsClientError', (err, tlsSocket) => {
          // ECONNRESET / "socket hang up" = client disconnected mid-handshake — perfectly normal.
          // Real TLS errors (bad cert, unknown protocol, etc.) are worth a warning.
          const isDisconnect = err.code === 'ECONNRESET' || err.message === 'socket hang up';
          const domain = tlsSocket.servername || tlsSocket.remoteAddress || 'unknown';
          if (isDisconnect) {
            this.logger.info('tls client disconnected during handshake', {
              domain,
              client_ip: tlsSocket.remoteAddress,
              error_code: err.code,
            });
          } else {
            this.logger.warn('tls client error', {
              domain,
              client_ip:  tlsSocket.remoteAddress,
              error:      err.message,
              error_code: err.code,
            });
          }
        });
        
        await new Promise((resolve) => {
          this.httpsServer.listen(httpsPort, httpHost, () => {
            this.httpsEnabled = true;
            this.logger.info(`HTTPS server listening on ${httpHost}:${httpsPort}`);
            resolve();
          });
        });
      } catch (error) {
        this.logger.warn('HTTPS server could not be started:', error.message || error);
        this.logger.error('HTTPS startup error details:', error);
        this.logger.info('To enable HTTPS in development, set ENABLE_HTTPS=true');
      }
    } else {
      this.logger.info(`HTTPS disabled (set ENABLE_HTTPS=true to enable in ${isProduction ? 'production' : 'development'})`);
    }

    // Raw TCP proxying is entirely opt-in: a listener exists only because a
    // protocol='tcp' row exists. With no such rows this is a no-op and the
    // proxy behaves exactly as it did before TCP support existed.
    await this.startTcpListeners(httpPort, httpsPort, httpHost);
  }

  // ── Raw TCP proxy ─────────────────────────────────────────────────────────
  //
  // Each TCP route is a dedicated net.Server on its own listen_port that forwards
  // raw bytes to backend:back_port. It never touches the http/https request path.
  // HA (multiple back_port values) reuses the exact same scoring machinery as the
  // HTTP path (rankedPorts / boostPort / penalizePort / startBackgroundCheck).
  // TLS is pure passthrough — bytes are forwarded untouched and the backend
  // terminates TLS. No auth/webhook/plugins apply here; only the IP allowlist does.
  async startTcpListeners(httpPort, httpsPort, httpHost) {
    let routes;
    try {
      routes = await this.db.getTcpRoutes();
    } catch (err) {
      this.logger.error('Could not load TCP routes (TCP proxying disabled):', err.message || err);
      return;
    }
    if (!routes || routes.length === 0) return;

    for (const route of routes) {
      const port = parseInt(route.listen_port, 10);
      if (!Number.isInteger(port) || port <= 0) {
        this.logger.warn(`TCP route ${route.id} has invalid listen_port (${route.listen_port}); skipping`);
        continue;
      }
      if (port === parseInt(httpPort, 10) || port === parseInt(httpsPort, 10)) {
        this.logger.warn(`TCP route ${route.id} listen_port ${port} collides with HTTP/HTTPS port; skipping`);
        continue;
      }
      if (this.tcpServers.has(port)) {
        this.logger.warn(`TCP route ${route.id} listen_port ${port} already bound; skipping duplicate`);
        continue;
      }

      const server = net.createServer((socket) => this.handleTcpConnection(route, socket));
      server.on('error', (err) => {
        this.logger.error(`TCP listener on ${port} error: ${err.message || err}`);
      });
      // Await the bind so a bad port (e.g. EADDRINUSE) logs and is skipped without
      // throwing out of start() (which would take the whole worker down). Only
      // track listeners that actually bound.
      const bound = await new Promise((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, httpHost, () => {
          this.logger.info(`TCP proxy listening on ${httpHost}:${port} -> ${route.backend || 'localhost'}:${route.back_port}`);
          resolve(true);
        });
      });
      if (bound) this.tcpServers.set(port, server);
    }
  }

  handleTcpConnection(route, clientSocket) {
    // Don't lose any bytes the client sends before the upstream is connected.
    clientSocket.pause();

    let clientIp = clientSocket.remoteAddress || '';
    if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);

    if (!this.isIpAllowed(clientIp, route.allowed_ips)) {
      this.logger.warn(`TCP: rejected ${clientIp} on port ${route.listen_port} (not in allowlist)`);
      clientSocket.destroy();
      return;
    }

    const ports = String(route.back_port)
      .split(',')
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p));

    if (ports.length === 0) {
      this.logger.error(`TCP route ${route.id} has no valid back_port; dropping connection`);
      clientSocket.destroy();
      return;
    }

    const backend = route.backend || 'http://localhost';
    const backendUrl = new URL(backend.startsWith('http') ? backend : `http://${backend}`);
    const host = backendUrl.hostname;
    const connectTimeoutMs = parseInt(
      process.env.TCP_CONNECT_TIMEOUT_MS || process.env.HA_CONNECT_TIMEOUT_MS || '3000', 10);
    const idleTimeoutMs = parseInt(process.env.TCP_IDLE_TIMEOUT_MS || '0', 10);

    const ordered = this.rankedPorts(route.id, ports);

    // Try ranked ports until one connects. Failover here is always safe: no client
    // bytes have been forwarded yet (the client socket is paused), so there is no
    // duplication risk regardless of protocol.
    const tryNext = (idx) => {
      if (clientSocket.destroyed) return;
      if (idx >= ordered.length) {
        this.logger.warn(`TCP: all backends down for route ${route.id} (port ${route.listen_port})`);
        clientSocket.destroy();
        return;
      }
      const port = ordered[idx];
      const upstream = new net.Socket();
      let settled = false;

      const fail = () => {
        if (settled) return;
        settled = true;
        upstream.destroy();
        this.penalizePort(route.id, port);
        this.startBackgroundCheck(route, port);
        tryNext(idx + 1);
      };

      upstream.setTimeout(connectTimeoutMs, fail);
      upstream.once('error', fail);

      upstream.connect(port, host, () => {
        if (settled) { upstream.destroy(); return; }
        settled = true;
        upstream.setTimeout(0);              // clear the connect timeout
        upstream.removeListener('error', fail);
        this.boostPort(route.id, port);

        if (idleTimeoutMs > 0) {
          clientSocket.setTimeout(idleTimeoutMs, () => clientSocket.destroy());
          upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        }

        // Bidirectional pipe. Tear down the peer when either side ends/errors so
        // no half-open socket lingers.
        const teardown = () => { clientSocket.destroy(); upstream.destroy(); };
        clientSocket.on('error', teardown);
        upstream.on('error', teardown);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
        clientSocket.resume();

        if (process.env.LOG_LEVEL === 'debug') {
          this.logger.debug(`TCP: ${clientIp} -> ${host}:${port} (route ${route.id})`);
        }
      });
    };

    tryNext(0);
  }

  async handleRequest(req, res, isHttps) {
    // Extract incoming W3C trace context, then create a server span.
    const parentCtx = propagation.extract(otelContext.active(), req.headers);
    const span = tracer.startSpan('proxy.request', {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method':    req.method,
        'http.url':       req.url,
        'http.host':      req.headers.host || '',
        'http.scheme':    isHttps ? 'https' : 'http',
        'net.peer.ip':    this.getClientIp(req),
      },
    }, parentCtx);
    req._span = span;

    // End the span when the response is fully sent (or connection is dropped).
    const endSpan = () => {
      span.setAttribute('http.status_code', res.statusCode || 0);
      span.end();
    };
    res.on('finish', endSpan);
    res.on('close',  endSpan);

    return otelContext.with(trace.setSpan(parentCtx, span), () => this._handleRequest(req, res, isHttps));
  }

  // Load the optional preflight header-rewrite script. Accepts a module that
  // exports a function directly, or an object with a `main` function. Returns
  // the function (called as fn(headers)) or null when not configured/loadable.
  _loadPreflight() {
    const argv = process.argv.find(a => a.startsWith('--preflight-script='));
    const scriptPath = process.env.PREFLIGHT_SCRIPT || (argv ? argv.split('=').slice(1).join('=') : '');
    if (!scriptPath) return null;
    try {
      const path = require('path');
      const resolved = path.resolve(scriptPath);
      const mod = require(resolved);
      const fn = typeof mod === 'function' ? mod : (mod && typeof mod.main === 'function' ? mod.main : null);
      if (typeof fn !== 'function') {
        this.logger.error(`Preflight script ${resolved} must export a function or { main }`);
        return null;
      }
      this.logger.info(`Preflight header script loaded: ${resolved}`);
      return fn;
    } catch (err) {
      this.logger.error(`Failed to load preflight script: ${err.message}`);
      return null;
    }
  }

  async _handleRequest(req, res, isHttps) {
    try {
      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      // Handle ACME reachability test — DO NOT proxy these
      if (req.url && req.url.startsWith('/.well-known/test-challenge/')) {
        const token = req.url.split('/').pop();
        const value = this.certManager.getTestChallenge(token);
        if (value) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(value);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
        return;
      }

      // Handle ACME challenges - DO NOT proxy these
      if (req.url && req.url.startsWith('/.well-known/acme-challenge/')) {
        const token = req.url.split('/').pop();
        const challenge = await this.certManager.getChallenge(token);
        if (challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Challenge not found');
        }
        return;
      }

      // Preflight header rewrite (runs before routing so it can change the Host
      // used for mapping — e.g. adopt a CDN's forwarded hostname). Returning null
      // declines the request; a returned object replaces req.headers. A thrown
      // error fails open (headers left unchanged) so a script bug can't blackhole
      // traffic. ACME/health above are intentionally exempt.
      if (this.preflight) {
        let rewritten;
        try {
          rewritten = this.preflight(req.headers);
        } catch (err) {
          this.logger.warn(`preflight script error (fail-open): ${err.message}`);
          rewritten = req.headers;
        }
        if (rewritten === null) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        if (rewritten && typeof rewritten === 'object') req.headers = rewritten;
      }

      // Redirect HTTP to HTTPS if FORCE_HTTPS is enabled. The forwarded scheme
      // headers (X-Forwarded-Proto / -Ssl / Front-End-Https, set by nginx, caddy,
      // cloudflare, haproxy, etc.) are honored only when the immediate peer is a
      // trusted proxy — see isClientHttps.
      const isSecure = isHttps || this.isClientHttps(req);
      if (!isSecure && process.env.FORCE_HTTPS === 'true') {
        const host = req.headers.host;
        const httpsPort = process.env.HTTPS_PORT || (process.env.NODE_ENV === 'production' ? 443 : 8443);
        const hostWithoutPort = host ? host.split(':')[0] : '';
        const portSuffix = httpsPort === 443 || httpsPort === '443' ? '' : `:${httpsPort}`;
        const redirectUrl = `https://${hostWithoutPort}${portSuffix}${req.url}`;
        res.writeHead(301, { 'Location': redirectUrl });
        res.end();
        return;
      }

      const host = req.headers.host;
      if (!host) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Missing Host header');
        return;
      }

      const domain = host.split(':')[0];
      // Store domain on req so proxy error handlers can include it in logs.
      req._proxyDomain = domain;
      if (req._span) req._span.setAttribute('proxy.domain', domain);

      // Terminate Expect: 100-continue here. Node's HTTP server already answered
      // 100 Continue to the client (its default before this handler runs), so the
      // handshake is complete and the client is sending the body. Strip the header
      // at this single chokepoint — BEFORE any forward path runs — so no backend
      // ever re-negotiates a second 100-continue. This is the reliable fix: the
      // http-proxy streaming path flushes outbound headers before its 'proxyReq'
      // event fires, so removing it there is too late; removing it from req.headers
      // (which every path copies from) covers proxy.web, the buffered HA path, the
      // streaming HA path, and the plugin paths alike. A downstream app that sees a
      // stale Expect has been observed to reject the upload with 404.
      delete req.headers['expect'];

      // Append this hop's real socket peer to X-Forwarded-For at the SAME single
      // chokepoint, BEFORE any forward path runs, so proxy.web, buffered HA,
      // streaming HA and the plugin paths all forward one identical, correct
      // chain (each path copies from req.headers). We append req.socket's peer
      // (getPeerIp) rather than trusting an inbound value: when a browser hits
      // the first jsproxy directly there is no inbound XFF, so its IP becomes the
      // leftmost entry and stays leftmost through every subsequent jsproxy hop —
      // the backend always reads the true client as the first XFF token. Done
      // once per request (never in a per-port retry), so failover can't duplicate.
      this._appendForwardedFor(req);

      // Set X-Forwarded-Proto at the SAME chokepoint (like XFF above) so proxy.web,
      // the buffered/streaming HA paths, and the plugin paths all forward one
      // identical scheme. The plugin BUFFERED path (_tryTarget) never set it, so a
      // TLS client's backend saw NO X-Forwarded-Proto and assumed http — breaking
      // secure cookies / OAuth redirect_uri / https-URL building on proxied apps.
      // isClientHttps() derives from this hop's own TLS socket (or a trusted proxy's
      // forwarded header), so a plaintext client still can't claim https.
      req.headers['x-forwarded-proto'] = this.isClientHttps(req) ? 'https' : 'http';

      if (process.env.LOG_LEVEL === 'debug') {
        this.logger.debug('incoming request', {
          domain, method: req.method, url: req.url,
          client_ip: this.getClientIp(req), https: isHttps,
        });
      }

      const mapping = await this.db.getMapping(domain, req.url);

      if (!mapping) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Automatic HTTP → HTTPS redirect. Once we can serve this served domain
      // over TLS — a trusted/ACME cert, a self-signed cert, or a covering
      // wildcard, whichever exists — send plain-HTTP clients a permanent 301 so
      // the proxy terminates TLS itself with no HTTP-only fronting layer (e.g.
      // nginx) needed. Runs before auth/IP so credentials never travel over
      // HTTP. Skipped when the request is already secure, HTTPS isn't actually
      // being served, the blanket FORCE_HTTPS path above already handled it, or
      // the operator opted out with AUTO_HTTPS_REDIRECT=false. A domain with no
      // cert yet is proxied over HTTP this once and its cert is warmed in the
      // background, so the NEXT request redirects — a brand-new domain that has
      // only ever seen HTTP is never blackholed waiting for a first TLS hit.
      if (!isSecure
          && this.httpsEnabled
          && process.env.FORCE_HTTPS !== 'true'
          && process.env.AUTO_HTTPS_REDIRECT !== 'false') {
        const certDomain = mapping.domain && mapping.domain.startsWith('*.')
          ? mapping.domain
          : domain;
        if (await this.certManager.hasCertificateFor(domain)) {
          const httpsPort = this.resolvedHttpsPort;
          const portSuffix = (httpsPort === 443 || httpsPort === '443') ? '' : `:${httpsPort}`;
          res.writeHead(301, { 'Location': `https://${domain}${portSuffix}${req.url}` });
          res.end();
          return;
        }
        this._warmCertificate(certDomain);
      }

      // Store mapping context for error handlers.
      req._proxyMappingId = mapping.id;
      // Optional per-mapping override of the Host header sent to the backend.
      // Null/absent (the default for every mapping) → forward the original Host
      // unchanged, i.e. exactly today's behavior.
      req._proxyBackHost = mapping.back_host || null;
      req._proxyIsHA = this._isHA(mapping);
      if (req._span) {
        req._span.setAttribute('proxy.mapping_id',   String(mapping.id));
        req._span.setAttribute('proxy.backend_port', String(mapping.back_port));
        req._span.setAttribute('proxy.backend',      mapping.backend || 'localhost');
      }

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const authResult = this.checkAuth(req, mapping);
      if (!authResult.allowed) {
        this._sendUnauthorized(res, authResult);
        return;
      }
      if (authResult.credentialIndex !== undefined) {
        this.db.recordAuthUse(mapping.id, authResult.credentialIndex).catch(() => {});
      }

      // Run certificate fetch (if HTTPS) and webhook check in parallel
      const certPromise = isHttps
        ? this.certManager.ensureCertificate(
            mapping.domain && mapping.domain.startsWith('*.') ? mapping.domain : domain,
            true
          )
        : Promise.resolve();
      const webhookPromise = this.callWebhook(mapping, req);

      const [, webhookDecision] = await Promise.all([certPromise, webhookPromise]);

      if (webhookDecision) {
        // 3xx: relay the redirect to the client
        if (webhookDecision.statusCode >= 300 && webhookDecision.statusCode < 400 && webhookDecision.location) {
          res.writeHead(webhookDecision.statusCode, { 'Location': webhookDecision.location });
          res.end();
          return;
        }
        // Non-200: serve the webhook response directly
        if (webhookDecision.statusCode !== 200) {
          const headers = Object.assign({ 'Content-Type': 'text/plain' }, webhookDecision.headers || {});
          res.writeHead(webhookDecision.statusCode, headers);
          res.end(webhookDecision.body || '');
          return;
        }
      }

      // ── Plugin hooks ─────────────────────────────────────────────────────
      // Completely skipped when no plugins are configured (hasPlugins = false).
      if (this.pluginManager.hasPlugins) {
        try {
          const inPort = isHttps
            ? parseInt(process.env.HTTPS_PORT || (process.env.NODE_ENV === 'production' ? '443' : '8443'), 10)
            : parseInt(process.env.HTTP_PORT || (process.env.NODE_ENV === 'production' ? '80' : '8080'), 10);
          const requestId = crypto.randomUUID();
          const { interested, needsBody } = await this.pluginManager.runValid(requestId, domain, inPort, req.url, req.method);
          if (interested.length > 0) {
            this.pluginManager.register(requestId, interested, needsBody);
            res.once('close', () => this.pluginManager.cleanup(requestId));
            await this._handleWithPlugins(requestId, domain, inPort, mapping, req, res, needsBody);
            return;
          }
        } catch (err) {
          this.logger.error('Plugin system error (fail-open):', err);
          // Fall through to normal proxy path
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // HA round-robin across multiple backends (multiple ports on one host, or
      // multiple distinct backend URLs — see _isHA / _backendTargets).
      if (this._isHA(mapping)) {
        await this.haRequest(mapping, req, res);
        return;
      }

      // Single backend, but a large / chunked / SSE stream: route through the
      // streaming pipe (with a single port → no failover) rather than http-proxy.
      // http-proxy applies fixed connection/proxy timeouts that tear down an
      // ACTIVE long upload or download; _streamHA uses a true idle timeout that
      // only fires when no bytes are moving in either direction. This is the
      // path a jsproxy-https -> jsproxy-http entry hop takes for big uploads.
      if (this._isStreamingRequest(req)) {
        return this._streamHA(mapping, req, res);
      }

      // For simple port forwarding (no URI mapping), just proxy directly
      if (!mapping.front_uri && !mapping.back_uri) {
        const backend = mapping.backend || 'http://localhost';
        const target = `${backend}:${mapping.back_port}`;
        this.proxy.web(req, res, {
          target: target,
          secure: false,
          changeOrigin: true
        });
      } else {
        // Complex URI mapping
        const targetUrl = this.buildTargetUrl(mapping, req.url);
        this.proxy.web(req, res, {
          target: targetUrl,
          secure: false,
          changeOrigin: true
        });
      }

    } catch (error) {
      const span = req._span;
      if (span) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      this.logger.error('request handling error', {
        domain: req._proxyDomain,
        method: req.method,
        url:    req.url,
        error:  error.message,
        stack:  process.env.LOG_LEVEL === 'debug' ? error.stack : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  }

  async handleWebSocket(req, socket, head, isHttps) {
    try {
      const host = req.headers.host;
      if (!host) {
        socket.destroy();
        return;
      }

      const domain = host.split(':')[0];
      const mapping = await this.db.getMapping(domain, req.url);

      if (!mapping) {
        socket.destroy();
        return;
      }

      req._proxyIsHA = this._isHA(mapping);

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden');
        socket.destroy();
        return;
      }

      const wsAuthResult = this.checkAuth(req, mapping);
      if (!wsAuthResult.allowed) {
        const scheme = wsAuthResult.type === 'bearer' ? 'Bearer' : 'Basic';
        socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${scheme} realm="Proxy"\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized`);
        socket.destroy();
        return;
      }
      if (wsAuthResult.credentialIndex !== undefined) {
        this.db.recordAuthUse(mapping.id, wsAuthResult.credentialIndex).catch(() => {});
      }

      // Only generate certificates for domains in our database
      if (isHttps) {
        // If mapping is for a wildcard domain, ensure wildcard certificate
        const certDomain = mapping.domain.startsWith('*.') ? mapping.domain : domain;
        await this.certManager.ensureCertificate(certDomain, true); // true = domain is validated
      }

      // Rewrite req.url to the remapped path (http-proxy joins target.path + req.url,
      // so keep target as host:port only to avoid doubling the path).
      if (mapping.front_uri || mapping.back_uri) {
        req.url = this.buildTargetPath(mapping, req.url);
      }

      // WebSocket upgrades bypass _handleRequest, so apply the same forwarded
      // headers here (xfwd is off — see createProxyServer). proxy.ws forwards
      // req.headers verbatim, so setting them here reaches the backend. Append
      // this hop's peer to X-Forwarded-For (original client stays leftmost down a
      // chain) and preserve X-Forwarded-Proto (was xfwd-provided); also record
      // X-Forwarded-Host, which the WS path never sent before.
      this._appendForwardedFor(req);
      req.headers['x-forwarded-proto'] = this.isClientHttps(req) ? 'https' : 'http';
      if (!req.headers['x-forwarded-host']) req.headers['x-forwarded-host'] = req.headers.host || '';

      // WebSocket has no mid-upgrade failover (http-proxy ends the client
      // socket on a backend error), so an HA mapping must pick a LIVE target
      // BEFORE the upgrade: TCP-probe candidates in ranked order, penalizing
      // dead ones as they're found so plain-HTTP requests shed them too. This
      // resolves both a port list and a multi-host backend list.
      const targets = this._backendTargets(mapping);
      let chosen;
      if (targets.length > 1) {
        chosen = await this._probeLiveTarget(mapping, targets);
        if (!chosen) {
          this.logger.error('all backends unavailable (websocket)', {
            domain, mapping_id: mapping.id,
            backends: targets.map(t => `${t.hostname}:${t.port}`).join(','),
          });
          socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway: all backends unavailable');
          socket.destroy();
          return;
        }
      } else {
        chosen = targets[0];
      }
      const scheme  = chosen && chosen.isHttps ? 'https' : 'http';
      const target  = chosen
        ? `${scheme}://${chosen.hostname}:${chosen.port}`
        : `${mapping.backend || 'http://localhost'}:${mapping.back_port}`;
      this.proxy.ws(req, socket, head, {
        target,
        secure: false,
        changeOrigin: true
      }, (err) => {
        // Error callback (used INSTEAD of the global 'error' handler, which
        // expects a ServerResponse it can writeHead on — here there is only the
        // raw client socket). Penalize the target on an HA mapping so the next
        // upgrade avoids it; http-proxy has already ended the client socket.
        if (chosen && targets.length > 1) {
          this.penalizePort(mapping.id, chosen.key);
          this.startBackgroundCheckTarget(mapping, chosen);
        }
        this.logger.warn('websocket proxy error', {
          domain, target, url: req.url, error: err.message, error_code: err.code,
        });
        socket.destroy();
      });

    } catch (error) {
      this.logger.error('websocket handling error', {
        domain: req.headers.host?.split(':')[0],
        url:    req.url,
        error:  error.message,
        error_code: error.code,
      });
      socket.destroy();
    }
  }

  buildTargetPath(mapping, requestUrl) {
    let targetPath = requestUrl;

    if (mapping.front_uri && mapping.front_uri !== '') {
      const frontUri = mapping.front_uri.startsWith('/') ? mapping.front_uri : `/${mapping.front_uri}`;

      if (mapping.back_uri && mapping.back_uri !== '') {
        const backUri = mapping.back_uri.startsWith('/') ? mapping.back_uri : `/${mapping.back_uri}`;
        if (requestUrl.startsWith(frontUri)) {
          targetPath = requestUrl.replace(frontUri, backUri);
        } else if (requestUrl.startsWith(frontUri.substring(1))) {
          targetPath = requestUrl.replace(frontUri.substring(1), backUri);
        }
      } else {
        if (requestUrl.startsWith(frontUri)) {
          targetPath = requestUrl.substring(frontUri.length) || '/';
        }
      }
    } else if (mapping.back_uri && mapping.back_uri !== '') {
      const backUri = mapping.back_uri.startsWith('/') ? mapping.back_uri : `/${mapping.back_uri}`;
      targetPath = `${backUri}${requestUrl}`;
    }

    targetPath = targetPath.replace(/\/+/g, '/');
    if (!targetPath.startsWith('/')) {
      targetPath = '/' + targetPath;
    }
    return targetPath;
  }

  buildTargetUrl(mapping, requestUrl) {
    const targetPath = this.buildTargetPath(mapping, requestUrl);
    const backend = mapping.backend || 'http://localhost';
    return `${backend}:${mapping.back_port}${targetPath}`;
  }

  // ── HA helpers ────────────────────────────────────────────────────────────

  // True when a mapping should use the failover engine: either multiple ports on
  // one backend (`back_port='3000,3001'`) OR multiple distinct backend URLs
  // (`backend='https://a.example,https://b.example'`). Both are comma-triggered.
  _isHA(mapping) {
    return String(mapping.back_port).includes(',') ||
           String(mapping.backend || '').includes(',');
  }

  // Expand a mapping into an ordered list of candidate backend targets. The unit
  // of failover is a target `{ hostname, port, isHttps, key }` — the `key` is what
  // the score map is keyed on, so failover state is tracked per distinct backend.
  //
  // Two modes, chosen by where the comma is:
  //   1. Multi-host  — `backend` is a comma list of URLs. Each URL contributes one
  //      target; its port comes from the URL, else a single numeric `back_port`
  //      fallback, else the scheme default (443/80). key = `host:port` so each
  //      distinct backend scores independently.
  //   2. Port-list / single — one `backend` host, `back_port` is one or more ports.
  //      This is the legacy path; key = the bare port string, so existing in-memory
  //      scores and the public getPortScore(id, port) API are byte-for-byte unchanged.
  //
  // The Host header sent upstream is NOT derived from these targets — every path
  // forwards `back_host || original client Host`, so the front URL (or the rewrite)
  // reaches all backends identically; the target hostname is only a connect address.
  _backendTargets(mapping) {
    const backendField = String(mapping.backend || 'http://localhost');
    const portField    = String(mapping.back_port ?? '');

    if (backendField.includes(',')) {
      const trimmed  = portField.trim();
      const fallback = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
      return backendField
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(entry => {
          const url     = new URL(entry.startsWith('http') ? entry : `http://${entry}`);
          const isHttps = url.protocol === 'https:';
          const port    = url.port ? parseInt(url.port, 10)
                        : (fallback ?? (isHttps ? 443 : 80));
          return { hostname: url.hostname, port, isHttps, key: `${url.hostname}:${port}` };
        });
    }

    const url     = new URL(backendField.startsWith('http') ? backendField : `http://${backendField}`);
    const isHttps = url.protocol === 'https:';
    return portField
      .split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(p => !isNaN(p))
      .map(port => ({ hostname: url.hostname, port, isHttps, key: String(port) }));
  }

  // ── Port scoring ─────────────────────────────────────────────────────────────
  // NOTE: the "port" argument throughout is really a score KEY — a bare port
  // number in legacy mode, or a "host:port" string in multi-host mode. The map is
  // string-keyed either way, so these work unchanged for both.

  _portKey(mappingId, port) { return `${mappingId}:${port}`; }

  getPortScore(mappingId, port) {
    return this.portScores.get(this._portKey(mappingId, port)) ?? 100;
  }

  boostPort(mappingId, port) {
    const key = this._portKey(mappingId, port);
    this.portScores.set(key, 100);
    this.portLastSeen.set(key, Date.now());
  }

  penalizePort(mappingId, port) {
    this.portScores.set(this._portKey(mappingId, port), 0);
  }

  // Return ports sorted best-first. Tie-break with round-robin rotation.
  rankedPorts(mappingId, ports) {
    const i = (this.rrCounters.get(mappingId) || 0);
    this.rrCounters.set(mappingId, i + 1);
    const rotated = [...ports.slice(i % ports.length), ...ports.slice(0, i % ports.length)];
    return rotated.slice().sort((a, b) =>
      this.getPortScore(mappingId, b) - this.getPortScore(mappingId, a)
    );
  }

  // Same ranking as rankedPorts, but over target objects (scored by target.key).
  // Used by every failover path so multi-host and port-list modes share one engine.
  rankedTargets(mappingId, targets) {
    const n = targets.length;
    if (n === 0) return [];
    const i = (this.rrCounters.get(mappingId) || 0);
    this.rrCounters.set(mappingId, i + 1);
    const off = i % n;
    const rotated = [...targets.slice(off), ...targets.slice(0, off)];
    return rotated.slice().sort((a, b) =>
      this.getPortScore(mappingId, b.key) - this.getPortScore(mappingId, a.key)
    );
  }

  // TCP-probe a port in the background until it responds, then set score to 50
  // so the next real request gives it a try. Legacy signature (fixed backend host,
  // port key) — delegates to the target-based probe below.
  startBackgroundCheck(mapping, port) {
    const backend = mapping.backend || 'http://localhost';
    const backendUrl = new URL(backend.startsWith('http') ? backend : `http://${backend}`);
    return this.startBackgroundCheckTarget(mapping, {
      hostname: backendUrl.hostname, port, key: String(port),
    });
  }

  // TCP-probe a single target `{ hostname, port, key }` until it accepts a
  // connection, then restore its score to 50. Keyed on target.key so multi-host
  // backends each get their own independent probe.
  startBackgroundCheckTarget(mapping, target) {
    const key = this._portKey(mapping.id, target.key);
    if (this.bgChecks.has(key)) return;
    this.bgChecks.add(key);

    const host = target.hostname;
    const port = target.port;

    const probe = () => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(port, host, () => {
        sock.destroy();
        this.bgChecks.delete(key);
        this.portScores.set(key, 50);
        this.portLastSeen.set(key, Date.now());
        this.logger.info(`HA: backend ${host}:${port} back up (score→50) for mapping ${mapping.id}`);
      });
      const retry = () => {
        sock.destroy();
        if (this.bgChecks.has(key)) {
          const t = setTimeout(probe, 5000);
          if (t.unref) t.unref();
        }
      };
      sock.on('error', retry);
      sock.on('timeout', retry);
    };

    const t = setTimeout(probe, 2000);
    if (t.unref) t.unref();
    this.logger.warn(`HA: backend ${host}:${port} scored 0, background probe started`);
  }

  // TCP-probe targets in ranked order and return the first that accepts a
  // connection; penalize (and background-probe) each dead one on the way.
  // Returns null when every target is down. Used by paths that cannot fail
  // over once the upgrade/stream has started (WebSocket).
  async _probeLiveTarget(mapping, targets) {
    const ordered   = this.rankedTargets(mapping.id, targets);
    const timeoutMs = parseInt(process.env.HA_CONNECT_TIMEOUT_MS || '3000', 10);
    for (const target of ordered) {
      const alive = await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(timeoutMs);
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.once('connect', () => done(true));
        sock.once('error',   () => done(false));
        sock.once('timeout', () => done(false));
        sock.connect(target.port, target.hostname);
      });
      if (alive) return target;
      this.penalizePort(mapping.id, target.key);
      this.startBackgroundCheckTarget(mapping, target);
      this.logger.warn('HA probe: backend down, trying next', {
        mapping_id: mapping.id, backend: `${target.hostname}:${target.port}`,
      });
    }
    return null;
  }

  // Kept for backward compat with any remaining call sites
  isPortDead(mappingId, port) { return this.getPortScore(mappingId, port) === 0; }
  markPortDead(mappingId, port) { this.penalizePort(mappingId, port); }
  nextRRIndex(mappingId, count) {
    const i = (this.rrCounters.get(mappingId) || 0) % count;
    this.rrCounters.set(mappingId, i + 1);
    return i;
  }

  bufferBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // Thin wrapper kept for backward compat with haRequest's original call sites.
  tryPort(mapping, port, req, body) {
    return this._tryPort(mapping, port, req.url, req.method, req.headers, body);
  }

  // Legacy signature (fixed backend host + port) kept for the plugin/single path.
  // Builds a target from mapping.backend + port and delegates to _tryTarget.
  _tryPort(mapping, port, uri, method, reqHeaders, body) {
    const backend = mapping.backend || 'http://localhost';
    const backendUrl = new URL(backend.startsWith('http') ? backend : `http://${backend}`);
    const target = {
      hostname: backendUrl.hostname,
      port,
      isHttps: backendUrl.protocol === 'https:',
      key: String(port),
    };
    return this._tryTarget(mapping, target, uri, method, reqHeaders, body);
  }

  // Core single-backend request against one target `{ hostname, port, isHttps, key }`.
  // Used by both the HA path and the plugin/single path.
  //
  // Timeouts are phased: a short window while the TCP connect is in progress
  // (so a genuinely-dead backend fails fast for HA failover), then a longer window
  // once we've connected and are waiting for the response. Rejections are
  // tagged with `err.phase` so _requestHA can distinguish:
  //   - phase === 'connect'  → backend unreachable; safe to penalize + failover.
  //   - phase === 'response' → connection succeeded, request may already be in
  //     flight on the backend; failing over would risk duplicating non-idempotent
  //     operations and the backend is provably up. Surface to client as-is.
  _tryTarget(mapping, target, uri, method, reqHeaders, body) {
    return new Promise((resolve, reject) => {
      const backendUrl = { hostname: target.hostname };
      const isHttpsBackend = target.isHttps;
      const lib = isHttpsBackend ? https : http;
      const port = target.port;

      const targetPath = (!mapping.front_uri && !mapping.back_uri)
        ? uri
        : this.buildTargetPath(mapping, uri);

      const headers = Object.assign({}, reqHeaders);
      // Mirror the streaming path's Host handling (setupProxyErrorHandling): keep
      // the original client Host in X-Forwarded-Host and forward either the
      // per-mapping back_host override or the original Host upstream. Forwarding
      // `localhost:<port>` would break a backend that routes on Host — e.g. a
      // downstream jsproxy — so the real Host is preserved instead.
      if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = headers['host'];
      headers['host'] = mapping.back_host || headers['host'];
      // We send a fully-buffered body with an explicit Content-Length, so any
      // inbound Transfer-Encoding (e.g. chunked) no longer applies. Forwarding
      // both is an HTTP framing violation that backends reject with 400 — strip
      // it and let Content-Length describe the buffered body.
      delete headers['transfer-encoding'];
      // We've already buffered the full body and answered any 100-continue to the
      // client ourselves, so a forwarded Expect is stale — drop it (a downstream
      // app re-negotiating 100-continue has been seen to 404 the request).
      delete headers['expect'];
      if (body && body.length > 0) headers['content-length'] = body.length;
      else delete headers['content-length'];

      const connectTimeoutMs  = parseInt(process.env.HA_CONNECT_TIMEOUT_MS  || '3000',  10);
      const responseTimeoutMs = parseInt(process.env.HA_RESPONSE_TIMEOUT_MS || '30000', 10);
      let connected = false;
      let responseStarted = false; // true once the backend sends any response bytes

      const proxyReq = lib.request({
        hostname: backendUrl.hostname,
        port,
        path: targetPath,
        method,
        headers,
        // Match the streaming path's `secure: false`: accept self-signed certs on
        // HTTPS backends (e.g. a downstream jsproxy terminating its own TLS).
        ...(isHttpsBackend ? { rejectUnauthorized: false } : {}),
      }, (proxyRes) => {
        responseStarted = true;
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => resolve({
          port,
          key: target.key,
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks),
        }));
        proxyRes.on('error', (err) => { err.phase = 'response'; reject(err); });
      });

      proxyReq.on('socket', (socket) => {
        if (socket.connecting) {
          socket.setTimeout(connectTimeoutMs);
          socket.once('connect', () => {
            connected = true;
            socket.setTimeout(responseTimeoutMs);
          });
        } else {
          // Pooled / keepalive socket — already connected.
          connected = true;
          socket.setTimeout(responseTimeoutMs);
        }
      });

      // Phase classification:
      //   - not connected            → 'connect'      (TCP never established)
      //   - connected, no bytes yet  → 'no-response'  (accepted but app not serving)
      //   - connected, bytes flowing → 'response'     (response genuinely in flight)
      const phaseOf = () => !connected ? 'connect' : (responseStarted ? 'response' : 'no-response');

      proxyReq.on('timeout', () => {
        const err   = new Error(connected ? (responseStarted ? 'Response timeout' : 'No response timeout') : 'Connect timeout');
        err.code    = connected ? 'EREADTIMEOUT' : 'ECONNTIMEOUT';
        err.phase   = phaseOf();
        err.responseStarted = responseStarted;
        reject(err);
        proxyReq.destroy();
      });
      proxyReq.on('error', (err) => {
        if (!err.phase) err.phase = phaseOf();
        if (err.responseStarted === undefined) err.responseStarted = responseStarted;
        reject(err);
      });

      if (body && body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
  }

  // Single-port backend request for the plugin path. Returns a result object or
  // a synthetic 502 on error.
  async _requestSingle(mapping, uri, method, headers, body) {
    const port = parseInt(mapping.back_port, 10);
    try {
      return await this._tryPort(mapping, port, uri, method, headers, body);
    } catch (err) {
      this.logger.error('backend request failed', {
        domain:     mapping.domain,
        port,
        uri,
        error:      err.message,
        error_code: err.code,
        address:    err.address,
      });
      return { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Bad Gateway'), _gatewayError: true, _gatewayReason: `backend-error:${err.code || 'unknown'}` };
    }
  }

  // HA request across multiple backends. A "backend" is a distinct target — either
  // another port on the same host (`back_port` list) or a whole other host
  // (`backend` URL list). Tries them best-score-first; short-circuits on the first
  // that actually responds (any status code). Connection-level failures (no
  // response at all) penalize that target and move to the next one.
  async _requestHA(mapping, uri, method, headers, body, span = null) {
    const ordered = this.rankedTargets(mapping.id, this._backendTargets(mapping));

    // Idempotent (safe) methods can be retried on another backend without risk of
    // duplicating side effects, because the HA path fully buffers the response
    // and only flushes it to the client in sendHAResponse *after* success — so
    // nothing is ever committed to the client on a failed attempt.
    const idempotent = ProxyServer.SAFE_METHODS.has(String(method).toUpperCase());

    for (const target of ordered) {
      const where = `${target.hostname}:${target.port}`;
      try {
        const result = await this._tryTarget(mapping, target, uri, method, headers, body);
        this.boostPort(mapping.id, target.key);
        return result;
      } catch (err) {
        // A post-connect failure ('no-response' or 'response') means the backend
        // accepted the TCP connection but never completed a response — e.g. a
        // container that has started listening during a blue/green deploy but is
        // not yet ready to serve. Such a target is NOT healthy: penalize it so the
        // ranking sheds it (and a background probe restores it once it recovers).
        const postConnect = err.phase === 'response' || err.phase === 'no-response';

        if (postConnect && !idempotent) {
          // Non-idempotent request (POST/PATCH/…): it may already have been
          // processed by the backend, so retrying could duplicate work. Surface a
          // 504 — but still penalize so subsequent requests avoid this target.
          this.penalizePort(mapping.id, target.key);
          this.startBackgroundCheckTarget(mapping, target);
          this.logger.error('HA backend failed post-connect on non-idempotent request (not failing over)', {
            domain:     mapping.domain,
            backend:    where,
            uri,
            method,
            phase:      err.phase,
            error:      err.message,
            error_code: err.code,
          });
          if (span) {
            span.setAttribute('ha.response_phase_error',   true);
            span.setAttribute('ha.response_phase_backend', where);
            span.setAttribute('ha.response_phase',         err.phase);
          }
          return {
            statusCode: 504,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('Gateway Timeout'),
            _gatewayError: true,
            _gatewayReason: 'post-connect-timeout',
          };
        }

        // connect-phase failure (any method) OR post-connect on an idempotent
        // request: penalize, probe in the background, and fail over to the next
        // ranked backend.
        this.logger.warn('HA backend failed, trying next', {
          domain:           mapping.domain,
          backend:          where,
          uri,
          method,
          phase:            err.phase,
          response_started: err.responseStarted,
          error:            err.message,
          error_code:       err.code,
          address:          err.address,
        });
        this.penalizePort(mapping.id, target.key);
        this.startBackgroundCheckTarget(mapping, target);
      }
    }

    const backendDetails = ordered.map(target => {
      const lastSeen = this.portLastSeen.get(this._portKey(mapping.id, target.key));
      return {
        backend:   `${target.hostname}:${target.port}`,
        score:     this.getPortScore(mapping.id, target.key),
        last_seen: lastSeen ? new Date(lastSeen).toISOString() : 'never',
        last_seen_ms_ago: lastSeen ? Date.now() - lastSeen : null,
      };
    });
    this.logger.error('all backends unavailable', {
      domain:          mapping.domain,
      mapping_id:      mapping.id,
      backend_details: backendDetails,
    });
    if (span) {
      span.setAttribute('ha.all_backends_down', true);
      span.setAttribute('ha.failed_backends', ordered.map(t => `${t.hostname}:${t.port}`).join(','));
    }
    return { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Bad Gateway: all backends unavailable'), _gatewayError: true, _gatewayReason: 'all-backends-unavailable' };
  }

  // Full request/response pipeline used when ≥1 plugin expressed interest.
  async _handleWithPlugins(requestId, domain, inPort, mapping, req, res, needsBody = true) {
    if (!needsBody) {
      return this._streamWithPlugins(requestId, domain, inPort, mapping, req, res);
    }

    // Buffer request body (needed for before() payload and for re-sending to backend)
    const requestBody = await this.bufferBody(req);

    // ── before() ────────────────────────────────────────────────────────────
    const beforeResult = await this.pluginManager.runBefore(
      requestId, domain, inPort, req.url, req.method, req.headers, requestBody
    );

    if (beforeResult.type === 'CANCEL') {
      // The plugin may supply its own headers + body (block page / PoW challenge);
      // fall back to a bare status with an empty text body.
      res.writeHead(beforeResult.statusCode, beforeResult.headers || { 'content-type': 'text/plain' });
      return res.end(beforeResult.body || undefined);
    }

    // Apply REWRITE_REQUEST (null fields keep the original value)
    let uri     = req.url;
    let method  = req.method;
    let headers = req.headers;
    let body    = requestBody;
    const skipAfter = beforeResult.type === 'IGNORE';

    if (beforeResult.type === 'REWRITE_REQUEST') {
      if (beforeResult.uri     != null) uri     = beforeResult.uri;
      if (beforeResult.method  != null) method  = beforeResult.method;
      if (beforeResult.headers != null) headers = beforeResult.headers;
      if (beforeResult.payload != null) body    = beforeResult.payload;
    }

    // ── backend request ──────────────────────────────────────────────────────
    const backendResult = this._isHA(mapping)
      ? await this._requestHA(mapping, uri, method, headers, body, req._span)
      : await this._requestSingle(mapping, uri, method, headers, body);

    // ── after() ──────────────────────────────────────────────────────────────
    // Skipped when before() returned IGNORE (cleanup already done)
    if (skipAfter) {
      return this.sendHAResponse(req, res, backendResult);
    }

    const afterResult = await this.pluginManager.runAfter(
      requestId, domain, inPort, backendResult.statusCode, backendResult.headers, backendResult.body
    );

    if (afterResult.type === 'CANCEL') {
      res.writeHead(afterResult.statusCode, { 'content-type': 'text/plain' });
      return res.end();
    }

    if (afterResult.type === 'REWRITE_RESPONSE') {
      const status  = afterResult.statusCode ?? backendResult.statusCode;
      const hdrs    = afterResult.headers    ?? backendResult.headers;
      const resBody = afterResult.payload != null
        ? afterResult.payload
        : backendResult.body;
      res.writeHead(status, hdrs);
      return res.end(resBody);
    }

    // CONTINUE — send the backend response as-is
    await this.sendHAResponse(req, res, backendResult);
  }

  // Streaming plugin path: run before()/after() with null body, pipe request and
  // response directly. Used when every interested plugin declared needsBody: false.
  async _streamWithPlugins(requestId, domain, inPort, mapping, req, res) {
    const beforeResult = await this.pluginManager.runBefore(
      requestId, domain, inPort, req.url, req.method, req.headers, null
    );

    if (beforeResult.type === 'CANCEL') {
      // The plugin may supply its own headers + body (block page / PoW challenge);
      // fall back to a bare status with an empty text body.
      res.writeHead(beforeResult.statusCode, beforeResult.headers || { 'content-type': 'text/plain' });
      return res.end(beforeResult.body || undefined);
    }

    let uri     = req.url;
    let method  = req.method;
    let headers = { ...req.headers };
    const skipAfter = beforeResult.type === 'IGNORE';

    if (beforeResult.type === 'REWRITE_REQUEST') {
      if (beforeResult.uri     != null) uri     = beforeResult.uri;
      if (beforeResult.method  != null) method  = beforeResult.method;
      if (beforeResult.headers != null) headers = beforeResult.headers;
    }

    // We already answered any Expect: 100-continue to the client; a forwarded
    // stale Expect can make the backend re-negotiate and 404 the request.
    delete headers['expect'];

    // A before() hook can supply a replacement request body even on the streaming
    // path: the plugin produced those bytes itself (it never needed the client's
    // body), so we send them with an explicit Content-Length rather than piping
    // the original — no buffering required.
    const rewriteReqBody = beforeResult.type === 'REWRITE_REQUEST' && beforeResult.payload != null
      ? beforeResult.payload
      : null;
    if (rewriteReqBody) {
      headers = { ...headers };
      headers['content-length'] = rewriteReqBody.length;
      delete headers['transfer-encoding'];
    }

    // Plugin streaming has no MID-STREAM failover, but a connect-phase failure
    // (TCP never established → nothing sent to the backend) fails over across
    // ranked targets exactly like _streamHA: penalize the dead target, start a
    // background probe, try the next. Previously this path picked one target
    // and 502'd on a dead port with no penalty — so on an HA mapping the dead
    // backend kept being picked (rotation) and every other request failed.
    const targets = this._backendTargets(mapping);
    const ordered = targets.length > 1 ? this.rankedTargets(mapping.id, targets) : targets;

    const targetPath = (!mapping.front_uri && !mapping.back_uri)
      ? uri
      : this.buildTargetPath(mapping, uri);

    headers['x-forwarded-host'] = headers['host'] || '';

    const skip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer']);
    const connectTimeoutMs = parseInt(process.env.HA_CONNECT_TIMEOUT_MS || '3000', 10);

    // Hold the client body until a backend connection is committed, so a
    // connect-phase failover never loses body bytes. (A plugin-supplied rewrite
    // body is resendable from memory and doesn't need this.)
    if (!rewriteReqBody) req.pause();

    return new Promise((resolve) => {
      const attempt = (idx) => {
      if (idx >= ordered.length) {
        const list = ordered.map(t => `${t.hostname}:${t.port}`).join(',');
        this.logger.error('all backends unavailable (plugin stream)', {
          domain, mapping_id: mapping.id, backends: list,
        });
        this._sendGatewayError(req, res, 502, 'Bad Gateway: all backends unavailable', 'plugin-stream-all-backends-unavailable');
        return resolve();
      }
      const target = ordered[idx];
      const port   = target.port;
      const lib    = target.isHttps ? https : http;
      let committed = false; // true once TCP connect succeeds and the body starts flowing

      // Honor a back_host rewrite when set; otherwise keep this path's historical
      // behavior of addressing the backend by its own host:port.
      const attemptHeaders = { ...headers };
      attemptHeaders['host'] = mapping.back_host || `${target.hostname}:${port}`;

      const proxyReq = lib.request(
        { hostname: target.hostname, port, path: targetPath, method, headers: attemptHeaders,
          ...(target.isHttps ? { rejectUnauthorized: false } : {}) },
        async (proxyRes) => {
          this.boostPort(mapping.id, target.key);
          try {
            if (!skipAfter) {
              const afterResult = await this.pluginManager.runAfter(
                requestId, domain, inPort, proxyRes.statusCode, proxyRes.headers, null
              );
              if (afterResult.type === 'CANCEL') {
                proxyRes.destroy();
                res.writeHead(afterResult.statusCode, { 'content-type': 'text/plain' });
                res.end();
                return resolve();
              }
              if (afterResult.type === 'REWRITE_RESPONSE') {
                const outHeaders = {};
                const src = afterResult.headers ?? proxyRes.headers;
                for (const [k, v] of Object.entries(src)) {
                  if (!skip.has(k.toLowerCase())) outHeaders[k] = v;
                }
                // If after() produced a replacement body, send it and discard the
                // backend's. The plugin's bytes are already in hand, so this works
                // on the streaming path without buffering the backend response.
                if (afterResult.payload != null) {
                  for (const k of Object.keys(outHeaders)) {
                    if (k.toLowerCase() === 'content-length') delete outHeaders[k];
                  }
                  outHeaders['content-length'] = afterResult.payload.length;
                  res.writeHead(afterResult.statusCode ?? proxyRes.statusCode, outHeaders);
                  proxyRes.destroy();
                  res.end(afterResult.payload);
                  return resolve();
                }
                res.writeHead(afterResult.statusCode ?? proxyRes.statusCode, outHeaders);
                proxyRes.pipe(res);
                proxyRes.on('end', resolve);
                proxyRes.on('error', () => resolve());
                return;
              }
            }
            const fwdHeaders = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
            }
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', () => resolve());
          } catch (err) {
            this.logger.error('plugin streaming after() error', { domain, error: err.message });
            if (!res.headersSent) {
              await this._sendGatewayError(req, res, 502, 'Bad Gateway', 'plugin-stream-after-error');
            }
            resolve();
          }
        }
      );

      proxyReq.on('socket', (socket) => {
        const onConnect = () => {
          committed = true;
          socket.setTimeout(0);
          if (rewriteReqBody) {
            req.resume();             // drain & discard the original client body
            proxyReq.end(rewriteReqBody);
          } else {
            req.pipe(proxyReq);
          }
        };
        if (socket.connecting) {
          socket.setTimeout(connectTimeoutMs);
          socket.once('connect', onConnect);
        } else {
          // Pooled / keepalive socket — already connected.
          onConnect();
        }
      });

      proxyReq.on('timeout', () => {
        // Only the pre-connect socket deadline can fire (post-connect we set 0).
        proxyReq.destroy(new Error('Connect timeout'));
      });

      proxyReq.on('error', (err) => {
        if (!committed) {
          // Connect-phase failure: nothing sent yet → penalize and fail over.
          this.penalizePort(mapping.id, target.key);
          this.startBackgroundCheckTarget(mapping, target);
          this.logger.warn('plugin stream connect failed, trying next backend', {
            domain, backend: `${target.hostname}:${port}`, url: req.url,
            error: err.message, error_code: err.code,
          });
          return attempt(idx + 1);
        }
        this.logger.error('plugin streaming backend error', { domain, port, error: err.message });
        if (!res.headersSent) {
          this._sendGatewayError(req, res, 502, 'Bad Gateway', `plugin-stream-backend-error:${err.code || 'unknown'}`);
        }
        resolve();
      });
      };
      attempt(0);
    });
  }

  async sendHAResponse(req, res, result) {
    // A result jsproxy synthesised because it could not reach the backend (marked
    // _gatewayError) is routed through the error hook so a plugin can brand it —
    // NOT the plain header-copy path used for a genuine backend response.
    if (result._gatewayError) {
      return this._sendGatewayError(req, res, result.statusCode, result.body, result._gatewayReason);
    }
    const skip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer']);
    const headers = {};
    for (const [k, v] of Object.entries(result.headers)) {
      if (!skip.has(k.toLowerCase())) headers[k] = v;
    }
    res.writeHead(result.statusCode, headers);
    res.end(result.body);
  }

  // Serve one of jsproxy's OWN synthetic gateway errors (a 502/504 it generated
  // because the backend was unreachable / timed out). Before falling back to the
  // plain-text body, offer a plugin the chance to supply a branded, per-host error
  // page via the /error hook (see PluginManager.runError). Fail-open in every
  // direction: no plugins, a plugin error/timeout, or an already-started response
  // all leave the plain-text default untouched, so this can never make a gateway
  // error worse. `reason` is a short machine tag (e.g. 'all-backends-unavailable')
  // passed through for the plugin's diagnostics/stats.
  async _sendGatewayError(req, res, statusCode, fallback, reason) {
    // Defensive: some error paths (WS upgrades) carry a raw socket instead of a
    // ServerResponse. Never throw out of here — this runs inside error handlers
    // where an exception becomes an unhandled rejection.
    if (!res || typeof res.writeHead !== 'function') {
      if (res && typeof res.destroy === 'function') res.destroy();
      return;
    }
    if (res.headersSent) return;
    if (this.pluginManager.hasPlugins) {
      try {
        const domain = req._proxyDomain
          || (req.headers && req.headers.host ? req.headers.host.split(':')[0] : '')
          || 'unknown';
        const inPort = (req.socket && req.socket.encrypted)
          ? parseInt(process.env.HTTPS_PORT || (process.env.NODE_ENV === 'production' ? '443' : '8443'), 10)
          : parseInt(process.env.HTTP_PORT || (process.env.NODE_ENV === 'production' ? '80' : '8080'), 10);
        const page = await this.pluginManager.runError({
          domain, inPort, statusCode,
          reason: reason || null,
          uri: req.url, method: req.method,
          headers: req.headers,
        });
        if (page && page.body && page.body.length > 0 && !res.headersSent) {
          const headers = (page.headers && typeof page.headers === 'object')
            ? page.headers
            : { 'content-type': 'text/html; charset=utf-8' };
          res.writeHead(page.statusCode || statusCode, headers);
          return res.end(page.body);
        }
      } catch (err) {
        this.logger.warn(`gateway error page hook failed (fail-open): ${err.message}`);
      }
    }
    if (!res.headersSent) {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
      res.end(fallback);
    }
  }

  async haRequest(mapping, req, res) {
    // Stream directly (never buffer) when the body is large, of unknown size, or
    // an open-ended response stream — buffering these into memory would OOM and,
    // for an "infinite" upload, can never complete. _streamHA fails over across
    // backends on a connect-phase failure (no body bytes sent yet, so retrying is
    // safe); once the connection is established the body flows and a mid-stream
    // failure surfaces to the client.
    if (this._isStreamingRequest(req)) {
      return this._streamHA(mapping, req, res);
    }

    // Small / known-size body: buffer and retry across ports for true failover
    // (including post-connect failures, which the streaming path cannot retry).
    const body = await this.bufferBody(req);
    const result = await this._requestHA(mapping, req.url, req.method, req.headers, body, req._span);
    await this.sendHAResponse(req, res, result);
  }

  // A request must be streamed (never buffered) when its body is large, of unknown
  // size, or it is an open-ended response stream:
  //   - SSE / event-streams
  //   - bodies larger than HA_STREAM_THRESHOLD
  //   - chunked bodies with no declared content-length (the streaming-upload case)
  _isStreamingRequest(req) {
    const cl        = parseInt(req.headers['content-length'] ?? '-1', 10);
    const isSSE     = req.headers.accept?.includes('text/event-stream');
    const isChunked = req.headers['transfer-encoding']?.toLowerCase().includes('chunked');
    const isLarge   = cl > ProxyServer.HA_STREAM_THRESHOLD;
    return Boolean(isSSE || isLarge || isChunked);
  }

  // Streaming HA proxy with connect-phase failover. Pipes the request body
  // straight through to the backend without ever buffering it — so a 1 GB or an
  // open-ended/chunked upload costs only socket buffers, not memory. Used for
  // SSE, large bodies, and chunked/unknown-size bodies, including jsproxy ->
  // jsproxy -> ... chains of arbitrary depth (every hop streams; nothing is held
  // in memory at any hop).
  //
  // Failover semantics mirror _requestHA but are constrained by streaming:
  //   - connect-phase failure (TCP never established) → no body bytes have been
  //     sent, so penalize the port and try the next ranked backend. This is the
  //     case that previously surfaced a 502 (the old proxy.web path picked one
  //     port and never failed over).
  //   - post-connect failure (backend accepted, then reset/timed out) → the body
  //     is already in flight; retrying could duplicate a non-idempotent upload
  //     and the original bytes are gone. Surface to the client, which retries.
  _streamHA(mapping, req, res) {
    // Ordered failover candidates — either ports on one host or distinct backend
    // URLs. Each attempt reads its host/port/scheme from the target; the Host
    // header is the same for all (back_host || original), set once below.
    const ordered = this.rankedTargets(mapping.id, this._backendTargets(mapping));

    const targetPath = (!mapping.front_uri && !mapping.back_uri)
      ? req.url
      : this.buildTargetPath(mapping, req.url);

    // Outbound headers mirror the streaming path in setupProxyErrorHandling:
    // preserve the client Host (or back_host) so a downstream Host-routing jsproxy
    // can still match the original domain. Strip hop-by-hop headers, including
    // transfer-encoding — when we pipe the body, Node re-frames it itself (fixed
    // length if Content-Length is present, otherwise chunked), so forwarding the
    // inbound framing header would risk a duplicate/conflicting one.
    //
    // 'expect' (100-continue) is stripped too: our own HTTP server already
    // answered 100 Continue to the client (Node's default) before this handler
    // ran, so the continue handshake is finished. Forwarding a stale Expect would
    // make the backend negotiate a second 100 — which breaks some app servers
    // (observed as a spurious 404) and can emit a duplicate 100 to the client.
    const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate',
      'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hopByHop.has(k.toLowerCase())) headers[k] = v;
    }
    if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = req.headers['host'] || '';
    headers['host'] = mapping.back_host || req.headers['host'] || (ordered[0] && ordered[0].hostname) || '';
    headers['x-forwarded-proto'] = this.isClientHttps(req) ? 'https' : 'http';
    // X-Forwarded-For is already correct here: the header-copy loop above carried
    // it over from req.headers, where _handleRequest appended this hop's peer at
    // the single chokepoint. Re-appending would duplicate the peer entry.

    const connectTimeoutMs = parseInt(process.env.HA_CONNECT_TIMEOUT_MS || '3000', 10);
    // Idle timeout: the ONLY deadline once a backend is connected. "Idle" is
    // measured directly from real byte movement on the backend socket —
    // bytesWritten (upload progress, client→backend) PLUS bytesRead (download
    // progress, backend→client). As long as either counter advances, the stream
    // is active and is never torn down: a multi-GB upload, a slow-but-steady
    // download, a long-lived SSE feed all keep it alive. It fires only when
    // NOTHING has moved either way for idleMs — a genuinely stalled connection.
    //
    // Why poll the socket counters instead of listening to 'data' events: under
    // backpressure (a slow backend), pipe() PAUSES the client request, so
    // req.on('data') goes silent for long stretches even though bytes are pouring
    // out to the backend. The socket's bytesWritten still advances, so polling it
    // sees the real activity that 'data' events miss.
    const idleMs = parseInt(process.env.STREAM_IDLE_TIMEOUT_MS || '300000', 10);
    const pollMs = Math.max(250, Math.min(Math.floor(idleMs / 4), 15000));
    const skip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer']);

    // Hold the body until a backend connection is committed. Nothing is read from
    // the client socket (and thus nothing buffered) until we start piping.
    req.pause();

    const span = req._span;
    let currentProxyReq = null;
    let idleTimer = null;
    let lastBytes = -1;
    let idleElapsed = 0;
    const onIdle = () => {
      this.logger.warn('HA stream idle timeout — no bytes moved in either direction', {
        domain: mapping.domain, url: req.url, idle_ms: idleMs,
      });
      if (currentProxyReq) currentProxyReq.destroy(new Error('Idle timeout'));
      if (!res.headersSent) this._sendGatewayError(req, res, 504, 'Gateway Timeout', 'stream-idle-timeout');
      else if (!res.writableEnded) res.destroy();
    };
    const clearIdle = () => { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } };
    const startIdleMonitor = () => {
      clearIdle();
      lastBytes = -1;
      idleElapsed = 0;
      idleTimer = setInterval(() => {
        // Sum byte movement on BOTH legs of the proxied connection: the client
        // socket (req) and the backend socket (proxyReq). The connection is active
        // if EITHER is moving — e.g. the client is still uploading into us while
        // the backend leg is briefly backpressured, or the backend is responding
        // while the client side is quiet. Watching only the backend socket would
        // wrongly call a still-uploading request idle.
        const inSock  = req.socket;
        const outSock = currentProxyReq && currentProxyReq.socket;
        const cur = (inSock  ? inSock.bytesRead  + inSock.bytesWritten  : 0)
                  + (outSock ? outSock.bytesRead + outSock.bytesWritten : 0);
        if (cur !== lastBytes) { lastBytes = cur; idleElapsed = 0; return; } // active
        idleElapsed += pollMs;
        if (idleElapsed >= idleMs) { clearIdle(); onIdle(); }
      }, pollMs);
      if (idleTimer.unref) idleTimer.unref();
    };

    // If the client aborts the upload, tear down whichever backend request is live.
    req.on('error', () => { clearIdle(); if (currentProxyReq) currentProxyReq.destroy(); });
    res.on('close', clearIdle);

    const attempt = (idx) => {
      if (idx >= ordered.length) {
        clearIdle();
        const list = ordered.map(t => `${t.hostname}:${t.port}`).join(',');
        this.logger.error('all backends unavailable (stream)', {
          domain: mapping.domain, mapping_id: mapping.id, backends: list,
        });
        if (span) {
          span.setAttribute('ha.all_backends_down', true);
          span.setAttribute('ha.failed_backends', list);
        }
        if (!res.headersSent) {
          this._sendGatewayError(req, res, 502, 'Bad Gateway: all backends unavailable', 'stream-all-backends-unavailable');
        }
        return;
      }

      const target = ordered[idx];
      const port   = target.port;
      const where  = `${target.hostname}:${target.port}`;
      const lib    = target.isHttps ? https : http;
      let committed = false; // true once TCP connect succeeds and the body starts flowing

      const proxyReq = lib.request({
        hostname: target.hostname,
        port,
        path: targetPath,
        method: req.method,
        headers,
        ...(target.isHttps ? { rejectUnauthorized: false } : {}),
      }, (proxyRes) => {
        // Response received → backend is healthy. Stream it straight back, resetting
        // the idle deadline on every response chunk so a long download stays alive.
        this.boostPort(mapping.id, target.key);
        if (span) span.setAttribute('proxy.backend_status', proxyRes.statusCode);
        const fwd = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!skip.has(k.toLowerCase())) fwd[k] = v;
        }
        res.writeHead(proxyRes.statusCode, fwd);
        // Download progress keeps the idle monitor satisfied via the socket's
        // bytesRead counter; stop monitoring once the response completes.
        proxyRes.on('end', clearIdle);
        proxyRes.pipe(res);
        proxyRes.on('error', () => { clearIdle(); if (!res.writableEnded) res.destroy(); });
      });

      currentProxyReq = proxyReq;

      proxyReq.on('socket', (socket) => {
        const onConnect = () => {
          committed = true;
          // Connect succeeded: drop the connect deadline and switch to the idle
          // timeout. We use our own timer (reset on real data both ways) rather
          // than socket.setTimeout, whose idle clock is only nudged by inbound
          // bytes and so would wrongly kill a long upload that sends but never
          // receives until the very end.
          socket.setTimeout(0);
          startIdleMonitor();   // watch real bytes on this socket, both directions
          req.pipe(proxyReq);
        };
        if (socket.connecting) {
          socket.setTimeout(connectTimeoutMs);
          socket.once('connect', onConnect);
        } else {
          // Pooled / keepalive socket — already connected.
          onConnect();
        }
      });

      proxyReq.on('timeout', () => {
        // Only the pre-connect socket deadline can fire (post-connect we set 0).
        proxyReq.destroy(new Error('Connect timeout'));
      });

      proxyReq.on('error', (err) => {
        if (!committed) {
          // Connect-phase failure: no body sent yet → penalize and fail over.
          this.penalizePort(mapping.id, target.key);
          this.startBackgroundCheckTarget(mapping, target);
          this.logger.warn('HA stream connect failed, trying next backend', {
            domain: mapping.domain, backend: where, url: req.url, error: err.message, error_code: err.code,
          });
          attempt(idx + 1);
        } else {
          // Post-connect failure: body already in flight, cannot fail over.
          clearIdle();
          this.logger.warn('HA stream backend failed mid-request (no failover)', {
            domain: mapping.domain, backend: where, url: req.url, error: err.message, error_code: err.code,
          });
          req.unpipe(proxyReq);
          if (!res.headersSent) {
            this._sendGatewayError(req, res, 502, 'Bad Gateway', `stream-post-connect-error:${err.code || 'unknown'}`);
          } else if (!res.writableEnded) {
            res.destroy();
          }
        }
      });
    };

    attempt(0);
  }

  static get HA_STREAM_THRESHOLD() { return 512 * 1024; } // 512 KB

  // HTTP methods safe to retry on another backend without risking duplicate
  // side effects. Used by _requestHA to decide whether a post-connect failure
  // should fail over or surface a 504.
  static get SAFE_METHODS() { return new Set(['GET', 'HEAD', 'OPTIONS']); }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  checkAuth(req, mapping) {
    if (!mapping.auth_type) return { allowed: true };

    let credentials = [];
    try { credentials = mapping.auth_credentials ? JSON.parse(mapping.auth_credentials) : []; }
    catch { return { allowed: false, type: 'basic' }; }

    if (credentials.length === 0) return { allowed: false, type: mapping.auth_type === 'bearer' ? 'bearer' : 'basic' };

    const authHeader = req.headers.authorization || '';
    const now = new Date();
    const expired = (c) => c.expires_at && new Date(c.expires_at) < now;

    if (mapping.auth_type === 'bearer') {
      if (!authHeader.startsWith('Bearer ')) return { allowed: false, type: 'bearer' };
      const token = authHeader.slice(7).trim();
      for (let i = 0; i < credentials.length; i++) {
        const c = credentials[i];
        if (c.token === token && !expired(c)) return { allowed: true, credentialIndex: i };
      }
      return { allowed: false, type: 'bearer' };
    }

    if (mapping.auth_type === 'basic') {
      if (!authHeader.startsWith('Basic ')) return { allowed: false, type: 'basic' };
      let user, pass;
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        user = idx >= 0 ? decoded.slice(0, idx) : decoded;
        pass = idx >= 0 ? decoded.slice(idx + 1) : '';
      } catch { return { allowed: false, type: 'basic' }; }
      for (let i = 0; i < credentials.length; i++) {
        const c = credentials[i];
        if (c.user === user && c.pass === pass && !expired(c)) return { allowed: true, credentialIndex: i };
      }
      return { allowed: false, type: 'basic' };
    }

    if (mapping.auth_type === 'password') {
      let pass = null;
      if (authHeader.startsWith('Bearer ')) {
        pass = authHeader.slice(7).trim();
      } else if (authHeader.startsWith('Basic ')) {
        try {
          const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
          const idx = decoded.lastIndexOf(':');
          pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
        } catch { /* ignore */ }
      }
      if (!pass) return { allowed: false, type: 'basic' };
      for (let i = 0; i < credentials.length; i++) {
        const c = credentials[i];
        if (c.pass === pass && !expired(c)) return { allowed: true, credentialIndex: i };
      }
      return { allowed: false, type: 'basic' };
    }

    return { allowed: false, type: 'basic' };
  }

  _sendUnauthorized(res, authResult) {
    const scheme = authResult.type === 'bearer' ? 'Bearer' : 'Basic';
    res.writeHead(401, {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': `${scheme} realm="Proxy"`,
    });
    res.end('Unauthorized');
  }

  // ── IP allowlist helpers ───────────────────────────────────────────────────

  // The ORIGINAL client IP, resolved against the trusted-proxy set. Start from the
  // real socket peer (unspoofable); only if that peer is a trusted proxy do we
  // believe X-Forwarded-For, walking it right-to-left and skipping further trusted
  // hops — the first non-trusted address is the true client. With no trusted
  // proxies configured (default edge posture) inbound XFF is ignored entirely and
  // the socket peer wins, so a client cannot spoof its IP via X-Forwarded-For.
  getClientIp(req) {
    const peer = this.getPeerIp(req);
    if (!this._isTrusted(peer)) return peer;
    const xff = req.headers['x-forwarded-for'];
    const chain = xff ? xff.split(',').map(s => s.trim()).filter(Boolean) : [];
    chain.push(peer); // peer is this hop's real socket — the most trustworthy entry
    for (let i = chain.length - 1; i >= 0; i--) {
      const ip = chain[i].startsWith('::ffff:') ? chain[i].slice(7) : chain[i];
      if (!this._isTrusted(ip)) return ip;
    }
    // Whole chain is trusted (e.g. the real client is itself inside a trusted
    // range): fall back to the leftmost claimed address.
    const first = chain[0];
    return first.startsWith('::ffff:') ? first.slice(7) : first;
  }

  // The immediate TCP peer (this hop's client socket) — NEVER a header value, so
  // it can't be spoofed. This is the IP we append to X-Forwarded-For at each hop.
  // Distinct from getClientIp(), which reports the ORIGINAL client (leftmost XFF)
  // for allowlist / telemetry / webhook use.
  getPeerIp(req) {
    const addr = req.socket && req.socket.remoteAddress;
    // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 -> 1.2.3.4)
    if (addr && addr.startsWith('::ffff:')) return addr.slice(7);
    return addr;
  }

  // Append this hop's real socket peer to X-Forwarded-For on req.headers so every
  // downstream forward path (all of which copy from req.headers) carries the same
  // chain. Preserves any inbound XFF (prior hops) and appends the true peer, so a
  // chain user -> jsproxy1 -> jsproxy2 -> backend yields "user, jsproxy1-peer" at
  // the backend with the original client always leftmost. Call exactly once per
  // request, before any forward path / retry loop.
  _appendForwardedFor(req) {
    const peerIp = this.getPeerIp(req);
    if (!peerIp) return;
    const existing = req.headers['x-forwarded-for'];
    req.headers['x-forwarded-for'] = existing ? `${existing}, ${peerIp}` : peerIp;
  }

  isIpAllowed(clientIp, allowedIps) {
    if (!allowedIps || allowedIps.trim() === '') return true;
    const entries = allowedIps.split(',').map(s => s.trim()).filter(Boolean);
    return entries.some(entry => {
      if (entry.includes('/')) return this._ipInCidr(clientIp, entry);
      return clientIp === entry;
    });
  }

  _ipInCidr(ip, cidr) {
    try {
      const [range, bits] = cidr.split('/');
      const mask = bits ? (~0 << (32 - parseInt(bits, 10))) >>> 0 : 0xFFFFFFFF;
      return (this._ipToInt(ip) & mask) === (this._ipToInt(range) & mask);
    } catch (e) {
      return false;
    }
  }

  _ipToInt(ip) {
    return ip.split('.').reduce((acc, octet) => (acc * 256) + parseInt(octet, 10), 0) >>> 0;
  }

  // Compile TRUSTED_PROXIES into a list of (ip)->bool predicates. Accepts IPv4
  // CIDRs / literal IPs and the keywords `loopback`, `private`, `all`.
  _parseTrustedProxies(spec) {
    const preds = [];
    const cidr  = (c) => (ip) => this._ipInCidr(ip, c);
    const exact = (a) => (ip) => ip === a;
    const ula   = () => (ip) => /^f[cd]/i.test(ip);          // IPv6 unique-local fc00::/7
    const loopback = [cidr('127.0.0.0/8'), exact('::1')];
    for (const raw of spec.split(',').map(s => s.trim()).filter(Boolean)) {
      switch (raw.toLowerCase()) {
        case 'all':      preds.push(() => true); break;
        case 'loopback': preds.push(...loopback); break;
        case 'private':  preds.push(...loopback,
                           cidr('10.0.0.0/8'), cidr('172.16.0.0/12'),
                           cidr('192.168.0.0/16'), ula()); break;
        default:         preds.push(raw.includes('/') ? cidr(raw) : exact(raw));
      }
    }
    return preds;
  }

  // True when `ip` belongs to a configured trusted proxy. Always false when the
  // trusted set is empty (edge posture) — the safe default.
  _isTrusted(ip) {
    if (!ip || !this.trustedProxies || this.trustedProxies.length === 0) return false;
    const norm = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return this.trustedProxies.some(pred => pred(norm));
  }

  // Whether the ORIGINAL client reached us over HTTPS. Believes inbound
  // X-Forwarded-Proto / -Ssl / Front-End-Https ONLY when the immediate peer is a
  // trusted proxy; otherwise derives purely from this hop's own TLS socket, so a
  // plaintext client can't claim https by sending a forwarded header.
  // Fire-and-forget certificate materialization for a served domain that has
  // only ever seen HTTP traffic (so no cert was lazily generated on a TLS SNI
  // handshake yet). Produces a self-signed cert immediately and, for public
  // domains, upgrades to ACME/trusted in the background. Deduped per domain so
  // repeated HTTP hits during warming don't spawn concurrent generations. Once
  // the cert lands, hasCertificateFor() flips true and the domain starts
  // redirecting to HTTPS on its own — no operator action needed.
  _warmCertificate(domain) {
    if (!domain || this._certWarming.has(domain)) return;
    this._certWarming.add(domain);
    Promise.resolve()
      .then(() => this.certManager.ensureCertificate(domain, true))
      .catch((err) => this.logger.warn(`cert warm failed for ${domain}: ${err.message || err}`))
      .finally(() => this._certWarming.delete(domain));
  }

  isClientHttps(req) {
    if (req.connection && req.connection.encrypted) return true;
    if (!this._isTrusted(this.getPeerIp(req))) return false;
    return req.headers['x-forwarded-proto'] === 'https'
        || req.headers['x-forwarded-ssl']   === 'on'
        || req.headers['front-end-https']   === 'on';
  }

  // ── Webhook interceptor ───────────────────────────────────────────────────

  /**
   * Fire the configured WEBHOOK_URL (if any) and return a decision object.
   *
   * Returns null when no webhook is configured or on any network/timeout error
   * (fail-open: the request is proxied as normal).
   *
   * Decision object shape:
   *   { statusCode: 200 }                                   → continue
   *   { statusCode: 3xx, location: '...' }                  → redirect client
   *   { statusCode: 4xx|5xx, headers: {…}, body: '…' }      → serve directly
   */
  async callWebhook(mapping, req) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return null;

    const timeoutMs = parseInt(process.env.WEBHOOK_TIMEOUT || '5000', 10);

    const ports = String(mapping.back_port)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    const payload = JSON.stringify({
      domain: mapping.domain,
      url: req.url,
      method: req.method,
      headers: req.headers,
      ports,
      ip: this.getClientIp(req),
      mappingId: mapping.id,
      timestamp: new Date().toISOString(),
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'jsproxy-webhook/1.0',
    };

    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${sig}`;
    }

    try {
      const parsed = new URL(webhookUrl);
      const lib = parsed.protocol === 'https:' ? https : http;

      const result = await new Promise((resolve, reject) => {
        const reqOptions = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        };

        const whReq = lib.request(reqOptions, (whRes) => {
          const chunks = [];
          whRes.on('data', chunk => chunks.push(chunk));
          whRes.on('end', () => resolve({
            statusCode: whRes.statusCode,
            headers: whRes.headers,
            body: Buffer.concat(chunks).toString(),
          }));
          whRes.on('error', reject);
        });

        whReq.on('timeout', () => {
          whReq.destroy();
          reject(new Error('Webhook timeout'));
        });
        whReq.on('error', reject);
        whReq.write(payload);
        whReq.end();
      });

      const { statusCode, headers: resHeaders, body } = result;
      this.logger.info(`Webhook response: ${statusCode} for ${req.method} ${req.url}`);

      if (statusCode >= 300 && statusCode < 400) {
        const location = resHeaders['location'] || resHeaders['Location'];
        return { statusCode, location };
      }

      if (statusCode !== 200) {
        // Pass through the response content-type if the webhook sets one,
        // but strip hop-by-hop headers.
        const hop = new Set(['transfer-encoding', 'connection', 'keep-alive']);
        const passHeaders = {};
        for (const [k, v] of Object.entries(resHeaders)) {
          if (!hop.has(k.toLowerCase())) passHeaders[k] = v;
        }
        return { statusCode, headers: passHeaders, body };
      }

      return { statusCode: 200 };
    } catch (err) {
      this.logger.error('Webhook call failed (proceeding with proxy):', err.message);
      return null; // fail-open
    }
  }

  async stop() {
    if (this.httpServer) {
      this.httpServer.closeAllConnections();
      await new Promise((resolve) => this.httpServer.close(resolve));
    }
    if (this.httpsServer) {
      this.httpsServer.closeAllConnections();
      await new Promise((resolve) => this.httpsServer.close(resolve));
    }
    for (const server of this.tcpServers.values()) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    this.tcpServers.clear();
    await this.db.close();
  }
}

module.exports = ProxyServer;
