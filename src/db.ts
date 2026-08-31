import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { loadConfig } from './config.js';

const { Pool } = pg;

export type DbClient = pg.Pool | PoolClient;

let sharedPool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: loadConfig().DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      application_name: 'game-goods-core',
    });
    sharedPool.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'postgres_pool_error', error: error.message })));
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function firstRow<T extends QueryResultRow>(rows: T[], message = 'Expected one database row'): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}
