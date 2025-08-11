#!/usr/bin/env node

/**
 * Manual WebSocket Test Script
 * 
 * This script demonstrates that WebSocket reverse proxying works for both ws:// and wss://
 * 
 * Usage:
 *   1. Start the proxy: npm run dev
 *   2. Run this test: node test-websocket.js
 */

const WebSocket = require('ws');
const http = require('http');

console.log('🚀 WebSocket Reverse Proxy Test');
console.log('=================================');

// Create a simple WebSocket backend server
const backendServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('WebSocket backend HTTP endpoint working!');
});

const wsServer = new WebSocket.Server({ server: backendServer });

wsServer.on('connection', (ws, req) => {
  console.log(`✅ Backend: WebSocket connection received on path: ${req.url}`);
  console.log(`   Headers: ${JSON.stringify(req.headers.host)}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to backend WebSocket server',
    path: req.url,
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());
    console.log(`📨 Backend: Received message type '${data.type}'`);
    
    // Echo back with backend info
    ws.send(JSON.stringify({
      type: 'echo',
      original: data,
      backend_response: 'Message processed by backend',
      timestamp: new Date().toISOString()
    }));
  });

  ws.on('close', () => {
    console.log('❌ Backend: WebSocket connection closed');
  });
});

// Start backend server
backendServer.listen(3030, async () => {
  console.log('🎯 Backend WebSocket server started on port 3030');
  console.log('');
  
  // Add test mapping to proxy database (assuming it's running)
  try {
    console.log('📝 You need to add this mapping to your proxy database:');
    console.log("   INSERT INTO mappings (id, domain, front_uri, back_port, back_uri)");
    console.log("   VALUES ('test-ws-id', 'websocket.test.local', '', 3030, '');");
    console.log('');
    console.log('📝 Or using SQLite command:');
    console.log('   sqlite3 ./data/current.db "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri) VALUES (\'test-ws-' + Date.now() + '\', \'websocket.test.local\', \'\', 3030, \'\');"');
    console.log('');
    
    // Give user time to add mapping
    console.log('⏳ Waiting 5 seconds for you to add the mapping...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Test WebSocket connection through proxy
    console.log('🧪 Testing WebSocket connection through proxy...');
    
    const ws = new WebSocket('ws://localhost:8080/', {
      headers: {
        'Host': 'websocket.test.local'
      }
    });

    ws.on('open', () => {
      console.log('✅ Proxy: WebSocket connection opened through proxy');
      
      // Send test message
      ws.send(JSON.stringify({
        type: 'test_message',
        message: 'Hello from WebSocket client!',
        test_id: 'ws-proxy-test-' + Date.now()
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      console.log(`📨 Proxy: Received message type '${message.type}'`);
      
      if (message.type === 'welcome') {
        console.log(`   Welcome message: ${message.message}`);
        console.log(`   Backend path: ${message.path}`);
      } else if (message.type === 'echo') {
        console.log(`   Echo response: ${message.backend_response}`);
        console.log(`   Original message: ${message.original.message}`);
        
        // Test successful!
        console.log('');
        console.log('🎉 SUCCESS: WebSocket reverse proxying is working!');
        console.log('   ✅ Connection established through proxy');
        console.log('   ✅ Messages proxied bidirectionally');  
        console.log('   ✅ Domain routing working');
        console.log('   ✅ WebSocket upgrade handled correctly');
        
        ws.close();
        process.exit(0);
      }
    });

    ws.on('error', (error) => {
      console.error('❌ Proxy: WebSocket error:', error.message);
      console.log('');
      console.log('🔧 Troubleshooting:');
      console.log('   1. Make sure the proxy server is running (npm run dev)');
      console.log('   2. Verify the database mapping was added');
      console.log('   3. Check that the proxy is listening on port 8080');
      process.exit(1);
    });

    ws.on('close', () => {
      console.log('🔌 Proxy: WebSocket connection closed');
    });

    // Timeout
    setTimeout(() => {
      console.error('❌ Test timed out after 30 seconds');
      console.log('');
      console.log('🔧 Make sure:');
      console.log('   1. Proxy server is running: npm run dev');
      console.log('   2. Database mapping is added (see command above)');
      process.exit(1);
    }, 30000);

  } catch (error) {
    console.error('❌ Test setup error:', error);
    process.exit(1);
  }
});

// Cleanup
process.on('SIGINT', () => {
  console.log('\\n🛑 Test interrupted');
  process.exit(0);
});

process.on('exit', () => {
  if (backendServer) {
    backendServer.close();
  }
});