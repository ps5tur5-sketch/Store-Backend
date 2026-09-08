import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { closePool } from '../src/db.js';
import { runDeliveryBatch } from '../src/services/delivery.js';
const config = loadConfig();
const app = buildApp(config);
try {
  await runDeliveryBatch(config, app.log);
} finally {
  await app.close();
  await closePool();
}
