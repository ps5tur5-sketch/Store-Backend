import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
let adminToken: string;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(
    response.ok,
    true,
    `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
  );
  return body as T;
}

async function setSupplier(provider: 'A' | 'B', mode: string, timeoutDelayMs = 500): Promise<void> {
  await getPool().query(
    `UPDATE supplier_configs SET mode = $2, failure_rate = 0, timeout_rate = 0,
     min_delay_ms = 0, timeout_delay_ms = $3, updated_at = now() WHERE provider = $1`,
    [provider, mode, timeoutDelayMs],
  );
}

async function sendPayment(
  order: { id: string; amount: string | number; currency: string },
  options: {
    eventId?: string;
    status?: 'paid' | 'failed';
    createdAt?: string;
  } = {},
): Promise<void> {
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
  adminToken = (
    await api<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: config.ADMIN_USERNAME, password: config.ADMIN_PASSWORD }),
    })
  ).token;
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
    const responses = await Promise.all(
      payloads.map((payload) =>
        fetch(`${origin}/webhook/payment`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      ),
    );
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
      method: 'POST',
      body: JSON.stringify({
        event_id: 'evt_before_paid',
        order_id: orderId,
        status: 'paid',
        amount: 500,
        currency: 'RUB',
        created_at: paidAt,
      }),
    });
    const order = await createOrder('STEAM-TOPUP-500', orderId);
    expect(order.payment_state).toBe('paid');
    await sendPayment(order, {
      eventId: 'evt_older_failed',
      status: 'failed',
      createdAt: '2026-01-01T12:00:00.000Z',
    });
    await runDeliveryBatch(config, app.log);
    const finalOrder = await getOrder(orderId);
    expect(finalOrder.payment_state).toBe('paid');
    expect(finalOrder.status).toBe('delivered');
    const older = await getPool().query('SELECT processing_result FROM payment_events WHERE event_id = $1', [
      'evt_older_failed',
    ]);
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
    const issuances = await getPool().query(
      'SELECT provider, request_id, code FROM provider_issuances WHERE order_id = $1',
      [order.id],
    );
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

  it('refunds exhausted legacy orders and uses replenished stock only for a new order', async () => {
    const sku = 'KEY-EFT';
    await getPool().query(
      `UPDATE provider_inventory SET claimed_by = concat('test-drain:', code), claimed_at = now() WHERE sku = $1`,
      [sku],
    );
    const order = await createOrder(sku);
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');

    await addInventory('A', sku, ['TEST-RESTOCK-0001']);
    expect(
      (
        await fetch(`${origin}/api/orders/${order.id}/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(409);
    const fresh = await createOrder(sku);
    await sendPayment(fresh);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');
    const recovered = await getOrder(fresh.id);
    expect(recovered.status).toBe('delivered');
    expect(recovered.code).toBe('TEST-RESTOCK-0001');
  });

  it('ignores a late failed payment after capture and keeps settlement balanced', async () => {
    const order = await createOrder('SUB-DISCORD-1M');
    await sendPayment(order, { eventId: 'evt_ledger_paid', createdAt: '2026-01-01T12:00:00.000Z' });
    await runDeliveryBatch(config, app.log);
    await sendPayment(order, {
      eventId: 'evt_ledger_reversal',
      status: 'failed',
      createdAt: '2026-01-01T12:00:01.000Z',
    });

    const report = (await reconciliationReport()) as Record<string, any[]>;
    expect(report.delivered_not_paid).toEqual([]);
    expect((await getOrder(order.id)).payment_state).toBe('paid');
    expect(report.ledger_imbalances).toEqual([]);
    const transactions = await getPool().query(
      'SELECT kind FROM ledger_transactions WHERE order_id = $1 ORDER BY created_at, id',
      [order.id],
    );
    expect(transactions.rows.map((row) => row.kind).sort()).toEqual(['delivery_settled', 'payment_received']);
  });

  it('makes the supplier contract idempotent under concurrent repeats', async () => {
    const payload = {
      request_id: 'req_direct_concurrent',
      sku: 'GIFT-PSN-1000',
      order_id: 'ord_supplier_contract',
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        api<Record<string, string>>('/suppliers/A/issue', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      ),
    );
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
        event_id: 'evt_wrong_amount',
        order_id: order.id,
        status: 'paid',
        amount: 1,
        currency: order.currency,
        created_at: new Date().toISOString(),
      }),
    });
    const unchanged = await getOrder(order.id);
    expect(unchanged.status).toBe('created');
    expect(unchanged.payment_state).toBe('pending');
    const ledger = await getPool().query(
      'SELECT count(*)::integer AS count FROM ledger_transactions WHERE order_id = $1',
      [order.id],
    );
    expect(ledger.rows[0].count).toBe(0);
  });

  it('refunds a legacy order once after bounded A and B failures', async () => {
    await setSupplier('A', 'always_fail');
    await setSupplier('B', 'always_fail');
    const order = await createOrder('GIFT-XBOX-1500');
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');
    await setSupplier('A', 'normal');
    await setSupplier('B', 'normal');
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');
    expect(
      (await getPool().query('SELECT count(*)::int AS n FROM refunds WHERE order_id=$1', [order.id])).rows[0]
        .n,
    ).toBe(1);
    expect(
      (await getPool().query('SELECT count(*)::int AS n FROM deliveries WHERE order_id=$1', [order.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('registers by username/password with 5000 points and requires auth for the server cart', async () => {
    const registered = await api<Record<string, any>>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'buyer_one', password: 'strong-pass-1' }),
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
      method: 'POST',
      body: JSON.stringify({ username: 'points_buyer', password: 'strong-pass-2' }),
    });
    const auth = { authorization: `Bearer ${registered.token}` };
    await api('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'STEAM-TOPUP-500', quantity: 1 }),
    });
    const cart = await api<Record<string, any>>('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'SUB-DISCORD-1M', quantity: 1 }),
    });
    expect(cart.item_count).toBe(2);
    expect(cart.total_points).toBe(899);

    const checkoutBody = JSON.stringify({ checkout_id: 'chk_points_exactly_once', code: '   ' });
    const first = await api<Record<string, any>>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
      body: checkoutBody,
    });
    const duplicate = await api<Record<string, any>>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
      body: checkoutBody,
    });
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
    expect(new Date(history.purchases[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(history.purchases[1].created_at).getTime(),
    );
    const detail = await api<Record<string, any>>(`/api/account/purchases/${history.purchases[0].id}`, {
      headers: auth,
    });
    expect(detail.id).toBe(history.purchases[0].id);
    expect(detail.status).toBe('delivered');
    expect(typeof detail.code).toBe('string');
  });

  it('applies only the payment-code nominal, charges the remainder in points, and rejects reuse', async () => {
    await addInventory(
      'A',
      'STEAM-TOPUP-2500',
      ['CODE-NOMINAL-STOCK-ONE', 'CODE-NOMINAL-STOCK-TWO', 'CODE-NOMINAL-STOCK-THREE'],
      false,
    );
    const registered = await api<Record<string, any>>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'code_buyer', password: 'strong-pass-3' }),
    });
    const auth = { authorization: `Bearer ${registered.token}` };
    await api('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'STEAM-TOPUP-2500', quantity: 3 }),
    });
    const quote = await api<Record<string, any>>('/api/cart/quote', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code: 'LFXC-TNCS-BPCD' }),
    });
    expect(quote).toMatchObject({
      code_status: 'valid',
      total_points: 7500,
      code_value_points: 5000,
      code_applied_points: 5000,
      points_to_charge: 2500,
      balance_after: 2500,
      can_checkout: true,
    });
    const checkout = await api<Record<string, any>>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
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
    expect(
      accountAfterCheckout.point_transactions.find((item: any) => item.kind === 'cart_purchase').amount,
    ).toBe(-2500);

    await api('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'STEAM-TOPUP-500', quantity: 1 }),
    });
    const reused = await fetch(`${origin}/api/cart/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ checkout_id: 'chk_code_reuse', code: 'LFXC-TNCS-BPCD' }),
    });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe('payment_code_already_used');
    expect((await api<Record<string, any>>('/api/account', { headers: auth })).user.points_balance).toBe(
      2500,
    );

    const invalidQuote = await api<Record<string, any>>('/api/cart/quote', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code: 'NOT-IN-TZ-POOL' }),
    });
    expect(invalidQuote).toMatchObject({
      code_status: 'not_found',
      can_checkout: false,
      error: 'payment_code_not_found',
    });
  });

  it('creates payment codes in admin and returns full catalog descriptions', async () => {
    const created = await api<Record<string, any>>('/api/admin/payment-codes', {
      method: 'POST',
      body: JSON.stringify({ codes: ['ADMIN-CODE-7000', 'ADMIN-CODE-7000'], value_points: 7000 }),
    });
    expect(created.inserted).toEqual(['ADMIN-CODE-7000']);
    const report = await api<Record<string, any>>('/api/admin/payment-codes');
    expect(
      report.codes.some((code: any) => code.code === 'ADMIN-CODE-7000' && code.value_points === 7000),
    ).toBe(true);

    const inventoryCode = await api<Record<string, any>>('/api/admin/inventory', {
      method: 'POST',
      body: JSON.stringify({ provider: 'A', sku: 'KEY-CS2-PRIME', codes: ['GAME-CODE-CS2-1290'] }),
    });
    expect(inventoryCode.payment_codes_inserted).toEqual(['GAME-CODE-CS2-1290']);
    expect(inventoryCode.payment_code_value_points).toBe(1290);
    const reportAfterInventory = await api<Record<string, any>>('/api/admin/payment-codes');
    expect(reportAfterInventory.codes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'GAME-CODE-CS2-1290',
          value_points: 1290,
          source_sku: 'KEY-CS2-PRIME',
          source_name: 'CS2 Prime Status ключ',
        }),
      ]),
    );

    const product = await api<Record<string, any>>('/api/catalog/KEY-GTA5');
    expect(product.description.length).toBeGreaterThan(30);
    expect(product.features.length).toBeGreaterThanOrEqual(4);
  });
});

describe('stage two: composed orders, adversarial suppliers and history', () => {
  const items = [
    { sku: 'STEAM-TOPUP-500', quantity: 1, provider: 'A' },
    { sku: 'SUB-DISCORD-1M', quantity: 1, provider: 'B' },
  ];
  async function group(id = `ord_group_${crypto.randomUUID().replaceAll('-', '')}`, input = items) {
    return api<Record<string, any> & { id: string; amount: number; currency: string }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ order_id: id, items: input }),
    });
  }

  it('settles a partial failure and repeated payments/recovery without duplicate refunds or deliveries', async () => {
    await setSupplier('B', 'out_of_stock');
    const order = await group();
    const payment = {
      event_id: 'evt_group_paid',
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    };
    await Promise.all(
      Array.from({ length: 30 }, () =>
        api('/webhook/payment', { method: 'POST', body: JSON.stringify(payment) }),
      ),
    );
    await Promise.all(Array.from({ length: 8 }, () => runDeliveryBatch(config, app.log)));
    for (let i = 0; i < 3; i++) {
      await api('/api/reconciliation/recover', { method: 'POST', body: '{}' });
      await runDeliveryBatch(config, app.log);
      await sendPayment(order);
    }
    const result = await getOrder(order.id);
    expect(result.status).toBe('partially_refunded');
    expect(result.money).toEqual({
      paid: 899,
      delivered: 500,
      refunded: 399,
      pending: 0,
      balanced: true,
      settled: true,
    });
    expect(result.progress).toEqual({ total: 2, completed: 2, delivered: 1, refunded: 1, queued: 0 });
    expect((await getPool().query('SELECT * FROM refunds')).rows).toHaveLength(1);
    expect((await getPool().query('SELECT * FROM deliveries')).rows).toHaveLength(1);
    const report = (await reconciliationReport()) as any;
    expect(report.ledger_imbalances).toEqual([]);
    expect(report.money.every((r: any) => r.settled)).toBe(true);
    expect(report.paid_not_delivered).toEqual([]);
    const retry = await fetch(`${origin}/api/orders/${order.id}/retry`, { method: 'POST' });
    expect(retry.status).toBe(409);
  });

  it.each(['duplicate_code', 'wrong_code', 'error_after_issue', 'timeout_after_issue'])(
    'automatically resolves %s and exposes only a verified unique key',
    async (mode) => {
      const first = await group(undefined, [items[0]!]);
      await sendPayment(first);
      await runDeliveryBatch(config, app.log);
      await setSupplier('A', mode, 450);
      await addInventory('A', 'STEAM-TOPUP-500', ['STAGE2-ADDITIONAL-KEY-1']);
      const second = await group(undefined, [items[0]!]);
      await sendPayment(second);
      await runDeliveryBatch(config, app.log);
      const a = await getOrder(first.id),
        b = await getOrder(second.id);
      expect(b.status).toBe('delivered');
      expect(b.items[0].code).not.toBe(a.items[0].code);
      const issuance = await getPool().query(
        'SELECT code,sku,order_id FROM provider_issuances WHERE order_id=$1',
        [b.items[0].id],
      );
      expect(issuance.rows).toHaveLength(1);
      expect(issuance.rows[0]).toMatchObject({ code: b.items[0].code, sku: 'STEAM-TOPUP-500' });
      expect(((await reconciliationReport()) as any).invalid_deliveries).toEqual([]);
      if (mode === 'wrong_code' || mode === 'duplicate_code') {
        expect(((await reconciliationReport()) as any).resolved_discrepancies).toHaveLength(1);
      }
    },
  );

  it('cancels an unissued timed-out request before refund, forbidding delayed issuance', async () => {
    await setSupplier('A', 'timeout_before_issue', 450);
    const order = await group(undefined, [items[0]!]);
    await sendPayment(order);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');
    const job = (await getPool().query('SELECT * FROM delivery_jobs WHERE order_id=$1', [order.items[0].id]))
      .rows[0];
    await setSupplier('A', 'normal');
    const late = await fetch(`${origin}/suppliers/A/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ request_id: job.request_id, order_id: job.order_id, sku: 'STEAM-TOPUP-500' }),
    });
    expect(late.status).toBe(409);
    expect((await getPool().query('SELECT * FROM provider_issuances')).rows).toHaveLength(0);
  });

  it('persists rate budgets and attempt budgets across batches; recovery preserves deferral and paid work has priority', async () => {
    await getPool().query(
      `UPDATE supplier_configs SET requests_per_minute=1,mode='always_fail' WHERE provider='A'`,
    );
    const unpaid = await group(undefined, [items[0]!]);
    const order = await group(undefined, [items[0]!]);
    await sendPayment(order);
    for (let i = 0; i < 3; i++) {
      if (i) {
        await getPool().query(`UPDATE supplier_requests SET requested_at=requested_at-interval '61 seconds'`);
        await getPool().query(`UPDATE delivery_jobs SET next_attempt_at=now() WHERE state='retry'`);
      }
      await Promise.all(Array.from({ length: 10 }, () => runDeliveryBatch(config, app.log)));
      const before = (await getPool().query('SELECT next_attempt_at FROM delivery_jobs')).rows[0]
        .next_attempt_at;
      await api('/api/reconciliation/recover', { method: 'POST', body: '{}' });
      expect(
        (await getPool().query('SELECT next_attempt_at FROM delivery_jobs')).rows[0].next_attempt_at,
      ).toEqual(before);
      const queue = await api<any>('/api/admin/queue');
      expect(queue.limits.find((r: any) => r.provider === 'A').requests_last_minute).toBe(1);
      expect(queue.unpaid).toBe(1);
    }
    expect((await getPool().query('SELECT issue_attempts,phase FROM delivery_jobs')).rows[0]).toMatchObject({
      issue_attempts: 3,
      phase: 'resolve',
    });
    await getPool().query(`UPDATE supplier_requests SET requested_at=requested_at-interval '61 seconds'`);
    await getPool().query(`UPDATE delivery_jobs SET next_attempt_at=now()`);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(order.id)).status).toBe('refunded');
    expect((await getOrder(unpaid.id)).status).toBe('created');
  });

  it('recovers after an actual SIGKILL between supplier commit and local delivery commit', async () => {
    await setSupplier('A', 'timeout_after_issue', 3000);
    await setSupplier('B', 'out_of_stock');
    const order = await group();
    await sendPayment(order);
    const child = spawn(process.execPath, ['dist/scripts/worker-once.js'], {
      env: {
        ...process.env,
        SUPPLIER_BASE_URL: origin,
        SUPPLIER_TIMEOUT_MS: '10000',
        WORKER_ENABLED: 'false',
        LOG_LEVEL: 'silent',
      },
      stdio: 'pipe',
    });
    const exited = once(child, 'exit');
    try {
      const deadline = Date.now() + 8000;
      let issued = false;
      while (Date.now() < deadline) {
        const result = await getPool().query('SELECT 1 FROM provider_issuances WHERE order_id=ANY($1)', [
          order.items.map((i: any) => i.id),
        ]);
        if (result.rowCount) {
          issued = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(issued).toBe(true);
      child.kill('SIGKILL');
      expect((await exited)[1]).toBe('SIGKILL');
      expect((await getPool().query('SELECT * FROM deliveries')).rows).toHaveLength(0);
      // Fast-forward only the test lease; production recovery waits for the real 30 seconds.
      await getPool().query(
        `UPDATE delivery_jobs SET locked_until=now()-interval '1 second' WHERE state='processing'`,
      );
      await api('/api/reconciliation/recover', { method: 'POST', body: '{}' });
      await runDeliveryBatch(config, app.log);
      const final = await getOrder(order.id);
      expect(final.status).toBe('partially_refunded');
      expect(final.money).toMatchObject({ paid: 899, delivered: 500, refunded: 399, settled: true });
      expect((await getPool().query('SELECT * FROM provider_issuances')).rows).toHaveLength(1);
      expect(((await reconciliationReport()) as any).ledger_imbalances).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15000);

  it('fences an expired worker while another worker resumes its committed issuance', async () => {
    await setSupplier('A', 'timeout_after_issue', 800);
    const order = await group(undefined, [items[0]!]);
    await sendPayment(order);
    const slow = runDeliveryBatch({ ...config, SUPPLIER_TIMEOUT_MS: 1500 }, app.log, 1);
    for (let i = 0; i < 100; i++) {
      if ((await getPool().query('SELECT 1 FROM provider_issuances')).rowCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await getPool().query(
      `UPDATE delivery_jobs SET locked_until=now()-interval '1 second' WHERE state='processing'`,
    );
    await api('/api/reconciliation/recover', { method: 'POST', body: '{}' });
    await runDeliveryBatch(config, app.log);
    await slow;
    expect((await getOrder(order.id)).money.settled).toBe(true);
    expect((await getPool().query('SELECT * FROM deliveries')).rows).toHaveLength(1);
    expect(
      (await getPool().query("SELECT * FROM ledger_transactions WHERE kind='delivery_settled'")).rows,
    ).toHaveLength(1);
  });

  it('rejects an unbalanced ledger write at transaction commit', async () => {
    const order = await createOrder('STEAM-TOPUP-500');
    await expect(
      getPool().query(
        `INSERT INTO ledger_transactions(id,order_id,kind) VALUES ('invalid-ledger',$1,'refund')`,
        [order.id],
      ),
    ).rejects.toThrow('unbalanced_ledger_transaction');
  });

  it('rejects changed idempotency payloads and atomically applies a webhook that arrived before the composed order', async () => {
    const id = 'ord_group_before';
    await sendPayment({ id, amount: 899, currency: 'RUB' });
    const order = await group(id);
    expect(order.payment_state).toBe('paid');
    expect((await group(id)).items.map((i: any) => i.id)).toEqual(order.items.map((i: any) => i.id));
    const conflict = await fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_id: id, items: [items[0]] }),
    });
    expect(conflict.status).toBe(409);
    await sendPayment(
      { id: order.items[0].id, amount: order.items[0].amount, currency: 'RUB' },
      { status: 'failed' },
    );
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(id)).status).toBe('delivered');
  });

  it('credits the complete failed position to the wallet once, including payment-code value, and checks ownership', async () => {
    const user = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'refund_user', password: 'password123' }),
    });
    const auth = { authorization: `Bearer ${user.token}` };
    for (const item of items)
      await api('/api/cart/items', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ sku: item.sku, quantity: 1, provider: item.provider }),
      });
    await api('/api/admin/payment-codes', {
      method: 'POST',
      body: JSON.stringify({ codes: ['STAGE2-REFUND-PAYMENT'], value_points: 899 }),
    });
    await setSupplier('B', 'always_fail');
    const checkout = await api<any>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ checkout_id: 'chk_refund_test', code: 'STAGE2-REFUND-PAYMENT' }),
    });
    expect(checkout.order_id).toBe('chk_refund_test');
    await runDeliveryBatch(config, app.log);
    const account = await api<any>('/api/account', { headers: auth });
    expect(account.user.points_balance).toBe(5399);
    expect(account.point_transactions.filter((p: any) => p.kind === 'order_refund')).toHaveLength(1);
    const order = await api<any>(`/api/account/orders/${checkout.order_id}`, { headers: auth });
    expect(order.money).toMatchObject({ paid: 899, refunded: 399, delivered: 500, settled: true });
    const other = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'other_user', password: 'password123' }),
    });
    expect(
      (
        await fetch(`${origin}/api/account/orders/${checkout.order_id}`, {
          headers: { authorization: `Bearer ${other.token}` },
        })
      ).status,
    ).toBe(404);
  });

  it('reconstructs creation, payment and partial settlement; immutable history and period ledger reconcile', async () => {
    const from = new Date().toISOString();
    const order = await group();
    const createdAt = (
      await getPool().query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      )
    ).rows[0].at;
    await new Promise((r) => setTimeout(r, 5));
    await sendPayment(order);
    const paidAt = (
      await getPool().query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      )
    ).rows[0].at;
    await new Promise((r) => setTimeout(r, 5));
    await setSupplier('B', 'out_of_stock');
    await runDeliveryBatch(config, app.log);
    const to = new Date(Date.now() + 10).toISOString();
    const created = await api<any>(`/api/orders/${order.id}/history?at=${encodeURIComponent(createdAt)}`);
    const paid = await api<any>(`/api/orders/${order.id}/history?at=${encodeURIComponent(paidAt)}`);
    const settled = await api<any>(`/api/orders/${order.id}/history?at=${encodeURIComponent(to)}`);
    expect(created.status).toBe('created');
    expect(created.money.paid).toBe(0);
    expect(paid.money).toMatchObject({ paid: 899, pending: 899, delivered: 0, refunded: 0 });
    expect(settled.status).toBe('partially_refunded');
    expect(settled.money.settled).toBe(true);
    for (const table of [
      'order_history',
      'audit_events',
      'ledger_entries',
      'ledger_transactions',
      'refunds',
    ]) {
      await expect(getPool().query(`DELETE FROM ${table}`)).rejects.toThrow('append_only_table');
    }
    const report = await api<any>(
      `/api/admin/money?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(report.accounts.reduce((n: number, r: any) => n + r.movement, 0)).toBe(0);
    expect(report.accounts.every((r: any) => r.opening + r.movement === r.closing)).toBe(true);
    const noHistory = await fetch(`${origin}/api/orders/${order.id}/history?at=2020-01-01T00:00:00Z`);
    expect(noHistory.status).toBe(404);
  });
});

describe('seller offers, verified reviews and evidence-based reputation', () => {
  async function buyer(name = 'seller_buyer') {
    const registered = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: name, password: 'strong-password' }),
    });
    return { authorization: `Bearer ${registered.token}` };
  }
  async function purchase(auth: Record<string, string>, provider = 'A') {
    await api('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'STEAM-TOPUP-500', quantity: 1, provider }),
    });
    return api<any>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ checkout_id: `chk_review_${crypto.randomUUID().replaceAll('-', '')}` }),
    });
  }
  it('exposes every seller price and stock, supports additional sellers, and snapshots the selected offer', async () => {
    await api('/api/admin/sellers', {
      method: 'POST',
      body: JSON.stringify({ id: 'vendor_300', name: 'Third Seller' }),
    });
    await api('/api/admin/offers/STEAM-TOPUP-500/vendor_300', {
      method: 'PUT',
      body: JSON.stringify({ price: 475 }),
    });
    await addInventory('vendor_300', 'STEAM-TOPUP-500', ['THIRD-SELLER-VALID-CODE']);
    const catalog = await api<any>('/api/catalog/STEAM-TOPUP-500');
    expect(catalog.offers).toHaveLength(3);
    expect(catalog.offers[0]).toMatchObject({
      provider: 'vendor_300',
      price: 475,
      available: 1,
      seller: { name: 'Third Seller', rating: null, review_count: 0, flag: 'none' },
    });
    const auth = await buyer();
    const order = await purchase(auth, 'vendor_300');
    expect(order.total_points).toBe(475);
    await api('/api/admin/offers/STEAM-TOPUP-500/vendor_300', {
      method: 'PUT',
      body: JSON.stringify({ price: 777 }),
    });
    await runDeliveryBatch(config, app.log);
    const result = await getOrder(order.order_id);
    expect(result.amount).toBe(475);
    expect(result.items[0]).toMatchObject({
      amount: 475,
      provider: 'vendor_300',
      assigned_provider: 'vendor_300',
      code: 'THIRD-SELLER-VALID-CODE',
    });
  });
  it('keeps the same SKU from different sellers separate throughout cart and checkout', async () => {
    const auth = await buyer();
    await api('/api/admin/offers/STEAM-TOPUP-500/B', { method: 'PUT', body: JSON.stringify({ price: 450 }) });
    for (const provider of ['A', 'B'])
      await api('/api/cart/items', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ sku: 'STEAM-TOPUP-500', provider }),
      });
    const cart = await api<any>('/api/cart', { headers: auth });
    expect(cart.items).toHaveLength(2);
    expect(cart.total_points).toBe(950);
    const ambiguous = await fetch(`${origin}/api/cart/items/STEAM-TOPUP-500`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 2 }),
    });
    expect(ambiguous.status).toBe(409);
    await api('/api/cart/items/STEAM-TOPUP-500?provider=B', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ quantity: 2 }),
    });
    const quote = await api<any>('/api/cart/quote', { method: 'POST', headers: auth, body: '{}' });
    expect(quote.total_points).toBe(1400);
    const checkout = await api<any>('/api/cart/checkout', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ checkout_id: 'chk_multi_seller_same_sku' }),
    });
    expect(checkout.order.items.filter((i: any) => i.assigned_provider === 'B')).toHaveLength(2);
    expect(checkout.order.amount).toBe(1400);
  });
  it('accepts exactly one verified 1–5 star review after completion and rejects fake or premature reviews', async () => {
    const auth = await buyer();
    const checkout = await purchase(auth);
    const path = `/api/account/purchases/${checkout.order_ids[0]}/review`;
    async function review(rating: number, headers: Record<string, string> = auth) {
      return fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ rating, comment: 'Всё работает' }),
      });
    }
    expect((await review(5)).status).toBe(409);
    await runDeliveryBatch(config, app.log);
    expect((await review(0)).status).toBe(400);
    expect((await review(6)).status).toBe(400);
    expect((await review(4.5)).status).toBe(400);
    expect((await review(5, {})).status).toBe(401);
    expect((await review(5, await buyer('unrelated_buyer'))).status).toBe(404);
    expect((await review(5)).status).toBe(201);
    expect((await review(5)).status).toBe(201);
    expect((await review(1)).status).toBe(409);
    const seller = await api<any>('/api/sellers/A');
    expect(seller).toMatchObject({ rating: 5, review_count: 1, flag: 'none' });
    expect(seller.reviews[0]).toMatchObject({ verified_purchase: true, rating: 5, comment: 'Всё работает' });
    const detail = await api<any>(`/api/account/purchases/${checkout.order_ids[0]}`, { headers: auth });
    expect(detail).toMatchObject({ can_review: false, review: { rating: 5 } });
  });
  it.each(['wrong_code', 'duplicate_code', 'error_after_issue'])(
    'automatically flags confirmed %s, retains proof, and never exposes keys in public seller reports',
    async (mode) => {
      await setSupplier('A', mode);
      const auth = await buyer();
      const checkout = await purchase(auth);
      await runDeliveryBatch(config, app.log);
      const final = await getOrder(checkout.order_id);
      expect(final.status).toBe('delivered');
      const report = await api<any>('/api/sellers/A');
      expect(report.flag).toBe('red');
      expect(report.confirmed_incidents).toBe(1);
      expect(report.evidence).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain(final.items[0].code);
      expect(JSON.stringify(report)).not.toContain('expected_code_hash');
      await api('/api/reconciliation/recover', { method: 'POST', body: '{}' });
      await runDeliveryBatch(config, app.log);
      expect((await api<any>('/api/sellers/A')).confirmed_incidents).toBe(1);
      await expect(getPool().query('DELETE FROM supplier_incidents')).rejects.toThrow('append_only_table');
      const product = await api<any>('/api/catalog/STEAM-TOPUP-500');
      expect(product.offers.find((o: any) => o.provider === 'A').seller.flag).toBe('red');
    },
  );
  it('does not equate stock shortage with proven misconduct and accepts a review of a refunded purchase', async () => {
    const auth = await buyer();
    await setSupplier('A', 'out_of_stock');
    const checkout = await purchase(auth);
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(checkout.order_id)).status).toBe('refunded');
    await api(`/api/account/purchases/${checkout.order_ids[0]}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rating: 2, comment: 'Товара не оказалось, деньги вернули.' }),
    });
    expect(await api<any>('/api/sellers/A')).toMatchObject({ flag: 'none', rating: 2, refunded: 1 });
  });
});

describe('private dashboards, moderation and refunds', () => {
  async function credentials(username: string, password = 'password123') {
    return api<any>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  }
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });
  async function purchase() {
    const buyer = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'cabinet_buyer', password: 'password123' }),
    });
    await api('/api/cart/items', {
      method: 'POST',
      headers: headers(buyer.token),
      body: JSON.stringify({ sku: 'KEY-GTA5', provider: 'A' }),
    });
    const checkout = await api<any>('/api/cart/checkout', {
      method: 'POST',
      headers: headers(buyer.token),
      body: JSON.stringify({ checkout_id: 'cabinet_checkout' }),
    });
    return { buyer, checkout, id: checkout.order_ids[0] as string };
  }
  it('enforces database roles and ownership on dashboards, orders, history and chat', async () => {
    const { buyer, checkout, id } = await purchase();
    const other = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'outsider', password: 'password123' }),
    });
    const seller = await credentials('seller_b', config.SELLER_PASSWORD);
    for (const path of [
      '/api/admin/users',
      '/api/admin/summary',
      '/api/reconciliation',
      '/api/seller/dashboard',
    ]) {
      expect((await fetch(origin + path, { headers: headers(buyer.token) })).status).toBe(403);
      expect((await fetch(origin + path)).status).toBe(401);
    }
    for (const path of [
      `/api/orders/${id}`,
      `/api/orders/${checkout.order_id}`,
      `/api/orders/${id}/history?at=${new Date().toISOString()}`,
      `/api/orders/${id}/messages`,
    ]) {
      expect((await fetch(origin + path, { headers: headers(other.token) })).status).toBe(404);
      expect((await fetch(origin + path)).status).toBe(401);
    }
    expect(
      (await fetch(`${origin}/api/orders/${id}/messages`, { headers: headers(seller.token) })).status,
    ).toBe(404);
    expect((await fetch(`${origin}/api/cart`, { headers: headers(seller.token) })).status).toBe(200);
    expect(
      (
        await fetch(`${origin}/api/orders`, {
          method: 'POST',
          headers: headers(other.token),
          body: JSON.stringify({ order_id: id, sku: 'KEY-GTA5' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${origin}/suppliers/A/resolve`, {
          method: 'POST',
          headers: headers(buyer.token),
          body: JSON.stringify({ order_id: id, sku: 'KEY-GTA5', request_id: `req_${id}_0` }),
        })
      ).status,
    ).toBe(403);
  });
  it('seller manages only own offers and keys without minting payment codes', async () => {
    const seller = await credentials('seller_a', config.SELLER_PASSWORD);
    const auth = headers(seller.token);
    await api('/api/seller/offers/KEY-GTA5', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ price: 1599, active: true }),
    });
    await api('/api/seller/inventory', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sku: 'KEY-GTA5', codes: ['SELLER-PRIVATE-STOCK'] }),
    });
    const view = await api<any>('/api/seller/dashboard', { headers: auth });
    expect(view.seller.id).toBe('A');
    expect(view.offers.find((f: any) => f.sku === 'KEY-GTA5').price).toBe(1599);
    expect(
      (await getPool().query("SELECT provider FROM provider_inventory WHERE code='SELLER-PRIVATE-STOCK'"))
        .rows[0].provider,
    ).toBe('A');
    expect(
      (await getPool().query("SELECT * FROM payment_codes WHERE code='SELLER-PRIVATE-STOCK'")).rowCount,
    ).toBe(0);
    expect(
      (
        await fetch(origin + '/api/seller/inventory', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ provider: 'B', sku: 'KEY-GTA5', codes: ['FORGED-CODE'] }),
        })
      ).status,
    ).toBe(400);
  });
  it('banning a seller revokes sessions, flags the profile and rejects existing cart checkout without charging', async () => {
    const buyer = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ban_buyer', password: 'password123' }),
    });
    const seller = await credentials('seller_a', config.SELLER_PASSWORD);
    await api('/api/cart/items', {
      method: 'POST',
      headers: headers(buyer.token),
      body: JSON.stringify({ sku: 'KEY-GTA5', provider: 'A' }),
    });
    await api('/api/admin/sellers/A/ban', {
      method: 'POST',
      body: JSON.stringify({ banned: true, reason: 'Confirmed policy violation' }),
    });
    expect((await fetch(origin + '/api/seller/dashboard', { headers: headers(seller.token) })).status).toBe(
      401,
    );
    const report = await api<any>('/api/sellers/A');
    expect(report.flag).toBe('red');
    expect(report.banned_at).toBeTruthy();
    const quote = await api<any>('/api/cart/quote', {
      method: 'POST',
      headers: headers(buyer.token),
      body: '{}',
    });
    expect(quote.can_checkout).toBe(false);
    expect(quote.error).toBe('cart_offer_unavailable');
    expect(
      (
        await fetch(origin + '/api/cart/checkout', {
          method: 'POST',
          headers: headers(buyer.token),
          body: '{}',
        })
      ).status,
    ).toBe(409);
    expect((await api<any>('/api/account', { headers: headers(buyer.token) })).user.points_balance).toBe(
      5000,
    );
    expect(
      (await api<any>('/api/catalog/KEY-GTA5/offers')).offers.every((o: any) => o.provider !== 'A'),
    ).toBe(true);
  });
  it('refunds an issued purchase once, revokes its key, reverses sales and closes the persisted chat', async () => {
    const { buyer, checkout, id } = await purchase();
    const seller = await credentials('seller_a', config.SELLER_PASSWORD);
    await runDeliveryBatch(config, app.log);
    const issued = await api<any>(`/api/account/purchases/${id}`, { headers: headers(buyer.token) });
    expect(issued.code).toBeTruthy();
    for (const [token, messageId, body] of [
      [buyer.token, 'buyer-message', 'Ключ не работает'],
      [seller.token, 'seller-message', 'Проверим заказ'],
    ]) {
      await api(`/api/orders/${id}/messages`, {
        method: 'POST',
        headers: headers(token!),
        body: JSON.stringify({ id: messageId, body }),
      });
    }
    await Promise.all(
      Array.from({ length: 8 }, () =>
        api(`/api/admin/orders/${id}/refund`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Возврат после проверки' }),
        }),
      ),
    );
    await Promise.all(Array.from({ length: 4 }, () => runDeliveryBatch(config, app.log)));
    const order = await getOrder(checkout.order_id);
    expect(order.status).toBe('refunded');
    expect(order.money).toMatchObject({
      paid: issued.amount,
      delivered: 0,
      refunded: issued.amount,
      pending: 0,
      balanced: true,
      settled: true,
    });
    expect((await api<any>('/api/account', { headers: headers(buyer.token) })).user.points_balance).toBe(
      5000,
    );
    expect(
      (await api<any>(`/api/account/purchases/${id}`, { headers: headers(buyer.token) })).code,
    ).toBeNull();
    const chat = await api<any>(`/api/orders/${id}/messages`, { headers: headers(buyer.token) });
    expect(chat.can_send).toBe(false);
    expect(chat.messages).toHaveLength(2);
    expect(
      (
        await fetch(`${origin}/api/orders/${id}/messages`, {
          method: 'POST',
          headers: headers(seller.token),
          body: JSON.stringify({ id: 'after-refund', body: 'hello' }),
        })
      ).status,
    ).toBe(409);
    const evidence = (
      await getPool().query(
        `SELECT (SELECT count(*)::int FROM refunds WHERE order_id=$1) AS refunds,
   (SELECT count(*)::int FROM delivery_revocations WHERE order_id=$1) AS revocations,
   (SELECT COALESCE(sum(e.amount),0)::int FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.order_id=$1) AS balance`,
        [id],
      )
    ).rows[0];
    expect(evidence).toEqual({ refunds: 1, revocations: 1, balance: 0 });
    expect(
      (await getPool().query('SELECT revoked_at FROM provider_inventory WHERE code=$1', [issued.code]))
        .rows[0].revoked_at,
    ).toBeTruthy();
    await api(`/api/admin/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Retry' }),
    });
    await runDeliveryBatch(config, app.log);
    expect((await api<any>('/api/account', { headers: headers(buyer.token) })).user.points_balance).toBe(
      5000,
    );
  });
  it('manual refund before issuance cancels the supplier request and preserves wallet balance', async () => {
    const { buyer, id } = await purchase();
    await api(`/api/admin/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cancel before fulfillment' }),
    });
    await runDeliveryBatch(config, app.log);
    expect((await getOrder(id)).status).toBe('refunded');
    expect((await getPool().query('SELECT * FROM provider_issuances WHERE order_id=$1', [id])).rowCount).toBe(
      0,
    );
    expect((await api<any>('/api/account', { headers: headers(buyer.token) })).user.points_balance).toBe(
      5000,
    );
  });
});

it('a seller-account ban closes every account bound to that seller and can be lifted', async () => {
  const created = await api<any>('/api/admin/seller-accounts', {
    method: 'POST',
    body: JSON.stringify({ username: 'seller_a_manager', password: 'ManagerDemo2026!', provider: 'A' }),
  });
  const login = await api<any>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'seller_a_manager', password: 'ManagerDemo2026!' }),
  });
  const existing = await api<any>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'seller_a', password: config.SELLER_PASSWORD }),
  });
  await api(`/api/admin/users/${created.user.id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ banned: true, reason: 'Seller-wide moderation' }),
  });
  for (const token of [login.token, existing.token])
    expect(
      (await fetch(`${origin}/api/seller/dashboard`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);
  expect((await api<any>('/api/sellers/A')).banned_at).toBeTruthy();
  await api(`/api/admin/users/${created.user.id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ banned: false, reason: 'Appeal accepted' }),
  });
  const restored = await api<any>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'seller_a', password: config.SELLER_PASSWORD }),
  });
  expect(
    (await api<any>('/api/seller/dashboard', { headers: { authorization: `Bearer ${restored.token}` } }))
      .seller.banned_at,
  ).toBeNull();
});

describe('marketplace registration and persistent simulated payments', () => {
  async function buyer(name = 'payment_buyer') {
    const r = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: name, password: 'TestPassword2026', role: 'buyer' }),
    });
    return { authorization: `Bearer ${r.token}` };
  }
  async function post(path: string, auth: Record<string, string>, body: unknown) {
    return api<any>(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  }
  async function checkout(auth: Record<string, string>, method = 'sbp', provider = 'A') {
    await post('/api/cart/items', auth, { sku: 'STEAM-TOPUP-500', provider, quantity: 1 });
    return post('/api/cart/checkout', auth, { checkout_id: `chk_${crypto.randomUUID()}`, method });
  }
  async function simulate(
    auth: Record<string, string>,
    paymentId: string,
    outcome = 'paid',
    eventId = `sim_${crypto.randomUUID()}`,
  ) {
    return post(`/api/payments/${paymentId}/simulate`, auth, { outcome, event_id: eventId });
  }
  async function negative(path: string, auth: Record<string, string>, body: unknown) {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  it('self-registers a new seller atomically and forbids privileged roles and store hijacking', async () => {
    const seller = await post(
      '/api/auth/register',
      {},
      { username: 'new_vendor', password: 'TestPassword2026', role: 'seller', store_name: 'Новый магазин' },
    );
    expect(seller.user).toMatchObject({ role: 'seller', points_balance: 0 });
    expect(seller.user.seller_id).toMatch(/^vendor_/);
    const auth = { authorization: `Bearer ${seller.token}` };
    expect((await api<any>(`/api/sellers/${seller.user.seller_id}`)).name).toBe('Новый магазин');
    expect((await fetch(`${origin}/api/cart`, { headers: auth })).status).toBe(200);
    expect(
      (
        await negative(
          '/api/auth/register',
          {},
          { username: 'admin_fake', password: 'TestPassword2026', role: 'admin' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await negative(
          '/api/auth/register',
          {},
          {
            username: 'hijacker',
            password: 'TestPassword2026',
            role: 'seller',
            store_name: 'Xx',
            seller_id: 'A',
          },
        )
      ).status,
    ).toBe(400);
    const before = (await getPool().query('SELECT count(*)::int n FROM supplier_configs')).rows[0].n;
    expect(
      (
        await negative(
          '/api/auth/register',
          {},
          {
            username: 'new_vendor',
            password: 'TestPassword2026',
            role: 'seller',
            store_name: 'Лишний магазин',
          },
        )
      ).status,
    ).toBe(409);
    expect((await getPool().query('SELECT count(*)::int n FROM supplier_configs')).rows[0].n).toBe(before);
  });
  it.each(['sbp', 'crypto'])(
    'captures %s only after confirmation, once under concurrent repeats',
    async (method) => {
      const auth = await buyer();
      const c = await checkout(auth, method);
      expect(c.status).toBe('pending');
      expect(c.order.money.paid).toBe(0);
      await runDeliveryBatch(config, app.log);
      expect((await getPool().query('SELECT count(*)::int n FROM deliveries')).rows[0].n).toBe(0);
      expect((await negative(`/api/orders/${c.order_id}/simulate-payment`, auth, {})).status).toBe(409);
      expect(
        (
          await negative(
            '/webhook/payment',
            {},
            {
              event_id: 'bypass',
              order_id: c.order_id,
              status: 'paid',
              amount: 500,
              currency: 'RUB',
              created_at: new Date().toISOString(),
            },
          )
        ).status,
      ).toBe(409);
      const other = await buyer('outsider');
      expect((await fetch(`${origin}/api/payments/${c.payment_id}`, { headers: other })).status).toBe(404);
      const outcomes = await Promise.all(
        Array.from({ length: 15 }, (_, i) => simulate(auth, c.payment_id, 'paid', `pay_race_${i}`)),
      );
      expect(outcomes.every((p) => p.status === 'paid')).toBe(true);
      await runDeliveryBatch(config, app.log);
      const order = await api<any>(`/api/account/orders/${c.order_id}`, { headers: auth });
      expect(order.status).toBe('delivered');
      expect((await api<any>('/api/account', { headers: auth })).user.points_balance).toBe(5000);
      expect(
        (
          await getPool().query(
            "SELECT count(*)::int n FROM ledger_transactions WHERE kind='payment_received'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await reconciliationReport()).wallet).toMatchObject({ balanced: true });
    },
  );
  it('persists failure and creates exactly one retry before completing the same order', async () => {
    const auth = await buyer();
    const c = await checkout(auth, 'crypto');
    await simulate(auth, c.payment_id, 'failed');
    expect((await api<any>(`/api/account/orders/${c.order_id}`, { headers: auth })).status).toBe(
      'payment_failed',
    );
    expect(
      (
        await negative(`/api/payments/${c.payment_id}/simulate`, auth, {
          outcome: 'paid',
          event_id: 'too_late',
        })
      ).status,
    ).toBe(409);
    const retries = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(`/api/payments/${c.payment_id}/retry`, auth, { retry_id: `retry_${i}` }),
      ),
    );
    expect(new Set(retries.map((p) => p.id)).size).toBe(1);
    await simulate(auth, retries[0].id);
    await runDeliveryBatch(config, app.log);
    expect((await api<any>(`/api/account/orders/${c.order_id}`, { headers: auth })).status).toBe('delivered');
    expect((await getPool().query('SELECT count(*)::int n FROM order_groups')).rows[0].n).toBe(1);
  });
  it.each(['sbp', 'crypto'])('credits a failed %s purchase to the account wallet once', async (method) => {
    await setSupplier('A', 'out_of_stock');
    const auth = await buyer();
    const c = await checkout(auth, method);
    await simulate(auth, c.payment_id);
    await runDeliveryBatch(config, app.log);
    const payment = await api<any>(`/api/payments/${c.payment_id}`, { headers: auth });
    expect(payment.refunded_amount).toBe(500);
    const group = await api<any>(`/api/account/orders/${c.order_id}`, { headers: auth });
    expect(group.money).toMatchObject({ paid: 500, refunded: 500, settled: true });
    expect(group.refund_destination).toBe('wallet');
    expect((await api<any>('/api/account', { headers: auth })).user.points_balance).toBe(5500);
    expect((await reconciliationReport()).wallet).toMatchObject({ balanced: true });
  });
  it('tops up a wallet once and reconciles bonus, top-up, purchase and refund', async () => {
    const auth = await buyer();
    const topup = await post('/api/account/topups', auth, {
      payment_id: 'topup_wallet',
      amount: 1500,
      method: 'sbp',
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => simulate(auth, topup.id, 'paid', `topup_event_${i}`)),
    );
    expect((await api<any>('/api/account', { headers: auth })).user.points_balance).toBe(6500);
    await setSupplier('A', 'out_of_stock');
    const c = await checkout(auth, 'balance');
    expect(c.balance_after).toBe(6000);
    await runDeliveryBatch(config, app.log);
    expect((await api<any>('/api/account', { headers: auth })).user.points_balance).toBe(6500);
    expect((await reconciliationReport()).wallet).toMatchObject({
      balanced: true,
      balances: 6500,
      ledger_balance: 6500,
    });
    const hist = await api<any>('/api/account/payments', { headers: auth });
    expect(hist.payments).toHaveLength(1);
    expect(
      (await getPool().query("SELECT count(*)::int n FROM point_transactions WHERE kind='wallet_topup'"))
        .rows[0].n,
    ).toBe(1);
  });
  it('expires abandoned payments after restart recovery without issuing goods', async () => {
    const auth = await buyer();
    const c = await checkout(auth);
    // A short fixture lifetime is set before any state transition; terms remain protected in normal operation.
    await getPool().query('ALTER TABLE payment_intents DISABLE TRIGGER immutable_intent_terms');
    try {
      await getPool().query(
        "UPDATE payment_intents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [c.payment_id],
      );
    } finally {
      await getPool().query('ALTER TABLE payment_intents ENABLE TRIGGER immutable_intent_terms');
    }
    const { recoverStuckOrders } = await import('../src/services/reconciliation.js');
    await recoverStuckOrders();
    const payment = await api<any>(`/api/payments/${c.payment_id}`, { headers: auth });
    expect(payment.status).toBe('expired');
    expect(payment.can_retry).toBe(true);
    await runDeliveryBatch(config, app.log);
    expect((await getPool().query('SELECT count(*)::int n FROM deliveries')).rows[0].n).toBe(0);
    await expect(
      getPool().query('UPDATE payment_intents SET amount=1 WHERE id=$1', [c.payment_id]),
    ).rejects.toThrow('immutable_payment_intent');
    await expect(getPool().query('DELETE FROM payment_intent_events')).rejects.toThrow('append_only_table');
  });
  it('uses COMMIT boundaries for atomic multi-item history and ledger, including a missed archive', async () => {
    const group = await api<any>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ items: [{ sku: 'STEAM-TOPUP-500', provider: 'A', quantity: 2 }] }),
    });
    const client = await getPool().connect();
    let before: string, commit: string;
    try {
      await client.query('BEGIN');
      const { applyGroupPayment } = await import('../src/services/payment.js');
      const event = (
        await client.query(
          `INSERT INTO payment_events(event_id,order_id,status,amount,currency,event_created_at,payload) VALUES('atomic_event',$1,'paid',1000,'RUB',clock_timestamp(),'{}') RETURNING *`,
          [group.id],
        )
      ).rows[0];
      await applyGroupPayment(client, event);
      before = (
        await client.query(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        )
      ).rows[0].at;
      expect((await getOrder(group.id)).money.paid).toBe(0);
      await client.query('COMMIT'); // Deliberately skip transaction() archival, as after a process crash.
      commit = (
        await client.query(
          `SELECT to_char(business_commit_time(lo.operation_key) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM ledger_operations lo JOIN ledger_transactions lt ON lt.id=lo.ledger_id WHERE lt.source_event_id IS NOT NULL LIMIT 1`,
        )
      ).rows[0].at;
    } finally {
      client.release();
    }
    const atBefore = await api<any>(`/api/orders/${group.id}/history?at=${encodeURIComponent(before!)}`);
    const atCommit = await api<any>(`/api/orders/${group.id}/history?at=${encodeURIComponent(commit!)}`);
    expect(atBefore.money.paid).toBe(0);
    expect(atCommit.money.paid).toBe(1000);
    expect(atCommit.items.every((i: any) => i.payment_state === 'paid')).toBe(true);
    const { moneyReport } = await import('../src/services/order-groups.js');
    const prior: any = await moneyReport('2000-01-01T00:00:00Z', commit!);
    expect(prior.accounts.find((a: any) => a.account === 'cash')?.closing ?? 0).toBe(0);
    await getPool().query('SELECT archive_business_commits()');
    expect(
      (await api<any>(`/api/orders/${group.id}/history?at=${encodeURIComponent(commit!)}`)).money.paid,
    ).toBe(1000);
    await expect(getPool().query('DELETE FROM operation_commits')).rejects.toThrow('append_only_table');
  });
});

it('allows browser preflight for authenticated PUT and DELETE operations', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const response = await fetch(`${origin}/api/cart/items/STEAM-TOPUP-500`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:8080',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(
      response.headers
        .get('access-control-allow-methods')
        ?.split(',')
        .map((value) => value.trim()),
    ).toContain(method);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
  }
});

it('extends a buyer account with seller access once, preserving money, purchases, cart and session', async () => {
  const buyer = await api<any>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'dual_account', password: 'DualPassword2026!' }),
  });
  const headers = { authorization: `Bearer ${buyer.token}` };
  const post = (path: string, body: unknown) =>
    api<any>(path, { method: 'POST', headers, body: JSON.stringify(body) });
  await post('/api/cart/items', { sku: 'STEAM-TOPUP-500', provider: 'A' });
  const checkout = await post('/api/cart/checkout', { checkout_id: 'dual_purchase', method: 'balance' });
  await runDeliveryBatch(config, app.log);
  await post('/api/cart/items', { sku: 'KEY-GTA5', provider: 'B' });
  const upgraded = await Promise.all(
    Array.from({ length: 12 }, () => post('/api/account/seller', { store_name: 'Единый аккаунт' })),
  );
  expect(new Set(upgraded.map((r) => r.user.seller_id)).size).toBe(1);
  expect(upgraded[0].user).toMatchObject({
    id: buyer.user.id,
    can_buy: true,
    can_sell: true,
    can_become_seller: false,
    points_balance: 4500,
  });
  expect((await api<any>('/api/cart', { headers })).item_count).toBe(1);
  expect(
    (await api<any>('/api/account/purchases', { headers })).purchases.some(
      (p: any) => p.id === checkout.order_ids[0],
    ),
  ).toBe(true);
  expect((await api<any>('/api/seller/dashboard', { headers })).seller.name).toBe('Единый аккаунт');
  await post(`/api/orders/${checkout.order_ids[0]}/messages`, {
    id: 'dual_message',
    body: 'Я покупатель в этом заказе',
  });
  expect(
    (await api<any>(`/api/orders/${checkout.order_ids[0]}/messages`, { headers })).messages[0].role,
  ).toBe('buyer');
  const { wallet } = await reconciliationReport();
  expect(wallet).toMatchObject({ balanced: true, balances: 4500 });
  const login = await post('/api/auth/login', { username: 'dual_account', password: 'DualPassword2026!' });
  expect(login.user.can_buy && login.user.can_sell).toBe(true);
  expect(
    (await getPool().query("SELECT count(*)::int n FROM audit_events WHERE event_type='seller_activated'"))
      .rows[0].n,
  ).toBe(1);
  expect(
    (await getPool().query("SELECT count(*)::int n FROM point_transactions WHERE kind='registration_bonus'"))
      .rows[0].n,
  ).toBe(1);
});
it('keeps activation private and rejects buying from the same account shop', async () => {
  const seller = await api<any>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'seller_a', password: config.SELLER_PASSWORD }),
  });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${seller.token}` };
  expect(seller.user).toMatchObject({ can_buy: true, can_sell: true });
  expect(
    (
      await fetch(origin + '/api/cart/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({ sku: 'STEAM-TOPUP-500', provider: 'A' }),
      })
    ).status,
  ).toBe(404);
  const cart = await api<any>('/api/cart/items', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500' }),
  });
  expect(cart.items[0].provider).toBe('B');
  expect(
    (
      await fetch(origin + '/api/account/seller', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ store_name: 'Fake' }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(origin + '/api/account/seller', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ store_name: 'Fake' }),
      })
    ).status,
  ).toBe(403);
});

describe('wallet withdrawals and refund policy', () => {
  async function buyer() {
    const r = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'withdraw_buyer', password: 'Withdrawal2026!' }),
    });
    return { authorization: `Bearer ${r.token}` };
  }
  async function post(headers: Record<string, string>, path: string, body: unknown) {
    return api<any>(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  it.each(['card', 'crypto'])('reserves %s withdrawal once and completes it exactly once', async (method) => {
    const headers = await buyer();
    const payload = {
      withdrawal_id: 'wd_concurrent',
      method,
      amount: 1000,
      recipient: method === 'card' ? '0000 0000 0000 1234' : 'DEMO-USDT-WALLET-1234',
    };
    const created = await Promise.all(
      Array.from({ length: 12 }, () => post(headers, '/api/account/withdrawals', payload)),
    );
    expect(created.every((w) => w.status === 'pending')).toBe(true);
    expect((await reconciliationReport()).withdrawals).toMatchObject({
      reserved: 1000,
      ledger_reserved: 1000,
      balanced: true,
    });
    expect(JSON.stringify(created[0])).not.toContain('0000000000001234');
    expect((await api<any>('/api/account', { headers })).user.points_balance).toBe(4000);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(headers, '/api/account/withdrawals/wd_concurrent/simulate', {
          event_id: `wd_event_${i}`,
          outcome: 'paid',
        }),
      ),
    );
    expect((await api<any>('/api/account', { headers })).user.points_balance).toBe(4000);
    expect((await api<any>('/api/account/withdrawals', { headers })).withdrawals[0].status).toBe('paid');
    expect((await reconciliationReport()).wallet).toMatchObject({ balanced: true, balances: 4000 });
    expect(
      (await getPool().query("SELECT count(*)::int n FROM ledger_transactions WHERE kind='withdrawal_paid'"))
        .rows[0].n,
    ).toBe(1);
  });
  it.each(['failed', 'cancelled'])('releases a %s withdrawal to the wallet once', async (outcome) => {
    const headers = await buyer();
    await post(headers, '/api/account/withdrawals', {
      withdrawal_id: 'wd_fail',
      method: 'card',
      amount: 5000,
      recipient: '0000000000001234',
    });
    expect((await api<any>('/api/account', { headers })).user.points_balance).toBe(0);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(headers, '/api/account/withdrawals/wd_fail/simulate', { event_id: `wd_failure_${i}`, outcome }),
      ),
    );
    expect((await api<any>('/api/account', { headers })).user.points_balance).toBe(5000);
    expect((await reconciliationReport()).wallet).toMatchObject({ balanced: true, balances: 5000 });
  });
  it('prevents overspending, cross-account access and final-state changes', async () => {
    const headers = await buyer();
    const results = await Promise.all(
      ['one', 'two'].map((withdrawal_id) =>
        fetch(origin + '/api/account/withdrawals', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            withdrawal_id,
            method: 'crypto',
            amount: 4000,
            recipient: 'DEMO-WALLET-12345',
          }),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const success = await results.find((r) => r.status === 201)!.json();
    expect((await fetch(origin + `/api/account/withdrawals/${success.id}`)).status).toBe(401);
    await post(headers, `/api/account/withdrawals/${success.id}/simulate`, {
      event_id: 'paid_only_once',
      outcome: 'paid',
    });
    expect(
      (
        await fetch(origin + `/api/account/withdrawals/${success.id}/simulate`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ event_id: 'late_failure', outcome: 'failed' }),
        })
      ).status,
    ).toBe(409);
    await expect(getPool().query('UPDATE withdrawals SET amount=1')).rejects.toThrow(
      'immutable_payment_intent',
    );
    await expect(getPool().query('DELETE FROM withdrawal_events')).rejects.toThrow('append_only_table');
  });
  it('releases abandoned withdrawal reservations during recovery', async () => {
    const headers = await buyer();
    await post(headers, '/api/account/withdrawals', {
      withdrawal_id: 'wd_expired',
      method: 'card',
      amount: 3000,
      recipient: '0000000000001234',
    });
    await getPool().query('ALTER TABLE withdrawals DISABLE TRIGGER immutable_withdrawal_terms');
    try {
      await getPool().query("UPDATE withdrawals SET expires_at=clock_timestamp()-interval '1 second'");
    } finally {
      await getPool().query('ALTER TABLE withdrawals ENABLE TRIGGER immutable_withdrawal_terms');
    }
    const { recoverStuckOrders } = await import('../src/services/reconciliation.js');
    await recoverStuckOrders();
    await recoverStuckOrders();
    expect((await api<any>('/api/account', { headers })).user.points_balance).toBe(5000);
    expect((await api<any>('/api/account/withdrawals', { headers })).withdrawals[0].status).toBe('expired');
  });
});

describe('seller products and financial results', () => {
  async function setup(cost: number | null = 300, quantity = 2) {
    const seller = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'financial_seller',
        password: 'password123',
        role: 'seller',
        store_name: 'Финансовый магазин',
      }),
    });
    const headers = { authorization: `Bearer ${seller.token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown, method = 'POST') =>
      api<any>(path, { method, headers, body: JSON.stringify(body) });
    await post('/api/seller/offers/KEY-GTA5', { price: 800, active: true }, 'PUT');
    await post('/api/seller/inventory', {
      sku: 'KEY-GTA5',
      codes: ['COST-KEY-ONE', 'COST-KEY-TWO'].slice(0, quantity),
      unit_cost: cost,
    });
    const buyer = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'financial_buyer', password: 'password123' }),
    });
    const buyerHeaders = { authorization: `Bearer ${buyer.token}` };
    await api('/api/cart/items', {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ sku: 'KEY-GTA5', provider: seller.user.seller_id, quantity }),
    });
    const checkout = await api<any>('/api/cart/checkout', {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ checkout_id: 'financial_checkout' }),
    });
    const dashboard = () => api<any>('/api/seller/dashboard', { headers });
    return { seller, buyer, checkout, headers, post, dashboard };
  }
  it('keeps sale price/cost snapshots, reverses income once and retains the cost of revoked keys', async () => {
    const { checkout, headers, post, dashboard } = await setup();
    expect((await dashboard()).summary).toMatchObject({
      paid: 1600,
      pending: 1600,
      net_income: 0,
      profit: 0,
    });
    await post('/api/seller/offers/KEY-GTA5', { price: 1200, active: true }, 'PUT');
    await runDeliveryBatch(config, app.log);
    let view = await dashboard();
    expect(view.summary).toMatchObject({
      paid: 1600,
      pending: 0,
      net_income: 1600,
      known_cost: 600,
      profit: 1000,
      unknown_cost_count: 0,
    });
    expect(view.orders).toHaveLength(2);
    expect(view.orders[0]).toMatchObject({ amount: 800, net_income: 800, cost_amount: 300, profit: 500 });
    expect(view.offers.find((o: any) => o.sku === 'KEY-GTA5')).toMatchObject({
      is_mine: true,
      price: 1200,
      listing_status: 'out_of_stock',
      available: 0,
      sold: 2,
    });
    expect(
      (
        await fetch(origin + '/api/seller/inventory/COST-KEY-ONE/cost', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ unit_cost: 1 }),
        })
      ).status,
    ).toBe(409);
    await expect(
      getPool().query("UPDATE provider_inventory SET unit_cost_minor=1 WHERE code='COST-KEY-ONE'"),
    ).rejects.toThrow('claimed_inventory_cost_immutable');
    await expect(getPool().query('UPDATE deliveries SET unit_cost_minor=1')).rejects.toThrow(
      'append_only_table',
    );
    const id = checkout.order_ids[0];
    await api(`/api/admin/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Financial verification' }),
    });
    await runDeliveryBatch(config, app.log);
    await api(`/api/admin/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Financial verification' }),
    });
    await runDeliveryBatch(config, app.log);
    view = await dashboard();
    expect(view.summary).toMatchObject({
      paid: 1600,
      refunded: 800,
      net_income: 800,
      known_cost: 600,
      profit: 200,
      refunds: 1,
    });
    expect(view.orders.find((o: any) => o.id === id)).toMatchObject({
      refunded_amount: 800,
      net_income: 0,
      cost_amount: 300,
      profit: -300,
    });
    const other = await api<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'seller_b', password: config.SELLER_PASSWORD }),
    });
    expect(
      (await api<any>('/api/seller/dashboard', { headers: { authorization: `Bearer ${other.token}` } }))
        .orders,
    ).toHaveLength(0);
  });
  it('distinguishes unknown procurement cost from a free key and protects private cost changes', async () => {
    const { post, dashboard } = await setup(null, 1);
    await runDeliveryBatch(config, app.log);
    expect((await dashboard()).summary).toMatchObject({
      net_income: 800,
      profit: null,
      unknown_cost_count: 1,
    });
    await post('/api/seller/inventory', { sku: 'KEY-CS2-PRIME', codes: ['UNPRICED-PRIVATE-KEY'] });
    await post('/api/seller/inventory/UNPRICED-PRIVATE-KEY/cost', { unit_cost: 0 }, 'PUT');
    const view = await dashboard();
    expect(view.inventory.find((i: any) => i.code === 'UNPRICED-PRIVATE-KEY')).toMatchObject({
      unit_cost: 0,
      can_edit_cost: true,
    });
    expect(view.offers.find((o: any) => o.sku === 'KEY-CS2-PRIME')).toMatchObject({
      is_mine: true,
      listing_status: 'paused',
      available: 1,
    });
    expect(view.products_summary).toMatchObject({ total: 2, selling: 0, available: 1 });
    const other = await api<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'seller_b', password: config.SELLER_PASSWORD }),
    });
    expect(
      (
        await fetch(origin + '/api/seller/inventory/UNPRICED-PRIVATE-KEY/cost', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
          body: JSON.stringify({ unit_cost: 100 }),
        })
      ).status,
    ).toBe(404);
    const publicProduct = await api<any>('/api/catalog/KEY-CS2-PRIME');
    expect(JSON.stringify(publicProduct)).not.toContain('unit_cost');
  });
  it('paginates all seller orders without limiting totals to the visible page', async () => {
    const seller = await api<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'seller_a', password: config.SELLER_PASSWORD }),
    });
    for (let n = 0; n < 51; n++)
      await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ order_id: `seller_page_${n}`, items: [{ sku: 'KEY-GTA5', provider: 'A' }] }),
      });
    const headers = { authorization: `Bearer ${seller.token}` };
    const first = await api<any>('/api/seller/dashboard', { headers });
    const second = await api<any>('/api/seller/dashboard?page=2', { headers });
    expect(first.pagination).toMatchObject({ page: 1, pages: 2, total: 51 });
    expect(first.orders).toHaveLength(50);
    expect(second.orders).toHaveLength(1);
    expect(new Set([...first.orders, ...second.orders].map((o) => o.id)).size).toBe(51);
    expect(first.summary).toEqual(second.summary);
    expect(first.summary).toMatchObject({ orders: 51, paid: 0, net_income: 0, profit: 0 });
  });
});

describe('seller stock lots and reservation integrity', () => {
  async function setup(quantity = 1000) {
    const seller = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'lots_seller',
        password: 'password123',
        role: 'seller',
        store_name: 'Партии ключей',
      }),
    });
    const headers = { authorization: `Bearer ${seller.token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown, method = 'POST') =>
      api<any>(path, { method, headers, body: JSON.stringify(body) });
    await post('/api/seller/offers/KEY-CS2-PRIME', { price: 99, active: true }, 'PUT');
    await post('/api/seller/inventory', {
      sku: 'KEY-CS2-PRIME',
      codes: Array.from({ length: quantity }, (_, i) => `LOT-KEY-${String(i).padStart(5, '0')}`),
      unit_cost: 40,
    });
    const dashboard = () => api<any>('/api/seller/dashboard', { headers });
    const source = (await dashboard()).offers.find((o: any) => o.sku === 'KEY-CS2-PRIME');
    return { seller, headers, post, dashboard, source };
  }
  async function buyer(name = 'lots_buyer') {
    const account = await api<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: name, password: 'password123' }),
    });
    const headers = { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown, method = 'POST') =>
      api<any>(path, { method, headers, body: JSON.stringify(body) });
    return { account, headers, post };
  }
  const parts = [
    { name: '200 дешёвых', quantity: 200, price: 100, active: true },
    { name: '400 средних', quantity: 400, price: 150, active: true },
    { name: '400 дорогих', quantity: 400, price: 200, active: true },
  ];
  it('prices two concrete keys independently at 1 and 2 and delivers the exact keys for 3', async () => {
    const { post, headers, seller, dashboard } = await setup(2);
    const codes = ['LOT-KEY-00000', 'LOT-KEY-00001'];
    const prices = await Promise.all(
      codes.map((code, i) =>
        post(`/api/seller/inventory/${code}/price`, { price: i + 1, active: true }, 'PUT'),
      ),
    );
    expect(new Set(prices.map((p) => p.offer_id)).size).toBe(2);
    const stock = await api<any>('/api/seller/inventory', { headers });
    expect(stock.items.map((k: any) => [k.code, k.price])).toEqual([
      [codes[0], 1],
      [codes[1], 2],
    ]);
    expect(stock.pagination).toMatchObject({ total: 2, pages: 1 });
    const offersBefore = (await dashboard()).offers.length;
    const retries = await Promise.all(
      Array.from({ length: 12 }, () =>
        post(`/api/seller/inventory/${codes[1]}/price`, { price: 2, active: true }, 'PUT'),
      ),
    );
    expect(retries.every((r) => r.offer_id === prices[1].offer_id)).toBe(true);
    expect((await dashboard()).offers).toHaveLength(offersBefore);
    const changed = await post(`/api/seller/inventory/${codes[0]}/price`, { price: 3, active: true }, 'PUT');
    expect(changed.offer_id).toBe(prices[0].offer_id);
    await post(`/api/seller/inventory/${codes[0]}/price`, { price: 1, active: true }, 'PUT');
    const b = await buyer();
    for (const p of prices) await b.post('/api/cart/items', { sku: 'KEY-CS2-PRIME', offer_id: p.offer_id });
    expect((await api<any>('/api/cart', { headers: b.headers })).total_points).toBe(3);
    const checkout = await b.post('/api/cart/checkout', { checkout_id: 'two_key_prices' });
    const locked = await fetch(origin + `/api/seller/inventory/${codes[0]}/price`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ price: 7, active: true }),
    });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toBe('inventory_price_locked');
    await runDeliveryBatch(config, app.log);
    const group = await getOrder(checkout.order_id);
    expect(group.status).toBe('delivered');
    expect(group.items.map((i: any) => [i.code, i.amount]).sort()).toEqual([
      [codes[0], 1],
      [codes[1], 2],
    ]);
    expect((await dashboard()).summary).toMatchObject({ net_income: 3, known_cost: 80, profit: -77 });
    const publicProduct = await api<any>('/api/catalog/KEY-CS2-PRIME/offers');
    for (const code of codes) expect(JSON.stringify(publicProduct)).not.toContain(code);
    const issued = await fetch(origin + `/api/seller/inventory/${codes[1]}/price`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ price: 9, active: true }),
    });
    expect(issued.status).toBe(409);
    const id = group.items.find((i: any) => i.code === codes[1]).id;
    await api(`/api/admin/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Individual key refund' }),
    });
    await runDeliveryBatch(config, app.log);
    expect((await dashboard()).summary).toMatchObject({ net_income: 1, refunded: 2, profit: -79 });
    expect((await api<any>('/api/account', { headers: b.headers })).user.points_balance).toBe(4999);
    expect(seller.user.seller_id).toBeTruthy();
  });
  it('changes only the selected key even after more stock is uploaded into its offer', async () => {
    const { post, headers } = await setup(2);
    const path = '/api/seller/inventory/LOT-KEY-00000/price';
    const first = await post(path, { price: 1, active: true }, 'PUT');
    await post('/api/seller/inventory', {
      sku: 'KEY-CS2-PRIME',
      offer_id: first.offer_id,
      codes: ['ADDED-TO-KEY-OFFER'],
    });
    const second = await post(path, { price: 2, active: false }, 'PUT');
    expect(second.offer_id).not.toBe(first.offer_id);
    const stock = await api<any>('/api/seller/inventory', { headers });
    expect(stock.items.find((k: any) => k.code === 'ADDED-TO-KEY-OFFER')).toMatchObject({
      price: 1,
      active: true,
    });
    expect(stock.items.find((k: any) => k.code === 'LOT-KEY-00001')).toMatchObject({
      price: 99,
      active: true,
    });
    expect(stock.items.find((k: any) => k.code === 'LOT-KEY-00000')).toMatchObject({
      price: 2,
      active: false,
      listing_label: 'Снят с продажи',
    });
    const other = await api<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'seller_a', password: config.SELLER_PASSWORD }),
    });
    const foreign = await fetch(origin + path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ price: 5, active: true }),
    });
    expect(foreign.status).toBe(404);
  });
  it('lists all 1000 keys with stable server pagination and literal search scoped to the seller', async () => {
    const { headers } = await setup();
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) => api<any>(`/api/seller/inventory?page=${i + 1}`, { headers })),
    );
    expect(all.every((r) => r.pagination.total === 1000 && r.items.length === 50)).toBe(true);
    expect(new Set(all.flatMap((r) => r.items.map((k: any) => k.code))).size).toBe(1000);
    const exact = await api<any>('/api/seller/inventory?search=LOT-KEY-00999', { headers });
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0].code).toBe('LOT-KEY-00999');
    expect((await api<any>('/api/seller/inventory?search=%25', { headers })).items).toHaveLength(0);
    expect((await api<any>('/api/seller/inventory?status=issued', { headers })).items).toHaveLength(0);
  });
  it('serializes repricing against checkout without delivering a key under another offer', async () => {
    const { post, headers, source } = await setup(1);
    const b = await buyer();
    await b.post('/api/cart/items', { sku: source.sku, offer_id: source.offer_id });
    const [price, checkout] = await Promise.all([
      fetch(origin + '/api/seller/inventory/LOT-KEY-00000/price', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ price: 1, active: true }),
      }),
      fetch(origin + '/api/cart/checkout', {
        method: 'POST',
        headers: b.headers,
        body: JSON.stringify({ checkout_id: 'price_checkout_race' }),
      }),
    ]);
    const priced = await price.json(),
      bought = await checkout.json();
    if (checkout.status === 201) {
      expect(price.status).toBe(409);
      expect(priced.error).toBe('inventory_price_locked');
      await runDeliveryBatch(config, app.log);
      expect((await getOrder(bought.order_id)).items[0]).toMatchObject({
        amount: 99,
        code: 'LOT-KEY-00000',
        assigned_offer_id: source.offer_id,
      });
    } else {
      expect(checkout.status).toBe(409);
      expect(price.status).toBe(200);
      expect((await api<any>('/api/account', { headers: b.headers })).user.points_balance).toBe(5000);
      expect((await getPool().query('SELECT count(*)::int n FROM deliveries')).rows[0].n).toBe(0);
    }
  });
  it('splits exactly 1000 existing keys into 200/400/400 once under concurrent retries', async () => {
    const { post, source, dashboard, seller, headers } = await setup();
    const body = { request_id: 'split_1000', source_offer_id: source.offer_id, parts };
    const replies = await Promise.all(Array.from({ length: 12 }, () => post('/api/seller/lots/split', body)));
    for (const reply of replies) expect(reply).toEqual(replies[0]);
    const view = await dashboard();
    const lots = view.offers.filter((o: any) => !o.is_default);
    expect(lots.map((o: any) => [o.available, o.price]).sort((a: any, b: any) => a[1] - b[1])).toEqual([
      [200, 100],
      [400, 150],
      [400, 200],
    ]);
    expect(view.offers.find((o: any) => o.offer_id === source.offer_id).available).toBe(0);
    expect(view.products_summary).toMatchObject({ total: 1, lots: 4, available: 1000, selling: 1 });
    expect(
      (
        await getPool().query('SELECT count(*)::int n FROM provider_inventory WHERE provider=$1', [
          seller.user.seller_id,
        ])
      ).rows[0].n,
    ).toBe(1000);
    expect((await getPool().query('SELECT count(*)::int n FROM seller_lot_operations')).rows[0].n).toBe(1);
    expect(
      (
        await fetch(origin + '/api/seller/lots/split', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, parts: [{ ...parts[0], quantity: 1 }] }),
        })
      ).status,
    ).toBe(409);
    const other = await api<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'seller_b', password: config.SELLER_PASSWORD }),
    });
    expect(
      (
        await fetch(origin + '/api/seller/lots/split', {
          method: 'POST',
          headers: { ...headers, authorization: `Bearer ${other.token}` },
          body: JSON.stringify({ ...body, request_id: 'steal' }),
        })
      ).status,
    ).toBe(404);
  });
  it('keeps three prices in one cart and delivers only the exact selected lot with fixed historic profit', async () => {
    const { post, source, dashboard, seller } = await setup(6);
    const lots = (
      await post('/api/seller/lots/split', {
        request_id: 'split_small',
        source_offer_id: source.offer_id,
        parts: parts.map((p) => ({ ...p, quantity: 2 })),
      })
    ).lots;
    const b = await buyer();
    for (const lot of lots)
      await b.post('/api/cart/items', {
        sku: source.sku,
        provider: seller.user.seller_id,
        offer_id: lot.offer_id,
        quantity: 1,
      });
    const cart = await api<any>('/api/cart', { headers: b.headers });
    expect(cart.items).toHaveLength(3);
    expect(cart.total_points).toBe(450);
    expect(
      (
        await fetch(origin + `/api/cart/items/${source.sku}?provider=${seller.user.seller_id}`, {
          method: 'PUT',
          headers: b.headers,
          body: JSON.stringify({ quantity: 2 }),
        })
      ).status,
    ).toBe(409);
    await b.post(`/api/cart/items/${source.sku}?offer_id=${lots[0].offer_id}`, { quantity: 2 }, 'PUT');
    expect((await api<any>('/api/cart', { headers: b.headers })).total_points).toBe(550);
    await b.post(`/api/cart/items/${source.sku}?offer_id=${lots[0].offer_id}`, { quantity: 1 }, 'PUT');
    const checkout = await b.post('/api/cart/checkout', { checkout_id: 'buy_three_lots' });
    expect(checkout.order.amount).toBe(450);
    expect((await dashboard()).products_summary).toMatchObject({ reserved: 3, available: 3 });
    await post(
      `/api/seller/lots/${lots[1].offer_id}`,
      { price: 999, active: true, name: 'Переименована' },
      'PUT',
    );
    await runDeliveryBatch(config, app.log);
    const group = await getOrder(checkout.order_id);
    expect(group.status).toBe('delivered');
    expect(group.items.map((i: any) => i.amount).sort((a: number, b: number) => a - b)).toEqual([
      100, 150, 200,
    ]);
    expect(group.items.find((i: any) => i.assigned_offer_id === lots[1].offer_id).offer_name).toBe(
      '400 средних',
    );
    const codes = (
      await getPool().query(
        `SELECT o.assigned_offer_id,i.offer_id FROM orders o JOIN deliveries d ON d.order_id=o.id JOIN provider_inventory i ON i.code=d.code WHERE o.group_id=$1`,
        [checkout.order_id],
      )
    ).rows;
    expect(codes).toHaveLength(3);
    expect(codes.every((r) => r.assigned_offer_id === r.offer_id)).toBe(true);
    expect((await dashboard()).summary).toMatchObject({ net_income: 450, known_cost: 120, profit: 330 });
    const refundId = group.items.find((i: any) => i.assigned_offer_id === lots[1].offer_id).id;
    await api(`/api/admin/orders/${refundId}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Lot profit refund' }),
    });
    await runDeliveryBatch(config, app.log);
    expect((await dashboard()).summary).toMatchObject({
      net_income: 300,
      refunded: 150,
      known_cost: 120,
      profit: 180,
    });
  });
  it('reserves the last key for exactly one concurrent buyer and cannot move or reprice its procurement', async () => {
    const { post, source, dashboard, headers } = await setup(1);
    const a = await buyer('last_key_a'),
      b = await buyer('last_key_b');
    for (const c of [a, b]) await c.post('/api/cart/items', { sku: source.sku, offer_id: source.offer_id });
    const results = await Promise.all(
      [a, b].map((c, i) =>
        fetch(origin + '/api/cart/checkout', {
          method: 'POST',
          headers: c.headers,
          body: JSON.stringify({ checkout_id: `race_lot_${i}`, method: 'sbp' }),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const view = await dashboard();
    expect(view.products_summary).toMatchObject({ available: 0, reserved: 1 });
    expect(view.inventory[0]).toMatchObject({ status: 'reserved', can_edit_cost: false });
    const inventory = await api<any>('/api/admin/inventory');
    expect(inventory.keys.find((k: any) => k.code === 'LOT-KEY-00000')).toMatchObject({
      status_label: 'В резерве',
    });
    expect((await api<any>('/api/admin/summary')).inventory.reserved).toBe(1);
    expect(
      (
        await fetch(origin + '/api/seller/lots/split', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            request_id: 'move_reserved',
            source_offer_id: source.offer_id,
            parts: [{ ...parts[0], quantity: 1 }],
          }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(origin + '/api/seller/inventory/LOT-KEY-00000/cost', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ unit_cost: 1 }),
        })
      ).status,
    ).toBe(409);
    await expect(
      getPool().query("UPDATE provider_inventory SET unit_cost_minor=1 WHERE code='LOT-KEY-00000'"),
    ).rejects.toThrow('claimed_inventory_cost_immutable');
    expect((await getPool().query('SELECT count(*)::int n FROM order_groups')).rows[0].n).toBe(1);
  });
  it.each(['failed', 'cancelled', 'expired'])(
    'releases %s payment reservations and refuses to substitute another lot on retry',
    async (outcome) => {
      const { source, post, dashboard } = await setup(1);
      const b = await buyer();
      await b.post('/api/cart/items', { sku: source.sku, offer_id: source.offer_id });
      const checkout = await b.post('/api/cart/checkout', { checkout_id: 'lot_payment', method: 'sbp' });
      if (outcome === 'expired') {
        await getPool().query('ALTER TABLE payment_intents DISABLE TRIGGER immutable_intent_terms');
        try {
          await getPool().query(
            "UPDATE payment_intents SET expires_at=clock_timestamp()-interval '1 second'",
          );
        } finally {
          await getPool().query('ALTER TABLE payment_intents ENABLE TRIGGER immutable_intent_terms');
        }
        const { expirePayments } = await import('../src/services/payment-intents.js');
        await expirePayments();
      } else
        await b.post(`/api/payments/${checkout.payment_id}/simulate`, { event_id: 'release_lot', outcome });
      expect((await dashboard()).products_summary).toMatchObject({ available: 1, reserved: 0 });
      await post('/api/seller/lots/split', {
        request_id: 'move_after_release',
        source_offer_id: source.offer_id,
        parts: [{ ...parts[0], quantity: 1 }],
      });
      const retry = await fetch(origin + `/api/payments/${checkout.payment_id}/retry`, {
        method: 'POST',
        headers: b.headers,
        body: JSON.stringify({ retry_id: 'retry_sold_out_lot' }),
      });
      expect(retry.status).toBe(409);
      expect((await retry.json()).error).toBe('lot_insufficient_stock');
      expect((await api<any>('/api/account', { headers: b.headers })).user.points_balance).toBe(5000);
      await post('/api/seller/inventory', {
        sku: source.sku,
        offer_id: source.offer_id,
        codes: ['REPLENISHED-SAME-LOT'],
        unit_cost: 30,
      });
      const next = await b.post(`/api/payments/${checkout.payment_id}/retry`, {
        retry_id: 'retry_replenished_lot',
      });
      await b.post(`/api/payments/${next.id}/simulate`, { event_id: 'paid_same_lot', outcome: 'paid' });
      await runDeliveryBatch(config, app.log);
      const group = await getOrder(checkout.order_id);
      expect(group.items[0]).toMatchObject({
        code: 'REPLENISHED-SAME-LOT',
        amount: 99,
        assigned_offer_id: source.offer_id,
      });
    },
  );
  it('rejects oversplitting atomically, wrong-product uploads and default-price access to custom lot stock', async () => {
    const { source, post, headers, seller } = await setup(2);
    const failed = await fetch(origin + '/api/seller/lots/split', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        request_id: 'too_many',
        source_offer_id: source.offer_id,
        parts: [
          { ...parts[0], quantity: 1 },
          { ...parts[1], quantity: 2 },
        ],
      }),
    });
    expect(failed.status).toBe(409);
    expect(
      (
        await getPool().query('SELECT count(*)::int n FROM seller_offers WHERE provider=$1', [
          seller.user.seller_id,
        ])
      ).rows[0].n,
    ).toBe(1);
    const lot = (
      await post('/api/seller/lots/split', {
        request_id: 'all_custom',
        source_offer_id: source.offer_id,
        parts: [{ ...parts[0], quantity: 2 }],
      })
    ).lots[0];
    expect(
      (
        await fetch(origin + '/api/seller/inventory', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sku: 'KEY-GTA5', offer_id: lot.offer_id, codes: ['WRONG-PRODUCT-LOT'] }),
        })
      ).status,
    ).toBe(404);
    await expect(
      getPool().query(
        "UPDATE provider_inventory SET offer_id=$1 WHERE code=(SELECT code FROM provider_inventory WHERE provider='B' LIMIT 1)",
        [lot.offer_id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      getPool().query('UPDATE seller_offers SET provider=$1 WHERE id=$2', ['B', lot.offer_id]),
    ).rejects.toThrow('lot_identity_immutable');
    const b = await buyer();
    await b.post('/api/cart/items', {
      sku: source.sku,
      provider: seller.user.seller_id,
      offer_id: source.offer_id,
    });
    expect(
      (await api<any>('/api/cart/quote', { method: 'POST', headers: b.headers, body: '{}' })).can_checkout,
    ).toBe(false);
  });
});
