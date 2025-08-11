const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const ProxyServer = require('../src/ProxyServer');
const path = require('path');
const fs = require('fs').promises;

describe('WebSocket Proxy - Production Ready Tests', () => {
  let proxyServer;
  let httpBackend;
  let httpsBackend;
  let httpWsServer;
  let httpsWsServer;
  let logger;
  let testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'ws-final-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = {
      info: jest.fn(),
      error: jest.fn(), 
      warn: jest.fn()
    };

    // HTTP WebSocket Backend (port 3020)
    httpBackend = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('HTTP Backend OK');
    });

    httpWsServer = new WebSocket.Server({ server: httpBackend });
    httpWsServer.on('connection', (ws, req) => {
      const info = {
        type: 'connection_info',
        backend: 'http',
        path: req.url,
        headers: req.headers,
        timestamp: Date.now()
      };
      ws.send(JSON.stringify(info));

      ws.on('message', (message) => {
        const data = JSON.parse(message.toString());
        ws.send(JSON.stringify({
          type: 'echo',
          backend: 'http',
          original: data,
          processed_at: Date.now()
        }));
      });
    });

    await new Promise(resolve => httpBackend.listen(3020, resolve));

    // Setup proxy server
    proxyServer = new ProxyServer(logger);
    proxyServer.db.dbPath = path.join(testDataDir, 'test.db');
    proxyServer.certManager.certsDir = path.join(testDataDir, 'certs');
    
    process.env.HTTP_PORT = '9100';
    process.env.HTTPS_PORT = '9443';  
    process.env.ENABLE_HTTPS = 'false'; // Disable HTTPS for easier testing

    await proxyServer.initialize();

    // Add various routing mappings
    await proxyServer.db.addMapping('websocket.test.com', '', 3020, '');
    await proxyServer.db.addMapping('api.test.com', 'ws', 3020, '');
    await proxyServer.db.addMapping('chat.test.com', 'socket/v1', 3020, '');
    await proxyServer.db.addMapping('multi.test.com', 'app/chat', 3020, 'ws');

    await proxyServer.start();
  }, 20000);

  afterAll(async () => {
    if (httpWsServer) httpWsServer.close();
    if (httpBackend) await new Promise(r => httpBackend.close(r));
    if (httpsWsServer) httpsWsServer.close();
    if (httpsBackend) await new Promise(r => httpsBackend.close(r));
    if (proxyServer) await proxyServer.stop();

    // Cleanup
    try {
      const files = await fs.readdir(testDataDir);
      for (const file of files) {
        const filePath = path.join(testDataDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            const subFiles = await fs.readdir(filePath);
            for (const subFile of subFiles) {
              await fs.unlink(path.join(filePath, subFile));
            }
            await fs.rmdir(filePath);
          } else {
            await fs.unlink(filePath);
          }
        } catch (e) {}
      }
      await fs.rmdir(testDataDir);
    } catch (e) {}

    delete process.env.HTTP_PORT;
    delete process.env.HTTPS_PORT;
    delete process.env.ENABLE_HTTPS;
  });

  test('✅ Basic WebSocket Proxying (ws://)', (done) => {
    const ws = new WebSocket('ws://localhost:9100/', {
      headers: { 'Host': 'websocket.test.com' }
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'ping', message: 'Hello WebSocket!' }));
    });

    let connectionInfoReceived = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'connection_info') {
        connectionInfoReceived = true;
        expect(msg.backend).toBe('http');
        expect(msg.path).toBe('/');
      }
      
      if (msg.type === 'echo') {
        expect(msg.backend).toBe('http');
        expect(msg.original.type).toBe('ping');
        expect(msg.original.message).toBe('Hello WebSocket!');
        
        if (connectionInfoReceived) {
          ws.close();
          done();
        }
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Timeout')), 5000);
  });

  test('✅ WebSocket Domain Routing', (done) => {
    const ws = new WebSocket('ws://localhost:9100/ws', {
      headers: { 'Host': 'api.test.com' }
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_info') {
        expect(msg.backend).toBe('http');
        expect(msg.path).toBe('/'); // /ws maps to /
        ws.close();
        done();
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Timeout')), 5000);
  });

  test('✅ WebSocket URI Path Mapping', (done) => {
    const ws = new WebSocket('ws://localhost:9100/socket/v1', {
      headers: { 'Host': 'chat.test.com' }
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_info') {
        expect(msg.backend).toBe('http');
        expect(msg.path).toBe('/'); // /socket/v1 maps to /
        ws.close();
        done();
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Timeout')), 5000);
  });

  test('✅ Complex URI Mapping', (done) => {
    const ws = new WebSocket('ws://localhost:9100/app/chat/room/1', {
      headers: { 'Host': 'multi.test.com' }
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_info') {
        expect(msg.backend).toBe('http');
        expect(msg.path).toBe('/ws/room/1'); // /app/chat/room/1 -> /ws/room/1
        ws.close();
        done();
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Timeout')), 5000);
  });

  test('✅ Multiple Concurrent WebSocket Connections', (done) => {
    const numConnections = 10;
    let completedConnections = 0;
    const connectionIds = new Set();

    for (let i = 0; i < numConnections; i++) {
      const ws = new WebSocket('ws://localhost:9100/', {
        headers: { 'Host': 'websocket.test.com' }
      });

      ws.on('open', () => {
        ws.send(JSON.stringify({ 
          type: 'connection_test',
          connectionId: i,
          timestamp: Date.now()
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'echo') {
          connectionIds.add(msg.original.connectionId);
          ws.close();
          
          completedConnections++;
          if (completedConnections === numConnections) {
            expect(connectionIds.size).toBe(numConnections);
            done();
          }
        }
      });

      ws.on('error', (error) => {
        done(error);
      });
    }

    setTimeout(() => {
      done(new Error(`Only ${completedConnections}/${numConnections} connections completed`));
    }, 10000);
  });

  test('✅ WebSocket Headers and Protocols Preservation', (done) => {
    const ws = new WebSocket('ws://localhost:9100/', ['chat', 'echo'], {
      headers: {
        'Host': 'websocket.test.com',
        'X-Custom-Header': 'test-value',
        'User-Agent': 'WebSocket-Test-Client'
      }
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_info') {
        // Verify headers were passed through
        expect(msg.headers['x-custom-header']).toBe('test-value');
        expect(msg.headers['user-agent']).toContain('WebSocket-Test-Client');
        ws.close();
        done();
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Timeout')), 5000);
  });

  test('✅ WebSocket Connection Rejection for Unmapped Domains', (done) => {
    const ws = new WebSocket('ws://localhost:9100/', {
      headers: { 'Host': 'nonexistent.test.com' }
    });

    ws.on('error', (error) => {
      // Expected - should fail to connect
      done();
    });

    ws.on('open', () => {
      ws.close();
      done(new Error('Connection should have been rejected'));
    });

    setTimeout(() => done(), 3000);
  });

  test('✅ WebSocket Ping/Pong Keep-Alive', (done) => {
    const ws = new WebSocket('ws://localhost:9100/', {
      headers: { 'Host': 'websocket.test.com' }
    });

    ws.on('open', () => {
      // Send ping
      ws.ping('test-ping');
    });

    ws.on('pong', (data) => {
      expect(data.toString()).toBe('test-ping');
      ws.close();
      done();
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Ping/Pong timeout')), 5000);
  });

  test('✅ Large Message Handling', (done) => {
    const ws = new WebSocket('ws://localhost:9100/', {
      headers: { 'Host': 'websocket.test.com' }
    });

    const largeMessage = 'x'.repeat(64 * 1024); // 64KB message

    ws.on('open', () => {
      ws.send(JSON.stringify({ 
        type: 'large_message_test',
        data: largeMessage
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'echo' && msg.original.type === 'large_message_test') {
        expect(msg.original.data).toBe(largeMessage);
        expect(msg.original.data.length).toBe(64 * 1024);
        ws.close();
        done();
      }
    });

    ws.on('error', done);
    setTimeout(() => done(new Error('Large message timeout')), 10000);
  });
});

describe('HTTP Request Handling on Same Proxy', () => {
  test('✅ HTTP requests work alongside WebSocket on same proxy', (done) => {
    // Create HTTP request to same backend
    const req = http.request({
      hostname: 'localhost',
      port: 9100,
      path: '/',
      method: 'GET',
      headers: {
        'Host': 'websocket.test.com'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        expect(data).toBe('HTTP Backend OK');
        expect(res.statusCode).toBe(200);
        done();
      });
    });

    req.on('error', done);
    req.end();
  });
});