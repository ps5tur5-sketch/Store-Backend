import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, transaction, type DbClient } from '../db.js';
import type { OrderRow, PaymentEventInput } from '../types.js';
import { publicOrderId } from './orders.js';
import { applyPaymentEvent, type PaymentEventRow } from './payment.js';

interface CartRow {
  sku: string;
  name: string;
  type: string;
  price_minor: string;
  currency: string;
  quantity: number;
  available: number;
  created_at: Date;
  updated_at: Date;
}

export type CheckoutMethod = 'points' | 'code';

async function loadCart(client: DbClient, userId: string): Promise<Record<string, unknown>> {
  const result = await client.query<CartRow>(
    `SELECT ci.sku, p.name, p.type, p.price_minor, p.currency, ci.quantity,
       COALESCE((SELECT count(*)::integer FROM provider_inventory i
                 WHERE i.sku = ci.sku AND i.claimed_by IS NULL), 0) AS available,
       ci.created_at, ci.updated_at
     FROM cart_items ci JOIN products p ON p.sku = ci.sku
     WHERE ci.user_id = $1 ORDER BY ci.created_at, ci.sku`,
    [userId],
  );
  const items = result.rows.map((row) => ({
    sku: row.sku,
    name: row.name,
    type: row.type,
    price: Number(row.price_minor),
    currency: row.currency,
    quantity: row.quantity,
    available: row.available,
    line_total: Number(row.price_minor) * row.quantity,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return {
    items,
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    total_points: items.reduce((sum, item) => sum + item.line_total, 0),
  };
}

export async function cartReport(userId: string): Promise<Record<string, unknown>> {
  return loadCart(getPool(), userId);
}

export async function addCartItem(userId: string, sku: string, quantity: number): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    const product = await client.query('SELECT 1 FROM products WHERE sku = $1 AND active = true', [sku]);
    if (!product.rowCount) throw Object.assign(new Error('product_not_found'), { statusCode: 404 });
    const existing = await client.query<{ quantity: number }>(
      'SELECT quantity FROM cart_items WHERE user_id = $1 AND sku = $2 FOR UPDATE',
      [userId, sku],
    );
    const nextQuantity = Number(existing.rows[0]?.quantity ?? 0) + quantity;
    if (nextQuantity > 10) throw Object.assign(new Error('cart_item_quantity_limit_10'), { statusCode: 409 });
    await client.query(
      `INSERT INTO cart_items (user_id, sku, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, sku) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [userId, sku, nextQuantity],
    );
    return loadCart(client, userId);
  });
}

export async function setCartItem(userId: string, sku: string, quantity: number): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    const updated = await client.query(
      'UPDATE cart_items SET quantity = $3, updated_at = now() WHERE user_id = $1 AND sku = $2 RETURNING sku',
      [userId, sku, quantity],
    );
    if (!updated.rowCount) throw Object.assign(new Error('cart_item_not_found'), { statusCode: 404 });
    return loadCart(client, userId);
  });
}

export async function removeCartItem(userId: string, sku: string): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('DELETE FROM cart_items WHERE user_id = $1 AND sku = $2', [userId, sku]);
    return loadCart(client, userId);
  });
}

function checkoutResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    checkout_id: row.id,
    method: row.method,
    total_points: Number(row.total_points),
    code_value_points: Number(row.code_value_points),
    code_applied_points: Number(row.code_applied_points),
    points_charged: Number(row.points_charged),
    balance_after: Number(row.balance_after),
    order_ids: row.order_ids,
    created_at: row.created_at,
  };
}

export async function cartQuote(userId: string, paymentCode?: string): Promise<Record<string, unknown>> {
  const userResult = await getPool().query<{ points_balance: string }>(
    'SELECT points_balance FROM users WHERE id = $1',
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });

  const cartResult = await getPool().query<{ total_points: string; item_count: string }>(
    `SELECT COALESCE(sum(p.price_minor * ci.quantity), 0)::bigint AS total_points,
       COALESCE(sum(ci.quantity), 0)::bigint AS item_count
     FROM cart_items ci JOIN products p ON p.sku = ci.sku
     WHERE ci.user_id = $1 AND p.active = true`,
    [userId],
  );
  const totalPoints = Number(cartResult.rows[0]?.total_points ?? 0);
  const itemCount = Number(cartResult.rows[0]?.item_count ?? 0);
  const balance = Number(user.points_balance);
  const normalizedCode = paymentCode?.trim().toUpperCase();

  if (!normalizedCode) {
    const pointsToCharge = totalPoints;
    return {
      code: null,
      code_status: 'none',
      code_value_points: 0,
      code_applied_points: 0,
      points_to_charge: pointsToCharge,
      total_points: totalPoints,
      item_count: itemCount,
      balance_before: balance,
      balance_after: balance - pointsToCharge,
      can_checkout: itemCount > 0 && balance >= pointsToCharge,
      error: itemCount === 0 ? 'cart_is_empty' : balance < pointsToCharge ? 'insufficient_points' : null,
    };
  }

  const codeResult = await getPool().query<{
    value_points: string;
    used_by: string | null;
    source_sku: string | null;
    source_name: string | null;
  }>(
    `SELECT pc.value_points, pc.used_by, pc.source_sku, p.name AS source_name
     FROM payment_codes pc LEFT JOIN products p ON p.sku = pc.source_sku
     WHERE pc.code = $1`,
    [normalizedCode],
  );
  const code = codeResult.rows[0];
  if (!code || code.used_by) {
    return {
      code: normalizedCode,
      code_status: !code ? 'not_found' : 'used',
      code_value_points: code ? Number(code.value_points) : 0,
      code_source_sku: code?.source_sku ?? null,
      code_source_name: code?.source_name ?? null,
      code_applied_points: 0,
      points_to_charge: totalPoints,
      total_points: totalPoints,
      item_count: itemCount,
      balance_before: balance,
      balance_after: balance - totalPoints,
      can_checkout: false,
      error: !code ? 'payment_code_not_found' : 'payment_code_already_used',
    };
  }

  const codeValue = Number(code.value_points);
  const codeApplied = Math.min(codeValue, totalPoints);
  const pointsToCharge = totalPoints - codeApplied;
  return {
    code: normalizedCode,
    code_status: 'valid',
    code_value_points: codeValue,
    code_source_sku: code.source_sku,
    code_source_name: code.source_name,
    code_applied_points: codeApplied,
    points_to_charge: pointsToCharge,
    total_points: totalPoints,
    item_count: itemCount,
    balance_before: balance,
    balance_after: balance - pointsToCharge,
    can_checkout: itemCount > 0 && balance >= pointsToCharge,
    error: itemCount === 0 ? 'cart_is_empty' : balance < pointsToCharge ? 'insufficient_points' : null,
  };
}

async function createPaidOrder(
  client: PoolClient,
  userId: string,
  item: CartRow,
  checkoutId: string,
  unitIndex: number,
  method: CheckoutMethod,
): Promise<string> {
  const orderId = publicOrderId();
  const insertedOrder = await client.query<OrderRow>(
    `INSERT INTO orders (id, sku, amount, currency, user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orderId, item.sku, item.price_minor, item.currency, userId],
  );
  const order = insertedOrder.rows[0];
  if (!order) throw new Error('Checkout order was not returned');

  const eventInput: PaymentEventInput = {
    event_id: `evt_checkout_${checkoutId}_${unitIndex}`,
    order_id: orderId,
    status: 'paid',
    amount: Number(item.price_minor),
    currency: item.currency,
    created_at: new Date().toISOString(),
  };
  const insertedEvent = await client.query<PaymentEventRow>(
    `INSERT INTO payment_events
      (event_id, order_id, status, amount, currency, event_created_at, payload)
     VALUES ($1, $2, 'paid', $3, $4, $5, $6::jsonb) RETURNING *`,
    [
      eventInput.event_id,
      orderId,
      eventInput.amount,
      eventInput.currency,
      eventInput.created_at,
      JSON.stringify({ ...eventInput, source: `cart_${method}`, checkout_id: checkoutId }),
    ],
  );
  const event = insertedEvent.rows[0];
  if (!event) throw new Error('Checkout payment event was not returned');
  await applyPaymentEvent(client, order, event);
  return orderId;
}

export async function checkoutCart(
  userId: string,
  checkoutId: string,
  paymentCode?: string,
): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [checkoutId]);
    const existing = await client.query('SELECT * FROM checkouts WHERE id = $1', [checkoutId]);
    if (existing.rows[0]) {
      if (existing.rows[0].user_id !== userId) {
        throw Object.assign(new Error('checkout_id_conflict'), { statusCode: 409 });
      }
      return checkoutResponse(existing.rows[0]);
    }

    const userResult = await client.query<{ points_balance: string }>(
      'SELECT points_balance FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });

    const cartResult = await client.query<CartRow>(
      `SELECT ci.sku, p.name, p.type, p.price_minor, p.currency, ci.quantity,
         0::integer AS available, ci.created_at, ci.updated_at
       FROM cart_items ci JOIN products p ON p.sku = ci.sku
       WHERE ci.user_id = $1 AND p.active = true ORDER BY ci.created_at, ci.sku FOR UPDATE OF ci`,
      [userId],
    );
    if (!cartResult.rowCount) throw Object.assign(new Error('cart_is_empty'), { statusCode: 409 });
    const totalPoints = cartResult.rows.reduce((sum, item) => sum + Number(item.price_minor) * item.quantity, 0);
    let balanceAfter = Number(user.points_balance);
    const normalizedCode = paymentCode?.trim().toUpperCase() || undefined;
    const method: CheckoutMethod = normalizedCode ? 'code' : 'points';
    let codeValuePoints = 0;
    let codeAppliedPoints = 0;
    let pointsCharged = totalPoints;

    if (normalizedCode) {
      const codeResult = await client.query<{ value_points: string; used_by: string | null }>(
        'SELECT value_points, used_by FROM payment_codes WHERE code = $1 FOR UPDATE',
        [normalizedCode],
      );
      const code = codeResult.rows[0];
      if (!code) throw Object.assign(new Error('payment_code_not_found'), { statusCode: 404 });
      if (code.used_by) throw Object.assign(new Error('payment_code_already_used'), { statusCode: 409 });
      codeValuePoints = Number(code.value_points);
      codeAppliedPoints = Math.min(codeValuePoints, totalPoints);
      pointsCharged = totalPoints - codeAppliedPoints;
    }

    if (balanceAfter < pointsCharged) throw Object.assign(new Error('insufficient_points'), { statusCode: 409 });
    balanceAfter -= pointsCharged;
    if (pointsCharged > 0) {
      await client.query('UPDATE users SET points_balance = $2, updated_at = now() WHERE id = $1', [userId, balanceAfter]);
    }
    if (normalizedCode) {
      await client.query(
        'UPDATE payment_codes SET used_by = $2, used_at = now() WHERE code = $1',
        [normalizedCode, userId],
      );
    }

    const orderIds: string[] = [];
    let unitIndex = 0;
    for (const item of cartResult.rows) {
      for (let quantityIndex = 0; quantityIndex < item.quantity; quantityIndex += 1) {
        unitIndex += 1;
        orderIds.push(await createPaidOrder(client, userId, item, checkoutId, unitIndex, method));
      }
    }

    const checkout = await client.query(
      `INSERT INTO checkouts
       (id, user_id, method, total_points, payment_code, code_value_points,
        code_applied_points, points_charged, balance_after, order_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
      [checkoutId, userId, method, totalPoints, normalizedCode ?? null, codeValuePoints,
        codeAppliedPoints, pointsCharged, balanceAfter, JSON.stringify(orderIds)],
    );
    if (pointsCharged > 0) {
      await client.query(
        `INSERT INTO point_transactions (id, user_id, checkout_id, kind, amount, balance_after)
         VALUES ($1, $2, $3, 'cart_purchase', $4, $5)`,
        [`points:checkout:${checkoutId}`, userId, checkoutId, -pointsCharged, balanceAfter],
      );
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    const row = checkout.rows[0];
    if (!row) throw new Error('Checkout was not returned');
    return checkoutResponse(row);
  });
}

export async function purchaseHistory(userId: string): Promise<Record<string, unknown>> {
  const result = await getPool().query(
    `SELECT o.id, o.sku, p.name, p.type, o.amount::bigint AS amount, o.currency,
       o.status, o.payment_state, o.created_at, o.delivered_at,
       d.provider, d.code
     FROM orders o JOIN products p ON p.sku = o.sku
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC, o.id DESC`,
    [userId],
  );
  return {
    purchases: result.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
  };
}

export async function purchaseDetail(userId: string, orderId: string): Promise<Record<string, unknown> | undefined> {
  const result = await getPool().query(
    `SELECT o.id, o.sku, p.name, p.type, p.image_path, p.description, p.features,
       o.amount::bigint AS amount,
       o.currency, o.status, o.payment_state, o.created_at, o.delivered_at,
       d.request_id, d.provider, d.code
     FROM orders o JOIN products p ON p.sku = o.sku
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.user_id = $1 AND o.id = $2`,
    [userId, orderId],
  );
  const row = result.rows[0];
  return row ? { ...row, amount: Number(row.amount) } : undefined;
}

export async function addPaymentCodes(codes: string[], valuePoints: number): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    const inserted: string[] = [];
    const duplicates: string[] = [];
    for (const input of [...new Set(codes.map((code) => code.trim().toUpperCase()))]) {
      const result = await client.query<{ code: string }>(
        `INSERT INTO payment_codes (code, value_points) VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING RETURNING code`,
        [input, valuePoints],
      );
      if (result.rows[0]) inserted.push(result.rows[0].code);
      else duplicates.push(input);
    }
    return { inserted, duplicates, value_points: valuePoints };
  });
}

export async function paymentCodesReport(): Promise<Record<string, unknown>> {
  const result = await getPool().query(
    `SELECT pc.code, pc.value_points::bigint, pc.source_sku,
       p.name AS source_name, pc.used_at, pc.created_at,
       u.username AS used_by_username
     FROM payment_codes pc
     LEFT JOIN users u ON u.id = pc.used_by
     LEFT JOIN products p ON p.sku = pc.source_sku
     ORDER BY pc.created_at DESC, pc.code`,
  );
  return {
    codes: result.rows.map((row) => ({ ...row, value_points: Number(row.value_points) })),
  };
}

export function publicCheckoutId(): string {
  return `chk_${randomUUID().replaceAll('-', '')}`;
}
