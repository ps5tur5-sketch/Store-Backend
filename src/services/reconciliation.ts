import { getPool, transaction } from '../db.js';
import { processPendingPaymentEvents, scheduleDelivery } from './payment.js';

export async function reconciliationReport(): Promise<Record<string, unknown>> {
  const db = getPool();
  const [paidNotDelivered, deliveredNotPaid, ledgerImbalances, pendingWebhooks] = await Promise.all([
    db.query(
      `SELECT o.id AS order_id, o.sku, o.status, o.updated_at
       FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.payment_state = 'paid' AND d.order_id IS NULL
       ORDER BY o.created_at`,
    ),
    db.query(
      `SELECT o.id AS order_id, o.sku, o.payment_state, d.provider, d.delivered_at
       FROM orders o JOIN deliveries d ON d.order_id = o.id
       WHERE o.payment_state <> 'paid' ORDER BY d.delivered_at`,
    ),
    db.query(
      `SELECT lt.id AS transaction_id, lt.order_id, COALESCE(sum(le.amount), 0)::bigint AS balance
       FROM ledger_transactions lt LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
       GROUP BY lt.id, lt.order_id HAVING COALESCE(sum(le.amount), 0) <> 0`,
    ),
    db.query(
      `SELECT event_id, order_id, received_at FROM payment_events
       WHERE processed_at IS NULL ORDER BY received_at`,
    ),
  ]);
  return {
    paid_not_delivered: paidNotDelivered.rows,
    delivered_not_paid: deliveredNotPaid.rows,
    ledger_imbalances: ledgerImbalances.rows.map((row) => ({ ...row, balance: Number(row.balance) })),
    pending_webhooks: pendingWebhooks.rows,
  };
}

export async function recoverStuckOrders(): Promise<{ pendingEvents: number; scheduledOrders: number; unlockedJobs: number }> {
  const pendingEvents = await processPendingPaymentEvents();
  const { scheduledOrders, unlockedJobs } = await transaction(async (client) => {
    const unlocked = await client.query(
      `UPDATE delivery_jobs SET state = 'retry', next_attempt_at = now(), locked_until = NULL,
       last_error = concat_ws(';', last_error, 'expired_lease_recovered'), updated_at = now()
       WHERE state = 'processing' AND locked_until < now() RETURNING order_id`,
    );
    const candidates = await client.query<{ id: string }>(
      `SELECT o.id FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.payment_state = 'paid' AND d.order_id IS NULL
         AND o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
       FOR UPDATE OF o SKIP LOCKED`,
    );
    for (const order of candidates.rows) await scheduleDelivery(client, order.id);
    return { scheduledOrders: candidates.rowCount ?? 0, unlockedJobs: unlocked.rowCount ?? 0 };
  });
  return { pendingEvents, scheduledOrders, unlockedJobs };
}
