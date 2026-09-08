import { transaction } from '../db.js';
import type { Provider } from '../types.js';

// Shared rolling window: survives restarts and serializes admission across workers.
export async function reserveSupplierRequest(provider: Provider): Promise<number> {
  return transaction(async (client) => {
    const config = await client.query(
      'SELECT requests_per_minute FROM supplier_configs WHERE provider=$1 FOR UPDATE',
      [provider],
    );
    const window = await client.query(
      `SELECT count(*)::int AS count,
      GREATEST(1,ceil(extract(epoch FROM (min(requested_at)+interval '60.05 seconds'-clock_timestamp()))*1000))::int AS wait_ms
      FROM supplier_requests WHERE provider=$1 AND requested_at>clock_timestamp()-interval '60 seconds'`,
      [provider],
    );
    if (window.rows[0].count >= config.rows[0].requests_per_minute) return window.rows[0].wait_ms;
    await client.query('INSERT INTO supplier_requests(provider) VALUES ($1)', [provider]);
    return 0;
  });
}
