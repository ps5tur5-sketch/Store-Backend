import { expireWithdrawals } from './withdrawals.js';
import { expirePayments } from './payment-intents.js';
import { getPool, transaction } from '../db.js';
import { processPendingPaymentEvents, scheduleDelivery } from './payment.js';

export async function reconciliationReport(): Promise<Record<string, unknown>> {
  const db = getPool();
  const [paidNotDelivered, deliveredNotPaid, ledgerImbalances, pendingWebhooks] = await Promise.all([
    db.query(
      `SELECT o.id AS order_id, o.sku, o.status, o.updated_at
       FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.payment_state = 'paid' AND d.order_id IS NULL AND o.status <> 'refunded'
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
  const money = await db.query(`SELECT o.id AS order_id,o.group_id,o.amount::text,
    COALESCE((SELECT sum(le.amount) FROM ledger_entries le JOIN ledger_transactions lt ON lt.id=le.transaction_id
      WHERE lt.order_id=o.id AND lt.kind IN ('payment_received','payment_reversed') AND le.account IN ('cash','wallet')),0)::text AS paid,
    COALESCE((SELECT -sum(le.amount) FROM ledger_entries le JOIN ledger_transactions lt ON lt.id=le.transaction_id
      WHERE lt.order_id=o.id AND le.account='sales'),0)::text AS delivered,
    COALESCE((SELECT amount FROM refunds r WHERE r.order_id=o.id),0)::text AS refunded,
    o.status FROM orders o WHERE o.payment_state='paid'`);
  const discrepancies = await db.query(`SELECT d.order_id FROM deliveries d JOIN orders o ON o.id=d.order_id
    LEFT JOIN provider_inventory i ON i.code=d.code LEFT JOIN provider_issuances p ON p.provider=d.provider AND p.request_id=d.request_id
    WHERE i.code IS NULL OR i.sku<>o.sku OR i.claimed_by IS DISTINCT FROM d.request_id
    OR (o.assigned_offer_id IS NOT NULL AND o.assigned_offer_id IS DISTINCT FROM i.offer_id)
    OR p.code IS DISTINCT FROM d.code OR p.order_id IS DISTINCT FROM d.order_id`);
  const resolved = await db.query(
    `SELECT order_id,payload,created_at FROM audit_events WHERE event_type='supplier_discrepancy_resolved' ORDER BY id DESC LIMIT 100`,
  );
  const wallet = (
    await db.query(
      `SELECT COALESCE((SELECT sum(points_balance) FROM users),0)::text AS balances, (-COALESCE((SELECT sum(amount) FROM ledger_entries WHERE account='wallet'),0))::text AS ledger_balance,COALESCE((SELECT sum(amount) FROM withdrawals WHERE status='pending'),0)::text AS withdrawal_reserved,(-COALESCE((SELECT sum(amount) FROM ledger_entries WHERE account='withdrawal_clearing'),0))::text AS withdrawal_ledger`,
    )
  ).rows[0];
  return {
    withdrawals: {
      reserved: Number(wallet.withdrawal_reserved),
      ledger_reserved: Number(wallet.withdrawal_ledger),
      balanced: Number(wallet.withdrawal_reserved) === Number(wallet.withdrawal_ledger),
    },
    wallet: {
      balances: Number(wallet.balances),
      ledger_balance: Number(wallet.ledger_balance),
      balanced: Number(wallet.balances) === Number(wallet.ledger_balance),
    },
    money: money.rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      paid: Number(r.paid),
      delivered: Number(r.delivered),
      refunded: Number(r.refunded),
      pending: Number(r.paid) - Number(r.delivered) - Number(r.refunded),
      settled:
        ['delivered', 'refunded'].includes(r.status) &&
        Number(r.paid) === Number(r.delivered) + Number(r.refunded),
    })),
    invalid_deliveries: discrepancies.rows,
    resolved_discrepancies: resolved.rows,
    paid_not_delivered: paidNotDelivered.rows,
    delivered_not_paid: deliveredNotPaid.rows,
    ledger_imbalances: ledgerImbalances.rows.map((row) => ({ ...row, balance: Number(row.balance) })),
    pending_webhooks: pendingWebhooks.rows,
  };
}

export async function recoverStuckOrders(): Promise<{
  pendingEvents: number;
  scheduledOrders: number;
  unlockedJobs: number;
}> {
  await getPool().query('SELECT archive_business_commits()');
  await expirePayments();
  await expireWithdrawals();
  const pendingEvents = await processPendingPaymentEvents();
  const { scheduledOrders, unlockedJobs } = await transaction(async (client) => {
    const unlocked = await client.query(
      `UPDATE delivery_jobs SET state = 'retry', next_attempt_at = now(), locked_until = NULL,
       last_error = concat_ws(';', last_error, 'expired_lease_recovered'), updated_at = now()
       WHERE state = 'processing' AND locked_until < now() RETURNING order_id`,
    );
    const candidates = await client.query<{ id: string }>(
      `SELECT o.id FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.payment_state = 'paid' AND d.order_id IS NULL AND o.status <> 'refunded'
         AND o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
         AND NOT EXISTS (SELECT 1 FROM delivery_jobs j WHERE j.order_id=o.id)
       FOR UPDATE OF o SKIP LOCKED`,
    );
    for (const order of candidates.rows) await scheduleDelivery(client, order.id);
    return { scheduledOrders: candidates.rowCount ?? 0, unlockedJobs: unlocked.rowCount ?? 0 };
  });
  return { pendingEvents, scheduledOrders, unlockedJobs };
}
