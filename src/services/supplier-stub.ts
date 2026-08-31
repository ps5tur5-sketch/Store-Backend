import { transaction } from '../db.js';
import type { Provider } from '../types.js';

export interface SupplierIssueInput {
  request_id: string;
  sku: string;
  order_id: string;
}

export interface SupplierHttpResult {
  statusCode: number;
  body: Record<string, unknown>;
  delayMs: number;
}

interface SupplierConfigRow {
  mode: 'normal' | 'always_fail' | 'out_of_stock' | 'timeout_before_issue' | 'timeout_after_issue';
  failure_rate: number;
  timeout_rate: number;
  min_delay_ms: number;
  timeout_delay_ms: number;
}

export async function issueFromStub(provider: Provider, input: SupplierIssueInput): Promise<SupplierHttpResult> {
  return transaction(async (client) => {
    // The lock makes concurrent repeats with one request_id deterministic before inventory is touched.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${provider}:${input.request_id}`]);
    const existing = await client.query<{ code: string }>(
      `SELECT code FROM provider_issuances WHERE provider = $1 AND request_id = $2`,
      [provider, input.request_id],
    );
    if (existing.rows[0]) {
      return {
        statusCode: 200,
        body: { status: 'ok', request_id: input.request_id, code: existing.rows[0].code },
        delayMs: 0,
      };
    }

    const configResult = await client.query<SupplierConfigRow>('SELECT * FROM supplier_configs WHERE provider = $1', [provider]);
    const config = configResult.rows[0];
    if (!config) throw new Error(`Supplier ${provider} is not configured`);

    const random = Math.random();
    const shouldFail = config.mode === 'always_fail'
      || (config.mode === 'normal' && random < config.failure_rate);
    const shouldTimeoutBefore = config.mode === 'timeout_before_issue';
    const shouldTimeoutAfter = config.mode === 'timeout_after_issue'
      || (config.mode === 'normal' && random >= config.failure_rate && random < config.failure_rate + config.timeout_rate);

    if (shouldFail) {
      return {
        statusCode: 503,
        body: { status: 'error', reason: 'provider_unavailable' },
        delayMs: config.min_delay_ms,
      };
    }
    if (shouldTimeoutBefore) {
      return {
        statusCode: 503,
        body: { status: 'error', reason: 'provider_timeout_before_issue' },
        delayMs: config.timeout_delay_ms,
      };
    }
    if (config.mode === 'out_of_stock') {
      return {
        statusCode: 409,
        body: { status: 'error', reason: 'out_of_stock' },
        delayMs: config.min_delay_ms,
      };
    }

    const inventory = await client.query<{ code: string }>(
      `SELECT code FROM provider_inventory
       WHERE provider = $1 AND sku = $2 AND claimed_by IS NULL
       ORDER BY random()
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [provider, input.sku],
    );
    const key = inventory.rows[0];
    if (!key) {
      return {
        statusCode: 409,
        body: { status: 'error', reason: 'out_of_stock' },
        delayMs: config.min_delay_ms,
      };
    }

    await client.query(
      `UPDATE provider_inventory SET claimed_by = $2, claimed_at = now() WHERE code = $1`,
      [key.code, input.request_id],
    );
    await client.query(
      `INSERT INTO provider_issuances (provider, request_id, order_id, sku, code)
       VALUES ($1, $2, $3, $4, $5)`,
      [provider, input.request_id, input.order_id, input.sku, key.code],
    );

    return {
      statusCode: 200,
      body: { status: 'ok', request_id: input.request_id, code: key.code },
      // The issuance commits before this delay. A timed-out client must retry the same provider/request_id.
      delayMs: shouldTimeoutAfter ? config.timeout_delay_ms : config.min_delay_ms,
    };
  });
}
