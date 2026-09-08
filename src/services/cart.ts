import { randomUUID } from 'node:crypto';
import { getPool, transaction, type DbClient } from '../db.js';
import { applyGroupPayment, type PaymentEventRow } from './payment.js';
import { chooseOffer, sellerReport, demoScenarioNotice } from './sellers.js';
import type { Provider } from '../types.js';
import { insertOrderGroup, getOrderGroup } from './order-groups.js';

interface CartRow {
  sku: string;
  offer_id: string;
  offer_name: string;
  provider: Provider;
  seller_name: string;
  demo_scenario: string | null;
  seller_flag: string;
  purchasable: boolean;
  name: string;
  image: string;
  type: string;
  price_minor: string;
  currency: string;
  quantity: number;
  available: number;
  created_at: Date;
  updated_at: Date;
}

export type CheckoutMethod = 'points' | 'code' | 'sbp' | 'crypto';
import { createIntent } from './payment-intents.js';
import { postWalletCredit } from './wallet.js';

async function loadCart(client: DbClient, userId: string): Promise<Record<string, unknown>> {
  const result = await client.query<CartRow>(
    `SELECT ci.sku,ci.offer_id,f.name AS offer_name, p.name, p.image_path AS image, p.type, f.price_minor, f.currency, ci.quantity, ci.provider,s.display_name AS seller_name,s.demo_scenario, (p.active AND f.active AND s.banned_at IS NULL AND f.provider IS DISTINCT FROM (SELECT u.seller_id FROM users u WHERE u.id=ci.user_id) AND ci.quantity <= (SELECT count(*) FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL)) AS purchasable,
       CASE WHEN s.banned_at IS NOT NULL OR EXISTS(SELECT 1 FROM supplier_incidents si WHERE si.provider=ci.provider AND si.created_at>clock_timestamp()-interval '30 days') THEN 'red' ELSE 'none' END AS seller_flag,
       COALESCE((SELECT count(*)::integer FROM provider_inventory i
                 WHERE i.offer_id=ci.offer_id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL), 0) AS available,
       ci.created_at, ci.updated_at
     FROM cart_items ci JOIN products p ON p.sku = ci.sku
     JOIN seller_offers f ON f.id=ci.offer_id
     JOIN supplier_configs s ON s.provider=ci.provider
     WHERE ci.user_id = $1 ORDER BY ci.created_at, ci.sku`,
    [userId],
  );
  const items = result.rows.map((row) => ({
    sku: row.sku,
    offer_id: row.offer_id,
    offer_name: row.offer_name,
    provider: row.provider,
    seller_name: row.seller_name,
    demo_notice: demoScenarioNotice(row.demo_scenario),
    seller_flag: row.seller_flag,
    purchasable: row.purchasable,
    name: row.name,
    image: row.image,
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

export async function addCartItem(
  userId: string,
  sku: string,
  quantity: number,
  requestedProvider?: Provider,
  offerId?: string,
): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const product = await client.query('SELECT 1 FROM products WHERE sku = $1 AND active = true', [sku]);
    if (!product.rowCount) throw Object.assign(new Error('product_not_found'), { statusCode: 404 });
    const offer = await chooseOffer(client, sku, requestedProvider, userId, offerId);
    const existing = await client.query<{ quantity: number }>(
      'SELECT quantity FROM cart_items WHERE user_id = $1 AND sku = $2 AND offer_id=$3 FOR UPDATE',
      [userId, sku, offer.id],
    );
    const nextQuantity = Number(existing.rows[0]?.quantity ?? 0) + quantity;
    if (nextQuantity > 10) throw Object.assign(new Error('cart_item_quantity_limit_10'), { statusCode: 409 });
    await client.query(
      `INSERT INTO cart_items (user_id, sku, quantity,provider,offer_id) VALUES ($1, $2, $3,$4,$5)
       ON CONFLICT (user_id,offer_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [userId, sku, nextQuantity, offer.provider, offer.id],
    );
    return loadCart(client, userId);
  });
}

export async function setCartItem(
  userId: string,
  sku: string,
  quantity: number,
  provider?: Provider,
  offerId?: string,
): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const selected = await selectCartOffer(client, userId, sku, provider, offerId);
    const updated = await client.query(
      'UPDATE cart_items SET quantity = $3, updated_at = now() WHERE user_id = $1 AND sku = $2 AND offer_id=$4 RETURNING sku',
      [userId, sku, quantity, selected],
    );
    if (!updated.rowCount) throw Object.assign(new Error('cart_item_not_found'), { statusCode: 404 });
    return loadCart(client, userId);
  });
}

export async function removeCartItem(
  userId: string,
  sku: string,
  provider?: Provider,
  offerId?: string,
): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const selected = await selectCartOffer(client, userId, sku, provider, offerId);
    await client.query('DELETE FROM cart_items WHERE user_id = $1 AND sku = $2 AND offer_id=$3', [
      userId,
      sku,
      selected,
    ]);
    return loadCart(client, userId);
  });
}

function checkoutResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    checkout_id: row.id,
    order_id: row.group_id,
    method: row.method,
    status: row.status,
    payment_id: row.payment_intent_id ?? null,
    external_amount: Number(row.external_amount),
    total_points: Number(row.total_points),
    code_value_points: Number(row.code_value_points),
    code_applied_points: Number(row.code_applied_points),
    points_charged: Number(row.points_charged),
    balance_after: Number(row.balance_after),
    order_ids: row.order_ids,
    created_at: row.created_at,
  };
}

export async function cartQuote(
  userId: string,
  paymentCode?: string,
  paymentMethod: 'balance' | 'sbp' | 'crypto' = 'balance',
): Promise<Record<string, unknown>> {
  const userResult = await getPool().query<{ points_balance: string }>(
    'SELECT points_balance FROM users WHERE id = $1',
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });

  const cartResult = await getPool().query<{
    total_points: string;
    item_count: string;
    purchasable: boolean;
  }>(
    `SELECT COALESCE(sum(f.price_minor * ci.quantity), 0)::bigint AS total_points,
       COALESCE(sum(ci.quantity), 0)::bigint AS item_count, bool_and(p.active AND f.active AND s.banned_at IS NULL AND f.provider IS DISTINCT FROM (SELECT u.seller_id FROM users u WHERE u.id=ci.user_id) AND ci.quantity <= (SELECT count(*) FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL)) AS purchasable
     FROM cart_items ci JOIN products p ON p.sku = ci.sku
     JOIN seller_offers f ON f.id=ci.offer_id
     JOIN supplier_configs s ON s.provider=ci.provider
     WHERE ci.user_id = $1`,
    [userId],
  );
  const totalPoints = Number(cartResult.rows[0]?.total_points ?? 0);
  const itemCount = Number(cartResult.rows[0]?.item_count ?? 0);
  const purchasable = cartResult.rows[0]?.purchasable === true;
  const balance = Number(user.points_balance);
  const normalizedCode = paymentCode?.trim().toUpperCase();
  if (paymentMethod !== 'balance') {
    if (paymentCode) throw Object.assign(new Error('code_requires_balance'), { statusCode: 400 });
    return {
      code: null,
      code_status: 'none',
      code_value_points: 0,
      code_applied_points: 0,
      points_to_charge: 0,
      external_to_pay: totalPoints,
      total_points: totalPoints,
      item_count: itemCount,
      balance_before: balance,
      balance_after: balance,
      can_checkout: purchasable && itemCount > 0,
      error: itemCount === 0 ? 'cart_is_empty' : !purchasable ? 'cart_offer_unavailable' : null,
      payment_method: paymentMethod,
    };
  }

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
      can_checkout: purchasable && itemCount > 0 && balance >= pointsToCharge,
      error:
        itemCount === 0
          ? 'cart_is_empty'
          : !purchasable
            ? 'cart_offer_unavailable'
            : balance < pointsToCharge
              ? 'insufficient_points'
              : null,
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
    can_checkout: purchasable && itemCount > 0 && balance >= pointsToCharge,
    error:
      itemCount === 0
        ? 'cart_is_empty'
        : !purchasable
          ? 'cart_offer_unavailable'
          : balance < pointsToCharge
            ? 'insufficient_points'
            : null,
  };
}

export async function checkoutCart(
  userId: string,
  checkoutId: string,
  paymentCode?: string,
  paymentMethod: 'balance' | 'sbp' | 'crypto' = 'balance',
): Promise<Record<string, unknown>> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [checkoutId]);
    const existing = await client.query('SELECT * FROM checkouts WHERE id = $1', [checkoutId]);
    if (existing.rows[0]) {
      if (existing.rows[0].user_id !== userId) {
        throw Object.assign(new Error('checkout_id_conflict'), { statusCode: 409 });
      }
      const expectedMethod =
        paymentMethod === 'balance' ? (paymentCode?.trim() ? 'code' : 'points') : paymentMethod;
      if (existing.rows[0].method !== expectedMethod)
        throw Object.assign(new Error('checkout_id_payload_conflict'), { statusCode: 409 });
      if ((existing.rows[0].payment_code ?? undefined) !== (paymentCode?.trim().toUpperCase() || undefined)) {
        throw Object.assign(new Error('checkout_id_payload_conflict'), { statusCode: 409 });
      }
      return checkoutResponse(existing.rows[0]);
    }

    const userResult = await client.query<{ points_balance: string }>(
      'SELECT points_balance FROM users WHERE id = $1 AND banned_at IS NULL FOR UPDATE',
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });

    const cartResult = await client.query<CartRow>(
      `SELECT ci.sku,ci.offer_id,f.name AS offer_name, p.name, p.image_path AS image, p.type, f.price_minor, f.currency, ci.quantity, ci.provider,s.display_name AS seller_name,s.demo_scenario, (p.active AND f.active AND s.banned_at IS NULL AND f.provider IS DISTINCT FROM (SELECT u.seller_id FROM users u WHERE u.id=ci.user_id) AND ci.quantity <= (SELECT count(*) FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL)) AS purchasable,
       CASE WHEN s.banned_at IS NOT NULL OR EXISTS(SELECT 1 FROM supplier_incidents si WHERE si.provider=ci.provider AND si.created_at>clock_timestamp()-interval '30 days') THEN 'red' ELSE 'none' END AS seller_flag,
         0::integer AS available, ci.created_at, ci.updated_at
       FROM cart_items ci JOIN products p ON p.sku = ci.sku
     JOIN seller_offers f ON f.id=ci.offer_id
     JOIN supplier_configs s ON s.provider=ci.provider
       WHERE ci.user_id = $1 ORDER BY ci.created_at, ci.sku FOR UPDATE OF ci FOR SHARE OF f, s`,
      [userId],
    );
    if (!cartResult.rowCount) throw Object.assign(new Error('cart_is_empty'), { statusCode: 409 });
    if (cartResult.rows.some((row) => !row.purchasable))
      throw Object.assign(new Error('cart_offer_unavailable'), { statusCode: 409 });
    const totalPoints = cartResult.rows.reduce(
      (sum, item) => sum + Number(item.price_minor) * item.quantity,
      0,
    );
    if (paymentMethod !== 'balance') {
      if (paymentCode) throw Object.assign(new Error('code_requires_balance'), { statusCode: 400 });
      const orderIds = await insertOrderGroup(
        client,
        cartResult.rows.map((item) => ({
          sku: item.sku,
          quantity: item.quantity,
          provider: item.provider,
          offer_id: item.offer_id,
        })),
        checkoutId,
        userId,
        paymentMethod,
      );
      const intent = await createIntent(client, {
        id: `pay_${randomUUID().replaceAll('-', '')}`,
        userId,
        purpose: 'checkout',
        method: paymentMethod,
        amount: totalPoints,
        groupId: checkoutId,
      });
      const checkout = (
        await client.query(
          `INSERT INTO checkouts(id,user_id,method,total_points,code_value_points,code_applied_points,points_charged,balance_after,order_ids,group_id,status,external_amount,payment_intent_id)
        VALUES($1,$2,$3,$4,0,0,0,$5,$6,$1,'pending',$4,$7) RETURNING *`,
          [
            checkoutId,
            userId,
            paymentMethod,
            totalPoints,
            user.points_balance,
            JSON.stringify(orderIds),
            intent.id,
          ],
        )
      ).rows[0];
      await client.query('DELETE FROM cart_items WHERE user_id=$1', [userId]);
      return checkoutResponse(checkout);
    }
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

    if (balanceAfter < pointsCharged)
      throw Object.assign(new Error('insufficient_points'), { statusCode: 409 });
    balanceAfter -= pointsCharged;
    if (pointsCharged > 0) {
      await client.query('UPDATE users SET points_balance = $2, updated_at = now() WHERE id = $1', [
        userId,
        balanceAfter,
      ]);
    }
    if (normalizedCode) {
      await client.query('UPDATE payment_codes SET used_by = $2, used_at = now() WHERE code = $1', [
        normalizedCode,
        userId,
      ]);
    }

    const orderIds = await insertOrderGroup(
      client,
      cartResult.rows.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        provider: item.provider,
        offer_id: item.offer_id,
      })),
      checkoutId,
      userId,
      'wallet',
    );
    await postWalletCredit(client, userId, codeAppliedPoints, 'code_credit', `code:${checkoutId}`);
    const eventId = `evt_checkout_${checkoutId}`;
    const event = await client.query<PaymentEventRow>(
      `INSERT INTO payment_events
      (event_id,order_id,status,amount,currency,event_created_at,payload)
      VALUES ($1,$2,'paid',$3,$4,clock_timestamp(),$5) RETURNING *`,
      [
        eventId,
        checkoutId,
        totalPoints,
        cartResult.rows[0]!.currency,
        JSON.stringify({ source: `cart_${method}`, checkout_id: checkoutId }),
      ],
    );
    await applyGroupPayment(client, event.rows[0]!);

    const checkout = await client.query(
      `INSERT INTO checkouts
       (id, user_id, method, total_points, payment_code, code_value_points,
        code_applied_points, points_charged, balance_after, order_ids, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $1) RETURNING *`,
      [
        checkoutId,
        userId,
        method,
        totalPoints,
        normalizedCode ?? null,
        codeValuePoints,
        codeAppliedPoints,
        pointsCharged,
        balanceAfter,
        JSON.stringify(orderIds),
      ],
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
    `SELECT o.id, o.sku,o.assigned_offer_id,o.offer_name, p.name, p.image_path AS image, p.type, o.amount::bigint AS amount, o.currency,
       'wallet'::text AS refund_destination,o.group_id, o.status, o.payment_state, o.created_at, o.delivered_at,
       d.provider, CASE WHEN o.status='refunded' THEN NULL ELSE d.code END AS code
     FROM orders o JOIN products p ON p.sku = o.sku
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC, o.id DESC`,
    [userId],
  );
  return {
    purchases: result.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
    orders: await Promise.all(
      [...new Set(result.rows.map((r) => r.group_id).filter(Boolean))].map((id) =>
        getOrderGroup(id, undefined, userId),
      ),
    ),
  };
}

export async function purchaseDetail(
  userId: string,
  orderId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await getPool().query(
    `SELECT o.id, o.sku,o.assigned_offer_id,o.offer_name, p.name, p.image_path AS image, p.type, p.image_path, p.description, p.features,
       o.amount::bigint AS amount,
       'wallet'::text AS refund_destination,o.currency, o.group_id, o.status, o.payment_state, o.created_at, o.delivered_at,
       d.request_id, COALESCE(d.provider,o.assigned_provider) AS provider, CASE WHEN o.status='refunded' THEN NULL ELSE d.code END AS code,
       (SELECT to_jsonb(r) FROM seller_reviews r WHERE r.order_id=o.id) AS review,
       (o.status IN ('delivered','refunded') AND NOT EXISTS(SELECT 1 FROM seller_reviews r WHERE r.order_id=o.id)) AS can_review
     FROM orders o JOIN products p ON p.sku = o.sku
     LEFT JOIN deliveries d ON d.order_id = o.id
     WHERE o.user_id = $1 AND o.id = $2`,
    [userId, orderId],
  );
  const row = result.rows[0];
  return row
    ? { ...row, amount: Number(row.amount), seller: row.provider ? await sellerReport(row.provider) : null }
    : undefined;
}

export async function addPaymentCodes(
  codes: string[],
  valuePoints: number,
): Promise<Record<string, unknown>> {
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

async function selectCartOffer(
  client: DbClient,
  userId: string,
  sku: string,
  provider?: Provider,
  offerId?: string,
): Promise<string> {
  const rows = await client.query(
    'SELECT offer_id FROM cart_items WHERE user_id=$1 AND sku=$2 AND ($3::text IS NULL OR provider=$3) AND ($4::text IS NULL OR offer_id=$4)',
    [userId, sku, provider ?? null, offerId ?? null],
  );
  if (rows.rowCount && rows.rowCount > 1)
    throw Object.assign(new Error('select_cart_item_offer'), { statusCode: 409 });
  if (!rows.rowCount) throw Object.assign(new Error('cart_item_not_found'), { statusCode: 404 });
  return rows.rows[0].offer_id;
}
