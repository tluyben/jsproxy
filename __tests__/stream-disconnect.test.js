'use strict';
// A completed GET request is not an aborted upload. Closing its response must
// still stop the backend SSE/download, otherwise its socket retains the request
// and buffers forever. Wasmbox uses this path for long-lived event feeds.
const http = require('http');
const ProxyServer = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');
const logger = {info() {}, warn() {}, error() {}, debug() {}};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = async server => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const until = async (predicate, message) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

let backend, edge, plugin, proxy, live, timers, opened, interested;
beforeEach(async () => {
  live = new Set(); timers = new Set(); opened = 0; interested = false;
  backend = http.createServer((req, res) => {
    opened++; live.add(res);
    res.once('close', () => live.delete(res));
    if (req.url === '/waiting') return; // no headers yet
    if (req.url === '/upload') { req.on('data', () => {}); return; }
    if (req.url === '/finite') { req.resume(); res.end('complete'); return; }
    res.writeHead(200, {'content-type':req.url === '/events' ? 'text/event-stream' : 'application/octet-stream'});
    const chunk = Buffer.alloc(4096, 65);
    const write = () => { if (!res.destroyed) res.write(chunk); };
    write();
    const timer = setInterval(write, 10); timers.add(timer);
    res.once('close', () => {clearInterval(timer); timers.delete(timer);});
  });
  plugin = http.createServer((req, res) => {
    req.resume(); res.setHeader('content-type', 'application/json');
    res.end(req.url === "/valid" ? JSON.stringify({valid:interested,needsBody:false}) : "");
  });
  await listen(backend); await listen(plugin);
  proxy = new ProxyServer(logger, new PluginManager(logger, '127.0.0.1:'+plugin.address().port));
  proxy.db.getMapping = async () => ({id:'stream-app',domain:'app.test',front_uri:'',back_uri:'',backend:'http://127.0.0.1',back_port:String(backend.address().port)});
  edge = http.createServer((req, res) => proxy.handleRequest(req, res, false));
  await listen(edge);
});
afterEach(async () => {
  for (const timer of timers) clearInterval(timer);
  await Promise.all([close(edge),close(backend),close(plugin)]);
});
function request(path, {stream = true, method = 'GET', onResponse} = {}) {
  const req = http.request({host:'127.0.0.1',port:edge.address().port,path,method,agent:false,
    headers:{host:'app.test',...(stream ? {accept:'text/event-stream'} : {})}}, onResponse);
  req.on('error', () => {});
  return req;
}

test('repeated EventSource disconnects leave no backend streams behind', async () => {
  for (let wave = 0; wave < 3; wave++) {
    for (let i = 0; i < 10; i++) await new Promise(resolve => {
      request('/events', {onResponse:res => res.once('data', () => {res.destroy();resolve();})}).end();
    });
    await until(() => live.size === 0, `${live.size} backend streams remain after client disconnect`);
    expect(timers.size).toBe(0);
  }
  expect(opened).toBe(30);
});

test('disconnect while waiting for SSE headers closes upstream without a backend penalty or failover', async () => {
  const penalize = jest.spyOn(proxy, 'penalizePort');
  const req = request('/waiting'); req.end();
  await until(() => live.size === 1, 'backend never received request');
  req.destroy();
  await until(() => live.size === 0, 'backend still waiting after client disconnect');
  expect(penalize).not.toHaveBeenCalled();
  expect(proxy.bgChecks.size).toBe(0);
});

test('ordinary download disconnect also closes the http-proxy upstream', async () => {
  await new Promise(resolve => request('/download', {stream:false,onResponse:res => res.once('data', () => {res.destroy();resolve();})}).end());
  await until(() => live.size === 0, 'http-proxy download survives client disconnect');
});

test('a live SSE feed continues, and a completed response remains intact', async () => {
  let response, chunks = 0;
  const req = request('/events', {onResponse:res => {response=res;res.on('data', () => chunks++);}});req.end();
  await until(() => chunks >= 5, 'live feed was interrupted');
  expect(live.size).toBe(1);response.destroy();
  await until(() => live.size === 0, 'feed survived its client');
  const body = await new Promise(resolve => request('/finite', {onResponse:res => {
    let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));
  }}).end());
  expect(body).toBe('complete');
});

test('aborted chunked upload tears down the limited request stream', async () => {
  proxy.maxRequestBodyBytes = 1048576;
  const req=request('/upload',{method:'POST',stream:false});req.write('partial');
  await until(()=>live.size===1,'backend never received upload');req.destroy();
  await until(()=>live.size===0,'upload survives client abort');
});


test('an interested streaming plugin also releases a disconnected response and its state', async () => {
  interested = true;
  await new Promise(resolve => request('/events', {onResponse:res => res.once('data', () => {res.destroy();resolve();})}).end());
  await until(() => live.size === 0, 'plugin stream survives client disconnect');
  expect(proxy.pluginManager._requests.size).toBe(0);
});

test('disconnect during plugin discovery never registers state or starts an upstream', async () => {
  let release, started;
  const entered = new Promise(resolve => {started=resolve;});
  proxy.pluginManager.runValid = async () => {
    started(); await new Promise(resolve => {release=resolve;});
    return {interested:[0],needsBody:false};
  };
  const req=request('/events');req.end();await entered;
  req.destroy();await new Promise(resolve=>req.once('close',resolve));
  await new Promise(resolve=>setTimeout(resolve,20));release();
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(opened).toBe(0);expect(proxy.pluginManager._requests.size).toBe(0);
});

test('disconnect while a streaming after-hook is pending closes the backend and completes the handler', async () => {
  interested = true;
  let started, release;
  const entered = new Promise(resolve => {started=resolve;});
  proxy.pluginManager.runAfter = async () => {
    started(); await new Promise(resolve=>{release=resolve;});return {type:'CONTINUE'};
  };
  const req=request('/events');req.end();await entered;req.destroy();
  try { await until(()=>live.size===0,'backend survives pending plugin hook cancellation'); }
  finally {release();}
  await until(()=>proxy.pluginManager._requests.size===0,'plugin state survives client cancellation');
});
