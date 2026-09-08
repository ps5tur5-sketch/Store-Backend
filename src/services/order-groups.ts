import type { PoolClient } from 'pg';
import { getPool, transaction } from '../db.js';
import { publicOrderId } from './orders.js';
import { applyPendingGroupEvents } from './payment.js';
import { reserveGroupKeys } from './lots.js';
import { chooseOffer } from './sellers.js';
import type { Provider } from '../types.js';

export interface OrderItemInput {
  sku: string;
  quantity: number;
  provider?: Provider;
  offer_id?: string;
}

export async function insertOrderGroup(
  client: PoolClient,
  items: OrderItemInput[],
  groupId: string,
  userId?: string,
  fundingSource: 'wallet' | 'sbp' | 'crypto' | 'payment_stub' = 'payment_stub',
) {
  const products = await client.query('SELECT * FROM products WHERE sku = ANY($1) AND active = true', [
    items.map((i) => i.sku),
  ]);
  const bySku = new Map(products.rows.map((p) => [p.sku, p]));
  if (items.some((i) => !bySku.has(i.sku)))
    throw Object.assign(new Error('product_not_found'), { statusCode: 404 });
  const offers = await Promise.all(
    items.map((i) => chooseOffer(client, i.sku, i.provider, userId, i.offer_id)),
  );
  const currencies = new Set(offers.map((p) => p.currency));
  if (currencies.size !== 1) throw Object.assign(new Error('mixed_currencies'), { statusCode: 400 });
  const amount = items.reduce(
    (sum, i) => sum + Number(offers[items.indexOf(i)]!.price_minor) * i.quantity,
    0,
  );
  if (!Number.isSafeInteger(amount))
    throw Object.assign(new Error('order_amount_too_large'), { statusCode: 400 });
  await client.query(
    `INSERT INTO order_groups(id,user_id,amount,currency,request_fingerprint) VALUES ($1,$2,$3,$4,$5)`,
    [groupId, userId ?? null, amount, [...currencies][0], JSON.stringify(items)],
  );
  const orderIds: string[] = [];
  for (const item of items) {
    const p = offers[items.indexOf(item)]!;
    for (let unit = 0; unit < item.quantity; unit++) {
      const id = publicOrderId();
      await client.query(
        `INSERT INTO orders(id,sku,amount,currency,user_id,group_id,assigned_provider,funding_source,assigned_offer_id,offer_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          item.sku,
          p.price_minor,
          p.currency,
          userId ?? null,
          groupId,
          p.provider,
          fundingSource,
          p.id,
          p.name,
        ],
      );
      orderIds.push(id);
    }
  }
  if (userId) await reserveGroupKeys(client, groupId);
  return orderIds;
}

export async function createOrderGroup(items: OrderItemInput[], groupId = publicOrderId()) {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [groupId]);
    const existing = await client.query('SELECT request_fingerprint FROM order_groups WHERE id=$1', [
      groupId,
    ]);
    if (existing.rows[0]) {
      const equal = await client.query(
        'SELECT request_fingerprint = $2::jsonb AS same FROM order_groups WHERE id=$1',
        [groupId, JSON.stringify(items)],
      );
      if (!equal.rows[0].same)
        throw Object.assign(new Error('order_id_payload_conflict'), { statusCode: 409 });
      return;
    }
    const collision = await client.query('SELECT 1 FROM orders WHERE id=$1', [groupId]);
    if (collision.rowCount) throw Object.assign(new Error('order_id_conflict'), { statusCode: 409 });
    await insertOrderGroup(client, items, groupId);
    await applyPendingGroupEvents(client, groupId);
  });
  return getOrderGroup(groupId);
}

function summarize(items: Record<string, any>[]) {
  const paid = items.reduce((n, i) => n + (i.payment_state === 'paid' ? Number(i.amount) : 0), 0);
  const delivered = items.reduce((n, i) => n + (i.status === 'delivered' ? Number(i.amount) : 0), 0);
  const refunded = items.reduce((n, i) => n + (i.status === 'refunded' ? Number(i.amount) : 0), 0);
  const completed = items.filter((i) => ['delivered', 'refunded'].includes(i.status)).length;
  const refundPending = items.some((i) => i.refund_requested && i.status !== 'refunded');
  const terminal = items.length > 0 && completed === items.length && !refundPending;
  const status = terminal
    ? refunded === 0
      ? 'delivered'
      : delivered === 0
        ? 'refunded'
        : 'partially_refunded'
    : refundPending
      ? 'refund_pending'
      : paid > 0
        ? 'processing'
        : items.some((i) => i.payment_state === 'failed')
          ? 'payment_failed'
          : 'created';
  return {
    status,
    terminal,
    payment_state: paid > 0 ? 'paid' : status === 'payment_failed' ? 'failed' : 'pending',
    money: {
      paid,
      delivered,
      refunded,
      pending: paid - delivered - refunded,
      balanced: paid >= delivered + refunded,
      settled: terminal && paid === delivered + refunded,
    },
    refund_details: {
      revoked_keys: items.filter((i) => i.status === 'refunded' && i.delivered_at).length,
      unissued_items: items.filter((i) => i.status === 'refunded' && !i.delivered_at).length,
    },
    progress: {
      total: items.length,
      completed,
      delivered: items.filter((i) => i.status === 'delivered').length,
      refunded: items.filter((i) => i.status === 'refunded').length,
      queued: items.length - completed,
    },
  };
}

export async function getOrderGroup(groupId: string, at?: string, userId?: string) {
  // A single SQL statement gives metadata and all positions the same MVCC snapshot.
  const result = await getPool().query(
    `SELECT g.*,c.payment_intent_id,c.method AS payment_method,c.status AS checkout_status,to_char(business_commit_time(go.operation_key) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_created_at,
      CASE WHEN EXISTS(SELECT 1 FROM order_history h JOIN history_operations ho ON ho.history_id=h.id
        JOIN business_operations bo ON bo.operation_key=ho.operation_key WHERE h.group_id=g.id AND bo.transaction_id IS NULL)
        THEN 'legacy_reconstructed' ELSE 'commit_time' END AS history_precision,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.name,'image',p.image_path,'type',p.type,'seller_name',seller.display_name) || s.snapshot ORDER BY s.order_id)
      FROM (SELECT DISTINCT ON (h.order_id) h.order_id,h.snapshot FROM order_history h
        JOIN history_operations ho ON ho.history_id=h.id
        WHERE h.group_id=g.id AND ($2::timestamptz IS NULL OR business_commit_time(ho.operation_key)<=$2)
        ORDER BY h.order_id,h.id DESC) s JOIN products p ON p.sku=s.snapshot->>'sku'
        LEFT JOIN supplier_configs seller ON seller.provider=s.snapshot->>'assigned_provider'), '[]') AS items
    FROM order_groups g JOIN group_operations go ON go.group_id=g.id LEFT JOIN checkouts c ON c.group_id=g.id
    WHERE g.id=$1 AND ($2::timestamptz IS NULL OR business_commit_time(go.operation_key)<=$2)
    AND ($3::text IS NULL OR g.user_id=$3)`,
    [groupId, at ?? null, userId ?? null],
  );
  const group = result.rows[0];
  if (!group) return undefined;
  const items = group.items.map((i: Record<string, any>) => ({ ...i, amount: Number(i.amount) }));
  return {
    id: group.id,
    amount: Number(group.amount),
    currency: group.currency,
    created_at: group.effective_created_at,
    history_precision: group.history_precision,
    ...(!at
      ? {
          payment_id: group.payment_intent_id ?? null,
          payment_method: group.payment_method ?? 'payment_stub',
          checkout_status: group.checkout_status ?? null,
          refund_destination: group.user_id ? 'wallet' : 'payment_stub',
        }
      : {}),
    ...summarize(items),
    items,
    as_of: at ?? null,
  };
}

export async function orderAt(orderId: string, at: string) {
  const group = await getOrderGroup(orderId, at);
  if (group) return group;
  const result = await getPool().query(
    `SELECT h.snapshot,CASE WHEN bo.transaction_id IS NULL THEN 'legacy_reconstructed' ELSE 'commit_time' END AS history_precision
     FROM order_history h JOIN history_operations ho ON ho.history_id=h.id JOIN business_operations bo ON bo.operation_key=ho.operation_key
     WHERE h.order_id=$1 AND business_commit_time(ho.operation_key)<=$2 ORDER BY h.id DESC LIMIT 1`,
    [orderId, at],
  );
  const snapshot = result.rows[0]?.snapshot;
  return snapshot
    ? {
        ...summarize([snapshot]),
        ...snapshot,
        amount: Number(snapshot.amount),
        as_of: at,
        history_precision: result.rows[0].history_precision,
      }
    : undefined;
}

export async function moneyReport(from: string, to: string) {
  const result = await getPool().query(
    `SELECT le.currency,le.account,
      COALESCE(sum(le.amount) FILTER(WHERE business_commit_time(lo.operation_key)<$1),0)::text AS opening,
      COALESCE(sum(le.amount) FILTER(WHERE business_commit_time(lo.operation_key)>=$1),0)::text AS movement,
      sum(le.amount)::text AS closing,
      CASE WHEN bool_or(bo.transaction_id IS NULL) THEN 'legacy_reconstructed' ELSE 'commit_time' END AS history_precision
     FROM ledger_entries le JOIN ledger_operations lo ON lo.ledger_id=le.transaction_id
     JOIN business_operations bo ON bo.operation_key=lo.operation_key
     WHERE business_commit_time(lo.operation_key)<$2 GROUP BY le.currency,le.account ORDER BY le.currency,le.account`,
    [from, to],
  );
  return {
    from,
    to,
    interval: '[from,to)',
    accounts: result.rows.map((r) => ({
      ...r,
      opening: Number(r.opening),
      movement: Number(r.movement),
      closing: Number(r.closing),
    })),
  };
}

export async function queueReport() {
  const result = await getPool().query(`SELECT j.provider,
    count(*) FILTER (WHERE j.state IN ('pending','retry'))::int AS queued,
    count(*) FILTER (WHERE j.state='processing')::int AS processing,
    count(*) FILTER (WHERE o.status='delivered')::int AS delivered,
    count(*) FILTER (WHERE o.status='refunded')::int AS refunded,
    min(j.next_attempt_at) FILTER (WHERE j.state IN ('pending','retry')) AS next_attempt_at
    FROM delivery_jobs j JOIN orders o ON o.id=j.order_id GROUP BY j.provider ORDER BY j.provider`);
  const limits = await getPool().query(`SELECT s.provider,s.requests_per_minute,
    (SELECT count(*)::int FROM supplier_requests r WHERE r.provider=s.provider AND r.requested_at>clock_timestamp()-interval '60 seconds') AS requests_last_minute
    FROM supplier_configs s ORDER BY s.provider`);
  const unpaid = await getPool().query(
    `SELECT count(*)::int AS count FROM orders WHERE payment_state='pending'`,
  );
  return { providers: result.rows, limits: limits.rows, unpaid: unpaid.rows[0].count };
}
