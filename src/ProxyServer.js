const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const DatabaseManager = require('./DatabaseManager');
const CertificateManager = require('./CertificateManager');
const { URL } = require('url');

class ProxyServer {
  constructor(logger) {
    this.logger = logger;
    this.db = new DatabaseManager(logger);
    this.certManager = new CertificateManager(logger, this.db);
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
    await this.certManager.initialize();
  }

  async start() {
    // Configure ports based on environment
    const isProduction = process.env.NODE_ENV === 'production';
    const httpPort = process.env.HTTP_PORT || (isProduction ? 80 : 8080);
    const httpsPort = process.env.HTTPS_PORT || (isProduction ? 443 : 8443);
    const enableHttps = process.env.ENABLE_HTTPS !== 'false' && (isProduction || process.env.ENABLE_HTTPS === 'true');

    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res, false);
    });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleWebSocket(req, socket, head, false);
    });

    await new Promise((resolve) => {
      this.httpServer.listen(httpPort, () => {
        this.logger.info(`HTTP server listening on port ${httpPort}`);
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
          this.httpsServer.listen(httpsPort, () => {
            this.logger.info(`HTTPS server listening on port ${httpsPort}`);
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

      // Only generate certificates for domains in our database
      if (isHttps) {
        await this.certManager.ensureCertificate(domain, true); // true = domain is validated
      }

      // For simple port forwarding (no URI mapping), just proxy directly
      if (!mapping.front_uri && !mapping.back_uri) {
        const target = `http://localhost:${mapping.back_port}`;
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

      // Only generate certificates for domains in our database
      if (isHttps) {
        await this.certManager.ensureCertificate(domain, true); // true = domain is validated
      }

      // For simple port forwarding (no URI mapping), just proxy directly
      if (!mapping.front_uri && !mapping.back_uri) {
        const target = `http://localhost:${mapping.back_port}`;
        this.proxy.ws(req, socket, head, {
          target: target,
          secure: false,
          changeOrigin: true
        });
      } else {
        // Complex URI mapping
        const targetUrl = this.buildTargetUrl(mapping, req.url);
        this.proxy.ws(req, socket, head, {
          target: targetUrl,
          secure: false,
          changeOrigin: true
        });
      }

    } catch (error) {
      this.logger.error('WebSocket handling error:', error);
      socket.destroy();
    }
  }

  buildTargetUrl(mapping, requestUrl) {
    let targetPath = requestUrl;
    
    // Only modify path if we have actual URI mappings
    if (mapping.front_uri && mapping.front_uri !== '') {
      // Create pattern to match front_uri at the beginning of the path
      const frontUri = mapping.front_uri.startsWith('/') ? mapping.front_uri : `/${mapping.front_uri}`;
      
      if (mapping.back_uri && mapping.back_uri !== '') {
        const backUri = mapping.back_uri.startsWith('/') ? mapping.back_uri : `/${mapping.back_uri}`;
        
        if (requestUrl.startsWith(frontUri)) {
          // Replace front_uri with back_uri
          targetPath = requestUrl.replace(frontUri, backUri);
        } else if (requestUrl.startsWith(frontUri.substring(1))) {
          // Handle case where front_uri has leading slash but requestUrl doesn't
          targetPath = requestUrl.replace(frontUri.substring(1), backUri);
        }
      } else {
        // Remove front_uri from path (back_uri is empty)
        if (requestUrl.startsWith(frontUri)) {
          targetPath = requestUrl.substring(frontUri.length) || '/';
        }
      }
    } else if (mapping.back_uri && mapping.back_uri !== '') {
      // If no front_uri but there's a back_uri, prepend it
      const backUri = mapping.back_uri.startsWith('/') ? mapping.back_uri : `/${mapping.back_uri}`;
      targetPath = `${backUri}${requestUrl}`;
    }
    // If both front_uri and back_uri are empty, don't modify the path at all
    
    // Clean up multiple slashes and ensure it starts with /
    targetPath = targetPath.replace(/\/+/g, '/');
    if (!targetPath.startsWith('/')) {
      targetPath = '/' + targetPath;
    }
    
    return `http://localhost:${mapping.back_port}${targetPath}`;
  }

  async stop() {
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
    }
    if (this.httpsServer) {
      await new Promise((resolve) => this.httpsServer.close(resolve));
    }
    await this.db.close();
  }
}

module.exports = ProxyServer;