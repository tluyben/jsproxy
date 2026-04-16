const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const DatabaseManager = require('./DatabaseManager');
const CertificateManager = require('./CertificateManager');
const { noop } = require('./PluginManager');
const { URL } = require('url');

class ProxyServer {
  constructor(logger, pluginManager) {
    this.logger = logger;
    this.pluginManager = pluginManager || noop;
    this.db = new DatabaseManager(logger);
    this.certManager = new CertificateManager(logger, this.db);

    // HA state — score-based port selection
    this.portScores = new Map();  // `${mappingId}:${port}` -> 0..100
    this.rrCounters = new Map();  // mappingId -> rotation counter (tie-break)
    this.bgChecks   = new Set();  // keys currently being TCP-probed

    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      timeout: 30000,
      proxyTimeout: 30000,
      xfwd: true  // Automatically adds X-Forwarded-For, X-Forwarded-Port, X-Forwarded-Proto
    });
    
    this.httpServer = null;
    this.httpsServer = null;
    this.setupProxyErrorHandling();
  }

  setupProxyErrorHandling() {
    // Set proper forwarding headers before proxying
    this.proxy.on('proxyReq', (proxyReq, req, res, options) => {
      // Preserve the original host
      const originalHost = req.headers.host;
      if (originalHost) {
        proxyReq.setHeader('X-Forwarded-Host', originalHost);
        // Keep the Host header as the original domain
        proxyReq.setHeader('Host', originalHost);
      }
      
      // Set the protocol based on whether this is HTTPS
      const protocol = req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      proxyReq.setHeader('X-Forwarded-Proto', protocol);
      
      // X-Forwarded-For is handled by xfwd: true
    });
    
    this.proxy.on('proxyRes', (proxyRes, req, res) => {
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
      this.logger.error('Proxy error:', err);
      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    });

    this.proxy.on('proxyReqError', (err, req, res) => {
      this.logger.error('Proxy request error:', err);
      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
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
          this.logger.error('TLS client error:', err);
        });
        
        await new Promise((resolve) => {
          this.httpsServer.listen(httpsPort, httpHost, () => {
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
  }

  async handleRequest(req, res, isHttps) {
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

      // Redirect HTTP to HTTPS if FORCE_HTTPS is enabled
      // Check multiple headers set by reverse proxies (nginx, caddy, cloudflare, haproxy, etc.)
      const isSecure = isHttps ||
        req.connection.encrypted ||
        req.headers['x-forwarded-proto'] === 'https' ||
        req.headers['x-forwarded-ssl'] === 'on' ||
        req.headers['front-end-https'] === 'on';
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
      const mapping = await this.db.getMapping(domain, req.url);

      if (!mapping) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
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
          const interested = await this.pluginManager.runValid(requestId, domain, inPort, req.url, req.method);
          if (interested.length > 0) {
            this.pluginManager.register(requestId, interested);
            res.once('close', () => this.pluginManager.cleanup(requestId));
            await this._handleWithPlugins(requestId, domain, inPort, mapping, req, res);
            return;
          }
        } catch (err) {
          this.logger.error('Plugin system error (fail-open):', err);
          // Fall through to normal proxy path
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // HA round-robin across multiple ports
      if (String(mapping.back_port).includes(',')) {
        await this.haRequest(mapping, req, res);
        return;
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
      this.logger.error('Request handling error:', error);
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

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden');
        socket.destroy();
        return;
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

      const backend = mapping.backend || 'http://localhost';
      const target = `${backend}:${mapping.back_port}`;
      this.proxy.ws(req, socket, head, {
        target,
        secure: false,
        changeOrigin: true
      });

    } catch (error) {
      this.logger.error('WebSocket handling error:', error);
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

  // ── Port scoring ─────────────────────────────────────────────────────────────

  _portKey(mappingId, port) { return `${mappingId}:${port}`; }

  getPortScore(mappingId, port) {
    return this.portScores.get(this._portKey(mappingId, port)) ?? 100;
  }

  boostPort(mappingId, port) {
    this.portScores.set(this._portKey(mappingId, port), 100);
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

  // TCP-probe a port in the background until it responds, then set score to 50
  // so the next real request gives it a try.
  startBackgroundCheck(mapping, port) {
    const key = this._portKey(mapping.id, port);
    if (this.bgChecks.has(key)) return;
    this.bgChecks.add(key);

    const backend = mapping.backend || 'http://localhost';
    const backendUrl = new URL(backend.startsWith('http') ? backend : `http://${backend}`);
    const host = backendUrl.hostname;

    const probe = () => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.connect(port, host, () => {
        sock.destroy();
        this.bgChecks.delete(key);
        this.portScores.set(key, 50);
        this.logger.info(`HA: port ${port} back up (score→50) for mapping ${mapping.id}`);
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
    this.logger.warn(`HA: port ${port} scored 0, background probe started`);
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

  // Core single-backend request. Used by both the HA path and the plugin path.
  _tryPort(mapping, port, uri, method, reqHeaders, body) {
    return new Promise((resolve, reject) => {
      const backend = mapping.backend || 'http://localhost';
      const backendUrl = new URL(backend.startsWith('http') ? backend : `http://${backend}`);
      const isHttpsBackend = backendUrl.protocol === 'https:';
      const lib = isHttpsBackend ? https : http;

      const targetPath = (!mapping.front_uri && !mapping.back_uri)
        ? uri
        : this.buildTargetPath(mapping, uri);

      const headers = Object.assign({}, reqHeaders);
      headers['host'] = `${backendUrl.hostname}:${port}`;
      if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = headers['host'];
      if (body && body.length > 0) headers['content-length'] = body.length;
      else delete headers['content-length'];

      const proxyReq = lib.request({
        hostname: backendUrl.hostname,
        port,
        path: targetPath,
        method,
        headers,
        timeout: 10000,
      }, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => resolve({
          port,
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks),
        }));
        proxyRes.on('error', reject);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        const err = new Error('Connection timeout');
        err.code = 'ETIMEOUT';
        reject(err);
      });
      proxyReq.on('error', reject);

      if (body && body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
  }

  // Single-port backend request for the plugin path. Returns a result object or
  // a synthetic 502 on error.
  async _requestSingle(mapping, uri, method, headers, body) {
    try {
      return await this._tryPort(mapping, parseInt(mapping.back_port, 10), uri, method, headers, body);
    } catch (err) {
      this.logger.error('_requestSingle failed:', err);
      return { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Bad Gateway') };
    }
  }

  // Multi-port HA request. Tries ports best-score-first; short-circuits on the
  // first port that actually responds (any status code). Connection-level
  // failures (no response at all) penalize the port and move to the next one.
  async _requestHA(mapping, uri, method, headers, body) {
    const ports = String(mapping.back_port)
      .split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(p => !isNaN(p));

    const ordered = this.rankedPorts(mapping.id, ports);

    for (const port of ordered) {
      try {
        const result = await this._tryPort(mapping, port, uri, method, headers, body);
        // Port responded — boost its score and return immediately
        this.boostPort(mapping.id, port);
        return result;
      } catch (err) {
        // Connection-level failure: penalize and probe in background
        this.penalizePort(mapping.id, port);
        this.startBackgroundCheck(mapping, port);
      }
    }

    return { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Bad Gateway: all backends unavailable') };
  }

  // Full request/response pipeline used when ≥1 plugin expressed interest.
  async _handleWithPlugins(requestId, domain, inPort, mapping, req, res) {
    // Buffer request body (needed for before() payload and for re-sending to backend)
    const requestBody = await this.bufferBody(req);

    // ── before() ────────────────────────────────────────────────────────────
    const beforeResult = await this.pluginManager.runBefore(
      requestId, domain, inPort, req.url, req.method, req.headers, requestBody
    );

    if (beforeResult.type === 'CANCEL') {
      res.writeHead(beforeResult.statusCode, { 'content-type': 'text/plain' });
      return res.end();
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
      if (beforeResult.payload != null) body    = Buffer.from(beforeResult.payload, 'base64');
    }

    // ── backend request ──────────────────────────────────────────────────────
    const backendResult = String(mapping.back_port).includes(',')
      ? await this._requestHA(mapping, uri, method, headers, body)
      : await this._requestSingle(mapping, uri, method, headers, body);

    // ── after() ──────────────────────────────────────────────────────────────
    // Skipped when before() returned IGNORE (cleanup already done)
    if (skipAfter) {
      return this.sendHAResponse(res, backendResult);
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
        ? Buffer.from(afterResult.payload, 'base64')
        : backendResult.body;
      res.writeHead(status, hdrs);
      return res.end(resBody);
    }

    // CONTINUE — send the backend response as-is
    this.sendHAResponse(res, backendResult);
  }

  sendHAResponse(res, result) {
    const skip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'trailer']);
    const headers = {};
    for (const [k, v] of Object.entries(result.headers)) {
      if (!skip.has(k.toLowerCase())) headers[k] = v;
    }
    res.writeHead(result.statusCode, headers);
    res.end(result.body);
  }

  async haRequest(mapping, req, res) {
    const ports = String(mapping.back_port)
      .split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(p => !isNaN(p));

    // SSE (and other streaming) can't be buffered for failover — stream directly
    // via http-proxy using one round-robin selected port.
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      const port = this.rankedPorts(mapping.id, ports)[0];
      const backend = mapping.backend || 'http://localhost';
      this.proxy.web(req, res, { target: `${backend}:${port}`, secure: false, changeOrigin: true });
      return;
    }

    const body = await this.bufferBody(req);
    const result = await this._requestHA(mapping, req.url, req.method, req.headers, body);
    this.sendHAResponse(res, result);
  }

  // ── IP allowlist helpers ───────────────────────────────────────────────────

  getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const addr = req.socket && req.socket.remoteAddress;
    // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 -> 1.2.3.4)
    if (addr && addr.startsWith('::ffff:')) return addr.slice(7);
    return addr;
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
    await this.db.close();
  }
}

module.exports = ProxyServer;
