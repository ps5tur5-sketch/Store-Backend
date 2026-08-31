import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getPool } from './db.js';
import { addInventory, inventoryReport } from './services/admin.js';
import { accountSummary, loginUser, logoutUser, registerUser, userFromToken, type PublicUser } from './services/accounts.js';
import {
  addCartItem, addPaymentCodes, cartQuote, cartReport, checkoutCart, paymentCodesReport,
  publicCheckoutId, purchaseDetail, purchaseHistory, removeCartItem, setCartItem,
} from './services/cart.js';
import { getCatalogItem, listCatalog } from './services/catalog.js';
import { retryOrder, runDeliveryBatch } from './services/delivery.js';
import { createOrder, getOrder } from './services/orders.js';
import { handlePaymentWebhook } from './services/payment.js';
import { reconciliationReport, recoverStuckOrders } from './services/reconciliation.js';
import { issueFromStub } from './services/supplier-stub.js';
import type { Provider } from './types.js';

const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const providerSchema = z.enum(['A', 'B']);
const orderBody = z.object({ sku: z.string().trim().min(1).max(100), order_id: id.optional() }).strict();
const paymentBody = z.object({
  event_id: id,
  order_id: id,
  status: z.enum(['paid', 'failed']),
  amount: z.number().int().positive(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  created_at: z.iso.datetime({ offset: true }),
}).strict();
const supplierBody = z.object({ request_id: id, sku: z.string().min(1).max(100), order_id: id }).strict();
const inventoryBody = z.object({
  provider: providerSchema,
  sku: z.string().trim().min(1).max(100),
  codes: z.array(z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9-]+$/)).min(1).max(1000),
}).strict();
const supplierConfigBody = z.object({
  mode: z.enum(['normal', 'always_fail', 'out_of_stock', 'timeout_before_issue', 'timeout_after_issue']),
  failure_rate: z.number().min(0).max(1).default(0),
  timeout_rate: z.number().min(0).max(1).default(0),
  min_delay_ms: z.number().int().min(0).max(60_000).default(0),
  timeout_delay_ms: z.number().int().min(0).max(60_000).default(1000),
}).strict();
const credentialsBody = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_.-]+$/u),
  password: z.string().min(6).max(128),
}).strict();
const cartItemBody = z.object({
  sku: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(10).default(1),
}).strict();
const checkoutBody = z.object({
  checkout_id: id.optional(),
  code: z.preprocess(
    (value) => typeof value === 'string' && !value.trim() ? undefined : value,
    z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  ),
}).strict();
const paymentCodesBody = z.object({
  codes: z.array(z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9-]+$/)).min(1).max(1000),
  value_points: z.number().int().positive().max(10_000_000),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw Object.assign(new Error('Validation failed'), { statusCode: 400, details: z.treeifyError(result.error) });
  }
  return result.data;
}

async function requireUser(request: FastifyRequest): Promise<PublicUser> {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : undefined;
  if (!match?.[1]) throw Object.assign(new Error('authentication_required'), { statusCode: 401 });
  const user = await userFromToken(match[1]);
  if (!user) throw Object.assign(new Error('invalid_or_expired_session'), { statusCode: 401 });
  return user;
}

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  app.register(cors, { origin: true });

  app.setErrorHandler((error, request, reply) => {
    const appError = error as Error & { statusCode?: number; details?: unknown };
    const statusCode = typeof appError.statusCode === 'number' ? appError.statusCode : 500;
    request.log.error({ event: 'request_failed', error: appError.message, statusCode }, 'request failed');
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : appError.message,
      details: appError.details,
    });
  });

  app.get('/health', async () => {
    await getPool().query('SELECT 1');
    return { status: 'ok', database: 'ok' };
  });

  app.get('/api/catalog', async (request) => {
    const query = parse(z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      type: z.string().optional(),
      search: z.string().max(100).optional(),
    }), request.query);
    return listCatalog(query);
  });

  app.get('/api/catalog/:sku', async (request, reply) => {
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    const product = await getCatalogItem(params.sku);
    if (!product) return reply.status(404).send({ error: 'product_not_found' });
    return product;
  });

  app.post('/api/auth/register', async (request, reply) => {
    const body = parse(credentialsBody, request.body);
    const result = await registerUser(body.username, body.password);
    request.log.info({ event: 'user_registered', userId: result.user.id, username: result.user.username }, 'user registered with starting points');
    return reply.status(201).send(result);
  });

  app.post('/api/auth/login', async (request) => {
    const body = parse(credentialsBody, request.body);
    const result = await loginUser(body.username, body.password);
    request.log.info({ event: 'user_logged_in', userId: result.user.id }, 'user logged in');
    return result;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : undefined;
    if (match?.[1]) await logoutUser(match[1]);
    return reply.status(204).send();
  });

  app.get('/api/account', async (request) => accountSummary((await requireUser(request)).id));

  app.get('/api/cart', async (request) => cartReport((await requireUser(request)).id));

  app.post('/api/cart/items', async (request, reply) => {
    const user = await requireUser(request);
    const body = parse(cartItemBody, request.body);
    return reply.status(201).send(await addCartItem(user.id, body.sku, body.quantity));
  });

  app.put('/api/cart/items/:sku', async (request) => {
    const user = await requireUser(request);
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    const body = parse(z.object({ quantity: z.number().int().min(1).max(10) }).strict(), request.body);
    return setCartItem(user.id, params.sku, body.quantity);
  });

  app.delete('/api/cart/items/:sku', async (request) => {
    const user = await requireUser(request);
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    return removeCartItem(user.id, params.sku);
  });

  app.post('/api/cart/quote', async (request) => {
    const user = await requireUser(request);
    const body = parse(checkoutBody.omit({ checkout_id: true }), request.body ?? {});
    return cartQuote(user.id, body.code);
  });

  app.post('/api/cart/checkout', async (request, reply) => {
    const user = await requireUser(request);
    const body = parse(checkoutBody, request.body);
    const result = await checkoutCart(user.id, body.checkout_id ?? publicCheckoutId(), body.code);
    request.log.info({ event: 'cart_checked_out', userId: user.id, checkoutId: result.checkout_id, method: result.method, orderIds: result.order_ids }, 'cart checkout committed');
    return reply.status(201).send(result);
  });

  app.get('/api/account/purchases', async (request) => purchaseHistory((await requireUser(request)).id));

  app.get('/api/account/purchases/:orderId', async (request, reply) => {
    const user = await requireUser(request);
    const params = parse(z.object({ orderId: id }), request.params);
    const purchase = await purchaseDetail(user.id, params.orderId);
    if (!purchase) return reply.status(404).send({ error: 'purchase_not_found' });
    return purchase;
  });

  app.post('/api/orders', async (request, reply) => {
    const body = parse(orderBody, request.body);
    const order = await createOrder(body.sku, body.order_id);
    request.log.info({ event: 'order_created', orderId: order.id, sku: order.sku, status: order.status }, 'order created');
    return reply.status(201).send(await getOrder(order.id));
  });

  app.get('/api/orders/:orderId', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const order = await getOrder(params.orderId);
    if (!order) return reply.status(404).send({ error: 'order_not_found' });
    return order;
  });

  app.post('/api/orders/:orderId/retry', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const scheduled = await retryOrder(params.orderId);
    if (!scheduled) return reply.status(409).send({ error: 'order_is_not_recoverable_or_not_paid' });
    return reply.status(202).send({ scheduled: true, order_id: params.orderId });
  });

  app.post('/webhook/payment', async (request, reply) => {
    const body = parse(paymentBody, request.body);
    const result = await handlePaymentWebhook(body);
    request.log.info({ event: 'payment_webhook', eventId: body.event_id, orderId: body.order_id, paymentStatus: body.status, ...result }, 'payment webhook durably accepted');
    if (result.outcome === 'event_id_payload_conflict') {
      return reply.status(409).send({ accepted: false, ...result });
    }
    return reply.status(200).send({ accepted: true, ...result });
  });

  // Local payment-system stub: builds the exact webhook contract from the order snapshot.
  app.post('/api/orders/:orderId/simulate-payment', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const body = parse(z.object({
      status: z.enum(['paid', 'failed']).default('paid'),
      event_id: id.optional(),
      created_at: z.iso.datetime({ offset: true }).optional(),
    }).default({ status: 'paid' }), request.body ?? {});
    const order = await getOrder(params.orderId);
    if (!order) return reply.status(404).send({ error: 'order_not_found' });
    const event = {
      event_id: body.event_id ?? `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      order_id: params.orderId,
      status: body.status,
      amount: Number(order.amount),
      currency: String(order.currency),
      created_at: body.created_at ?? new Date().toISOString(),
    };
    const result = await handlePaymentWebhook(event);
    return reply.status(200).send({ event, result });
  });

  app.post('/suppliers/:provider/issue', async (request, reply) => {
    const params = parse(z.object({ provider: providerSchema }), request.params);
    const body = parse(supplierBody, request.body);
    const result = await issueFromStub(params.provider, body);
    request.log.info({ event: 'supplier_stub_request', provider: params.provider, requestId: body.request_id, orderId: body.order_id, responseStatus: result.statusCode, delayMs: result.delayMs }, 'supplier stub handled request');
    if (result.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, result.delayMs));
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/api/reconciliation', async () => reconciliationReport());
  app.post('/api/reconciliation/recover', async (request, reply) => {
    const result = await recoverStuckOrders();
    request.log.info({ event: 'reconciliation_recovery', ...result }, 'reconciliation recovery completed');
    return reply.status(202).send(result);
  });

  app.get('/api/admin/inventory', async (request) => {
    const query = parse(z.object({ sku: z.string().optional() }), request.query);
    return inventoryReport(query.sku);
  });

  app.post('/api/admin/inventory', async (request, reply) => {
    const body = parse(inventoryBody, request.body);
    const result = await addInventory(body.provider, body.sku, body.codes);
    request.log.info({ event: 'inventory_added', provider: body.provider, sku: body.sku, inserted: result.inserted.length, duplicates: result.duplicates.length, paymentCodesInserted: result.payment_codes_inserted.length, paymentCodeValuePoints: result.payment_code_value_points }, 'inventory batch processed');
    return reply.status(201).send(result);
  });

  app.get('/api/admin/payment-codes', async () => paymentCodesReport());

  app.post('/api/admin/payment-codes', async (request, reply) => {
    const body = parse(paymentCodesBody, request.body);
    const result = await addPaymentCodes(body.codes, body.value_points);
    request.log.info({ event: 'payment_codes_added', inserted: (result.inserted as string[]).length, valuePoints: body.value_points }, 'payment code batch processed');
    return reply.status(201).send(result);
  });

  app.get('/api/admin/suppliers', async () => {
    const result = await getPool().query('SELECT * FROM supplier_configs ORDER BY provider');
    return { suppliers: result.rows };
  });

  app.put('/api/admin/suppliers/:provider', async (request) => {
    const params = parse(z.object({ provider: providerSchema }), request.params);
    const body = parse(supplierConfigBody, request.body);
    const result = await getPool().query(
      `UPDATE supplier_configs SET mode = $2, failure_rate = $3, timeout_rate = $4,
       min_delay_ms = $5, timeout_delay_ms = $6, updated_at = now()
       WHERE provider = $1 RETURNING *`,
      [params.provider, body.mode, body.failure_rate, body.timeout_rate, body.min_delay_ms, body.timeout_delay_ms],
    );
    return result.rows[0];
  });

  app.post('/api/admin/workers/run', async (request) => {
    const body = parse(z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 }), request.body ?? {});
    return { processed: await runDeliveryBatch(config, request.log, body.limit) };
  });

  app.get('/api/admin/summary', async () => {
    const [orders, stock, ledger] = await Promise.all([
      getPool().query(`SELECT status, count(*)::integer AS count FROM orders GROUP BY status ORDER BY status`),
      getPool().query(`SELECT count(*) FILTER (WHERE claimed_by IS NULL)::integer AS available,
        count(*) FILTER (WHERE claimed_by IS NOT NULL)::integer AS issued FROM provider_inventory`),
      getPool().query(`SELECT account, COALESCE(sum(amount), 0)::bigint AS balance FROM ledger_entries GROUP BY account ORDER BY account`),
    ]);
    return { orders: orders.rows, inventory: stock.rows[0], ledger: ledger.rows.map((row) => ({ ...row, balance: Number(row.balance) })) };
  });

  app.get('/api/admin/orders/:orderId/evidence', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const order = await getOrder(params.orderId);
    if (!order) return reply.status(404).send({ error: 'order_not_found' });
    const result = await getPool().query(
      `SELECT
        (SELECT count(*)::integer FROM payment_events WHERE order_id = $1) AS payment_events,
        (SELECT count(*)::integer FROM deliveries WHERE order_id = $1) AS deliveries,
        (SELECT count(*)::integer FROM provider_issuances WHERE order_id = $1) AS provider_issuances,
        (SELECT count(*)::integer FROM audit_events WHERE order_id = $1 AND event_type = 'order_delivered') AS delivery_facts,
        (SELECT COALESCE(sum(le.amount), 0)::bigint FROM ledger_entries le
          JOIN ledger_transactions lt ON lt.id = le.transaction_id WHERE lt.order_id = $1) AS ledger_balance`,
      [params.orderId],
    );
    const evidence = result.rows[0];
    return { order, evidence: { ...evidence, ledger_balance: Number(evidence.ledger_balance) } };
  });

  if (config.ENABLE_TEST_CONTROLS) {
    app.post('/api/test/inventory/:sku/drain', async (request) => {
      const params = parse(z.object({ sku: z.string().min(1) }), request.params);
      const result = await getPool().query(
        `UPDATE provider_inventory SET claimed_by = concat('test-drain:', code), claimed_at = now()
         WHERE sku = $1 AND claimed_by IS NULL RETURNING code`,
        [params.sku],
      );
      return { drained: result.rowCount ?? 0 };
    });
    app.post('/api/test/inventory/:sku/restore', async (request) => {
      const params = parse(z.object({ sku: z.string().min(1) }), request.params);
      const result = await getPool().query(
        `UPDATE provider_inventory SET claimed_by = NULL, claimed_at = NULL
         WHERE sku = $1 AND claimed_by LIKE 'test-drain:%' RETURNING code`,
        [params.sku],
      );
      return { restored: result.rowCount ?? 0 };
    });
  }

  return app;
}
