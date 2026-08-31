import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closePool, getPool } from '../src/db.js';
import { addInventory } from '../src/services/admin.js';
import { runDeliveryBatch } from '../src/services/delivery.js';
import { reconciliationReport } from '../src/services/reconciliation.js';
import { createOrder } from '../src/services/orders.js';
import { resetBusinessData, seedDatabase } from '../src/seed.js';

let app: FastifyInstance;
let origin: string;
let config: AppConfig;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function setSupplier(provider: 'A' | 'B', mode: string, timeoutDelayMs = 500): Promise<void> {
  await getPool().query(
    `UPDATE supplier_configs SET mode = $2, failure_rate = 0, timeout_rate = 0,
     min_delay_ms = 0, timeout_delay_ms = $3, updated_at = now() WHERE provider = $1`,
    [provider, mode, timeoutDelayMs],
  );
}

async function sendPayment(order: { id: string; amount: string | number; currency: string }, options: {
  eventId?: string; status?: 'paid' | 'failed'; createdAt?: string;
} = {}): Promise<void> {
  await api('/webhook/payment', {
    method: 'POST',
    body: JSON.stringify({
      event_id: options.eventId ?? `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      order_id: order.id,
      status: options.status ?? 'paid',
      amount: Number(order.amount),
      currency: order.currency,
      created_at: options.createdAt ?? new Date().toISOString(),
    }),
  });
}

async function getOrder(id: string): Promise<Record<string, any>> {
  return api(`/api/orders/${id}`);
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://hr:hr@127.0.0.1:5432/hr';
  config = loadConfig({
    LOG_LEVEL: 'silent',
    WORKER_ENABLED: 'false',
    SUPPLIER_TIMEOUT_MS: 200,
    SUPPLIER_MAX_ATTEMPTS: 3,
    SUPPLIER_BACKOFF_MS: 5,
    SUPPLIER_BASE_URL: 'http://127.0.0.1:1',
  });
  await migrate();
  await seedDatabase(getPool());
  app = buildApp(config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  config.SUPPLIER_BASE_URL = origin;
});

beforeEach(async () => {
  await resetBusinessData(getPool());
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('adversarial acceptance scenarios', () => {
  it('handles 50 parallel paid webhooks and one duplicate with one delivery fact', async () => {
    const order = await createOrder('STEAM-TOPUP-500');
    const createdAt = new Date().toISOString();
    const payloads = Array.from({ length: 50 }, (_, index) => ({
      event_id: `evt_race_${String(index).padStart(2, '0')}`,
      order_id: order.id,
      status: 'paid',
      amount: Number(order.amount),
      currency: order.currency,
      created_at: createdAt,
    }));
    const responses = await Promise.all(payloads.map((payload) => fetch(`${origin}/webhook/payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })));
    expect(responses.every((response) => response.status === 200)).toBe(true);

    await Promise.all(Array.from({ length: 20 }, () => runDeliveryBatch(config, app.log, 1)));
    await api('/webhook/payment', { method: 'POST', body: JSON.stringify(payloads[0]) });

    const counts = await getPool().query(
      `SELECT
       (SELECT count(*)::integer FROM payment_events WHERE order_id = $1) AS events,
       (SELECT count(*)::integer FROM deliveries WHERE order_id = $1) AS deliveries,
       (SELECT count(*)::integer FROM provider_issuances WHERE order_id = $1) AS issuances,
       (SELECT count(*)::integer FROM audit_events WHERE order_id = $1 AND event_type = 'order_delivered') AS facts`,
      [order.id],
    );
    expect(counts.rows[0]).toEqual({ events: 50, deliveries: 1, issuances: 1, facts: 1 });
    expect((await getOrder(order.id)).status).toBe('delivered');
  });

  it('persists a webhook before order creation and ignores an older out-of-order failure', async () => {
    const orderId = `ord_before_${crypto.randomUUID().replaceAll('-', '')}`;
    const paidAt = new Date('2026-01-01T12:00:10.000Z').toISOString();
    await api('/webhook/payment', {
      method: 'POST', body: JSON.stringify({ event_id: 'evt_before_paid', order_id: orderId, status: 'paid', amount: 500, currency: 'RUB', created_at: paidAt }),
    });
    const order = await createOrder('STEAM-TOPUP-500', orderId);
    expect(order.payment_state).toBe('paid');
    await sendPayment(order, { eventId: 'evt_older_failed', status: 'failed', createdAt: '2026-01-01T12:00:00.000Z' });
    await runDeliveryBatch(config, app.log);
    const finalOrder = await getOrder(orderId);
    expect(finalOrder.payment_state).toBe('paid');
    expect(finalOrder.status).toBe('delivered');
    const older = await getPool().query('SELECT processing_result FROM payment_events WHERE event_id = $1', ['evt_older_failed']);
    expect(older.rows[0].processing_result).toBe('ignored_out_of_order');
  });

  it('retries the same provider/request_id after timeout-after-issue without a second issuance', async () => {
    await setSupplier('A', 'timeout_after_issue', 500);
    const order = await createOrder('KEY-CS2-PRIME');
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);

    const finalOrder = await getOrder(order.id);
    expect(finalOrder.status).toBe('delivered');
    expect(finalOrder.provider).toBe('A');
    expect(finalOrder.delivery_attempts.map((attempt: any) => attempt.outcome)).toEqual(['timeout', 'ok']);
    const issuances = await getPool().query('SELECT provider, request_id, code FROM provider_issuances WHERE order_id = $1', [order.id]);
    expect(issuances.rows).toHaveLength(1);
  });

  it('falls back from explicitly unavailable A to B and delivers once', async () => {
    await setSupplier('A', 'always_fail');
    const order = await createOrder('KEY-GTA5');
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);

    const finalOrder = await getOrder(order.id);
    expect(finalOrder.status).toBe('delivered');
    expect(finalOrder.provider).toBe('B');
    const counts = await getPool().query(
      `SELECT (SELECT count(*)::integer FROM deliveries WHERE order_id = $1) deliveries,
       (SELECT count(*)::integer FROM provider_issuances WHERE order_id = $1) issuances`,
      [order.id],
    );
    expect(counts.rows[0]).toEqual({ deliveries: 1, issuances: 1 });
  });

  it('keeps empty stock recoverable and delivers after an admin restock', async () => {
    const sku = 'KEY-EFT';
    await getPool().query(`UPDATE provider_inventory SET claimed_by = concat('test-drain:', code), claimed_at = now() WHERE sku = $1`, [sku]);
    const order = await createOrder(sku);
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('out_of_stock');

    await addInventory('A', sku, ['TEST-RESTOCK-0001']);
    await api(`/api/orders/${order.id}/retry`, { method: 'POST', body: '{}' });
    await runDeliveryBatch(config, app.log);
    const recovered = await getOrder(order.id);
    expect(recovered.status).toBe('delivered');
    expect(recovered.code).toBe('TEST-RESTOCK-0001');
  });

  it('reports delivered-but-not-paid and keeps every ledger transaction balanced', async () => {
    const order = await createOrder('SUB-DISCORD-1M');
    await sendPayment(order, { eventId: 'evt_ledger_paid', createdAt: '2026-01-01T12:00:00.000Z' });
    await runDeliveryBatch(config, app.log);
    await sendPayment(order, { eventId: 'evt_ledger_reversal', status: 'failed', createdAt: '2026-01-01T12:00:01.000Z' });

    const report = await reconciliationReport() as Record<string, any[]>;
    expect((report.delivered_not_paid ?? []).map((item) => item.order_id)).toContain(order.id);
    expect(report.ledger_imbalances).toEqual([]);
    const transactions = await getPool().query('SELECT kind FROM ledger_transactions WHERE order_id = $1 ORDER BY created_at, id', [order.id]);
    expect(transactions.rows.map((row) => row.kind).sort()).toEqual(['payment_received', 'payment_reversed']);
  });

  it('makes the supplier contract idempotent under concurrent repeats', async () => {
    const payload = { request_id: 'req_direct_concurrent', sku: 'GIFT-PSN-1000', order_id: 'ord_supplier_contract' };
    const responses = await Promise.all(Array.from({ length: 20 }, () => api<Record<string, string>>('/suppliers/A/issue', {
      method: 'POST', body: JSON.stringify(payload),
    })));
    expect(new Set(responses.map((response) => response.code)).size).toBe(1);
    const issuances = await getPool().query(
      'SELECT count(*)::integer AS count FROM provider_issuances WHERE provider = $1 AND request_id = $2',
      ['A', payload.request_id],
    );
    expect(issuances.rows[0].count).toBe(1);
  });

  it('rejects a wrong payment amount without changing the order or ledger', async () => {
    const order = await createOrder('STEAM-TOPUP-1000');
    await api('/webhook/payment', {
      method: 'POST',
      body: JSON.stringify({
        event_id: 'evt_wrong_amount', order_id: order.id, status: 'paid', amount: 1,
        currency: order.currency, created_at: new Date().toISOString(),
      }),
    });
    const unchanged = await getOrder(order.id);
    expect(unchanged.status).toBe('created');
    expect(unchanged.payment_state).toBe('pending');
    const ledger = await getPool().query('SELECT count(*)::integer AS count FROM ledger_transactions WHERE order_id = $1', [order.id]);
    expect(ledger.rows[0].count).toBe(0);
  });

  it('recovers delivery_failed after both suppliers become available', async () => {
    await setSupplier('A', 'always_fail');
    await setSupplier('B', 'always_fail');
    const order = await createOrder('GIFT-XBOX-1500');
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('delivery_failed');

    await setSupplier('A', 'normal');
    await setSupplier('B', 'normal');
    await api(`/api/orders/${order.id}/retry`, { method: 'POST', body: '{}' });
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('delivered');
    const deliveries = await getPool().query('SELECT count(*)::integer AS count FROM deliveries WHERE order_id = $1', [order.id]);
    expect(deliveries.rows[0].count).toBe(1);
  });

  it('registers by username/password with 5000 points and requires auth for the server cart', async () => {
    const registered = await api<Record<string, any>>('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'buyer_one', password: 'strong-pass-1' }),
    });
    expect(registered.user.username).toBe('buyer_one');
    expect(registered.user.points_balance).toBe(5000);
    expect(typeof registered.token).toBe('string');

    const account = await api<Record<string, any>>('/api/account', {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(account.user.points_balance).toBe(5000);
    expect(account.point_transactions).toHaveLength(1);
    expect(account.point_transactions[0].kind).toBe('registration_bonus');

    const unauthenticated = await fetch(`${origin}/api/cart`);
    expect(unauthenticated.status).toBe(401);
  });

  it('checks out a server cart with points exactly once and exposes dated clickable purchase details', async () => {
    const registered = await api<Record<string, any>>('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'points_buyer', password: 'strong-pass-2' }),
    });
    const auth = { authorization: `Bearer ${registered.token}` };
    await api('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ sku: 'STEAM-TOPUP-500', quantity: 1 }) });
    const cart = await api<Record<string, any>>('/api/cart/items', {
      method: 'POST', headers: auth, body: JSON.stringify({ sku: 'SUB-DISCORD-1M', quantity: 1 }),
    });
    expect(cart.item_count).toBe(2);
    expect(cart.total_points).toBe(899);

    const checkoutBody = JSON.stringify({ checkout_id: 'chk_points_exactly_once', code: '   ' });
    const first = await api<Record<string, any>>('/api/cart/checkout', { method: 'POST', headers: auth, body: checkoutBody });
    const duplicate = await api<Record<string, any>>('/api/cart/checkout', { method: 'POST', headers: auth, body: checkoutBody });
    expect(first.order_ids).toEqual(duplicate.order_ids);
    expect(first.order_ids).toHaveLength(2);
    expect(first.balance_after).toBe(4101);

    const account = await api<Record<string, any>>('/api/account', { headers: auth });
    expect(account.user.points_balance).toBe(4101);
    expect(account.point_transactions.filter((item: any) => item.kind === 'cart_purchase')).toHaveLength(1);
    expect((await api<Record<string, any>>('/api/cart', { headers: auth })).item_count).toBe(0);

    await runDeliveryBatch(config, app.log, 10);
    const history = await api<Record<string, any>>('/api/account/purchases', { headers: auth });
    expect(history.purchases).toHaveLength(2);
    expect(new Date(history.purchases[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(history.purchases[1].created_at).getTime());
    const detail = await api<Record<string, any>>(`/api/account/purchases/${history.purchases[0].id}`, { headers: auth });
    expect(detail.id).toBe(history.purchases[0].id);
    expect(detail.status).toBe('delivered');
    expect(typeof detail.code).toBe('string');
  });

  it('applies only the payment-code nominal, charges the remainder in points, and rejects reuse', async () => {
    const registered = await api<Record<string, any>>('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username: 'code_buyer', password: 'strong-pass-3' }),
    });
    const auth = { authorization: `Bearer ${registered.token}` };
    await api('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ sku: 'STEAM-TOPUP-2500', quantity: 3 }) });
    const quote = await api<Record<string, any>>('/api/cart/quote', {
      method: 'POST', headers: auth, body: JSON.stringify({ code: 'LFXC-TNCS-BPCD' }),
    });
    expect(quote).toMatchObject({
      code_status: 'valid', total_points: 7500, code_value_points: 5000,
      code_applied_points: 5000, points_to_charge: 2500, balance_after: 2500,
      can_checkout: true,
    });
    const checkout = await api<Record<string, any>>('/api/cart/checkout', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ checkout_id: 'chk_code_payment', code: 'LFXC-TNCS-BPCD' }),
    });
    expect(checkout.method).toBe('code');
    expect(checkout.total_points).toBe(7500);
    expect(checkout.code_value_points).toBe(5000);
    expect(checkout.code_applied_points).toBe(5000);
    expect(checkout.points_charged).toBe(2500);
    expect(checkout.balance_after).toBe(2500);
    expect(checkout.order_ids).toHaveLength(3);

    const accountAfterCheckout = await api<Record<string, any>>('/api/account', { headers: auth });
    expect(accountAfterCheckout.user.points_balance).toBe(2500);
    expect(accountAfterCheckout.point_transactions.find((item: any) => item.kind === 'cart_purchase').amount).toBe(-2500);

    await api('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ sku: 'STEAM-TOPUP-500', quantity: 1 }) });
    const reused = await fetch(`${origin}/api/cart/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ checkout_id: 'chk_code_reuse', code: 'LFXC-TNCS-BPCD' }),
    });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe('payment_code_already_used');
    expect((await api<Record<string, any>>('/api/account', { headers: auth })).user.points_balance).toBe(2500);

    const invalidQuote = await api<Record<string, any>>('/api/cart/quote', {
      method: 'POST', headers: auth, body: JSON.stringify({ code: 'NOT-IN-TZ-POOL' }),
    });
    expect(invalidQuote).toMatchObject({ code_status: 'not_found', can_checkout: false, error: 'payment_code_not_found' });
  });

  it('creates payment codes in admin and returns full catalog descriptions', async () => {
    const created = await api<Record<string, any>>('/api/admin/payment-codes', {
      method: 'POST', body: JSON.stringify({ codes: ['ADMIN-CODE-7000', 'ADMIN-CODE-7000'], value_points: 7000 }),
    });
    expect(created.inserted).toEqual(['ADMIN-CODE-7000']);
    const report = await api<Record<string, any>>('/api/admin/payment-codes');
    expect(report.codes.some((code: any) => code.code === 'ADMIN-CODE-7000' && code.value_points === 7000)).toBe(true);

    const inventoryCode = await api<Record<string, any>>('/api/admin/inventory', {
      method: 'POST', body: JSON.stringify({ provider: 'A', sku: 'KEY-CS2-PRIME', codes: ['GAME-CODE-CS2-1290'] }),
    });
    expect(inventoryCode.payment_codes_inserted).toEqual(['GAME-CODE-CS2-1290']);
    expect(inventoryCode.payment_code_value_points).toBe(1290);
    const reportAfterInventory = await api<Record<string, any>>('/api/admin/payment-codes');
    expect(reportAfterInventory.codes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'GAME-CODE-CS2-1290', value_points: 1290,
        source_sku: 'KEY-CS2-PRIME', source_name: 'CS2 Prime Status ключ',
      }),
    ]));

    const product = await api<Record<string, any>>('/api/catalog/KEY-GTA5');
    expect(product.description.length).toBeGreaterThan(30);
    expect(product.features.length).toBeGreaterThanOrEqual(4);
  });
});
