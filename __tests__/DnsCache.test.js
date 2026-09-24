const { createCachedLookup, agentFor, httpAgent, httpsAgent } = require('../src/DnsCache');

// Fake resolver: counts calls, answers from `answers`, can be told to fail.
function fakeResolver(answers) {
  const r = (hostname, options, cb) => {
    r.calls.push({ hostname, options });
    const a = answers[hostname];
    if (r.fail || !a) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      return setImmediate(() => cb(err));
    }
    setImmediate(() => cb(null, options.all ? a : a[0].address, options.all ? undefined : a[0].family));
  };
  r.calls = [];
  return r;
}

const A = { 'backend-1': [{ address: '100.96.68.7', family: 4 }, { address: 'fd7a::1', family: 6 }] };
const call = (lookup, host, opts) => new Promise((resolve) =>
  lookup(host, opts, (err, address, family) => resolve({ err, address, family })));

describe('DnsCache.createCachedLookup', () => {
  test('caches within TTL: many connects, one resolver call', async () => {
    let t = 0;
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ ttlMs: 30000, staleMs: 0, resolve, now: () => t });
    for (let i = 0; i < 50; i++) {
      const r = await call(lookup, 'backend-1', {});
      expect(r.address).toBe('100.96.68.7');
      expect(r.family).toBe(4);
    }
    expect(resolve.calls).toHaveLength(1);
    expect(resolve.calls[0].options.all).toBe(true);
  });

  test('all:true callers get the full address list (net autoSelectFamily)', async () => {
    const lookup = createCachedLookup({ resolve: fakeResolver(A), now: () => 0 });
    const r = await call(lookup, 'backend-1', { all: true });
    expect(r.address).toEqual(A['backend-1']);
  });

  test('legacy (hostname, family, cb) and (hostname, cb) signatures work', async () => {
    const lookup = createCachedLookup({ resolve: fakeResolver(A), now: () => 0 });
    await new Promise((done) => lookup('backend-1', 4, (err, addr) => { expect(addr).toBe('100.96.68.7'); done(); }));
    await new Promise((done) => lookup('backend-1', (err, addr) => { expect(addr).toBe('100.96.68.7'); done(); }));
  });

  test('concurrent misses share a single lookup', async () => {
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ resolve, now: () => 0 });
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(lookup, 'backend-1', {})));
    rs.forEach(r => expect(r.address).toBe('100.96.68.7'));
    expect(resolve.calls).toHaveLength(1);
  });

  test('after TTL serves stale immediately and refreshes once in the background', async () => {
    let t = 0;
    const answers = { 'backend-1': [{ address: '10.0.0.1', family: 4 }] };
    const resolve = fakeResolver(answers);
    const lookup = createCachedLookup({ ttlMs: 1000, staleMs: 60000, resolve, now: () => t });
    await call(lookup, 'backend-1', {});
    answers['backend-1'] = [{ address: '10.0.0.2', family: 4 }];
    t = 2000;
    expect((await call(lookup, 'backend-1', {})).address).toBe('10.0.0.1'); // stale, no wait
    await new Promise(r => setImmediate(r));
    expect((await call(lookup, 'backend-1', {})).address).toBe('10.0.0.2'); // refreshed
    expect(resolve.calls).toHaveLength(2);
  });

  test('resolver failure keeps serving the last good answer within the stale window', async () => {
    let t = 0;
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ ttlMs: 1000, staleMs: 60000, resolve, now: () => t });
    await call(lookup, 'backend-1', {});
    resolve.fail = true;
    t = 5000;
    await call(lookup, 'backend-1', {}); // triggers failing background refresh
    await new Promise(r => setImmediate(r));
    const r = await call(lookup, 'backend-1', {});
    expect(r.err).toBeFalsy();
    expect(r.address).toBe('100.96.68.7');
  });

  test('past the stale window a real miss is resolved again', async () => {
    let t = 0;
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ ttlMs: 1000, staleMs: 1000, resolve, now: () => t });
    await call(lookup, 'backend-1', {});
    t = 10000;
    await call(lookup, 'backend-1', {});
    expect(resolve.calls).toHaveLength(2);
  });

  test('failures are cached briefly (negative TTL), then retried', async () => {
    let t = 0;
    const resolve = fakeResolver({});
    const lookup = createCachedLookup({ negativeTtlMs: 5000, resolve, now: () => t });
    for (let i = 0; i < 10; i++) expect((await call(lookup, 'nope', {})).err.code).toBe('ENOTFOUND');
    expect(resolve.calls).toHaveLength(1);
    t = 6000;
    await call(lookup, 'nope', {});
    expect(resolve.calls).toHaveLength(2);
  });

  test('IP literals bypass the cache', async () => {
    const resolve = fakeResolver({});
    resolve.fail = false;
    const passthrough = (h, o, cb) => { resolve.calls.push(h); setImmediate(() => cb(null, h, 4)); };
    const lookup = createCachedLookup({ resolve: passthrough, now: () => 0 });
    await call(lookup, '127.0.0.1', {});
    await call(lookup, '127.0.0.1', {});
    expect(resolve.calls).toEqual(['127.0.0.1', '127.0.0.1']);
    expect(lookup.size()).toBe(0);
  });

  test('ttlMs=0 disables caching (plain dns.lookup behaviour)', async () => {
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ ttlMs: 0, resolve, now: () => 0 });
    await call(lookup, 'backend-1', {});
    await call(lookup, 'backend-1', {});
    expect(resolve.calls).toHaveLength(2);
  });

  test('family is part of the cache key', async () => {
    const resolve = fakeResolver(A);
    const lookup = createCachedLookup({ resolve, now: () => 0 });
    await call(lookup, 'backend-1', { family: 4 });
    await call(lookup, 'backend-1', { family: 6 });
    await call(lookup, 'backend-1', { family: 4 });
    expect(resolve.calls).toHaveLength(2);
  });

  test('bounded: evicts oldest entries past maxEntries', async () => {
    const answers = {};
    for (let i = 0; i < 5; i++) answers[`h${i}`] = [{ address: `10.0.0.${i}`, family: 4 }];
    const lookup = createCachedLookup({ maxEntries: 3, resolve: fakeResolver(answers), now: () => 0 });
    for (let i = 0; i < 5; i++) await call(lookup, `h${i}`, {});
    expect(lookup.size()).toBe(3);
  });
});

describe('DnsCache.agentFor', () => {
  test('picks the https agent only for https/wss targets', () => {
    expect(agentFor('https://b:443')).toBe(httpsAgent);
    expect(agentFor('wss://b:443')).toBe(httpsAgent);
    expect(agentFor('http://b:80')).toBe(httpAgent);
    expect(agentFor('localhost:3000')).toBe(httpAgent);
    expect(agentFor('10.0.0.1:3000')).toBe(httpAgent);
    expect(agentFor(new URL('https://b'))).toBe(httpsAgent);
  });

  test('agents keep http-proxy\'s per-request connection semantics', () => {
    expect(httpAgent.keepAlive).toBe(false);
    expect(httpsAgent.keepAlive).toBe(false);
    expect(typeof httpAgent.options.lookup).toBe('function');
  });
});
