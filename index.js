require('dotenv').config({ quiet: true });
// Telemetry must be initialized before anything else so the OTEL provider
// and W3C propagator are registered before HTTP servers start.
require('./src/Telemetry');

const { createLogger } = require('./src/Logger');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

const logger = createLogger({
  service: 'jsproxy',
  role: cluster.isMaster ? 'master' : 'worker',
  pid: process.pid,
});

if (cluster.isMaster) {
  logger.info('master starting', { workers: Math.min(numCPUs, 4) });

  const workerIds = new Map();

  for (let i = 0; i < Math.min(numCPUs, 4); i++) {
    const worker = cluster.fork({ WORKER_ID: i.toString() });
    workerIds.set(worker.id, i);
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.error('worker died', { worker_pid: worker.process.pid, code, signal });
    logger.info('respawning worker');
    const workerId = workerIds.get(worker.id) || 0;
    workerIds.delete(worker.id);
    const newWorker = cluster.fork({ WORKER_ID: workerId.toString() });
    workerIds.set(newWorker.id, workerId);
  });

  cluster.on('listening', (worker, address) => {
    logger.info('worker listening', { worker_pid: worker.process.pid, address: address.address, port: address.port });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception in master', { error: error.message, stack: error.stack });
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('unhandled rejection in master', { error: msg, stack });
  });

} else {
  const ProxyServer  = require('./src/ProxyServer');
  const { PluginManager } = require('./src/PluginManager');

  async function startWorker() {
    const workerId  = parseInt(process.env.WORKER_ID || '0');
    const wLogger   = logger.child({ worker_id: workerId });

    wLogger.info('worker starting');

    try {
      const pluginManager = new PluginManager(wLogger, process.env.PLUGIN);
      const server = new ProxyServer(wLogger, pluginManager);
      await server.initialize();
      await server.start();
      wLogger.info('worker ready');
    } catch (error) {
      wLogger.error('worker failed to start', { error: error.message, stack: error.stack });
      process.exit(1);
    }
  }

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception in worker', { error: error.message, stack: error.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('unhandled rejection in worker', { error: msg, stack });
    process.exit(1);
  });

  startWorker();
}
