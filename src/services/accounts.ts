import { promisify } from 'node:util';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, transaction } from '../db.js';

import { postWalletCredit } from './wallet.js';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 30;

export interface PublicUser {
  id: string;
  role: 'buyer' | 'seller' | 'admin';
  seller_id: string | null;
  can_buy: boolean;
  can_sell: boolean;
  can_become_seller: boolean;
  username: string;
  points_balance: number;
  created_at: Date;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function createSession(client: PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await client.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    tokenHash(token),
    userId,
    expiresAt,
  ]);
  return token;
}

function publicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    can_buy: row.role === 'buyer' || row.role === 'seller',
    can_sell: row.role === 'seller' && !!row.seller_id,
    can_become_seller: row.role === 'buyer' && !row.seller_id,
    role: row.role as PublicUser['role'],
    seller_id: row.seller_id ? String(row.seller_id) : null,
    username: String(row.username),
    points_balance: Number(row.points_balance),
    created_at: row.created_at as Date,
  };
}

export async function registerUser(
  username: string,
  password: string,
  role: PublicUser['role'] = 'buyer',
  sellerId?: string,
  storeName?: string,
): Promise<{ token: string; user: PublicUser }> {
  const userId = `usr_${randomUUID().replaceAll('-', '')}`;
  const passwordHash = await hashPassword(password);
  try {
    return await transaction(async (client) => {
      let binding = sellerId;
      if (role === 'seller' && !binding) {
        if (!storeName?.trim()) throw Object.assign(new Error('store_name_required'), { statusCode: 400 });
        binding = `vendor_${randomUUID().replaceAll('-', '')}`;
        await client.query('INSERT INTO supplier_configs(provider,display_name) VALUES($1,$2)', [
          binding,
          storeName.trim(),
        ]);
      }
      const startingPoints = role === 'buyer' ? 5000 : 0;
      const inserted = await client.query(
        `INSERT INTO users (id, username, username_normalized, password_hash, points_balance,role,seller_id)
         VALUES ($1, $2, $3, $4, $5,$6,$7) RETURNING id, username, points_balance, created_at,role,seller_id`,
        [
          userId,
          username.trim(),
          normalizeUsername(username),
          passwordHash,
          startingPoints,
          role,
          binding ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Registered user was not returned');
      if (startingPoints)
        await client.query(
          `INSERT INTO point_transactions (id, user_id, kind, amount, balance_after)
         VALUES ($1, $2, 'registration_bonus', 5000, 5000)`,
          [`points:registration:${userId}`, userId],
        );
      await postWalletCredit(client, userId, startingPoints, 'registration_bonus', `registration:${userId}`);
      return { token: await createSession(client, userId), user: publicUser(row) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error('username_already_exists'), { statusCode: 409 });
    }
    throw error;
  }
}

export async function loginUser(
  username: string,
  password: string,
): Promise<{ token: string; user: PublicUser }> {
  const result = await getPool().query(
    'SELECT id, username, password_hash, points_balance, created_at,role,seller_id,banned_at FROM users WHERE username_normalized = $1',
    [normalizeUsername(username)],
  );
  const row = result.rows[0];
  if (!row || !(await passwordMatches(password, String(row.password_hash)))) {
    throw Object.assign(new Error('invalid_username_or_password'), { statusCode: 401 });
  }
  if (row.banned_at) throw Object.assign(new Error('account_banned'), { statusCode: 403 });
  const token = await transaction((client) => createSession(client, String(row.id)));
  return { token, user: publicUser(row) };
}

export async function userFromToken(token: string): Promise<PublicUser | undefined> {
  const result = await getPool().query(
    `SELECT u.id, u.username, u.points_balance, u.created_at,u.role,u.seller_id
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.banned_at IS NULL AND (u.seller_id IS NULL OR EXISTS(SELECT 1 FROM supplier_configs sc WHERE sc.provider=u.seller_id AND sc.banned_at IS NULL))`,
    [tokenHash(token)],
  );
  return result.rows[0] ? publicUser(result.rows[0]) : undefined;
}

export async function logoutUser(token: string): Promise<void> {
  await getPool().query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function accountSummary(userId: string): Promise<Record<string, unknown>> {
  const [user, transactions] = await Promise.all([
    getPool().query(
      'SELECT id, username, points_balance, created_at,role,seller_id FROM users WHERE id = $1',
      [userId],
    ),
    getPool().query(
      `SELECT id, kind, amount::bigint, balance_after::bigint, created_at
       FROM point_transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [userId],
    ),
  ]);
  const row = user.rows[0];
  if (!row) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
  return {
    user: publicUser(row),
    point_transactions: transactions.rows.map((item) => ({
      ...item,
      amount: Number(item.amount),
      balance_after: Number(item.balance_after),
    })),
  };
}

// Activating sales extends the existing account; purchases, money and sessions keep their owner.
export async function activateSeller(userId: string, storeName: string) {
  return transaction(async (client) => {
    const user = (
      await client.query('SELECT * FROM users WHERE id=$1 AND banned_at IS NULL FOR UPDATE', [userId])
    ).rows[0];
    if (!user) throw Object.assign(new Error('authentication_required'), { statusCode: 401 });
    if (user.role === 'admin') throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
    if (user.seller_id) {
      const store = (
        await client.query('SELECT display_name FROM supplier_configs WHERE provider=$1', [user.seller_id])
      ).rows[0];
      if (store.display_name !== storeName.trim())
        throw Object.assign(new Error('seller_already_activated'), { statusCode: 409 });
      return { user: publicUser(user) };
    }
    const provider = `vendor_${randomUUID().replaceAll('-', '')}`;
    await client.query('INSERT INTO supplier_configs(provider,display_name) VALUES($1,$2)', [
      provider,
      storeName.trim(),
    ]);
    const updated = (
      await client.query(
        "UPDATE users SET role='seller',seller_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [userId, provider],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO audit_events(idempotency_key,event_type,payload) VALUES($1,'seller_activated',$2)",
      [
        `seller-activation:${userId}`,
        JSON.stringify({ user_id: userId, provider, store_name: storeName.trim() }),
      ],
    );
    return { user: publicUser(updated) };
  });
}
