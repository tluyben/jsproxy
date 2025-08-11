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
    this.certManager = new CertificateManager(logger);
    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      timeout: 30000,
      proxyTimeout: 30000
    });
    
    this.httpServer = null;
    this.httpsServer = null;
    this.setupProxyErrorHandling();
  }

  setupProxyErrorHandling() {
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
        this.httpsServer = https.createServer(
          await this.certManager.getDefaultCertificate(),
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

        // Set up SNI callback
        const sniCallback = await this.certManager.getSNICallback();
        if (sniCallback) {
          this.httpsServer.addContext('*', sniCallback);
        }
      } catch (error) {
        this.logger.warn('HTTPS server could not be started:', error.message);
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

      if (isHttps) {
        await this.certManager.ensureCertificate(domain);
      }

      const targetUrl = this.buildTargetUrl(mapping, req.url);
      
      this.proxy.web(req, res, {
        target: targetUrl,
        secure: false
      });

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

      if (isHttps) {
        await this.certManager.ensureCertificate(domain);
      }

      const targetUrl = this.buildTargetUrl(mapping, req.url);
      
      this.proxy.ws(req, socket, head, {
        target: targetUrl,
        secure: false
      });

    } catch (error) {
      this.logger.error('WebSocket handling error:', error);
      socket.destroy();
    }
  }

  buildTargetUrl(mapping, requestUrl) {
    let targetPath = requestUrl;
    
    if (mapping.front_uri && mapping.front_uri !== '') {
      const frontUriPattern = new RegExp(`^/${mapping.front_uri.replace(/\//g, '\\/')}`);  
      targetPath = requestUrl.replace(frontUriPattern, `/${mapping.back_uri}`);
    } else if (mapping.back_uri && mapping.back_uri !== '') {
      targetPath = `/${mapping.back_uri}${requestUrl}`;
    }
    
    // Clean up double slashes
    targetPath = targetPath.replace(/\/+/g, '/');
    
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