/**
 * jsproxy — Deno single-binary entry point.
 *
 * Drop-in replacement for the Node.js index.js, minus the cluster manager
 * (Deno has no cluster module). Run multiple copies behind a load-balancer
 * or process supervisor if you need multi-core concurrency.
 *
 * Supported env vars are identical to the Node.js version; the same .env
 * file is loaded automatically when present.
 */

import { load as loadEnv } from "@std/dotenv";

// Load .env from the working directory (same behaviour as dotenv in Node.js).
// Silently ignore if the file doesn't exist.
try {
  const env = await loadEnv({ envPath: ".env", export: true });
  for (const [k, v] of Object.entries(env)) {
    if (Deno.env.get(k) === undefined) Deno.env.set(k, v);
  }
} catch {
  // no .env file — that's fine
}

import ProxyServer from "./src/ProxyServer.ts";

// ── Simple structured logger (matches the winston interface used everywhere) ──
function makeLogger() {
  const ts = () => new Date().toISOString();
  return {
    info:  (...a: unknown[]) => console.log (`[INFO]  ${ts()}`, ...a),
    warn:  (...a: unknown[]) => console.warn(`[WARN]  ${ts()}`, ...a),
    error: (...a: unknown[]) => console.error(`[ERROR] ${ts()}`, ...a),
  };
}

const logger = makeLogger();

logger.info(`jsproxy (Deno ${Deno.version.deno}) starting — PID ${Deno.pid}`);

const server = new ProxyServer(logger);

try {
  await server.initialize();
  await server.start();
  logger.info("jsproxy ready");
} catch (err) {
  logger.error("Fatal startup error:", err);
  Deno.exit(1);
}

// Graceful shutdown on SIGTERM / SIGINT
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down…`);
  try {
    await server.stop();
  } catch (err) {
    logger.error("Error during shutdown:", err);
  }
  Deno.exit(0);
}

Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT",  () => shutdown("SIGINT"));
