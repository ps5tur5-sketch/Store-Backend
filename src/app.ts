import { splitLot, updateLot, updateKeyPrice } from './services/lots.js';
import { sellerInventory } from './services/seller-dashboard.js';
import {
  createWithdrawal,
  getWithdrawal,
  withdrawalHistory,
  simulateWithdrawal,
  adminWithdrawals,
} from './services/withdrawals.js';
import {
  createTopup,
  getPaymentIntent,
  paymentHistory,
  paymentMethods,
  retryPayment,
  simulatePayment,
} from './services/payment-intents.js';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getPool } from './db.js';
import { addInventory, inventoryReport } from './services/admin.js';
import {
  accountSummary,
  activateSeller,
  loginUser,
  logoutUser,
  registerUser,
  userFromToken,
  type PublicUser,
} from './services/accounts.js';
import {
  addCartItem,
  addPaymentCodes,
  cartQuote,
  cartReport,
  checkoutCart,
  paymentCodesReport,
  publicCheckoutId,
  purchaseDetail,
  purchaseHistory,
  removeCartItem,
  setCartItem,
} from './services/cart.js';
import { getCatalogItem, listCatalog } from './services/catalog.js';
import { retryOrder, runDeliveryBatch } from './services/delivery.js';
import { createOrder, getOrder } from './services/orders.js';
import { handlePaymentWebhook } from './services/payment.js';
import { reconciliationReport, recoverStuckOrders } from './services/reconciliation.js';
import {
  createOrderGroup,
  getOrderGroup,
  orderAt,
  moneyReport,
  queueReport,
} from './services/order-groups.js';
import { issueFromStub, resolveFromStub } from './services/supplier-stub.js';
import { sellerReport, productOffers, reviewPurchase } from './services/sellers.js';
import { conversation, sendOrderMessage } from './services/chat.js';
import { setUserBan, setSellerBan, requestRefund, administrationOrders } from './services/moderation.js';
import { sellerDashboard, updateOffer, updateInventoryCost } from './services/seller-dashboard.js';
import type { Provider } from './types.js';

const id = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const providerSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9_-]+$/);
const orderBody = z.union([
  z.object({ sku: z.string().trim().min(1).max(100), order_id: id.optional() }).strict(),
  z
    .object({
      items: z
        .array(
          z
            .object({
              sku: z.string().trim().min(1).max(100),
              quantity: z.number().int().min(1).max(10).default(1),
              provider: providerSchema.optional(),
              offer_id: id.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      order_id: id.optional(),
    })
    .strict(),
]);
const paymentBody = z
  .object({
    event_id: id,
    order_id: id,
    status: z.enum(['paid', 'failed']),
    amount: z.number().int().positive(),
    currency: z
      .string()
      .length(3)
      .transform((value) => value.toUpperCase()),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
const supplierBody = z.object({ request_id: id, sku: z.string().min(1).max(100), order_id: id }).strict();
const inventoryBody = z
  .object({
    provider: providerSchema,
    sku: z.string().trim().min(1).max(100),
    codes: z
      .array(
        z
          .string()
          .trim()
          .min(4)
          .max(100)
          .regex(/^[A-Za-z0-9-]+$/),
      )
      .min(1)
      .max(1000),
  })
  .strict();
const supplierConfigBody = z
  .object({
    mode: z.enum([
      'normal',
      'always_fail',
      'out_of_stock',
      'timeout_before_issue',
      'timeout_after_issue',
      'duplicate_code',
      'wrong_code',
      'error_after_issue',
    ]),
    requests_per_minute: z.number().int().min(1).max(100000).default(120),
    failure_rate: z.number().min(0).max(1).default(0),
    timeout_rate: z.number().min(0).max(1).default(0),
    min_delay_ms: z.number().int().min(0).max(60_000).default(0),
    timeout_delay_ms: z.number().int().min(0).max(60_000).default(1000),
  })
  .strict();
const credentialsBody = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N}_.-]+$/u),
    password: z.string().min(6).max(128),
  })
  .strict();
const cartItemBody = z
  .object({
    sku: z.string().trim().min(1).max(100),
    quantity: z.number().int().min(1).max(10).default(1),
    provider: providerSchema.optional(),
    offer_id: id.optional(),
  })
  .strict();
const checkoutBody = z
  .object({
    checkout_id: id.optional(),
    method: z.enum(['balance', 'sbp', 'crypto']).default('balance'),
    code: z.preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
      z
        .string()
        .trim()
        .min(4)
        .max(100)
        .regex(/^[A-Za-z0-9-]+$/)
        .optional(),
    ),
  })
  .strict();
const paymentCodesBody = z
  .object({
    codes: z
      .array(
        z
          .string()
          .trim()
          .min(4)
          .max(100)
          .regex(/^[A-Za-z0-9-]+$/),
      )
      .min(1)
      .max(1000),
    value_points: z.number().int().positive().max(10_000_000),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw Object.assign(new Error('Validation failed'), {
      statusCode: 400,
      details: z.treeifyError(result.error),
    });
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

async function requireRole(request: FastifyRequest, role: PublicUser['role']) {
  const user = await requireUser(request);
  const permitted =
    role === 'buyer' ? user.can_buy : role === 'seller' ? user.can_sell : user.role === 'admin';
  if (!permitted) throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  return user;
}
async function authorizeOrder(request: FastifyRequest, orderId: string) {
  const owner = (
    await getPool().query(
      'SELECT user_id FROM orders WHERE id=$1 UNION ALL SELECT user_id FROM order_groups WHERE id=$1',
      [orderId],
    )
  ).rows[0];
  if (owner?.user_id) {
    const user = await requireUser(request);
    if (user.id !== owner.user_id && user.role !== 'admin')
      throw Object.assign(new Error('order_not_found'), { statusCode: 404 });
  }
}
async function rejectOwnedPayment(orderId: string) {
  const owner = (
    await getPool().query(
      'SELECT user_id FROM orders WHERE id=$1 UNION ALL SELECT user_id FROM order_groups WHERE id=$1',
      [orderId],
    )
  ).rows[0];
  if (owner?.user_id) throw Object.assign(new Error('use_account_payment_intent'), { statusCode: 409 });
}
export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  app.addHook('preHandler', async (request) => {
    if (
      request.url.startsWith('/suppliers/') &&
      request.headers['x-supplier-secret'] !== config.SUPPLIER_SHARED_SECRET
    )
      await requireRole(request, 'admin');
    if (/^\/api\/(admin|test|reconciliation)(\/|\?|$)/.test(request.url)) await requireRole(request, 'admin');
    if (/^\/api\/seller(\/|\?|$)/.test(request.url)) await requireRole(request, 'seller');
    if (/^\/api\/cart(\/|\?|$)/.test(request.url)) await requireRole(request, 'buyer');
  });

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
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        type: z.string().optional(),
        search: z.string().max(100).optional(),
        sort: z.enum(['default', 'price_asc', 'price_desc']).default('default'),
      }),
      request.query,
    );
    return listCatalog(query);
  });

  app.get('/api/catalog/:sku', async (request, reply) => {
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    const product = await getCatalogItem(params.sku);
    if (!product) return reply.status(404).send({ error: 'product_not_found' });
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
    const account = match?.[1] ? await userFromToken(match[1]) : undefined;
    return {
      ...product,
      offers: (product.offers as Awaited<ReturnType<typeof productOffers>>).map((offer) => ({
        ...offer,
        purchasable: (!account || account.can_buy) && account?.seller_id !== offer.provider,
        purchase_disabled_reason:
          account?.seller_id === offer.provider
            ? 'own_store'
            : account && !account.can_buy
              ? 'admin_account'
              : null,
      })),
    };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const body = parse(
      credentialsBody
        .extend({
          role: z.enum(['buyer', 'seller']).default('buyer'),
          store_name: z.string().trim().min(2).max(100).optional(),
        })
        .strict()
        .refine((v) => (v.role === 'seller' ? !!v.store_name : !v.store_name), {
          message: 'store_name_required_for_seller_only',
        }),
      request.body,
    );
    const result = await registerUser(body.username, body.password, body.role, undefined, body.store_name);
    request.log.info(
      { event: 'user_registered', userId: result.user.id, username: result.user.username },
      'user registered with starting points',
    );
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

  app.post('/api/account/seller', async (request, reply) => {
    const user = await requireRole(request, 'buyer');
    const body = parse(z.object({ store_name: z.string().trim().min(2).max(100) }).strict(), request.body);
    return reply.status(201).send(await activateSeller(user.id, body.store_name));
  });
  app.get('/api/withdrawal-methods', async () => ({
    methods: [
      { id: 'card', name: 'На карту', description: 'Тестовый вывод на карту' },
      { id: 'crypto', name: 'Криптовалюта', description: 'Тестовый вывод USDT' },
    ],
    is_demo: true,
  }));
  app.get('/api/account/withdrawals', async (request) =>
    withdrawalHistory((await requireRole(request, 'buyer')).id),
  );
  app.post('/api/account/withdrawals', async (request, reply) => {
    const user = await requireRole(request, 'buyer');
    const body = parse(
      z
        .object({
          withdrawal_id: id,
          method: z.enum(['card', 'crypto']),
          amount: z.number().int().min(1).max(1000000),
          recipient: z.string().trim().min(10).max(120),
        })
        .strict(),
      request.body,
    );
    return reply
      .status(201)
      .send(await createWithdrawal(user.id, body.withdrawal_id, body.method, body.amount, body.recipient));
  });
  app.get('/api/account/withdrawals/:withdrawalId', async (request) => {
    const user = await requireRole(request, 'buyer');
    const params = parse(z.object({ withdrawalId: id }), request.params);
    return getWithdrawal(user.id, params.withdrawalId);
  });
  app.post('/api/account/withdrawals/:withdrawalId/simulate', async (request) => {
    const user = await requireRole(request, 'buyer');
    const params = parse(z.object({ withdrawalId: id }), request.params);
    const body = parse(
      z.object({ event_id: id, outcome: z.enum(['paid', 'failed', 'cancelled']) }).strict(),
      request.body,
    );
    return simulateWithdrawal(user.id, params.withdrawalId, body.outcome, body.event_id);
  });
  app.get('/api/admin/withdrawals', adminWithdrawals);
  app.get('/api/payment-methods', async () => ({
    methods: paymentMethods,
    is_demo: true,
    currency: 'RUB',
    wallet_unit_rub: 1,
  }));
  app.get('/api/account/payments', async (request) =>
    paymentHistory((await requireRole(request, 'buyer')).id),
  );
  app.post('/api/account/topups', async (request, reply) => {
    const user = await requireRole(request, 'buyer');
    const body = parse(
      z
        .object({
          payment_id: id,
          amount: z.number().int().min(1).max(1000000),
          method: z.enum(['sbp', 'crypto']),
        })
        .strict(),
      request.body,
    );
    return reply.status(201).send(await createTopup(user.id, body.payment_id, body.amount, body.method));
  });
  app.get('/api/payments/:paymentId', async (request) => {
    const user = await requireRole(request, 'buyer');
    const params = parse(z.object({ paymentId: id }), request.params);
    return getPaymentIntent(user.id, params.paymentId);
  });
  app.post('/api/payments/:paymentId/simulate', async (request) => {
    const user = await requireRole(request, 'buyer');
    const params = parse(z.object({ paymentId: id }), request.params);
    const body = parse(
      z.object({ event_id: id, outcome: z.enum(['paid', 'failed', 'cancelled']) }).strict(),
      request.body,
    );
    return simulatePayment(user.id, params.paymentId, body.outcome, body.event_id);
  });
  app.post('/api/payments/:paymentId/retry', async (request, reply) => {
    const user = await requireRole(request, 'buyer');
    const params = parse(z.object({ paymentId: id }), request.params);
    const body = parse(z.object({ retry_id: id }).strict(), request.body);
    return reply.status(201).send(await retryPayment(user.id, params.paymentId, body.retry_id));
  });
  app.get('/api/admin/payments', async () => ({
    payments: (
      await getPool().query(`SELECT i.*,u.username,
    CASE WHEN i.status='paid' THEN COALESCE((SELECT sum(r.amount) FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.group_id=i.group_id),0) ELSE 0 END AS refunded_amount
    FROM payment_intents i JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC LIMIT 200`)
    ).rows.map((r) => ({ ...r, amount: Number(r.amount), refunded_amount: Number(r.refunded_amount) })),
  }));
  app.get('/api/account', async (request) => accountSummary((await requireUser(request)).id));

  app.get('/api/cart', async (request) => cartReport((await requireUser(request)).id));

  app.post('/api/cart/items', async (request, reply) => {
    const user = await requireUser(request);
    const body = parse(cartItemBody, request.body);
    return reply
      .status(201)
      .send(await addCartItem(user.id, body.sku, body.quantity, body.provider, body.offer_id));
  });

  app.put('/api/cart/items/:sku', async (request) => {
    const user = await requireUser(request);
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    const body = parse(z.object({ quantity: z.number().int().min(1).max(10) }).strict(), request.body);
    const query = parse(
      z.object({ provider: providerSchema.optional(), offer_id: id.optional() }),
      request.query,
    );
    return setCartItem(user.id, params.sku, body.quantity, query.provider, query.offer_id);
  });

  app.delete('/api/cart/items/:sku', async (request) => {
    const user = await requireUser(request);
    const params = parse(z.object({ sku: z.string().trim().min(1).max(100) }), request.params);
    const query = parse(
      z.object({ provider: providerSchema.optional(), offer_id: id.optional() }),
      request.query,
    );
    return removeCartItem(user.id, params.sku, query.provider, query.offer_id);
  });

  app.post('/api/cart/quote', async (request) => {
    const user = await requireUser(request);
    const body = parse(checkoutBody.omit({ checkout_id: true }), request.body ?? {});
    return cartQuote(user.id, body.code, body.method);
  });

  app.post('/api/cart/checkout', async (request, reply) => {
    const user = await requireUser(request);
    const body = parse(checkoutBody, request.body);
    const result = await checkoutCart(
      user.id,
      body.checkout_id ?? publicCheckoutId(),
      body.code,
      body.method,
    );
    request.log.info(
      {
        event: 'cart_checked_out',
        userId: user.id,
        checkoutId: result.checkout_id,
        method: result.method,
        orderIds: result.order_ids,
      },
      'cart checkout committed',
    );
    return reply
      .status(201)
      .send({ ...result, order: await getOrderGroup(String(result.order_id), undefined, user.id) });
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
    if (body.order_id) await authorizeOrder(request, body.order_id);
    if ('items' in body) return reply.status(201).send(await createOrderGroup(body.items, body.order_id));
    const order = await createOrder(body.sku, body.order_id);
    request.log.info(
      { event: 'order_created', orderId: order.id, sku: order.sku, status: order.status },
      'order created',
    );
    return reply.status(201).send(await getOrder(order.id));
  });

  app.get('/api/orders/:orderId', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    await authorizeOrder(request, params.orderId);
    const order = (await getOrderGroup(params.orderId)) ?? (await getOrder(params.orderId));
    if (!order) return reply.status(404).send({ error: 'order_not_found' });
    return order;
  });

  app.post('/api/orders/:orderId/retry', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    await authorizeOrder(request, params.orderId);
    const scheduled = await retryOrder(params.orderId);
    if (!scheduled) return reply.status(409).send({ error: 'order_is_not_recoverable_or_not_paid' });
    return reply.status(202).send({ scheduled: true, order_id: params.orderId });
  });

  app.post('/webhook/payment', async (request, reply) => {
    const body = parse(paymentBody, request.body);
    await rejectOwnedPayment(body.order_id);
    const result = await handlePaymentWebhook(body);
    request.log.info(
      {
        event: 'payment_webhook',
        eventId: body.event_id,
        orderId: body.order_id,
        paymentStatus: body.status,
        ...result,
      },
      'payment webhook durably accepted',
    );
    if (result.outcome === 'event_id_payload_conflict') {
      return reply.status(409).send({ accepted: false, ...result });
    }
    return reply.status(200).send({ accepted: true, ...result });
  });

  // Local payment-system stub: builds the exact webhook contract from the order snapshot.
  app.post('/api/orders/:orderId/simulate-payment', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const body = parse(
      z
        .object({
          status: z.enum(['paid', 'failed']).default('paid'),
          event_id: id.optional(),
          created_at: z.iso.datetime({ offset: true }).optional(),
        })
        .default({ status: 'paid' }),
      request.body ?? {},
    );
    await authorizeOrder(request, params.orderId);
    const order = (await getOrderGroup(params.orderId)) ?? (await getOrder(params.orderId));
    if (!order) return reply.status(404).send({ error: 'order_not_found' });
    const event = {
      event_id: body.event_id ?? `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      order_id: params.orderId,
      status: body.status,
      amount: Number(order.amount),
      currency: String(order.currency),
      created_at: body.created_at ?? new Date().toISOString(),
    };
    await rejectOwnedPayment(params.orderId);
    const result = await handlePaymentWebhook(event);
    return reply.status(200).send({ event, result });
  });

  app.post('/suppliers/:provider/issue', async (request, reply) => {
    const params = parse(z.object({ provider: providerSchema }), request.params);
    const body = parse(supplierBody, request.body);
    const result = await issueFromStub(params.provider, body);
    request.log.info(
      {
        event: 'supplier_stub_request',
        provider: params.provider,
        requestId: body.request_id,
        orderId: body.order_id,
        responseStatus: result.statusCode,
        delayMs: result.delayMs,
      },
      'supplier stub handled request',
    );
    if (result.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, result.delayMs));
    return reply.status(result.statusCode).send(result.body);
  });

  app.post('/suppliers/:provider/resolve', async (request, reply) => {
    const params = parse(z.object({ provider: providerSchema }), request.params);
    const result = await resolveFromStub(params.provider, parse(supplierBody, request.body));
    return reply.status(result.statusCode).send(result.body);
  });
  app.get('/api/orders/:orderId/history', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    const query = parse(z.object({ at: z.iso.datetime({ offset: true }) }), request.query);
    await authorizeOrder(request, params.orderId);
    const state = await orderAt(params.orderId, query.at);
    return state ?? reply.status(404).send({ error: 'order_not_found_at_time' });
  });
  app.get('/api/admin/money', async (request) => {
    const query = parse(
      z
        .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
        .refine((q) => new Date(q.from) < new Date(q.to)),
      request.query,
    );
    return moneyReport(query.from, query.to);
  });
  app.get('/api/admin/queue', async () => queueReport());
  app.get('/api/account/orders/:orderId', async (request, reply) => {
    const user = await requireUser(request);
    const params = parse(z.object({ orderId: id }), request.params);
    return (
      (await getOrderGroup(params.orderId, undefined, user.id)) ??
      reply.status(404).send({ error: 'order_not_found' })
    );
  });

  app.get('/api/catalog/:sku/offers', async (request) => {
    const params = parse(z.object({ sku: z.string().min(1).max(100) }), request.params);
    return { offers: await productOffers(params.sku) };
  });
  app.get('/api/sellers', async () => ({
    sellers: await Promise.all(
      (await getPool().query('SELECT provider FROM supplier_configs ORDER BY provider')).rows.map((r) =>
        sellerReport(r.provider),
      ),
    ),
  }));
  app.get('/api/sellers/:provider', async (request, reply) => {
    const seller = await sellerReport(parse(z.object({ provider: providerSchema }), request.params).provider);
    return seller ?? reply.status(404).send({ error: 'seller_not_found' });
  });
  app.post('/api/account/purchases/:orderId/review', async (request, reply) => {
    const user = await requireUser(request);
    const params = parse(z.object({ orderId: id }), request.params);
    const body = parse(
      z
        .object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).default('') })
        .strict(),
      request.body,
    );
    return reply.status(201).send(await reviewPurchase(user.id, params.orderId, body.rating, body.comment));
  });
  app.post('/api/admin/sellers', async (request, reply) => {
    const body = parse(
      z.object({ id: providerSchema, name: z.string().trim().min(2).max(80) }).strict(),
      request.body,
    );
    const result = await getPool().query(
      `INSERT INTO supplier_configs(provider,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING provider`,
      [body.id, body.name],
    );
    if (!result.rowCount) return reply.status(409).send({ error: 'seller_already_exists' });
    return reply.status(201).send(await sellerReport(body.id));
  });
  app.put('/api/admin/offers/:sku/:provider', async (request) => {
    const params = parse(
      z.object({ sku: z.string().min(1).max(100), provider: providerSchema }),
      request.params,
    );
    const body = parse(
      z.object({ price: z.number().int().min(1).max(10000000), active: z.boolean().default(true) }).strict(),
      request.body,
    );
    return updateOffer(params.sku, params.provider, body.price, body.active);
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
    request.log.info(
      {
        event: 'inventory_added',
        provider: body.provider,
        sku: body.sku,
        inserted: result.inserted.length,
        duplicates: result.duplicates.length,
        paymentCodesInserted: result.payment_codes_inserted.length,
        paymentCodeValuePoints: result.payment_code_value_points,
      },
      'inventory batch processed',
    );
    return reply.status(201).send(result);
  });

  app.get('/api/admin/payment-codes', async () => paymentCodesReport());

  app.post('/api/admin/payment-codes', async (request, reply) => {
    const body = parse(paymentCodesBody, request.body);
    const result = await addPaymentCodes(body.codes, body.value_points);
    request.log.info(
      {
        event: 'payment_codes_added',
        inserted: (result.inserted as string[]).length,
        valuePoints: body.value_points,
      },
      'payment code batch processed',
    );
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
       min_delay_ms = $5, timeout_delay_ms = $6, requests_per_minute = $7, updated_at = now()
       WHERE provider = $1 RETURNING *`,
      [
        params.provider,
        body.mode,
        body.failure_rate,
        body.timeout_rate,
        body.min_delay_ms,
        body.timeout_delay_ms,
        body.requests_per_minute,
      ],
    );
    if (!result.rowCount) throw Object.assign(new Error('seller_not_found'), { statusCode: 404 });
    return result.rows[0];
  });

  app.post('/api/admin/workers/run', async (request) => {
    const body = parse(
      z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 }),
      request.body ?? {},
    );
    return { processed: await runDeliveryBatch(config, request.log, body.limit) };
  });

  app.get('/api/admin/summary', async () => {
    const [orders, stock, ledger] = await Promise.all([
      getPool().query(
        `SELECT status, count(*)::integer AS count FROM orders GROUP BY status ORDER BY status`,
      ),
      getPool()
        .query(`SELECT count(*) FILTER (WHERE claimed_by IS NULL AND revoked_at IS NULL AND reserved_order_id IS NULL)::integer AS available,
        count(*) FILTER (WHERE reserved_order_id IS NOT NULL)::integer AS reserved, count(*)::integer AS total,
        count(*) FILTER (WHERE claimed_by IS NOT NULL)::integer AS issued FROM provider_inventory`),
      getPool().query(
        `SELECT account, COALESCE(sum(amount), 0)::bigint AS balance FROM ledger_entries GROUP BY account ORDER BY account`,
      ),
    ]);
    return {
      orders: orders.rows,
      inventory: stock.rows[0],
      ledger: ledger.rows.map((row) => ({ ...row, balance: Number(row.balance) })),
    };
  });

  app.get('/api/admin/orders/:orderId/evidence', async (request, reply) => {
    const params = parse(z.object({ orderId: id }), request.params);
    await authorizeOrder(request, params.orderId);
    const order = (await getOrderGroup(params.orderId)) ?? (await getOrder(params.orderId));
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

  app.get('/api/seller/dashboard', async (request) => {
    const user = await requireRole(request, 'seller');
    const query = parse(
      z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1) }),
      request.query,
    );
    return sellerDashboard(user.seller_id!, query.page);
  });
  app.put('/api/seller/offers/:sku', async (request) => {
    const user = await requireRole(request, 'seller');
    const params = parse(z.object({ sku: z.string().min(1).max(100) }), request.params);
    const body = parse(
      z.object({ price: z.number().int().min(1).max(10000000), active: z.boolean().default(true) }).strict(),
      request.body,
    );
    return updateOffer(params.sku, user.seller_id!, body.price, body.active);
  });
  app.get('/api/seller/inventory', async (request) => {
    const user = await requireRole(request, 'seller');
    const query = parse(
      z.object({
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        search: z.string().trim().max(100).default(''),
        status: z.enum(['all', 'available', 'reserved', 'issued', 'revoked']).default('all'),
      }),
      request.query,
    );
    return sellerInventory(user.seller_id!, query.page, query.search, query.status);
  });
  app.put('/api/seller/inventory/:code/price', async (request) => {
    const user = await requireRole(request, 'seller');
    const params = parse(z.object({ code: z.string().min(4).max(100) }), request.params);
    const body = parse(
      z.object({ price: z.number().int().min(1).max(10000000), active: z.boolean() }).strict(),
      request.body,
    );
    return updateKeyPrice(user.seller_id!, params.code, body.price, body.active);
  });
  app.post('/api/seller/inventory', async (request, reply) => {
    const user = await requireRole(request, 'seller');
    const body = parse(
      inventoryBody
        .omit({ provider: true })
        .extend({
          unit_cost: z.number().int().min(0).max(10000000).nullable().optional(),
          offer_id: id.optional(),
        })
        .strict(),
      request.body,
    );
    return reply
      .status(201)
      .send(
        await addInventory(
          user.seller_id!,
          body.sku,
          body.codes,
          false,
          body.unit_cost ?? null,
          body.offer_id,
        ),
      );
  });
  app.post('/api/seller/lots/split', async (request, reply) => {
    const user = await requireRole(request, 'seller');
    const body = parse(
      z
        .object({
          request_id: id,
          source_offer_id: id,
          parts: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(80),
                  quantity: z.number().int().min(1).max(100000),
                  price: z.number().int().min(1).max(10000000),
                  active: z.boolean().default(true),
                })
                .strict(),
            )
            .min(1)
            .max(20),
        })
        .strict(),
      request.body,
    );
    return reply
      .status(201)
      .send(await splitLot(user.seller_id!, body.request_id, body.source_offer_id, body.parts));
  });
  app.put('/api/seller/lots/:offerId', async (request) => {
    const user = await requireRole(request, 'seller');
    const params = parse(z.object({ offerId: id }), request.params);
    const body = parse(
      z
        .object({
          price: z.number().int().min(1).max(10000000),
          active: z.boolean(),
          name: z.string().trim().min(1).max(80).optional(),
        })
        .strict(),
      request.body,
    );
    return updateLot(user.seller_id!, params.offerId, body.price, body.active, body.name);
  });
  app.put('/api/seller/inventory/:code/cost', async (request) => {
    const user = await requireRole(request, 'seller');
    const params = parse(z.object({ code: z.string().min(4).max(100) }), request.params);
    const body = parse(
      z.object({ unit_cost: z.number().int().min(0).max(10000000).nullable() }).strict(),
      request.body,
    );
    return updateInventoryCost(user.seller_id!, params.code, body.unit_cost);
  });
  app.get('/api/admin/users', async () => ({
    users: (
      await getPool().query(
        'SELECT id,username,role,seller_id,points_balance::float AS points_balance,banned_at,ban_reason,created_at FROM users ORDER BY created_at DESC LIMIT 500',
      )
    ).rows,
  }));
  app.post('/api/admin/seller-accounts', async (request, reply) => {
    const body = parse(credentialsBody.extend({ provider: providerSchema }).strict(), request.body);
    const seller = await sellerReport(body.provider);
    if (!seller) return reply.status(404).send({ error: 'seller_not_found' });
    if (seller.banned_at) return reply.status(409).send({ error: 'seller_banned' });
    const result = await registerUser(body.username, body.password, 'seller', body.provider);
    return reply.status(201).send({ user: result.user });
  });
  const banBody = z.object({ banned: z.boolean(), reason: z.string().trim().min(3).max(1000) }).strict();
  app.post('/api/admin/users/:userId/ban', async (request) => {
    const body = parse(banBody, request.body);
    return setUserBan(
      await requireRole(request, 'admin'),
      parse(z.object({ userId: id }), request.params).userId,
      body.banned,
      body.reason,
    );
  });
  app.post('/api/admin/sellers/:provider/ban', async (request) => {
    const body = parse(banBody, request.body);
    return setSellerBan(
      await requireRole(request, 'admin'),
      parse(z.object({ provider: providerSchema }), request.params).provider,
      body.banned,
      body.reason,
    );
  });
  app.get('/api/admin/orders', async () => administrationOrders());
  app.post('/api/admin/orders/:orderId/refund', async (request, reply) => {
    const body = parse(z.object({ reason: z.string().trim().min(3).max(1000) }).strict(), request.body);
    return reply
      .status(202)
      .send(
        await requestRefund(
          await requireRole(request, 'admin'),
          parse(z.object({ orderId: id }), request.params).orderId,
          body.reason,
        ),
      );
  });
  app.get('/api/admin/audit', async () => ({
    events: (
      await getPool().query(
        'SELECT event_type,order_id,payload,created_at FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 200',
      )
    ).rows,
  }));
  app.get('/api/orders/:orderId/messages', async (request) =>
    conversation(await requireUser(request), parse(z.object({ orderId: id }), request.params).orderId),
  );
  app.post('/api/orders/:orderId/messages', async (request, reply) => {
    const body = parse(z.object({ id, body: z.string().trim().min(1).max(2000) }).strict(), request.body);
    return reply
      .status(201)
      .send(
        await sendOrderMessage(
          await requireUser(request),
          parse(z.object({ orderId: id }), request.params).orderId,
          body.id,
          body.body,
        ),
      );
  });

  return app;
}
