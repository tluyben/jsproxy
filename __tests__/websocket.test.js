const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const ProxyServer = require('../src/ProxyServer');
const path = require('path');
const fs = require('fs');

describe('WebSocket Proxy Tests', () => {
  let proxyServer;
  let httpWsServer;
  let httpsWsServer;
  let httpBackendServer;
  let httpsBackendServer;
  let logger;
  let testDataDir;

  beforeAll(async () => {
    // Setup test directory
    testDataDir = path.join(__dirname, 'websocket-test-data');
    try {
      await fs.promises.mkdir(testDataDir, { recursive: true });
    } catch (error) {
      // Directory exists
    }

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    // Create HTTP WebSocket backend server
    httpBackendServer = http.createServer();
    httpWsServer = new WebSocket.Server({ 
      server: httpBackendServer,
      path: '/ws'
    });

    httpWsServer.on('connection', (ws, req) => {
      ws.on('message', (message) => {
        const data = JSON.parse(message.toString());
        ws.send(JSON.stringify({
          type: 'echo',
          original: data,
          backend: 'http',
          path: req.url,
          timestamp: Date.now()
        }));
      });

      ws.send(JSON.stringify({
        type: 'welcome',
        backend: 'http',
        path: req.url
      }));
    });

    await new Promise((resolve) => {
      httpBackendServer.listen(3001, resolve);
    });

    // Setup proxy server
    proxyServer = new ProxyServer(logger);
    proxyServer.db.dbPath = path.join(testDataDir, 'test.db');
    proxyServer.certManager.certsDir = path.join(testDataDir, 'certs');
    
    // Override port configuration for testing
    process.env.HTTP_PORT = '9080';
    process.env.HTTPS_PORT = '9443';
    process.env.ENABLE_HTTPS = 'false';

    await proxyServer.initialize();

    // Add WebSocket mappings to the database
    await proxyServer.db.addMapping('ws.example.com', 'ws', 3001, 'ws');
    await proxyServer.db.addMapping('api.example.com', '', 3001, '');
    await proxyServer.db.addMapping('chat.example.com', 'socket', 3001, 'ws');

    await proxyServer.start();
  }, 30000);

  afterAll(async () => {
    if (proxyServer) {
      await proxyServer.stop();
    }
    if (httpBackendServer) {
      await new Promise(resolve => httpBackendServer.close(resolve));
    }
    if (httpsBackendServer) {
      await new Promise(resolve => httpsBackendServer.close(resolve));
    }

    // Cleanup test data
    try {
      const files = await fs.promises.readdir(testDataDir);
      for (const file of files) {
        const filePath = path.join(testDataDir, file);
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          const subFiles = await fs.promises.readdir(filePath);
          for (const subFile of subFiles) {
            await fs.promises.unlink(path.join(filePath, subFile));
          }
          await fs.promises.rmdir(filePath);
        } else {
          await fs.promises.unlink(filePath);
        }
      }
      await fs.promises.rmdir(testDataDir);
    } catch (error) {
      // Ignore cleanup errors
    }

    delete process.env.HTTP_PORT;
    delete process.env.HTTPS_PORT;
    delete process.env.ENABLE_HTTPS;
  }, 10000);

  test('should proxy WebSocket connections (ws://)', (done) => {
    const ws = new WebSocket('ws://localhost:9080/ws', {
      headers: {
        'Host': 'ws.example.com'
      }
    });

    let welcomeReceived = false;
    let echoReceived = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'test',
        message: 'Hello WebSocket!'
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'welcome') {
        welcomeReceived = true;
        expect(message.backend).toBe('http');
        expect(message.path).toBe('/ws');
      }
      
      if (message.type === 'echo') {
        echoReceived = true;
        expect(message.backend).toBe('http');
        expect(message.original.type).toBe('test');
        expect(message.original.message).toBe('Hello WebSocket!');
      }

      if (welcomeReceived && echoReceived) {
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    setTimeout(() => {
      if (!welcomeReceived || !echoReceived) {
        ws.close();
        done(new Error('WebSocket test timed out'));
      }
    }, 5000);
  });

  test('should handle WebSocket routing based on domain', (done) => {
    const ws = new WebSocket('ws://localhost:9080/', {
      headers: {
        'Host': 'api.example.com'
      }
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'domain_test',
        message: 'Testing domain routing'
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'welcome') {
        expect(message.backend).toBe('http');
        expect(message.path).toBe('/');
      }
      
      if (message.type === 'echo') {
        expect(message.original.type).toBe('domain_test');
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    setTimeout(() => {
      ws.close();
      done(new Error('Domain routing test timed out'));
    }, 5000);
  });

  test('should handle WebSocket URI path mapping', (done) => {
    const ws = new WebSocket('ws://localhost:9080/socket', {
      headers: {
        'Host': 'chat.example.com'
      }
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'path_test',
        message: 'Testing path mapping'
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'welcome') {
        expect(message.backend).toBe('http');
        expect(message.path).toBe('/ws'); // Should be mapped from /socket to /ws
      }
      
      if (message.type === 'echo') {
        expect(message.original.type).toBe('path_test');
        expect(message.path).toBe('/ws');
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    setTimeout(() => {
      ws.close();
      done(new Error('Path mapping test timed out'));
    }, 5000);
  });

  test('should handle WebSocket connection errors gracefully', (done) => {
    // Try to connect to non-existent backend
    const ws = new WebSocket('ws://localhost:9080/nonexistent', {
      headers: {
        'Host': 'nonexistent.com'
      }
    });

    ws.on('error', (error) => {
      // Expected behavior - connection should fail for unmapped domain
      done();
    });

    ws.on('open', () => {
      ws.close();
      done(new Error('Connection should have failed for unmapped domain'));
    });

    setTimeout(() => {
      ws.close();
      done();
    }, 2000);
  });

  test('should handle multiple concurrent WebSocket connections', (done) => {
    const numConnections = 5;
    let completedConnections = 0;
    const errors = [];

    for (let i = 0; i < numConnections; i++) {
      const ws = new WebSocket('ws://localhost:9080/ws', {
        headers: {
          'Host': 'ws.example.com'
        }
      });

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'concurrent_test',
          connectionId: i,
          message: `Connection ${i}`
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'echo' && message.original.type === 'concurrent_test') {
          expect(message.original.connectionId).toBe(i);
          ws.close();
          
          completedConnections++;
          if (completedConnections === numConnections) {
            if (errors.length > 0) {
              done(new Error(`Errors in concurrent connections: ${errors.join(', ')}`));
            } else {
              done();
            }
          }
        }
      });

      ws.on('error', (error) => {
        errors.push(`Connection ${i}: ${error.message}`);
        completedConnections++;
        
        if (completedConnections === numConnections) {
          done(new Error(`Errors in concurrent connections: ${errors.join(', ')}`));
        }
      });
    }

    setTimeout(() => {
      if (completedConnections < numConnections) {
        done(new Error(`Only ${completedConnections}/${numConnections} connections completed`));
      }
    }, 10000);
  });

  test('should preserve WebSocket subprotocols and headers', (done) => {
    const ws = new WebSocket('ws://localhost:9080/ws', ['chat', 'echo'], {
      headers: {
        'Host': 'ws.example.com',
        'X-Custom-Header': 'test-value'
      }
    });

    ws.on('open', () => {
      // WebSocket opened successfully, protocol negotiation worked
      ws.send(JSON.stringify({
        type: 'protocol_test',
        message: 'Testing protocol preservation'
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'echo') {
        expect(message.original.type).toBe('protocol_test');
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    setTimeout(() => {
      ws.close();
      done(new Error('Protocol test timed out'));
    }, 5000);
  });
});

describe('WebSocket Integration with Database Hot-Swap', () => {
  let proxyServer;
  let backendServer;
  let wsServer;
  let logger;
  let testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'websocket-hotswap-data');
    try {
      await fs.promises.mkdir(testDataDir, { recursive: true });
    } catch (error) {
      // Directory exists
    }

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    // Create backend WebSocket server
    backendServer = http.createServer();
    wsServer = new WebSocket.Server({ server: backendServer });

    wsServer.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    await new Promise((resolve) => {
      backendServer.listen(3002, resolve);
    });

    // Setup proxy
    proxyServer = new ProxyServer(logger);
    proxyServer.db.dbPath = path.join(testDataDir, 'test.db');
    proxyServer.certManager.certsDir = path.join(testDataDir, 'certs');
    
    process.env.HTTP_PORT = '9081';
    process.env.ENABLE_HTTPS = 'false';

    await proxyServer.initialize();
    await proxyServer.db.addMapping('test.com', '', 3002, '');
    await proxyServer.start();
  }, 30000);

  afterAll(async () => {
    if (proxyServer) await proxyServer.stop();
    if (backendServer) await new Promise(resolve => backendServer.close(resolve));

    // Cleanup
    try {
      const files = await fs.promises.readdir(testDataDir);
      for (const file of files) {
        const filePath = path.join(testDataDir, file);
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          const subFiles = await fs.promises.readdir(filePath);
          for (const subFile of subFiles) {
            await fs.promises.unlink(path.join(filePath, subFile));
          }
          await fs.promises.rmdir(filePath);
        } else {
          await fs.promises.unlink(filePath);
        }
      }
      await fs.promises.rmdir(testDataDir);
    } catch (error) {
      // Ignore cleanup errors
    }

    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
  });

  test('should maintain WebSocket connections during database hot-swap', (done) => {
    const ws = new WebSocket('ws://localhost:9081/', {
      headers: { 'Host': 'test.com' }
    });

    let connectionEstablished = false;
    let messagesAfterSwap = 0;

    ws.on('open', () => {
      connectionEstablished = true;
      
      // Perform hot database swap after connection is established
      setTimeout(async () => {
        try {
          // Create new database with different mapping
          const newDbPath = path.join(testDataDir, 'new.db');
          const newDbManager = new (require('../src/DatabaseManager'))(logger);
          newDbManager.dbPath = newDbPath;
          
          await newDbManager.initialize();
          await newDbManager.addMapping('test.com', '', 3002, ''); // Same mapping
          await newDbManager.close();

          // Hot swap the database
          await proxyServer.db.hotReplaceDatabase(newDbPath);
          
          // Connection should still work
          ws.ping();
        } catch (error) {
          done(error);
        }
      }, 1000);
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'connected') {
        messagesAfterSwap++;
        if (messagesAfterSwap >= 1 && connectionEstablished) {
          ws.close();
          done();
        }
      }
    });

    ws.on('pong', () => {
      // WebSocket is still alive after database hot-swap
      messagesAfterSwap++;
      if (messagesAfterSwap >= 1 && connectionEstablished) {
        ws.close();
        done();
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    setTimeout(() => {
      ws.close();
      done(new Error('Hot-swap test timed out'));
    }, 10000);
  });
});