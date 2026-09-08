import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, transaction } from '../db.js';
type Method = 'card' | 'crypto';
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
function publicWithdrawal(row: Record<string, any>) {
  const { recipient_fingerprint, ...data } = row;
  return {
    ...data,
    amount: Number(row.amount),
    is_demo: true,
    can_confirm: row.status === 'pending' && new Date(row.expires_at) > new Date(),
  };
}
async function posting(
  client: PoolClient,
  row: Record<string, any>,
  kind: 'withdrawal_hold' | 'withdrawal_paid' | 'withdrawal_release',
) {
  const id = `${kind}:${row.id}`;
  await client.query('INSERT INTO ledger_transactions(id,user_id,kind) VALUES($1,$2,$3)', [
    id,
    row.user_id,
    kind,
  ]);
  const debit = kind === 'withdrawal_hold' ? 'wallet' : 'withdrawal_clearing';
  const credit =
    kind === 'withdrawal_hold' ? 'withdrawal_clearing' : kind === 'withdrawal_paid' ? 'cash' : 'wallet';
  await client.query(
    'INSERT INTO ledger_entries(transaction_id,account,amount,currency) VALUES($1,$2,$4,$5),($1,$3,-$4,$5)',
    [id, debit, credit, row.amount, row.currency],
  );
}
export async function createWithdrawal(
  userId: string,
  id: string,
  method: Method,
  amount: number,
  recipient: string,
) {
  const normalized = method === 'card' ? recipient.replace(/\s/g, '') : recipient.trim();
  if (method === 'card' ? !/^\d{16,19}$/.test(normalized) : !/^[-A-Za-z0-9_:]{10,120}$/.test(normalized))
    throw fail('invalid_withdrawal_recipient', 400);
  const fingerprint = createHash('sha256')
    .update(method + ':' + normalized)
    .digest('hex');
  return transaction(async (client) => {
    const user = (
      await client.query('SELECT * FROM users WHERE id=$1 AND banned_at IS NULL FOR UPDATE', [userId])
    ).rows[0];
    if (!user) throw fail('authentication_required', 401);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`withdrawal:${id}`]);
    const old = (await client.query('SELECT * FROM withdrawals WHERE id=$1', [id])).rows[0];
    if (old) {
      if (
        old.user_id !== userId ||
        old.method !== method ||
        Number(old.amount) !== amount ||
        old.recipient_fingerprint !== fingerprint
      )
        throw fail('withdrawal_id_conflict');
      return publicWithdrawal(old);
    }
    if (Number(user.points_balance) < amount) throw fail('insufficient_points');
    const details =
      method === 'card'
        ? { card_last4: normalized.slice(-4), display: `Карта •••• ${normalized.slice(-4)}` }
        : {
            address: normalized,
            display: normalized,
            asset: 'USDT',
            network: 'Демо-сеть',
            exchange_rate_rub: 100,
            crypto_amount: (amount / 100).toFixed(2),
          };
    const row = (
      await client.query(
        'INSERT INTO withdrawals(id,user_id,method,amount,recipient,recipient_fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id, userId, method, amount, JSON.stringify(details), fingerprint],
      )
    ).rows[0];
    const balance = Number(user.points_balance) - amount;
    await client.query('UPDATE users SET points_balance=$2,updated_at=clock_timestamp() WHERE id=$1', [
      userId,
      balance,
    ]);
    await client.query(
      "INSERT INTO point_transactions(id,user_id,kind,amount,balance_after) VALUES($1,$2,'withdrawal_hold',$3,$4)",
      [`withdrawal-hold:${id}`, userId, -amount, balance],
    );
    await posting(client, row, 'withdrawal_hold');
    await client.query("INSERT INTO withdrawal_events(id,withdrawal_id,status) VALUES($1,$2,'created')", [
      `created:${id}`,
      id,
    ]);
    return publicWithdrawal(row);
  });
}
export async function withdrawalHistory(userId: string) {
  const rows = (
    await getPool().query('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [
      userId,
    ])
  ).rows;
  return { withdrawals: rows.map(publicWithdrawal) };
}
export async function getWithdrawal(userId: string, id: string) {
  const row = (await getPool().query('SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2', [id, userId]))
    .rows[0];
  if (!row) throw fail('withdrawal_not_found', 404);
  return publicWithdrawal(row);
}
async function finish(
  client: PoolClient,
  row: Record<string, any>,
  status: 'paid' | 'failed' | 'cancelled' | 'expired',
  eventId: string,
) {
  if (status === 'paid') {
    await posting(client, row, 'withdrawal_paid');
  } else {
    const user = (
      await client.query(
        'UPDATE users SET points_balance=points_balance+$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING points_balance',
        [row.user_id, row.amount],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO point_transactions(id,user_id,kind,amount,balance_after) VALUES($1,$2,'withdrawal_release',$3,$4)",
      [`withdrawal-release:${row.id}`, row.user_id, row.amount, user.points_balance],
    );
    await posting(client, row, 'withdrawal_release');
  }
  await client.query('UPDATE withdrawals SET status=$2,completed_at=clock_timestamp() WHERE id=$1', [
    row.id,
    status,
  ]);
  await client.query('INSERT INTO withdrawal_events(id,withdrawal_id,status) VALUES($1,$2,$3)', [
    eventId,
    row.id,
    status,
  ]);
}
export async function simulateWithdrawal(
  userId: string,
  id: string,
  outcome: 'paid' | 'failed' | 'cancelled',
  eventId: string,
) {
  await transaction(async (client) => {
    const user = (
      await client.query('SELECT id FROM users WHERE id=$1 AND banned_at IS NULL FOR UPDATE', [userId])
    ).rows[0];
    if (!user) throw fail('authentication_required', 401);
    const row = (
      await client.query('SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])
    ).rows[0];
    if (!row) throw fail('withdrawal_not_found', 404);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `withdrawal-event:${eventId}`,
    ]);
    const old = (await client.query('SELECT * FROM withdrawal_events WHERE id=$1', [eventId])).rows[0];
    if (old) {
      if (old.withdrawal_id !== id || old.status !== outcome) throw fail('withdrawal_event_conflict');
      return;
    }
    if (row.status !== 'pending') {
      if (row.status === outcome) return;
      throw fail('withdrawal_already_final');
    }
    await finish(client, row, new Date(row.expires_at) <= new Date() ? 'expired' : outcome, eventId);
  });
  return getWithdrawal(userId, id);
}
export async function expireWithdrawals() {
  const rows = (
    await getPool().query(
      "SELECT id,user_id FROM withdrawals WHERE status='pending' AND expires_at<=clock_timestamp() LIMIT 100",
    )
  ).rows;
  for (const row of rows)
    await transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
      const current = (
        await client.query("SELECT * FROM withdrawals WHERE id=$1 AND status='pending' FOR UPDATE", [row.id])
      ).rows[0];
      if (current) await finish(client, current, 'expired', `expired:${row.id}`);
    });
}
export async function adminWithdrawals() {
  const rows = (
    await getPool().query(
      'SELECT w.*,u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.created_at DESC LIMIT 200',
    )
  ).rows;
  return { withdrawals: rows.map(publicWithdrawal) };
}
