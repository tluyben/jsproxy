const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (cluster.isMaster) {
  logger.info(`Master ${process.pid} is running`);

  for (let i = 0; i < Math.min(numCPUs, 4); i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    logger.info('Starting a new worker');
    cluster.fork();
  });

  cluster.on('listening', (worker, address) => {
    logger.info(`Worker ${worker.process.pid} listening on ${address.address}:${address.port}`);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception in master:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection in master at:', promise, 'reason:', reason);
  });

} else {
  const ProxyServer = require('./src/ProxyServer');
  
  async function startWorker() {
    try {
      const server = new ProxyServer(logger);
      await server.initialize();
      await server.start();
      
      logger.info(`Worker ${process.pid} started successfully`);
    } catch (error) {
      logger.error(`Worker ${process.pid} failed to start:`, error);
      process.exit(1);
    }
  }

  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception in worker ${process.pid}:`, error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection in worker ${process.pid} at:`, promise, 'reason:', reason);
    process.exit(1);
  });

  startWorker();
}