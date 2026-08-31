import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { getPool, transaction } from '../db.js';
import type { OrderRow, Provider } from '../types.js';

const successResponse = z.object({
  status: z.literal('ok'),
  request_id: z.string(),
  code: z.string().min(1),
});

interface DeliveryJobRow {
  order_id: string;
  request_id: string;
  attempts: number;
  sku: string;
}

type ProviderResult =
  | { kind: 'success'; provider: Provider; code: string }
  | { kind: 'out_of_stock'; provider: Provider }
  | { kind: 'explicit_failure'; provider: Provider; error: string }
  | { kind: 'ambiguous_timeout'; provider: Provider; error: string };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function recordAttempt(
  job: DeliveryJobRow,
  provider: Provider,
  attemptNo: number,
  outcome: 'ok' | 'explicit_failure' | 'out_of_stock' | 'timeout' | 'invalid_response',
  latencyMs: number,
  httpStatus?: number,
  error?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO delivery_attempts
      (order_id, request_id, provider, attempt_no, outcome, http_status, latency_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [job.order_id, job.request_id, provider, attemptNo, outcome, httpStatus ?? null, latencyMs, error ?? null],
  );
}

async function callProvider(
  job: DeliveryJobRow,
  provider: Provider,
  config: AppConfig,
  logger: FastifyBaseLogger,
): Promise<ProviderResult> {
  for (let attempt = 1; attempt <= config.SUPPLIER_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${config.SUPPLIER_BASE_URL}/suppliers/${provider}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: job.request_id, sku: job.sku, order_id: job.order_id }),
        signal: AbortSignal.timeout(config.SUPPLIER_TIMEOUT_MS),
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const rawBody: unknown = await response.json().catch(() => undefined);
      if (response.ok) {
        const parsed = successResponse.safeParse(rawBody);
        if (!parsed.success || parsed.data.request_id !== job.request_id) {
          await recordAttempt(job, provider, attempt, 'invalid_response', latencyMs, response.status, 'invalid_or_mismatched_response');
          if (attempt < config.SUPPLIER_MAX_ATTEMPTS) {
            await sleep(config.SUPPLIER_BACKOFF_MS * 2 ** (attempt - 1));
            continue;
          }
          return { kind: 'explicit_failure', provider, error: 'invalid_or_mismatched_response' };
        }
        await recordAttempt(job, provider, attempt, 'ok', latencyMs, response.status);
        logger.info({ event: 'supplier_issue_succeeded', orderId: job.order_id, requestId: job.request_id, provider, attempt }, 'supplier issue succeeded');
        return { kind: 'success', provider, code: parsed.data.code };
      }

      const reason = typeof rawBody === 'object' && rawBody !== null && 'reason' in rawBody
        ? String((rawBody as { reason: unknown }).reason)
        : `http_${response.status}`;
      if (reason === 'out_of_stock') {
        await recordAttempt(job, provider, attempt, 'out_of_stock', latencyMs, response.status, reason);
        return { kind: 'out_of_stock', provider };
      }
      await recordAttempt(job, provider, attempt, 'explicit_failure', latencyMs, response.status, reason);
      if (attempt < config.SUPPLIER_MAX_ATTEMPTS) {
        await sleep(config.SUPPLIER_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      return { kind: 'explicit_failure', provider, error: reason };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      await recordAttempt(job, provider, attempt, 'timeout', latencyMs, undefined, message);
      logger.warn({ event: 'supplier_timeout', orderId: job.order_id, requestId: job.request_id, provider, attempt, error: message }, 'supplier call timed out; retrying same request_id on same provider');
      if (attempt < config.SUPPLIER_MAX_ATTEMPTS) {
        await sleep(config.SUPPLIER_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      // Never fallback after an ambiguous timeout: the provider may have committed an issuance.
      return { kind: 'ambiguous_timeout', provider, error: message };
    }
  }
  return { kind: 'explicit_failure', provider, error: 'attempts_exhausted' };
}

async function orchestrateProviders(
  job: DeliveryJobRow,
  config: AppConfig,
  logger: FastifyBaseLogger,
): Promise<ProviderResult> {
  const primary = await callProvider(job, 'A', config, logger);
  if (primary.kind === 'success' || primary.kind === 'ambiguous_timeout') return primary;
  logger.warn({ event: 'supplier_fallback', orderId: job.order_id, requestId: job.request_id, from: 'A', to: 'B', reason: primary.kind }, 'falling back to supplier B');
  const fallback = await callProvider(job, 'B', config, logger);
  if (fallback.kind === 'out_of_stock' && primary.kind === 'out_of_stock') return fallback;
  return fallback;
}

async function claimJob(): Promise<DeliveryJobRow | undefined> {
  return transaction(async (client) => {
    const result = await client.query<DeliveryJobRow>(
      `WITH candidate AS (
         SELECT j.order_id
         FROM delivery_jobs j
         JOIN orders o ON o.id = j.order_id
         WHERE (
           (j.state IN ('pending', 'retry') AND j.next_attempt_at <= now())
           OR (j.state = 'processing' AND j.locked_until < now())
         )
         AND o.payment_state = 'paid'
         ORDER BY j.next_attempt_at, j.created_at
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
       )
       UPDATE delivery_jobs j SET state = 'processing', attempts = attempts + 1,
         locked_until = now() + interval '30 seconds', updated_at = now()
       FROM candidate c, orders o
       WHERE j.order_id = c.order_id AND o.id = j.order_id
       RETURNING j.order_id, j.request_id, j.attempts, o.sku`,
    );
    return result.rows[0];
  });
}

async function prepareOrder(job: DeliveryJobRow): Promise<boolean> {
  return transaction(async (client) => {
    const orderResult = await client.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [job.order_id]);
    const order = orderResult.rows[0];
    if (!order) return false;
    const delivered = await client.query('SELECT 1 FROM deliveries WHERE order_id = $1', [job.order_id]);
    if (delivered.rowCount || order.status === 'delivered') {
      await client.query(`UPDATE delivery_jobs SET state = 'completed', locked_until = NULL, updated_at = now() WHERE order_id = $1`, [job.order_id]);
      return false;
    }
    if (order.payment_state !== 'paid') {
      await client.query(`UPDATE delivery_jobs SET state = 'retry', next_attempt_at = now() + interval '1 day',
        locked_until = NULL, last_error = 'payment_not_paid', updated_at = now() WHERE order_id = $1`, [job.order_id]);
      return false;
    }
    await client.query(
      `UPDATE orders SET status = 'delivering', version = version + 1, updated_at = now()
       WHERE id = $1 AND status IN ('paid', 'out_of_stock', 'delivery_failed', 'delivering')`,
      [job.order_id],
    );
    return true;
  });
}

async function persistSuccess(job: DeliveryJobRow, result: Extract<ProviderResult, { kind: 'success' }>): Promise<void> {
  await transaction(async (client) => {
    const orderResult = await client.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [job.order_id]);
    const order = orderResult.rows[0];
    if (!order) throw new Error(`Order ${job.order_id} disappeared before delivery persistence`);
    await client.query(
      `INSERT INTO deliveries (order_id, request_id, provider, code)
       VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING`,
      [job.order_id, job.request_id, result.provider, result.code],
    );
    await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()),
       version = version + 1, updated_at = now() WHERE id = $1`,
      [job.order_id],
    );
    await client.query(
      `UPDATE delivery_jobs SET state = 'completed', locked_until = NULL, last_error = NULL, updated_at = now()
       WHERE order_id = $1`,
      [job.order_id],
    );
    await client.query(
      `INSERT INTO audit_events (idempotency_key, event_type, order_id, payload)
       VALUES ($1, 'order_delivered', $2, $3::jsonb) ON CONFLICT DO NOTHING`,
      [`order:${job.order_id}:delivered`, job.order_id, JSON.stringify({ requestId: job.request_id, provider: result.provider })],
    );
  });
}

async function persistFailure(job: DeliveryJobRow, result: Exclude<ProviderResult, { kind: 'success' }>): Promise<void> {
  const status = result.kind === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed';
  const reason = `${result.provider}:${result.kind}${'error' in result ? `:${result.error}` : ''}`;
  const backoffSeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await transaction(async (client) => {
    const alreadyDelivered = await client.query('SELECT 1 FROM deliveries WHERE order_id = $1', [job.order_id]);
    if (alreadyDelivered.rowCount) {
      await client.query(`UPDATE delivery_jobs SET state = 'completed', locked_until = NULL, updated_at = now() WHERE order_id = $1`, [job.order_id]);
      return;
    }
    await client.query(
      `UPDATE orders SET status = $2, version = version + 1, updated_at = now()
       WHERE id = $1 AND payment_state = 'paid' AND status <> 'delivered'`,
      [job.order_id, status],
    );
    await client.query(
      `UPDATE delivery_jobs SET state = 'retry', next_attempt_at = now() + ($2 * interval '1 second'),
       locked_until = NULL, last_error = $3, updated_at = now() WHERE order_id = $1`,
      [job.order_id, backoffSeconds, reason],
    );
    await client.query(
      `INSERT INTO audit_events (idempotency_key, event_type, order_id, payload)
       VALUES ($1, 'delivery_recoverable_failure', $2, $3::jsonb) ON CONFLICT DO NOTHING`,
      [`order:${job.order_id}:delivery-attempt:${job.attempts}:failed`, job.order_id, JSON.stringify({ status, reason })],
    );
  });
}

export async function runOneDelivery(config: AppConfig, logger: FastifyBaseLogger): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  if (!(await prepareOrder(job))) return true;
  const result = await orchestrateProviders(job, config, logger);
  if (result.kind === 'success') {
    await persistSuccess(job, result);
    logger.info({ event: 'order_delivered', orderId: job.order_id, requestId: job.request_id, provider: result.provider }, 'order delivered exactly once');
  } else {
    await persistFailure(job, result);
    logger.warn({ event: 'delivery_recoverable_failure', orderId: job.order_id, requestId: job.request_id, result }, 'delivery moved to a recoverable state');
  }
  return true;
}

export async function runDeliveryBatch(config: AppConfig, logger: FastifyBaseLogger, limit = 100): Promise<number> {
  let processed = 0;
  while (processed < limit && await runOneDelivery(config, logger)) processed += 1;
  return processed;
}

export async function retryOrder(orderId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE delivery_jobs j SET state = 'pending', next_attempt_at = now(), locked_until = NULL,
       last_error = NULL, updated_at = now()
     FROM orders o
     WHERE j.order_id = $1 AND o.id = j.order_id AND o.payment_state = 'paid'
       AND o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
     RETURNING j.order_id`,
    [orderId],
  );
  return Boolean(result.rowCount);
}
