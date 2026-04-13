/**
 * Tests for the webhook interceptor feature.
 *
 * When WEBHOOK_URL is set, the proxy fires a POST to that URL for every
 * request whose domain is found in the database, in parallel with any
 * certificate work. Depending on the webhook's HTTP response the proxy
 * either continues normally, redirects the client, or serves the webhook's
 * response body directly.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// ── helpers ──────────────────────────────────────────────────────────────────

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpGet(proxyPort, urlPath, host = 'example.com') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: urlPath,
        method: 'GET',
        headers: { Host: host },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── ports ─────────────────────────────────────────────────────────────────────
const PROXY_PORT   = 9700;
const WEBHOOK_PORT = 9701;
const BACKEND_PORT = 9702;

// ── shared mapping ────────────────────────────────────────────────────────────
const MAPPING = {
  id: 'test-mapping-id',
  domain: 'example.com',
  front_uri: '',
  back_port: String(BACKEND_PORT),
  back_uri: '',
  backend: null,
  allowed_ips: null,
};

// ── main suite ────────────────────────────────────────────────────────────────

describe('Webhook interceptor', () => {
  let proxy;
  let webhookServer;
  let backendServer;
  let testDataDir;

  // controls what the webhook server replies; set per-test
  let webhookHandler;
  // raw webhook calls received; reset per-test
  let webhookRequests;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'webhook-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    // Real backend that always returns 200
    backendServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('backend-ok');
    });
    await listenOn(backendServer, BACKEND_PORT);

    // Webhook server whose behaviour is driven by webhookHandler
    webhookServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        webhookRequests.push({ headers: req.headers, body: raw });
        if (webhookHandler) {
          webhookHandler(req, res, raw);
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });
    await listenOn(webhookServer, WEBHOOK_PORT);

    // Single proxy instance shared across all tests
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}/hook`;

    proxy = new ProxyServer(logger);

    // Wire up a real SQLite DB so the proxy actually starts
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    await proxy.initialize();

    // Seed a mapping for example.com
    await proxy.db.addMapping(
      MAPPING.domain,
      MAPPING.front_uri,
      MAPPING.back_port,
      MAPPING.back_uri,
      MAPPING.backend
    );

    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await closeServer(backendServer);
    await closeServer(webhookServer);
    delete process.env.WEBHOOK_URL;
    delete process.env.HTTP_PORT;
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    webhookRequests = [];
    webhookHandler = null;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_TIMEOUT;
  });

  // ── 1. webhook returns 200 → proxy as normal ─────────────────────────────────

  test('proxies normally when webhook returns 200', async () => {
    const res = await httpGet(PROXY_PORT, '/hello');
    expect(res.status).toBe(200);
    expect(res.body).toBe('backend-ok');
    expect(webhookRequests).toHaveLength(1);
  });

  // ── 2. webhook returns 403 → serve 403 to client ─────────────────────────────

  test('returns 403 to client when webhook returns 403', async () => {
    webhookHandler = (_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied');
    };

    const res = await httpGet(PROXY_PORT, '/secret');
    expect(res.status).toBe(403);
    expect(res.body).toBe('access denied');
  });

  // ── 3. webhook returns 429 → serve 429 to client ─────────────────────────────

  test('returns 429 to client when webhook returns 429', async () => {
    webhookHandler = (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('rate limited');
    };

    const res = await httpGet(PROXY_PORT, '/api');
    expect(res.status).toBe(429);
    expect(res.body).toBe('rate limited');
  });

  // ── 4. webhook returns 302 → redirect client ──────────────────────────────────

  test('redirects client when webhook returns 302', async () => {
    webhookHandler = (_req, res) => {
      res.writeHead(302, { Location: 'https://login.example.com/auth' });
      res.end();
    };

    const res = await httpGet(PROXY_PORT, '/protected');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://login.example.com/auth');
  });

  // ── 5. webhook returns 301 → redirect client ──────────────────────────────────

  test('redirects client when webhook returns 301', async () => {
    webhookHandler = (_req, res) => {
      res.writeHead(301, { Location: 'https://new.example.com/' });
      res.end();
    };

    const res = await httpGet(PROXY_PORT, '/old');
    expect(res.status).toBe(301);
    expect(res.headers['location']).toBe('https://new.example.com/');
  });

  // ── 6. webhook payload ────────────────────────────────────────────────────────

  test('sends correct payload to webhook', async () => {
    const res = await httpGet(PROXY_PORT, '/path?q=1');
    expect(res.status).toBe(200); // sanity

    expect(webhookRequests).toHaveLength(1);
    const payload = JSON.parse(webhookRequests[0].body);

    expect(payload.domain).toBe('example.com');
    expect(payload.url).toBe('/path?q=1');
    expect(payload.method).toBe('GET');
    expect(payload.ports).toEqual([String(BACKEND_PORT)]);
    expect(payload.headers).toBeDefined();
    expect(typeof payload.timestamp).toBe('string');
  });

  // ── 7. Content-Type header ────────────────────────────────────────────────────

  test('sends Content-Type: application/json to webhook', async () => {
    await httpGet(PROXY_PORT, '/');
    expect(webhookRequests[0].headers['content-type']).toBe('application/json');
  });

  // ── 8. HMAC signature ─────────────────────────────────────────────────────────

  test('sends X-Webhook-Signature when WEBHOOK_SECRET is set', async () => {
    process.env.WEBHOOK_SECRET = 'mysecret';

    await httpGet(PROXY_PORT, '/secure');

    const { headers, body } = webhookRequests[0];
    expect(headers['x-webhook-signature']).toMatch(/^sha256=/);

    const expected = 'sha256=' +
      crypto.createHmac('sha256', 'mysecret').update(body).digest('hex');
    expect(headers['x-webhook-signature']).toBe(expected);
  });

  // ── 9. no signature header when secret not set ────────────────────────────────

  test('does not send X-Webhook-Signature when WEBHOOK_SECRET is not set', async () => {
    await httpGet(PROXY_PORT, '/');
    expect(webhookRequests[0].headers['x-webhook-signature']).toBeUndefined();
  });

  // ── 10. fail-open on timeout ──────────────────────────────────────────────────

  test('proxies normally when webhook times out (fail-open)', async () => {
    process.env.WEBHOOK_TIMEOUT = '100';
    // Webhook never responds — deliberately leave connection open
    webhookHandler = () => {};

    const res = await httpGet(PROXY_PORT, '/hello');
    expect(res.status).toBe(200);
    expect(res.body).toBe('backend-ok');
  }, 10000);

  // ── 11. fail-open on connection refused ───────────────────────────────────────

  test('proxies normally when webhook URL is unreachable (fail-open)', async () => {
    // Temporarily point at a port with nothing listening
    const orig = process.env.WEBHOOK_URL;
    process.env.WEBHOOK_URL = 'http://127.0.0.1:19999/hook';

    const res = await httpGet(PROXY_PORT, '/hello');
    expect(res.status).toBe(200);
    expect(res.body).toBe('backend-ok');

    process.env.WEBHOOK_URL = orig;
  });

  // ── 12. callWebhook unit: returns null when WEBHOOK_URL not set ────────────────

  test('callWebhook returns null when WEBHOOK_URL is not set', async () => {
    const savedUrl = process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;

    const mockReq = { url: '/', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const result = await proxy.callWebhook(MAPPING, mockReq);
    expect(result).toBeNull();

    process.env.WEBHOOK_URL = savedUrl;
  });

  // ── 13. multi-port payload ────────────────────────────────────────────────────

  test('webhook payload includes all HA ports', async () => {
    const haMapping = { ...MAPPING, back_port: '9702,9703,9704', id: 'ha-id' };
    const mockReq = {
      url: '/', method: 'GET',
      headers: { host: 'example.com' },
      socket: { remoteAddress: '127.0.0.1' },
    };

    // Call callWebhook directly so we don't need all ports running
    const result = await proxy.callWebhook(haMapping, mockReq);

    expect(webhookRequests).toHaveLength(1);
    const payload = JSON.parse(webhookRequests[0].body);
    expect(payload.ports).toEqual(['9702', '9703', '9704']);
    expect(result).toEqual({ statusCode: 200 });
  });
});

// ── suite: WEBHOOK_URL not set ────────────────────────────────────────────────

describe('Webhook interceptor — disabled (no WEBHOOK_URL)', () => {
  let proxy;
  let backendServer;
  let testDataDir;
  const PROXY_PORT2   = 9710;
  const BACKEND_PORT2 = 9712;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'webhook-disabled-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    backendServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('backend-ok');
    });
    await listenOn(backendServer, BACKEND_PORT2);

    delete process.env.WEBHOOK_URL;
    process.env.HTTP_PORT = String(PROXY_PORT2);

    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    await proxy.initialize();
    await proxy.db.addMapping('example.com', '', String(BACKEND_PORT2), '', null);
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await closeServer(backendServer);
    delete process.env.HTTP_PORT;
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('proxies normally when WEBHOOK_URL is not set', async () => {
    const res = await httpGet(PROXY_PORT2, '/hello');
    expect(res.status).toBe(200);
    expect(res.body).toBe('backend-ok');
  });
});
