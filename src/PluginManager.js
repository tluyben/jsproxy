'use strict';

const http = require('http');

/**
 * No-op stub — used when PLUGIN is not set.
 * hasPlugins is a plain false so the caller can skip the block entirely.
 */
const noop = {
  hasPlugins: false,
  register() {},
  cleanup() {},
  async runValid() { return { interested: [], needsBody: true }; },
  async runBefore() { return { type: 'CONTINUE' }; },
  async runAfter() { return { type: 'CONTINUE' }; },
};

class PluginManager {
  /**
   * @param {object} logger  - Winston-compatible logger
   * @param {string} [pluginEnv] - value of the PLUGIN env var, e.g. "localhost:3001,localhost:3002"
   */
  constructor(logger, pluginEnv) {
    this.logger = logger;
    this.plugins = [];
    // requestId → { ignore: bool, interested: number[] }
    // Only populated for requests where ≥1 plugin expressed interest.
    this._requests = new Map();
    this._timeoutMs = parseInt(process.env.PLUGIN_TIMEOUT || '5000', 10);

    if (pluginEnv) {
      this.plugins = pluginEnv
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(addr => {
          const colonIdx = addr.lastIndexOf(':');
          const host = colonIdx > 0 ? addr.slice(0, colonIdx) : 'localhost';
          const port = parseInt(addr.slice(colonIdx + 1), 10);
          return { host, port };
        })
        .filter(p => !isNaN(p.port));

      if (this.plugins.length > 0) {
        logger.info(`PluginManager: loaded ${this.plugins.length} plugin(s): ${this.plugins.map(p => `${p.host}:${p.port}`).join(', ')}`);
      }
    }
  }

  get hasPlugins() {
    return this.plugins.length > 0;
  }

  /**
   * Store per-request state. Only called when ≥1 plugin returned valid=true.
   * needsBody=false only when every interested plugin explicitly declared it.
   */
  register(requestId, interested, needsBody = true) {
    this._requests.set(requestId, { ignore: false, interested, needsBody });
  }

  requestNeedsBody(requestId) {
    const state = this._requests.get(requestId);
    return state ? state.needsBody : true;
  }

  /**
   * Remove per-request state. Idempotent — safe to call multiple times.
   * Called explicitly on early exits (IGNORE, CANCEL, end of runAfter) and
   * unconditionally by res.once('close', ...) as a safety net.
   */
  cleanup(requestId) {
    this._requests.delete(requestId);
  }

  // ── Internal HTTP helpers ───────────────────────────────────────────────────

  /**
   * Metadata-only JSON POST. Used by /valid, which never carries a body.
   */
  _postJson(plugin, path, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: plugin.host,
          port: plugin.port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
          timeout: this._timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(new Error(`${plugin.host}:${plugin.port}${path} returned invalid JSON`));
            }
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${plugin.host}:${plugin.port}${path} timed out after ${this._timeoutMs}ms`));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Raw body POST used by /before and /after. The request/response body IS the
   * payload — sent as raw bytes, never base64. Out-of-band metadata (uri, method,
   * headers, statusCode, the plugin's decision, …) rides in the `x-plugin-meta`
   * header as compact JSON; the decision verb is mirrored into `x-plugin-result`
   * for readability.
   *
   * Resolves to { result, meta, body } where:
   *   result  - the plugin's decision verb (string, defaults to 'CONTINUE')
   *   meta    - parsed x-plugin-meta object from the response ({} if absent)
   *   body    - the raw response payload as a Buffer (zero-length if none)
   */
  _postRaw(plugin, path, meta, bodyBuffer) {
    const body = bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: plugin.host,
          port: plugin.port,
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': body.length,
            'x-plugin-meta': JSON.stringify(meta),
          },
          timeout: this._timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            let resMeta = {};
            if (res.headers['x-plugin-meta']) {
              try { resMeta = JSON.parse(res.headers['x-plugin-meta']); }
              catch { return reject(new Error(`${plugin.host}:${plugin.port}${path} returned invalid x-plugin-meta`)); }
            }
            resolve({
              result: res.headers['x-plugin-result'] || resMeta.result || 'CONTINUE',
              meta:   resMeta,
              body:   Buffer.concat(chunks),
            });
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${plugin.host}:${plugin.port}${path} timed out after ${this._timeoutMs}ms`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * POST /valid to ALL plugins in parallel (cheap — no payload, no base64).
   * Returns the indices of plugins that returned { valid: true }.
   * An empty array means nothing is interested and no further plugin calls
   * will be made for this request.
   */
  async runValid(requestId, domain, inPort, uri, method) {
    const results = await Promise.allSettled(
      this.plugins.map((plugin, idx) =>
        this._postJson(plugin, '/valid', { requestId, domain, inPort, uri, method })
          .then(res => ({ idx, valid: res.valid === true, needsBody: res.needsBody !== false }))
          .catch(err => {
            this.logger.warn(`Plugin ${plugin.host}:${plugin.port} /valid error: ${err.message}`);
            return { idx, valid: false, needsBody: true };
          })
      )
    );

    const interested = results
      .filter(r => r.status === 'fulfilled' && r.value.valid)
      .map(r => r.value);

    // Conservative: needsBody is true unless every interested plugin opts out
    const needsBody = interested.length === 0 || interested.some(r => r.needsBody);

    return { interested: interested.map(r => r.idx), needsBody };
  }

  /**
   * POST /before to each interested plugin in order.
   * First non-CONTINUE result short-circuits the rest.
   *
   * Returns one of:
   *   { type: 'CONTINUE' }
   *   { type: 'IGNORE' }
   *   { type: 'CANCEL', statusCode }
   *   { type: 'REWRITE_REQUEST', uri, method, headers, payload }   (null fields = keep original)
   */
  async runBefore(requestId, domain, inPort, uri, method, headers, bodyBuffer) {
    const state = this._requests.get(requestId);
    if (!state) return { type: 'CONTINUE' };

    const meta = { requestId, domain, inPort, uri, method, headers };

    for (const idx of state.interested) {
      const plugin = this.plugins[idx];
      try {
        const res = await this._postRaw(plugin, '/before', meta, bodyBuffer);
        switch (res.result) {
          case 'IGNORE':
            this.cleanup(requestId);
            return { type: 'IGNORE' };
          case 'CANCEL':
            this.cleanup(requestId);
            return { type: 'CANCEL', statusCode: res.meta.statusCode || 400 };
          case 'REWRITE_REQUEST':
            // Don't clean up — runAfter will still be called. payload is the raw
            // response body (a Buffer); zero-length means "keep original body".
            return {
              type: 'REWRITE_REQUEST',
              uri: res.meta.uri ?? null,
              method: res.meta.method ?? null,
              headers: res.meta.headers ?? null,
              payload: res.body.length > 0 ? res.body : null,
            };
          // default / 'CONTINUE': fall through to next plugin
        }
      } catch (err) {
        this.logger.warn(`Plugin ${plugin.host}:${plugin.port} /before error: ${err.message} (fail-open)`);
      }
    }

    return { type: 'CONTINUE' };
  }

  /**
   * POST /after to each interested plugin in order.
   * First non-CONTINUE result short-circuits the rest.
   * Always cleans up the request state before returning (it's the last call).
   *
   * Returns one of:
   *   { type: 'CONTINUE' }
   *   { type: 'CANCEL', statusCode }
   *   { type: 'REWRITE_RESPONSE', statusCode, headers, payload }  (null fields = keep original)
   */
  async runAfter(requestId, domain, inPort, statusCode, headers, bodyBuffer) {
    const state = this._requests.get(requestId);
    // state may be gone if IGNORE or CANCEL already cleaned up
    if (!state) return { type: 'CONTINUE' };

    const meta = { requestId, domain, inPort, statusCode, headers };

    let result = { type: 'CONTINUE' };

    for (const idx of state.interested) {
      const plugin = this.plugins[idx];
      try {
        const res = await this._postRaw(plugin, '/after', meta, bodyBuffer);
        if (res.result === 'CANCEL') {
          result = { type: 'CANCEL', statusCode: res.meta.statusCode || 502 };
          break;
        }
        if (res.result === 'REWRITE_RESPONSE') {
          result = {
            type: 'REWRITE_RESPONSE',
            statusCode: res.meta.statusCode ?? null,
            headers: res.meta.headers ?? null,
            payload: res.body.length > 0 ? res.body : null,
          };
          break;
        }
        // 'CONTINUE': next plugin
      } catch (err) {
        this.logger.warn(`Plugin ${plugin.host}:${plugin.port} /after error: ${err.message} (fail-open)`);
      }
    }

    this.cleanup(requestId); // always clean up — this is the last call
    return result;
  }
}

module.exports = { PluginManager, noop };
