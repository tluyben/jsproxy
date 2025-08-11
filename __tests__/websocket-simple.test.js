const WebSocket = require('ws');
const http = require('http');
const ProxyServer = require('../src/ProxyServer');
const path = require('path');
const fs = require('fs').promises;

describe('Simple WebSocket Test', () => {
  let proxyServer;
  let backendServer;
  let wsServer;
  let logger;
  let testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'simple-ws-data');
    
    try {
      await fs.mkdir(testDataDir, { recursive: true });
    } catch (error) {
      // Directory exists
    }

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    // Create simple WebSocket backend
    backendServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('HTTP backend working');
    });

    wsServer = new WebSocket.Server({ server: backendServer });
    
    wsServer.on('connection', (ws, req) => {
      console.log('Backend WS connection received, path:', req.url);
      ws.send(JSON.stringify({ 
        type: 'welcome',
        message: 'Connected to backend',
        path: req.url 
      }));
      
      ws.on('message', (message) => {
        console.log('Backend received:', message.toString());
        ws.send(JSON.stringify({
          type: 'echo',
          data: JSON.parse(message.toString())
        }));
      });
    });

    await new Promise((resolve) => {
      backendServer.listen(3010, () => {
        console.log('WebSocket backend started on port 3010');
        resolve();
      });
    });

    // Setup proxy
    proxyServer = new ProxyServer(logger);
    proxyServer.db.dbPath = path.join(testDataDir, 'test.db');
    proxyServer.certManager.certsDir = path.join(testDataDir, 'certs');
    
    // Use a different port for testing
    const originalEnv = process.env.HTTP_PORT;
    process.env.HTTP_PORT = '9090';
    process.env.ENABLE_HTTPS = 'false';

    await proxyServer.initialize();

    // Add mapping for WebSocket
    await proxyServer.db.addMapping('test.example.com', '', 3010, '');
    
    await proxyServer.start();
    
    console.log('Proxy started on port 9090');
    
    // Restore original env
    if (originalEnv) {
      process.env.HTTP_PORT = originalEnv;
    } else {
      delete process.env.HTTP_PORT;
    }
  }, 15000);

  afterAll(async () => {
    if (wsServer) {
      wsServer.close();
    }
    if (backendServer) {
      await new Promise(resolve => backendServer.close(resolve));
    }
    if (proxyServer) {
      await proxyServer.stop();
    }

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
        } catch (e) {
          // Ignore file-level cleanup errors
        }
      }
      await fs.rmdir(testDataDir);
    } catch (error) {
      // Ignore cleanup errors
    }

    delete process.env.ENABLE_HTTPS;
  });

  test('should proxy WebSocket connection', (done) => {
    console.log('Starting WebSocket test...');
    
    const ws = new WebSocket('ws://localhost:9090/', {
      headers: {
        'Host': 'test.example.com'
      }
    });

    let welcomeReceived = false;

    ws.on('open', () => {
      console.log('WebSocket connection opened');
      ws.send(JSON.stringify({
        type: 'test',
        message: 'Hello from test!'
      }));
    });

    ws.on('message', (data) => {
      console.log('Received message:', data.toString());
      const message = JSON.parse(data.toString());
      
      if (message.type === 'welcome') {
        welcomeReceived = true;
        console.log('Welcome message received');
      }
      
      if (message.type === 'echo') {
        console.log('Echo message received');
        expect(message.data.type).toBe('test');
        expect(message.data.message).toBe('Hello from test!');
        
        if (welcomeReceived) {
          ws.close();
          done();
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      done(error);
    });

    ws.on('close', (code, reason) => {
      console.log('WebSocket closed:', code, reason?.toString());
    });

    setTimeout(() => {
      console.log('Test timeout reached');
      ws.close();
      done(new Error('Test timed out'));
    }, 8000);
  }, 10000);

  test('should handle HTTP requests to same backend', async () => {
    console.log('Testing HTTP to same backend...');
    
    const response = await fetch('http://localhost:9090/', {
      headers: {
        'Host': 'test.example.com'
      }
    });
    
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toBe('HTTP backend working');
  });
});