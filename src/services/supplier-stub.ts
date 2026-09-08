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
  mode:
    | 'normal'
    | 'always_fail'
    | 'out_of_stock'
    | 'timeout_before_issue'
    | 'timeout_after_issue'
    | 'duplicate_code'
    | 'wrong_code'
    | 'error_after_issue';
  failure_rate: number;
  timeout_rate: number;
  min_delay_ms: number;
  timeout_delay_ms: number;
}

export async function issueFromStub(
  provider: Provider,
  input: SupplierIssueInput,
): Promise<SupplierHttpResult> {
  return transaction(async (client) => {
    // The lock makes concurrent repeats with one request_id deterministic before inventory is touched.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${provider}:${input.request_id}`,
    ]);
    const cancelled = await client.query(
      'SELECT 1 FROM supplier_cancellations WHERE provider=$1 AND request_id=$2',
      [provider, input.request_id],
    );
    if (cancelled.rowCount)
      return { statusCode: 409, body: { status: 'error', reason: 'request_cancelled' }, delayMs: 0 };
    const configResult = await client.query<SupplierConfigRow>(
      'SELECT * FROM supplier_configs WHERE provider = $1',
      [provider],
    );
    const config = configResult.rows[0];
    if (!config) throw new Error(`Supplier ${provider} is not configured`);
    const responseCode = async (actual: string) => {
      if (!['duplicate_code', 'wrong_code'].includes(config.mode)) return actual;
      const other = await client.query(
        config.mode === 'duplicate_code'
          ? 'SELECT code FROM provider_issuances WHERE request_id <> $1 ORDER BY created_at LIMIT 1'
          : 'SELECT code FROM provider_inventory WHERE sku <> $1 ORDER BY code LIMIT 1',
        [config.mode === 'duplicate_code' ? input.request_id : input.sku],
      );
      return other.rows[0]?.code ?? 'UNREGISTERED-FOREIGN-CODE';
    };
    const existing = await client.query<{ code: string; sku: string; order_id: string }>(
      `SELECT code,sku,order_id FROM provider_issuances WHERE provider = $1 AND request_id = $2`,
      [provider, input.request_id],
    );
    if (existing.rows[0]) {
      if (
        (
          await client.query('SELECT 1 FROM provider_inventory WHERE code=$1 AND revoked_at IS NOT NULL', [
            existing.rows[0].code,
          ])
        ).rowCount
      )
        return { statusCode: 409, body: { status: 'error', reason: 'code_revoked' }, delayMs: 0 };
      if (existing.rows[0].sku !== input.sku || existing.rows[0].order_id !== input.order_id) {
        return {
          statusCode: 409,
          body: { status: 'error', reason: 'request_id_payload_conflict' },
          delayMs: 0,
        };
      }
      return {
        statusCode: 200,
        body: { status: 'ok', request_id: input.request_id, code: await responseCode(existing.rows[0].code) },
        delayMs: 0,
      };
    }

    const random = Math.random();
    const shouldFail =
      config.mode === 'always_fail' || (config.mode === 'normal' && random < config.failure_rate);
    const shouldTimeoutBefore = config.mode === 'timeout_before_issue';
    const shouldTimeoutAfter =
      config.mode === 'timeout_after_issue' ||
      (config.mode === 'normal' &&
        random >= config.failure_rate &&
        random < config.failure_rate + config.timeout_rate);

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
       WHERE provider = $1 AND sku = $2 AND claimed_by IS NULL AND revoked_at IS NULL
       AND (reserved_order_id IS NULL OR reserved_order_id=$3)
       AND (offer_id=(SELECT assigned_offer_id FROM orders WHERE id=$3)
         OR ((SELECT assigned_offer_id FROM orders WHERE id=$3) IS NULL AND EXISTS(SELECT 1 FROM seller_offers f WHERE f.id=offer_id AND f.is_default)))
       ORDER BY (reserved_order_id=$3) DESC NULLS LAST,random()
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [provider, input.sku, input.order_id],
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
      `UPDATE provider_inventory SET claimed_by = $2, claimed_at = now(),reserved_order_id=NULL WHERE code = $1`,
      [key.code, input.request_id],
    );
    await client.query(
      `INSERT INTO provider_issuances (provider, request_id, order_id, sku, code)
       VALUES ($1, $2, $3, $4, $5)`,
      [provider, input.request_id, input.order_id, input.sku, key.code],
    );

    return {
      statusCode: config.mode === 'error_after_issue' ? 503 : 200,
      body:
        config.mode === 'error_after_issue'
          ? { status: 'error', reason: 'error_after_issue' }
          : { status: 'ok', request_id: input.request_id, code: await responseCode(key.code) },
      // The issuance commits before this delay. A timed-out client must retry the same provider/request_id.
      delayMs: shouldTimeoutAfter ? config.timeout_delay_ms : config.min_delay_ms,
    };
  });
}

// Independent authoritative lookup/cancel contract. A cancellation is a durable
// tombstone under the same lock as issue: a delayed request cannot issue afterward.
export async function resolveFromStub(
  provider: Provider,
  input: SupplierIssueInput,
): Promise<SupplierHttpResult> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${provider}:${input.request_id}`,
    ]);
    const issued = await client.query(
      `SELECT code,sku,order_id FROM provider_issuances WHERE provider=$1 AND request_id=$2`,
      [provider, input.request_id],
    );
    if (issued.rows[0]) {
      return {
        statusCode: 200,
        body: { status: 'issued', request_id: input.request_id, ...issued.rows[0] },
        delayMs: 0,
      };
    }
    await client.query(
      'INSERT INTO supplier_cancellations(provider,request_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [provider, input.request_id],
    );
    return { statusCode: 200, body: { status: 'cancelled', request_id: input.request_id }, delayMs: 0 };
  });
}
