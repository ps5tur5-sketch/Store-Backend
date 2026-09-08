import { seedDemoMarketplace } from './demo-marketplace.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closePool, getPool } from './db.js';
import { seedDatabase } from './seed.js';
import { startBackgroundWorkers } from './worker.js';
import { migrate } from '../scripts/migrate.js';

const config = loadConfig();
await migrate();
await seedDatabase(getPool());
if (config.DEMO_MARKETPLACE) await seedDemoMarketplace();

const app = buildApp(config);
await app.listen({ host: config.HOST, port: config.PORT });
const stopWorkers = config.WORKER_ENABLED ? startBackgroundWorkers(app, config) : () => undefined;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ event: 'shutdown', signal }, 'shutting down');
  stopWorkers();
  await app.close();
  await closePool();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
