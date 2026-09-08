import { randomUUID } from 'node:crypto';
import { transaction, getPool } from '../db.js';
import type { OrderRow } from '../types.js';
import { applyPendingEventsForOrder } from './payment.js';

export function publicOrderId(): string {
  return `ord_${randomUUID().replaceAll('-', '')}`;
}

export async function createOrder(sku: string, requestedId?: string): Promise<OrderRow> {
  const orderId = requestedId ?? publicOrderId();
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
    const groupExists = await client.query('SELECT 1 FROM order_groups WHERE id=$1', [orderId]);
    if (groupExists.rowCount) throw Object.assign(new Error('order_id_conflict'), { statusCode: 409 });
    const productResult = await client.query<{ sku: string; price_minor: string; currency: string }>(
      'SELECT sku, price_minor, currency FROM products WHERE sku = $1 AND active = true',
      [sku],
    );
    const product = productResult.rows[0];
    if (!product) throw Object.assign(new Error(`Unknown or inactive SKU: ${sku}`), { statusCode: 404 });
    try {
      await client.query(`INSERT INTO orders (id, sku, amount, currency) VALUES ($1, $2, $3, $4)`, [
        orderId,
        sku,
        product.price_minor,
        product.currency,
      ]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw Object.assign(new Error(`Order id already exists: ${orderId}`), { statusCode: 409 });
      }
      throw error;
    }
    return applyPendingEventsForOrder(client, orderId);
  });
}

export async function getOrder(orderId: string): Promise<Record<string, unknown> | undefined> {
  const result = await getPool().query(
    `SELECT o.id, o.sku, p.name, o.amount::bigint AS amount, o.currency, o.status,
       o.group_id,o.assigned_offer_id,o.offer_name, o.assigned_provider, o.payment_state, o.payment_event_id, o.version::bigint AS version,
       o.created_at, o.updated_at, o.delivered_at,
       d.request_id, d.provider, CASE WHEN o.status='refunded' THEN NULL ELSE d.code END AS code,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'provider', da.provider, 'attempt', da.attempt_no, 'outcome', da.outcome,
         'latency_ms', da.latency_ms, 'created_at', da.created_at
       ) ORDER BY da.id) FROM delivery_attempts da WHERE da.order_id = o.id), '[]'::jsonb) AS delivery_attempts
     FROM orders o
     JOIN products p ON p.sku = o.sku
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return { ...row, amount: Number(row.amount), version: Number(row.version) };
}
