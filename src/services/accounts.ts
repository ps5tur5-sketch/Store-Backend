import { promisify } from 'node:util';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, transaction } from '../db.js';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 30;

export interface PublicUser {
  id: string;
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
  const derived = await scryptAsync(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = await scryptAsync(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function createSession(client: PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await client.query(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), userId, expiresAt],
  );
  return token;
}

function publicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    username: String(row.username),
    points_balance: Number(row.points_balance),
    created_at: row.created_at as Date,
  };
}

export async function registerUser(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const userId = `usr_${randomUUID().replaceAll('-', '')}`;
  const passwordHash = await hashPassword(password);
  try {
    return await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO users (id, username, username_normalized, password_hash, points_balance)
         VALUES ($1, $2, $3, $4, 5000) RETURNING id, username, points_balance, created_at`,
        [userId, username.trim(), normalizeUsername(username), passwordHash],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Registered user was not returned');
      await client.query(
        `INSERT INTO point_transactions (id, user_id, kind, amount, balance_after)
         VALUES ($1, $2, 'registration_bonus', 5000, 5000)`,
        [`points:registration:${userId}`, userId],
      );
      return { token: await createSession(client, userId), user: publicUser(row) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error('username_already_exists'), { statusCode: 409 });
    }
    throw error;
  }
}

export async function loginUser(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const result = await getPool().query(
    'SELECT id, username, password_hash, points_balance, created_at FROM users WHERE username_normalized = $1',
    [normalizeUsername(username)],
  );
  const row = result.rows[0];
  if (!row || !(await passwordMatches(password, String(row.password_hash)))) {
    throw Object.assign(new Error('invalid_username_or_password'), { statusCode: 401 });
  }
  const token = await transaction((client) => createSession(client, String(row.id)));
  return { token, user: publicUser(row) };
}

export async function userFromToken(token: string): Promise<PublicUser | undefined> {
  const result = await getPool().query(
    `SELECT u.id, u.username, u.points_balance, u.created_at
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return result.rows[0] ? publicUser(result.rows[0]) : undefined;
}

export async function logoutUser(token: string): Promise<void> {
  await getPool().query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export async function accountSummary(userId: string): Promise<Record<string, unknown>> {
  const [user, transactions] = await Promise.all([
    getPool().query('SELECT id, username, points_balance, created_at FROM users WHERE id = $1', [userId]),
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
