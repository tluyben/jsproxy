'use strict';

// Cached DNS lookup for every outbound backend connection.
//
// Node resolves a hostname with a fresh getaddrinfo() on EVERY connect —
// there is no resolver cache in Node or glibc. jsproxy connects to backends by
// name for every proxied request, every failover attempt and every health
// probe, so a busy (or probe-heavy) proxy turned into a DNS flood: behind
// Docker's embedded resolver it was ~160 lookups/s (A + AAAA, each tried bare
// and with the search suffix) for a handful of backend names that never change,
// and dockerd burned several cores answering them.
//
// `lookup` below is a drop-in for dns.lookup — the signature net.connect,
// dgram.createSocket, http(s).request and http(s).Agent all accept as their
// `lookup` option:
//   - answers are cached for DNS_CACHE_TTL_MS (default 30s);
//   - after that, the old answer is still served immediately while ONE
//     background refresh runs (stale-while-revalidate, up to DNS_CACHE_STALE_MS,
//     default 5 min) — so an expiry never adds latency to a request, and a
//     resolver outage doesn't take down backends whose address we already know;
//   - concurrent misses for the same name share one lookup;
//   - failures are cached for DNS_CACHE_NEGATIVE_TTL_MS (default 5s) so a
//     misconfigured backend name can't flood the resolver either.
// IP literals bypass the cache. DNS_CACHE_TTL_MS=0 disables caching entirely
// (plain dns.lookup, the old behaviour).

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function createCachedLookup(opts = {}) {
  const ttlMs         = opts.ttlMs         ?? envInt('DNS_CACHE_TTL_MS', 30000);
  const staleMs       = opts.staleMs       ?? envInt('DNS_CACHE_STALE_MS', 300000);
  const negativeTtlMs = opts.negativeTtlMs ?? envInt('DNS_CACHE_NEGATIVE_TTL_MS', 5000);
  const maxEntries    = opts.maxEntries    ?? 10000;
  const resolve       = opts.resolve       || dns.lookup;
  const now           = opts.now           || Date.now;

  const cache    = new Map(); // key -> { addresses, error, expires, staleUntil }
  const inflight = new Map(); // key -> [callback(err, addresses)]

  function store(key, entry) {
    cache.delete(key); // re-insert so Map order stays oldest-first for eviction
    cache.set(key, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  function reply(callback, all, err, addresses) {
    process.nextTick(() => {
      if (err) return callback(err);
      if (all) return callback(null, addresses.map(a => ({ address: a.address, family: a.family })));
      callback(null, addresses[0].address, addresses[0].family);
    });
  }

  // Resolve `hostname` (always with all:true, so one cache entry serves both
  // single-address and all-address callers) and update the cache.
  function refresh(key, hostname, options, onDone) {
    const waiting = inflight.get(key);
    if (waiting) { if (onDone) waiting.push(onDone); return; }
    const queue = onDone ? [onDone] : [];
    inflight.set(key, queue);

    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      inflight.delete(key);
      const t = now();
      if (!err && (!Array.isArray(addresses) || addresses.length === 0)) {
        err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`),
          { code: 'ENOTFOUND', errno: 'ENOTFOUND', syscall: 'getaddrinfo', hostname });
      }
      if (err) {
        const prev = cache.get(key);
        if (prev && prev.addresses && t < prev.staleUntil) {
          // Keep serving the last good answer through a resolver hiccup.
          queue.forEach(cb => cb(null, prev.addresses));
          return;
        }
        store(key, { error: err, expires: t + negativeTtlMs, staleUntil: t + negativeTtlMs });
        queue.forEach(cb => cb(err));
        return;
      }
      store(key, { addresses, expires: t + ttlMs, staleUntil: t + ttlMs + staleMs });
      queue.forEach(cb => cb(null, addresses));
    });
  }

  function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    else if (typeof options === 'number') options = { family: options };
    else options = options || {};

    if (ttlMs === 0 || !hostname || net.isIP(hostname)) {
      return resolve(hostname, options, callback);
    }

    const all = options.all === true;
    // Everything except `all` can change the answer, so it is part of the key.
    const { all: _ignored, ...rest } = options;
    const key = `${String(hostname).toLowerCase()}|${JSON.stringify(rest)}`;
    const entry = cache.get(key);
    const t = now();

    if (entry && t < entry.expires) {
      return entry.error ? reply(callback, all, entry.error) : reply(callback, all, null, entry.addresses);
    }
    if (entry && entry.addresses && t < entry.staleUntil) {
      refresh(key, hostname, rest); // background; this caller gets the stale answer now
      return reply(callback, all, null, entry.addresses);
    }
    refresh(key, hostname, rest, (err, addresses) => reply(callback, all, err, addresses));
  }

  lookup.clear = () => cache.clear();
  lookup.size = () => cache.size;
  return lookup;
}

// Process-wide instance shared by every connection jsproxy makes.
const lookup = createCachedLookup();

// http-proxy never forwards a `lookup` option to http(s).request — it only
// forwards `agent` (and uses agent:false, i.e. a fresh non-keep-alive agent per
// request, when none is given). These agents keep that exact behaviour
// (keepAlive:false → one connection per request, "Connection: close") and add
// the cached lookup. Only lookup/keepAlive are set here, so every per-request
// option (rejectUnauthorized, servername, ...) still comes from the request.
const httpAgent  = new http.Agent({ keepAlive: false, lookup });
const httpsAgent = new https.Agent({ keepAlive: false, lookup });

// Agent for an http-proxy target (string URL or URL object).
function agentFor(target) {
  let protocol = null;
  try { protocol = typeof target === 'string' ? new URL(target).protocol : target && target.protocol; }
  catch (_) { /* not a URL http-proxy would treat as https */ }
  return protocol === 'https:' || protocol === 'wss:' ? httpsAgent : httpAgent;
}

module.exports = { lookup, createCachedLookup, httpAgent, httpsAgent, agentFor };
