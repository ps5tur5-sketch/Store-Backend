import { reserveGroupKeys } from './lots.js';
import type { PoolClient } from 'pg';
import { getPool, transaction, type DbClient } from '../db.js';
import { applyGroupPayment, type PaymentEventRow } from './payment.js';
import { postWalletCredit } from './wallet.js';
export type ExternalMethod = 'sbp' | 'crypto';
export const paymentMethods = [
  {
    id: 'balance',
    name: 'Баланс личного кабинета',
    description: 'Мгновенная оплата с баланса',
    external: false,
  },
  { id: 'sbp', name: 'СБП', description: 'Тестовый платёж через Систему быстрых платежей', external: true },
  {
    id: 'crypto',
    name: 'Криптовалюта',
    description: 'Тестовый платёж USDT · без настоящего перевода',
    external: true,
  },
];
export async function createIntent(
  client: PoolClient,
  input: {
    id: string;
    userId: string;
    purpose: 'checkout' | 'wallet_topup';
    method: ExternalMethod;
    amount: number;
    groupId?: string;
    retryOf?: string;
  },
) {
  const details =
    input.method === 'sbp'
      ? {
          title: 'СБП · тестовый банк',
          reference: `SBP-${input.id.slice(-12).toUpperCase()}`,
          instructions: 'Подтвердите тестовую оплату. Перевод в банковском приложении не требуется.',
        }
      : {
          title: 'USDT · тестовая сеть',
          asset: 'USDT',
          network: 'Демо-сеть',
          exchange_rate_rub: 100,
          crypto_amount: (input.amount / 100).toFixed(2),
          address: `DEMO-USDT-${input.id.slice(-20).toUpperCase()}`,
          instructions:
            'Это тестовые реквизиты. Используйте кнопку имитации оплаты, настоящие средства не переводятся.',
        };
  const row = (
    await client.query(
      `INSERT INTO payment_intents(id,user_id,purpose,group_id,method,amount,details,retry_of)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.id,
        input.userId,
        input.purpose,
        input.groupId ?? null,
        input.method,
        input.amount,
        JSON.stringify(details),
        input.retryOf ?? null,
      ],
    )
  ).rows[0];
  await client.query(
    `INSERT INTO payment_intent_events(id,payment_intent_id,status,payload) VALUES($1,$2,'created',$3)`,
    [
      `created:${input.id}`,
      input.id,
      JSON.stringify({ amount: input.amount, method: input.method, purpose: input.purpose }),
    ],
  );
  return serializeIntent(row);
}
function serializeIntent(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    amount: Number(row.amount),
    refunded_amount: Number(row.refunded_amount ?? 0),
    is_demo: true,
    refund_destination: 'wallet',
    can_confirm: row.status === 'pending' && new Date(row.expires_at) > new Date(),
    can_retry: ['failed', 'cancelled', 'expired'].includes(row.status),
  };
}
export async function getPaymentIntent(userId: string, id: string, db: DbClient = getPool()) {
  const row = (
    await db.query(
      `SELECT i.*,(SELECT COALESCE(sum(r.amount),0) FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.group_id=i.group_id AND i.status='paid') AS refunded_amount
  FROM payment_intents i WHERE i.id=$1 AND i.user_id=$2`,
      [id, userId],
    )
  ).rows[0];
  if (!row) throw Object.assign(new Error('payment_not_found'), { statusCode: 404 });
  return serializeIntent(row);
}
export async function createTopup(userId: string, id: string, amount: number, method: ExternalMethod) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`intent:${id}`]);
    const existing = (await client.query('SELECT * FROM payment_intents WHERE id=$1', [id])).rows[0];
    if (existing) {
      if (
        existing.user_id !== userId ||
        existing.purpose !== 'wallet_topup' ||
        Number(existing.amount) !== amount ||
        existing.method !== method
      )
        throw Object.assign(new Error('payment_id_conflict'), { statusCode: 409 });
      return serializeIntent(existing);
    }
    return createIntent(client, { id, userId, amount, method, purpose: 'wallet_topup' });
  });
}
async function finishIntent(
  client: PoolClient,
  row: Record<string, any>,
  status: 'paid' | 'failed' | 'cancelled' | 'expired',
  eventId: string,
) {
  if (row.status !== 'pending') return;
  if (row.purpose === 'checkout') {
    const checkout = (
      await client.query('SELECT * FROM checkouts WHERE group_id=$1 FOR UPDATE', [row.group_id])
    ).rows[0];
    if (!checkout || checkout.payment_intent_id !== row.id)
      throw Object.assign(new Error('payment_superseded'), { statusCode: 409 });
    const group = await client.query('SELECT id FROM order_groups WHERE id=$1', [row.group_id]);
    if (!group.rowCount) throw new Error('payment_order_missing');
    const event = (
      await client.query<PaymentEventRow>(
        `INSERT INTO payment_events(event_id,order_id,status,amount,currency,event_created_at,payload)
   VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6) RETURNING *`,
        [
          `intent:${eventId}`,
          row.group_id,
          status === 'paid' ? 'paid' : 'failed',
          row.amount,
          row.currency,
          JSON.stringify({ source: 'payment_simulator', intent_id: row.id, method: row.method }),
        ],
      )
    ).rows[0]!;
    await applyGroupPayment(client, event);
    await client.query('UPDATE checkouts SET status=$2 WHERE id=$1', [checkout.id, status]);
  } else if (status === 'paid') {
    const user = (
      await client.query(
        'UPDATE users SET points_balance=points_balance+$2,updated_at=now() WHERE id=$1 RETURNING points_balance',
        [row.user_id, row.amount],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO point_transactions(id,user_id,kind,amount,balance_after) VALUES($1,$2,'wallet_topup',$3,$4)`,
      [`topup:${row.id}`, row.user_id, row.amount, user.points_balance],
    );
    await postWalletCredit(client, row.user_id, Number(row.amount), 'wallet_topup', `topup:${row.id}`);
  }
  await client.query('UPDATE payment_intents SET status=$2,completed_at=clock_timestamp() WHERE id=$1', [
    row.id,
    status,
  ]);
  await client.query(
    'INSERT INTO payment_intent_events(id,payment_intent_id,status,payload) VALUES($1,$2,$3,$4)',
    [eventId, row.id, status, JSON.stringify({ amount: Number(row.amount), method: row.method })],
  );
}
export async function simulatePayment(
  userId: string,
  id: string,
  outcome: 'paid' | 'failed' | 'cancelled',
  eventId: string,
) {
  await transaction(async (client) => {
    // One user lock gives wallet operations, checkout and payment retries the same lock ordering.
    const user = (
      await client.query('SELECT id FROM users WHERE id=$1 AND banned_at IS NULL FOR UPDATE', [userId])
    ).rows[0];
    if (!user) throw Object.assign(new Error('authentication_required'), { statusCode: 401 });
    const row = (
      await client.query('SELECT * FROM payment_intents WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])
    ).rows[0];
    if (!row) throw Object.assign(new Error('payment_not_found'), { statusCode: 404 });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`payment-event:${eventId}`]);
    const event = (await client.query('SELECT * FROM payment_intent_events WHERE id=$1', [eventId])).rows[0];
    if (event) {
      if (event.payment_intent_id !== id || event.status !== outcome)
        throw Object.assign(new Error('payment_event_conflict'), { statusCode: 409 });
      return;
    }
    if (row.status !== 'pending') {
      if (row.status === outcome) return;
      throw Object.assign(new Error('payment_already_final'), { statusCode: 409 });
    }
    await finishIntent(client, row, new Date(row.expires_at) <= new Date() ? 'expired' : outcome, eventId);
  });
  return getPaymentIntent(userId, id);
}
export async function retryPayment(userId: string, id: string, retryId: string) {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const previous = (
      await client.query('SELECT * FROM payment_intents WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])
    ).rows[0];
    if (!previous) throw Object.assign(new Error('payment_not_found'), { statusCode: 404 });
    const existing = (await client.query('SELECT * FROM payment_intents WHERE id=$1', [retryId])).rows[0];
    if (existing) {
      if (
        existing.retry_of !== id ||
        existing.user_id !== userId ||
        existing.group_id !== previous.group_id ||
        existing.method !== previous.method ||
        Number(existing.amount) !== Number(previous.amount)
      )
        throw Object.assign(new Error('payment_id_conflict'), { statusCode: 409 });
      return serializeIntent(existing);
    }
    const priorRetry = (await client.query('SELECT * FROM payment_intents WHERE retry_of=$1', [id])).rows[0];
    if (priorRetry) return serializeIntent(priorRetry);
    if (!['failed', 'cancelled', 'expired'].includes(previous.status))
      throw Object.assign(new Error('payment_cannot_retry'), { statusCode: 409 });
    if (previous.group_id) {
      const checkout = (
        await client.query('SELECT * FROM checkouts WHERE group_id=$1 FOR UPDATE', [previous.group_id])
      ).rows[0];
      if (checkout.status === 'paid')
        throw Object.assign(new Error('order_already_paid'), { statusCode: 409 });
      if (checkout.payment_intent_id !== id) {
        return getPaymentIntent(userId, checkout.payment_intent_id, client);
      }
    }
    if (previous.group_id) await reserveGroupKeys(client, previous.group_id);
    const next = await createIntent(client, {
      id: retryId,
      userId,
      purpose: previous.purpose,
      method: previous.method,
      amount: Number(previous.amount),
      groupId: previous.group_id ?? undefined,
      retryOf: id,
    });
    if (previous.group_id) {
      await client.query("UPDATE checkouts SET payment_intent_id=$2,status='pending' WHERE group_id=$1", [
        previous.group_id,
        retryId,
      ]);
      await client.query(
        "UPDATE orders SET payment_state='pending',status='created',version=version+1,updated_at=clock_timestamp() WHERE group_id=$1 AND payment_state<>'paid'",
        [previous.group_id],
      );
    }
    return next;
  });
}
export async function expirePayments() {
  const rows = (
    await getPool().query(
      "SELECT id,user_id FROM payment_intents WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100",
    )
  ).rows;
  for (const row of rows)
    await transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
      const current = (
        await client.query("SELECT * FROM payment_intents WHERE id=$1 AND status='pending' FOR UPDATE", [
          row.id,
        ])
      ).rows[0];
      if (current) await finishIntent(client, current, 'expired', `expired:${row.id}`);
    });
  return rows.length;
}
export async function paymentHistory(userId: string) {
  const rows = (
    await getPool().query(
      `SELECT i.*,COALESCE((SELECT sum(r.amount) FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.group_id=i.group_id AND i.status='paid'),0) AS refunded_amount FROM payment_intents i WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
  ).rows;
  return { payments: rows.map(serializeIntent) };
}
