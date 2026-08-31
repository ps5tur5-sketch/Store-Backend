import type { PoolClient } from 'pg';
import { transaction } from '../db.js';
import type { OrderRow, PaymentEventInput } from '../types.js';

export interface PaymentEventRow {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: string;
  currency: string;
  event_created_at: Date;
  payload: PaymentEventInput;
  processed_at: Date | null;
  processing_result: string | null;
}

function isNewerEvent(event: PaymentEventRow, order: OrderRow): boolean {
  if (!order.payment_event_created_at) return true;
  const timeDifference = event.event_created_at.getTime() - order.payment_event_created_at.getTime();
  if (timeDifference !== 0) return timeDifference > 0;
  return event.event_id > (order.payment_event_id ?? '');
}

async function postLedgerTransition(
  client: PoolClient,
  order: OrderRow,
  event: PaymentEventRow,
  kind: 'payment_received' | 'payment_reversed',
): Promise<void> {
  const transactionId = `ledger:${event.event_id}`;
  const inserted = await client.query(
    `INSERT INTO ledger_transactions (id, order_id, source_event_id, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_event_id) DO NOTHING
     RETURNING id`,
    [transactionId, order.id, event.event_id, kind],
  );
  if (!inserted.rowCount) return;

  const amount = Number(order.amount);
  const cashAmount = kind === 'payment_received' ? amount : -amount;
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account, amount, currency)
     VALUES ($1, 'cash', $2, $4), ($1, 'customer_clearing', $3, $4)`,
    [transactionId, cashAmount, -cashAmount, order.currency],
  );
}

export async function scheduleDelivery(client: PoolClient, orderId: string): Promise<void> {
  const requestId = `req_${orderId}_1`;
  await client.query(
    `INSERT INTO delivery_jobs (order_id, request_id)
     VALUES ($1, $2)
     ON CONFLICT (order_id) DO UPDATE SET
       state = CASE WHEN delivery_jobs.state = 'completed' THEN 'completed' ELSE 'pending' END,
       next_attempt_at = CASE WHEN delivery_jobs.state = 'completed' THEN delivery_jobs.next_attempt_at ELSE now() END,
       locked_until = CASE WHEN delivery_jobs.state = 'completed' THEN delivery_jobs.locked_until ELSE NULL END,
       last_error = CASE WHEN delivery_jobs.state = 'completed' THEN delivery_jobs.last_error ELSE NULL END,
       updated_at = now()`,
    [orderId, requestId],
  );
}

async function markEvent(client: PoolClient, eventId: string, result: string): Promise<void> {
  await client.query(
    `UPDATE payment_events SET processed_at = now(), processing_result = $2 WHERE event_id = $1`,
    [eventId, result],
  );
}

export async function applyPaymentEvent(
  client: PoolClient,
  order: OrderRow,
  event: PaymentEventRow,
): Promise<{ outcome: string; order: OrderRow }> {
  if (!isNewerEvent(event, order)) {
    await markEvent(client, event.event_id, 'ignored_out_of_order');
    return { outcome: 'ignored_out_of_order', order };
  }

  if (Number(event.amount) !== Number(order.amount) || event.currency !== order.currency) {
    await markEvent(client, event.event_id, 'rejected_amount_or_currency_mismatch');
    await client.query(
      `INSERT INTO audit_events (idempotency_key, event_type, order_id, payload)
       VALUES ($1, 'payment_rejected', $2, $3::jsonb) ON CONFLICT DO NOTHING`,
      [`payment:${event.event_id}:rejected`, order.id, JSON.stringify({
        eventId: event.event_id,
        expectedAmount: Number(order.amount),
        receivedAmount: Number(event.amount),
        expectedCurrency: order.currency,
        receivedCurrency: event.currency,
      })],
    );
    return { outcome: 'rejected_amount_or_currency_mismatch', order };
  }

  const previousPaymentState = order.payment_state;
  let nextStatus = order.status;
  if (event.status === 'paid') {
    if (order.status === 'created' || order.status === 'payment_failed') nextStatus = 'paid';
  } else if (order.status !== 'delivered') {
    nextStatus = 'payment_failed';
  }

  const updated = await client.query<OrderRow>(
    `UPDATE orders SET payment_state = $2, status = $3, payment_event_id = $4,
       payment_event_created_at = $5, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [order.id, event.status, nextStatus, event.event_id, event.event_created_at],
  );
  const updatedOrder = updated.rows[0];
  if (!updatedOrder) throw new Error(`Order ${order.id} disappeared while applying payment`);

  if (event.status === 'paid' && previousPaymentState !== 'paid') {
    await postLedgerTransition(client, updatedOrder, event, 'payment_received');
  } else if (event.status === 'failed' && previousPaymentState === 'paid') {
    await postLedgerTransition(client, updatedOrder, event, 'payment_reversed');
  }

  if (event.status === 'paid' && updatedOrder.status !== 'delivered') {
    await scheduleDelivery(client, updatedOrder.id);
  }

  await markEvent(client, event.event_id, 'applied');
  await client.query(
    `INSERT INTO audit_events (idempotency_key, event_type, order_id, payload)
     VALUES ($1, 'payment_applied', $2, $3::jsonb) ON CONFLICT DO NOTHING`,
    [`payment:${event.event_id}:applied`, order.id, JSON.stringify({
      eventId: event.event_id,
      status: event.status,
      previousPaymentState,
      nextStatus,
    })],
  );
  return { outcome: 'applied', order: updatedOrder };
}

async function lockOrder(client: PoolClient, orderId: string): Promise<OrderRow | undefined> {
  const result = await client.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  return result.rows[0];
}

export async function handlePaymentWebhook(
  input: PaymentEventInput,
): Promise<{ duplicate: boolean; outcome: string }> {
  return transaction(async (client) => {
    // Serializes order creation and webhook processing even when the order row does not exist yet.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.order_id]);
    const inserted = await client.query<PaymentEventRow>(
      `INSERT INTO payment_events
        (event_id, order_id, status, amount, currency, event_created_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [input.event_id, input.order_id, input.status, input.amount, input.currency, input.created_at, JSON.stringify(input)],
    );

    if (!inserted.rowCount) {
      const existingResult = await client.query<PaymentEventRow>('SELECT * FROM payment_events WHERE event_id = $1', [input.event_id]);
      const existing = existingResult.rows[0];
      if (!existing) throw new Error(`Payment event ${input.event_id} conflict without an existing row`);
      const samePayload = existing.order_id === input.order_id
        && existing.status === input.status
        && Number(existing.amount) === input.amount
        && existing.currency === input.currency
        && existing.event_created_at.getTime() === new Date(input.created_at).getTime();
      if (!samePayload) return { duplicate: true, outcome: 'event_id_payload_conflict' };
      return { duplicate: true, outcome: existing.processing_result ?? 'awaiting_order' };
    }

    const event = inserted.rows[0];
    if (!event) throw new Error('Inserted payment event was not returned');
    const order = await lockOrder(client, input.order_id);
    if (!order) return { duplicate: false, outcome: 'awaiting_order' };
    const applied = await applyPaymentEvent(client, order, event);
    return { duplicate: false, outcome: applied.outcome };
  });
}

export async function applyPendingEventsForOrder(client: PoolClient, orderId: string): Promise<OrderRow> {
  let order = await lockOrder(client, orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  const events = await client.query<PaymentEventRow>(
    `SELECT * FROM payment_events WHERE order_id = $1 AND processed_at IS NULL
     ORDER BY event_created_at, event_id`,
    [orderId],
  );
  for (const event of events.rows) {
    const result = await applyPaymentEvent(client, order, event);
    order = result.order;
  }
  return order;
}

export async function processPendingPaymentEvents(limit = 100): Promise<number> {
  const candidates = await transaction(async (client) => {
    const result = await client.query<{ order_id: string }>(
      `SELECT DISTINCT pe.order_id FROM payment_events pe
       JOIN orders o ON o.id = pe.order_id
       WHERE pe.processed_at IS NULL
       ORDER BY pe.order_id LIMIT $1`,
      [limit],
    );
    return result.rows;
  });
  for (const candidate of candidates) {
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [candidate.order_id]);
      await applyPendingEventsForOrder(client, candidate.order_id);
    });
  }
  return candidates.length;
}
