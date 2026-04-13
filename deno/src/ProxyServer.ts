/**
 * ProxyServer — Deno edition.
 *
 * Identical to src/ProxyServer.js in the Node.js version; the only
 * difference is ES-module import syntax in place of require().
 * All npm packages (http-proxy) are consumed through Deno's npm compat layer.
 */

// deno-lint-ignore-file no-explicit-any

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
// @ts-ignore — no bundled Deno types for http-proxy; types come from @types/http-proxy via npm
import httpProxy from "npm:http-proxy@1";
import DatabaseManager from "./DatabaseManager.ts";
import CertificateManager from "./CertificateManager.ts";

interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export default class ProxyServer {
  logger: Logger;
  db: DatabaseManager;
  certManager: CertificateManager;

  // HA state
  deadPorts: Map<string, number>;
  rrCounters: Map<string, number>;
  readonly DEAD_PORT_TTL = 30_000;

  proxy: any;
  httpServer: http.Server | null;
  httpsServer: net.Server | null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.db = new DatabaseManager(logger);
    this.certManager = new CertificateManager(logger, this.db);

    this.deadPorts = new Map();
    this.rrCounters = new Map();

    this.proxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      timeout: 30_000,
      proxyTimeout: 30_000,
      xfwd: true,
    });

    this.httpServer = null;
    this.httpsServer = null;
    this.setupProxyErrorHandling();
  }

  setupProxyErrorHandling() {
    this.proxy.on("proxyReq", (proxyReq: any, req: any, _res: any, _options: any) => {
      const originalHost = req.headers.host;
      if (originalHost) {
        proxyReq.setHeader("X-Forwarded-Host", originalHost);
        proxyReq.setHeader("Host", originalHost);
      }
      const protocol =
        req.connection?.encrypted || req.headers["x-forwarded-proto"] === "https"
          ? "https"
          : "http";
      proxyReq.setHeader("X-Forwarded-Proto", protocol);
    });

    this.proxy.on("proxyRes", (proxyRes: any, req: any, _res: any) => {
      if (req.method === "GET" && Deno.env.get("CACHE_HEADERS") === "true") {
        const expiry = Deno.env.get("CACHE_EXPIRY");
        const infinite = !expiry || expiry === "-1";
        proxyRes.headers["cache-control"] = infinite
          ? "public, max-age=31536000, immutable"
          : `public, max-age=${parseInt(expiry!, 10) * 60}`;
        if (infinite) proxyRes.headers["expires"] = "Thu, 31 Dec 2099 23:59:59 GMT";
      }
    });

    this.proxy.on("error", (err: Error, _req: any, res: any) => {
      this.logger.error("Proxy error:", err);
      if (res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });

    this.proxy.on("proxyReqError", (err: Error, _req: any, res: any) => {
      this.logger.error("Proxy request error:", err);
      if (res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });
  }

  async initialize() {
    await this.db.initialize();
    await this.certManager.initialize();
  }

  async start() {
    const isProduction = Deno.env.get("NODE_ENV") === "production";
    const httpPort = parseInt(Deno.env.get("HTTP_PORT") ?? (isProduction ? "80" : "8080"), 10);
    const httpsPort = parseInt(Deno.env.get("HTTPS_PORT") ?? (isProduction ? "443" : "8443"), 10);
    const httpHost = Deno.env.get("HTTP_HOST") ?? "0.0.0.0";
    const enableHttps =
      Deno.env.get("ENABLE_HTTPS") !== "false" &&
      (isProduction || Deno.env.get("ENABLE_HTTPS") === "true");

    this.httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res, false);
    });
    this.httpServer.on("upgrade", (req, socket, head) => {
      this.handleWebSocket(req, socket, head, false);
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(httpPort, httpHost, () => {
        this.logger.info(`HTTP server listening on ${httpHost}:${httpPort}`);
        resolve();
      });
    });

    if (enableHttps) {
      try {
        // Deno uses rustls (not OpenSSL), which requires the certificate to be
        // selected before the TLS handshake — there is no mid-handshake callback.
        // node:https SNICallback is silently ignored. Fix: use a raw TCP server,
        // peek at the TLS ClientHello to extract the SNI hostname, then wrap the
        // socket with the correct cert via node:tls.TLSSocket.

        // Inner HTTP server handles already-decrypted HTTPS traffic.
        const innerHttpsServer = http.createServer((req, res) => {
          this.handleRequest(req, res, true);
        });
        innerHttpsServer.on("upgrade", (req, socket, head) => {
          this.handleWebSocket(req, socket, head, true);
        });

        // Registry of per-cert internal TLS servers on localhost.
        // Key = domain name; each server uses the cert for that domain.
        // Avoids creating a new server per connection while still supporting
        // multiple certs (one per unique domain).
        const domainServers = new Map<string, { server: tls.Server; port: number }>();
        let nextInternalPort = 18_000;

        const getOrCreateInternalServer = async (
          domain: string,
          certificate: { cert: string; key: string },
        ): Promise<number> => {
          const existing = domainServers.get(domain);
          if (existing) return existing.port;

          const port = nextInternalPort++;
          const tlsServer = tls.createServer(
            { cert: certificate.cert, key: certificate.key },
            (tlsSock: tls.TLSSocket) => {
              tlsSock.on("error", () => {});
              innerHttpsServer.emit("connection", tlsSock);
            },
          );
          await new Promise<void>((resolve) => tlsServer.listen(port, "127.0.0.1", resolve));
          domainServers.set(domain, { server: tlsServer, port });
          this.logger.info(`HTTPS internal TLS server for ${domain} on :${port}`);
          return port;
        };

        const rawServer = net.createServer((clientSocket) => {
          clientSocket.once("data", (chunk: Buffer) => {
            const sni = extractSNI(chunk);

            (async () => {
              try {
                const domain = sni ?? "default";
                const isDomainValidated = sni
                  ? (await this.db.getMapping(sni, "/")) !== null
                  : false;
                const certificate = await this.certManager.ensureCertificate(
                  domain,
                  isDomainValidated,
                );
                const internalPort = await getOrCreateInternalServer(domain, certificate);

                // Proxy the raw TCP connection to the internal TLS server.
                // We forward the already-read ClientHello chunk first, then
                // pipe the rest of the stream bidirectionally.
                const proxyConn = net.connect(internalPort, "127.0.0.1");
                proxyConn.once("connect", () => {
                  proxyConn.write(chunk); // replay the ClientHello
                  clientSocket.pipe(proxyConn);
                  proxyConn.pipe(clientSocket);
                });
                proxyConn.on("error", () => clientSocket.destroy());
                clientSocket.on("error", () => proxyConn.destroy());
              } catch (err) {
                this.logger.error(`HTTPS setup error for ${sni ?? "unknown"}:`, err);
                clientSocket.destroy();
              }
            })();
          });
          clientSocket.on("error", () => {});
        });

        this.httpsServer = rawServer;

        await new Promise<void>((resolve) => {
          rawServer.listen(httpsPort, httpHost, () => {
            this.logger.info(`HTTPS server listening on ${httpHost}:${httpsPort}`);
            resolve();
          });
        });
      } catch (error: any) {
        this.logger.warn("HTTPS server could not be started:", error.message ?? error);
        this.logger.info("To enable HTTPS in development, set ENABLE_HTTPS=true");
      }
    } else {
      this.logger.info(
        `HTTPS disabled (set ENABLE_HTTPS=true to enable in ${
          isProduction ? "production" : "development"
        })`,
      );
    }
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, isHttps: boolean) {
    try {
      // Health check
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      // ACME reachability test
      if (req.url?.startsWith("/.well-known/test-challenge/")) {
        const token = req.url.split("/").pop()!;
        const value = this.certManager.getTestChallenge(token);
        if (value) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(value);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
        return;
      }

      // ACME challenge
      if (req.url?.startsWith("/.well-known/acme-challenge/")) {
        const token = req.url.split("/").pop()!;
        const challenge = await this.certManager.getChallenge(token);
        if (challenge) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(challenge);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Challenge not found");
        }
        return;
      }

      // FORCE_HTTPS redirect
      const isSecure =
        isHttps ||
        (req.connection as any)?.encrypted ||
        req.headers["x-forwarded-proto"] === "https" ||
        req.headers["x-forwarded-ssl"] === "on" ||
        req.headers["front-end-https"] === "on";
      if (!isSecure && Deno.env.get("FORCE_HTTPS") === "true") {
        const host = req.headers.host;
        const httpsPortNum = Deno.env.get("HTTPS_PORT") ??
          (Deno.env.get("NODE_ENV") === "production" ? "443" : "8443");
        const hostWithoutPort = host ? host.split(":")[0] : "";
        const portSuffix =
          httpsPortNum === "443" ? "" : `:${httpsPortNum}`;
        res.writeHead(301, { Location: `https://${hostWithoutPort}${portSuffix}${req.url}` });
        res.end();
        return;
      }

      const host = req.headers.host;
      if (!host) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: Missing Host header");
        return;
      }

      const domain = host.split(":")[0];
      const mapping = await this.db.getMapping(domain, req.url!);
      if (!mapping) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips as string)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      // Cert fetch + webhook in parallel
      const certPromise = isHttps
        ? this.certManager.ensureCertificate(
            mapping.domain && (mapping.domain as string).startsWith("*.") ? mapping.domain as string : domain,
            true,
          )
        : Promise.resolve();
      const webhookPromise = this.callWebhook(mapping, req);

      const [, webhookDecision] = await Promise.all([certPromise, webhookPromise]);

      if (webhookDecision) {
        if (
          webhookDecision.statusCode >= 300 &&
          webhookDecision.statusCode < 400 &&
          webhookDecision.location
        ) {
          res.writeHead(webhookDecision.statusCode, { Location: webhookDecision.location });
          res.end();
          return;
        }
        if (webhookDecision.statusCode !== 200) {
          const headers = Object.assign({ "Content-Type": "text/plain" }, webhookDecision.headers ?? {});
          res.writeHead(webhookDecision.statusCode, headers);
          res.end(webhookDecision.body ?? "");
          return;
        }
      }

      // HA round-robin
      if (String(mapping.back_port).includes(",")) {
        await this.haRequest(mapping, req, res);
        return;
      }

      if (!mapping.front_uri && !mapping.back_uri) {
        const backend = (mapping.backend as string) || "http://localhost";
        this.proxy.web(req, res, {
          target: `${backend}:${mapping.back_port}`,
          secure: false,
          changeOrigin: true,
        });
      } else {
        this.proxy.web(req, res, {
          target: this.buildTargetUrl(mapping, req.url!),
          secure: false,
          changeOrigin: true,
        });
      }
    } catch (error) {
      this.logger.error("Request handling error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  }

  async handleWebSocket(
    req: http.IncomingMessage,
    socket: any,
    head: Buffer,
    isHttps: boolean,
  ) {
    try {
      const host = req.headers.host;
      if (!host) { socket.destroy(); return; }

      const domain = host.split(":")[0];
      const mapping = await this.db.getMapping(domain, req.url!);
      if (!mapping) { socket.destroy(); return; }

      if (!this.isIpAllowed(this.getClientIp(req), mapping.allowed_ips as string)) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden",
        );
        socket.destroy();
        return;
      }

      if (isHttps) {
        const certDomain =
          (mapping.domain as string).startsWith("*.") ? mapping.domain as string : domain;
        await this.certManager.ensureCertificate(certDomain, true);
      }

      if (mapping.front_uri || mapping.back_uri) {
        req.url = this.buildTargetPath(mapping, req.url!);
      }

      const backend = (mapping.backend as string) || "http://localhost";
      this.proxy.ws(req, socket, head, {
        target: `${backend}:${mapping.back_port}`,
        secure: false,
        changeOrigin: true,
      });
    } catch (error) {
      this.logger.error("WebSocket handling error:", error);
      socket.destroy();
    }
  }

  // ── URI rewriting ──────────────────────────────────────────────────────────

  buildTargetPath(mapping: any, requestUrl: string): string {
    let targetPath = requestUrl;
    if (mapping.front_uri && mapping.front_uri !== "") {
      const frontUri = mapping.front_uri.startsWith("/")
        ? mapping.front_uri
        : `/${mapping.front_uri}`;
      if (mapping.back_uri && mapping.back_uri !== "") {
        const backUri = mapping.back_uri.startsWith("/")
          ? mapping.back_uri
          : `/${mapping.back_uri}`;
        if (requestUrl.startsWith(frontUri)) {
          targetPath = requestUrl.replace(frontUri, backUri);
        } else if (requestUrl.startsWith(frontUri.substring(1))) {
          targetPath = requestUrl.replace(frontUri.substring(1), backUri);
        }
      } else {
        if (requestUrl.startsWith(frontUri)) {
          targetPath = requestUrl.substring(frontUri.length) || "/";
        }
      }
    } else if (mapping.back_uri && mapping.back_uri !== "") {
      const backUri = mapping.back_uri.startsWith("/")
        ? mapping.back_uri
        : `/${mapping.back_uri}`;
      targetPath = `${backUri}${requestUrl}`;
    }
    targetPath = targetPath.replace(/\/+/g, "/");
    if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;
    return targetPath;
  }

  buildTargetUrl(mapping: any, requestUrl: string): string {
    const targetPath = this.buildTargetPath(mapping, requestUrl);
    const backend = (mapping.backend as string) || "http://localhost";
    return `${backend}:${mapping.back_port}${targetPath}`;
  }

  // ── HA helpers ─────────────────────────────────────────────────────────────

  isPortDead(mappingId: string, port: number): boolean {
    const key = `${mappingId}:${port}`;
    const deadAt = this.deadPorts.get(key);
    if (!deadAt) return false;
    if (Date.now() - deadAt > this.DEAD_PORT_TTL) {
      this.deadPorts.delete(key);
      return false;
    }
    return true;
  }

  markPortDead(mappingId: string, port: number) {
    this.logger.warn(`HA: marking port ${port} dead for mapping ${mappingId}`);
    this.deadPorts.set(`${mappingId}:${port}`, Date.now());
  }

  nextRRIndex(mappingId: string, count: number): number {
    const i = (this.rrCounters.get(mappingId) ?? 0) % count;
    this.rrCounters.set(mappingId, i + 1);
    return i;
  }

  bufferBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  tryPort(mapping: any, port: number, req: http.IncomingMessage, body: Buffer): Promise<any> {
    return new Promise((resolve, reject) => {
      const backend = (mapping.backend as string) || "http://localhost";
      const backendUrl = new URL(backend.startsWith("http") ? backend : `http://${backend}`);
      const isHttpsBackend = backendUrl.protocol === "https:";
      const lib = isHttpsBackend ? https : http;

      const targetPath =
        !mapping.front_uri && !mapping.back_uri
          ? req.url!
          : this.buildTargetPath(mapping, req.url!);

      const headers: Record<string, string | string[]> = Object.assign({}, req.headers as any);
      headers["host"] = `${backendUrl.hostname}:${port}`;
      headers["x-forwarded-host"] = req.headers.host ?? "";
      headers["x-forwarded-proto"] = (req.connection as any)?.encrypted ? "https" : "http";
      if (body.length > 0) headers["content-length"] = String(body.length);
      else delete headers["content-length"];

      const proxyReq = (lib as typeof http).request(
        {
          hostname: backendUrl.hostname,
          port,
          path: targetPath,
          method: req.method,
          headers,
          timeout: 10_000,
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk) => chunks.push(chunk));
          proxyRes.on("end", () =>
            resolve({
              port,
              statusCode: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: Buffer.concat(chunks),
            })
          );
          proxyRes.on("error", reject);
        },
      );

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        const err: any = new Error("Connection timeout");
        err.code = "ETIMEOUT";
        reject(err);
      });
      proxyReq.on("error", reject);
      if (body.length > 0) proxyReq.write(body);
      proxyReq.end();
    });
  }

  sendHAResponse(res: http.ServerResponse, result: any) {
    const skip = new Set(["transfer-encoding", "connection", "keep-alive", "upgrade", "trailer"]);
    const headers: Record<string, any> = {};
    for (const [k, v] of Object.entries(result.headers)) {
      if (!skip.has(k.toLowerCase())) headers[k] = v;
    }
    res.writeHead(result.statusCode, headers);
    res.end(result.body);
  }

  async haRequest(mapping: any, req: http.IncomingMessage, res: http.ServerResponse) {
    const ports = String(mapping.back_port)
      .split(",")
      .map((p: string) => parseInt(p.trim(), 10))
      .filter((p: number) => !isNaN(p));

    // SSE — stream directly, no buffering
    if (req.headers.accept?.includes("text/event-stream")) {
      const alive = ports.filter((p: number) => !this.isPortDead(mapping.id, p));
      const pool = alive.length > 0 ? alive : ports;
      const port = pool[this.nextRRIndex(mapping.id, pool.length)];
      const backend = (mapping.backend as string) || "http://localhost";
      this.proxy.web(req, res, {
        target: `${backend}:${port}`,
        secure: false,
        changeOrigin: true,
      });
      return;
    }

    const body = await this.bufferBody(req);
    let alive = ports.filter((p: number) => !this.isPortDead(mapping.id, p));
    if (alive.length === 0) alive = [...ports];

    const start = this.nextRRIndex(mapping.id, alive.length);
    const ordered = [...alive.slice(start), ...alive.slice(0, start)];
    const results: any[] = [];

    for (const port of ordered) {
      try {
        const result = await this.tryPort(mapping, port, req, body);
        results.push(result);
        if (result.statusCode >= 200 && result.statusCode < 300) {
          this.sendHAResponse(res, result);
          return;
        }
      } catch (err: any) {
        if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
          this.markPortDead(mapping.id, port);
        }
      }
    }

    if (results.length === 0) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway: all backends unavailable");
      return;
    }

    results.sort(
      (a, b) => Math.floor(a.statusCode / 100) - Math.floor(b.statusCode / 100),
    );
    this.sendHAResponse(res, results[0]);
  }

  // ── Webhook interceptor ────────────────────────────────────────────────────

  async callWebhook(mapping: any, req: http.IncomingMessage): Promise<any> {
    const webhookUrl = Deno.env.get("WEBHOOK_URL");
    if (!webhookUrl) return null;

    const timeoutMs = parseInt(Deno.env.get("WEBHOOK_TIMEOUT") ?? "5000", 10);

    const ports = String(mapping.back_port)
      .split(",")
      .map((p: string) => p.trim())
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      "User-Agent": "jsproxy-webhook/1.0",
    };

    const secret = Deno.env.get("WEBHOOK_SECRET");
    if (secret) {
      const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      headers["X-Webhook-Signature"] = `sha256=${sig}`;
    }

    try {
      const parsed = new URL(webhookUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      const result = await new Promise<any>((resolve, reject) => {
        const reqOptions = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
          timeout: timeoutMs,
        };

        const whReq = (lib as typeof http).request(reqOptions, (whRes) => {
          const chunks: Buffer[] = [];
          whRes.on("data", (chunk) => chunks.push(chunk));
          whRes.on("end", () =>
            resolve({
              statusCode: whRes.statusCode!,
              headers: whRes.headers,
              body: Buffer.concat(chunks).toString(),
            })
          );
          whRes.on("error", reject);
        });

        whReq.on("timeout", () => {
          whReq.destroy();
          reject(new Error("Webhook timeout"));
        });
        whReq.on("error", reject);
        whReq.write(payload);
        whReq.end();
      });

      const { statusCode, headers: resHeaders, body } = result;
      this.logger.info(`Webhook response: ${statusCode} for ${req.method} ${req.url}`);

      if (statusCode >= 300 && statusCode < 400) {
        const location = resHeaders["location"] ?? resHeaders["Location"];
        return { statusCode, location };
      }

      if (statusCode !== 200) {
        const hop = new Set(["transfer-encoding", "connection", "keep-alive"]);
        const passHeaders: Record<string, any> = {};
        for (const [k, v] of Object.entries(resHeaders)) {
          if (!hop.has(k.toLowerCase())) passHeaders[k] = v;
        }
        return { statusCode, headers: passHeaders, body };
      }

      return { statusCode: 200 };
    } catch (err: any) {
      this.logger.error("Webhook call failed (proceeding with proxy):", err.message);
      return null;
    }
  }

  // ── IP allowlist ───────────────────────────────────────────────────────────

  getClientIp(req: http.IncomingMessage): string {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    const addr = (req.socket as any)?.remoteAddress ?? "";
    return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  }

  isIpAllowed(clientIp: string, allowedIps: string | null | undefined): boolean {
    if (!allowedIps || allowedIps.trim() === "") return true;
    const entries = allowedIps.split(",").map((s) => s.trim()).filter(Boolean);
    return entries.some((entry) => {
      if (entry.includes("/")) return this._ipInCidr(clientIp, entry);
      return clientIp === entry;
    });
  }

  _ipInCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bits] = cidr.split("/");
      const mask = bits ? (~0 << (32 - parseInt(bits, 10))) >>> 0 : 0xffffffff;
      return (this._ipToInt(ip) & mask) === (this._ipToInt(range) & mask);
    } catch {
      return false;
    }
  }

  _ipToInt(ip: string): number {
    return (
      ip.split(".").reduce((acc, octet) => acc * 256 + parseInt(octet, 10), 0) >>> 0
    );
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────

  async stop() {
    if (this.httpServer) {
      this.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
    if (this.httpsServer) {
      this.httpsServer.closeAllConnections?.();
      await new Promise<void>((resolve) => this.httpsServer!.close(() => resolve()));
    }
    await this.db.close();
  }
}

/**
 * Parse a TLS ClientHello record and extract the SNI hostname.
 * Returns null if the buffer is too short, malformed, or contains no SNI.
 */
function extractSNI(buf: Buffer): string | null {
  try {
    // TLS record header: content-type (1) + version (2) + length (2) = 5 bytes
    if (buf.length < 5 || buf[0] !== 0x16 /* handshake */) return null;
    let pos = 5;

    // Handshake header: type (1) + length (3)
    if (buf[pos] !== 0x01 /* ClientHello */) return null;
    pos += 4;

    // ClientVersion (2)
    pos += 2;
    // Random (32)
    pos += 32;

    // Session ID
    if (pos >= buf.length) return null;
    const sessionIdLen = buf[pos]; pos += 1 + sessionIdLen;

    // Cipher Suites
    if (pos + 2 > buf.length) return null;
    const cipherSuitesLen = buf.readUInt16BE(pos); pos += 2 + cipherSuitesLen;

    // Compression Methods
    if (pos >= buf.length) return null;
    const compressionLen = buf[pos]; pos += 1 + compressionLen;

    // Extensions
    if (pos + 2 > buf.length) return null;
    const extensionsLen = buf.readUInt16BE(pos); pos += 2;
    const extensionsEnd = pos + extensionsLen;

    while (pos + 4 <= extensionsEnd && pos + 4 <= buf.length) {
      const extType = buf.readUInt16BE(pos);
      const extLen = buf.readUInt16BE(pos + 2);
      pos += 4;

      if (extType === 0x0000 /* server_name */) {
        // SNI extension: list length (2) + entry type (1) + name length (2) + name
        if (pos + 5 > buf.length) return null;
        const nameType = buf[pos + 2];
        if (nameType === 0 /* host_name */) {
          const nameLen = buf.readUInt16BE(pos + 3);
          if (pos + 5 + nameLen > buf.length) return null;
          return buf.slice(pos + 5, pos + 5 + nameLen).toString("utf8");
        }
        return null;
      }

      pos += extLen;
    }
    return null;
  } catch {
    return null;
  }
}
