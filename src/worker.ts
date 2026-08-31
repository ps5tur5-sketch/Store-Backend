import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { runOneDelivery } from './services/delivery.js';
import { recoverStuckOrders } from './services/reconciliation.js';

export function startBackgroundWorkers(app: FastifyInstance, config: AppConfig): () => void {
  let deliveryRunning = false;
  let recoveryRunning = false;

  const deliveryTimer = setInterval(async () => {
    if (deliveryRunning) return;
    deliveryRunning = true;
    try {
      await runOneDelivery(config, app.log);
    } catch (error) {
      app.log.error({ event: 'delivery_worker_error', error }, 'delivery worker iteration failed');
    } finally {
      deliveryRunning = false;
    }
  }, config.WORKER_POLL_MS);

  const recoveryTimer = setInterval(async () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      const result = await recoverStuckOrders();
      if (result.pendingEvents || result.scheduledOrders || result.unlockedJobs) {
        app.log.info({ event: 'background_recovery', ...result }, 'background recovery made progress');
      }
    } catch (error) {
      app.log.error({ event: 'recovery_worker_error', error }, 'recovery worker iteration failed');
    } finally {
      recoveryRunning = false;
    }
  }, config.RECOVERY_POLL_MS);

  deliveryTimer.unref();
  recoveryTimer.unref();
  return () => {
    clearInterval(deliveryTimer);
    clearInterval(recoveryTimer);
  };
}
