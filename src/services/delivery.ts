import type { FastifyBaseLogger } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { getPool, transaction } from '../db.js';
import type { OrderRow, Provider } from '../types.js';
import { recordSupplierIncident } from './sellers.js';
import { reserveSupplierRequest } from './supplier-limits.js';

const successResponse = z.object({
  status: z.literal('ok'),
  request_id: z.string(),
  code: z.string().min(1),
});
interface DeliveryJobRow {
  order_id: string;
  request_id: string;
  refund_requested: boolean;
  attempts: number;
  sku: string;
  provider: Provider;
  issue_attempts: number;
  generation: number;
  phase: 'issue' | 'resolve';
  assigned_provider: Provider | null;
}
type ProviderResult =
  | { kind: 'success'; provider: Provider; code: string }
  | { kind: 'cancelled'; provider: Provider; reason: string }
  | { kind: 'retry'; provider: Provider; reason: string; waitMs: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function recordAttempt(
  job: DeliveryJobRow,
  attempt: number,
  outcome: string,
  started: number,
  status?: number,
  error?: string,
) {
  await getPool().query(
    `INSERT INTO delivery_attempts(order_id,request_id,provider,attempt_no,outcome,http_status,latency_ms,error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      job.order_id,
      job.request_id,
      job.provider,
      attempt,
      outcome,
      status ?? null,
      Math.round(performance.now() - started),
      error ?? null,
    ],
  );
}

// Platform registry is authoritative about validity, product and ownership.
// A valid-looking provider response alone is never sufficient for delivery.
async function validCode(client: PoolClient | ReturnType<typeof getPool>, job: DeliveryJobRow, code: string) {
  const result = await client.query(
    `SELECT 1 FROM provider_inventory i
    JOIN provider_issuances p ON p.code=i.code AND p.provider=i.provider
    WHERE i.code=$1 AND i.revoked_at IS NULL AND i.provider=$2 AND i.sku=$3 AND i.claimed_by=$4
    AND p.request_id=$4 AND p.order_id=$5 AND p.sku=$3
    AND EXISTS(SELECT 1 FROM orders o WHERE o.id=$5 AND (o.assigned_offer_id IS NULL OR o.assigned_offer_id=i.offer_id))
    AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.code=i.code AND d.order_id<>$5)`,
    [code, job.provider, job.sku, job.request_id, job.order_id],
  );
  return Boolean(result.rowCount);
}

async function ownsLease(client: PoolClient, job: DeliveryJobRow) {
  const result = await client.query(
    `SELECT 1 FROM delivery_jobs WHERE order_id=$1 AND request_id=$2
    AND attempts=$3 AND state='processing' FOR UPDATE`,
    [job.order_id, job.request_id, job.attempts],
  );
  return Boolean(result.rowCount);
}

async function setPhase(job: DeliveryJobRow, phase: 'issue' | 'resolve') {
  const result = await getPool().query(
    `UPDATE delivery_jobs SET phase=$4 WHERE order_id=$1 AND request_id=$2
    AND attempts=$3 AND state='processing' RETURNING order_id`,
    [job.order_id, job.request_id, job.attempts, phase],
  );
  if (result.rowCount) job.phase = phase;
  return Boolean(result.rowCount);
}

async function resolveProvider(
  job: DeliveryJobRow,
  config: AppConfig,
  reason: string,
): Promise<ProviderResult> {
  if (!(await setPhase(job, 'resolve')))
    return { kind: 'retry', provider: job.provider, reason: 'lease_lost', waitMs: 1000 };
  const waitMs = await reserveSupplierRequest(job.provider);
  if (waitMs) return { kind: 'retry', provider: job.provider, reason: 'rate_limited', waitMs };
  try {
    const response = await fetch(`${config.SUPPLIER_BASE_URL}/suppliers/${job.provider}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-supplier-secret': config.SUPPLIER_SHARED_SECRET },
      body: JSON.stringify({ request_id: job.request_id, sku: job.sku, order_id: job.order_id }),
      signal: AbortSignal.timeout(config.SUPPLIER_TIMEOUT_MS),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.ok && body.request_id === job.request_id) {
      if (
        body.status === 'issued' &&
        typeof body.code === 'string' &&
        (await validCode(getPool(), job, body.code))
      ) {
        await getPool().query(
          `INSERT INTO audit_events(idempotency_key,event_type,order_id,payload)
          VALUES ($1,'supplier_discrepancy_resolved',$2,$3) ON CONFLICT DO NOTHING`,
          [
            `resolve:${job.provider}:${job.request_id}`,
            job.order_id,
            JSON.stringify({
              provider: job.provider,
              request_id: job.request_id,
              reason,
              resolution: 'verified_issuance',
            }),
          ],
        );
        return { kind: 'success', provider: job.provider, code: body.code };
      }
      // Confirm the tombstone independently; do not trust a claimed cancellation either.
      if (body.status === 'cancelled') {
        const cancelled = await getPool().query(
          `SELECT 1 FROM supplier_cancellations c WHERE provider=$1 AND request_id=$2
          AND NOT EXISTS(SELECT 1 FROM provider_issuances p WHERE p.provider=c.provider AND p.request_id=c.request_id)`,
          [job.provider, job.request_id],
        );
        if (cancelled.rowCount) return { kind: 'cancelled', provider: job.provider, reason };
      }
    }
  } catch {
    /* An unknown outcome stays durable in resolve phase; never issue/fallback/refund blindly. */
  }
  return { kind: 'retry', provider: job.provider, reason: 'resolution_pending', waitMs: 1000 };
}

async function callProvider(
  job: DeliveryJobRow,
  config: AppConfig,
  logger: FastifyBaseLogger,
): Promise<ProviderResult> {
  if (job.phase === 'resolve') return resolveProvider(job, config, 'recovered_resolution');
  let reason = 'provider_unavailable';
  for (let attempt = job.issue_attempts + 1; attempt <= config.SUPPLIER_MAX_ATTEMPTS; attempt++) {
    const waitMs = await reserveSupplierRequest(job.provider);
    if (waitMs) return { kind: 'retry', provider: job.provider, reason: 'rate_limited', waitMs };
    const admitted = await getPool().query(
      `UPDATE delivery_jobs SET issue_attempts=issue_attempts+1
      WHERE order_id=$1 AND request_id=$2 AND attempts=$3 AND state='processing' RETURNING order_id`,
      [job.order_id, job.request_id, job.attempts],
    );
    if (!admitted.rowCount)
      return { kind: 'retry', provider: job.provider, reason: 'lease_lost', waitMs: 1000 };
    const started = performance.now();
    try {
      const response = await fetch(`${config.SUPPLIER_BASE_URL}/suppliers/${job.provider}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-supplier-secret': config.SUPPLIER_SHARED_SECRET },
        body: JSON.stringify({ request_id: job.request_id, sku: job.sku, order_id: job.order_id }),
        signal: AbortSignal.timeout(config.SUPPLIER_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      const parsed = successResponse.safeParse(body);
      if (
        response.ok &&
        parsed.success &&
        parsed.data.request_id === job.request_id &&
        (await validCode(getPool(), job, parsed.data.code))
      ) {
        await recordAttempt(job, attempt, 'ok', started, response.status);
        return { kind: 'success', provider: job.provider, code: parsed.data.code };
      }
      if (response.ok && parsed.success) {
        const observed = await getPool().query(
          'SELECT sku,claimed_by FROM provider_inventory WHERE code=$1',
          [parsed.data.code],
        );
        const expected = await getPool().query(
          'SELECT code FROM provider_issuances WHERE provider=$1 AND request_id=$2',
          [job.provider, job.request_id],
        );
        const duplicate = Boolean(
          observed.rows[0]?.claimed_by && observed.rows[0].claimed_by !== job.request_id,
        );
        await recordSupplierIncident(
          job,
          duplicate ? 'duplicate_code' : 'wrong_code',
          {
            expected_sku: job.sku,
            observed_sku: observed.rows[0]?.sku ?? null,
            ownership_matches: observed.rows[0]?.claimed_by === job.request_id,
            response_request_matches: parsed.data.request_id === job.request_id,
            check: 'platform_registry_and_issuance_ownership',
            http_status: response.status,
          },
          parsed.data.code,
          expected.rows[0]?.code,
        );
      } else if (!response.ok) {
        const issuance = await getPool().query(
          'SELECT code FROM provider_issuances WHERE provider=$1 AND request_id=$2',
          [job.provider, job.request_id],
        );
        if (issuance.rows[0])
          await recordSupplierIncident(
            job,
            'error_after_issue',
            {
              expected_sku: job.sku,
              http_status: response.status,
              issuance_confirmed: true,
              check: 'issuance_committed_before_error_response',
            },
            undefined,
            issuance.rows[0].code,
          );
      }
      reason = response.ok
        ? 'invalid_or_foreign_code'
        : String((body as { reason?: unknown })?.reason ?? `http_${response.status}`);
      await recordAttempt(
        job,
        attempt,
        response.ok ? 'invalid_response' : reason === 'out_of_stock' ? 'out_of_stock' : 'explicit_failure',
        started,
        response.status,
        reason,
      );
      if (response.ok || reason === 'out_of_stock' || reason === 'request_cancelled') break;
    } catch (error) {
      reason = 'ambiguous_timeout';
      await recordAttempt(
        job,
        attempt,
        'timeout',
        started,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      logger.warn(
        { event: 'supplier_timeout', orderId: job.order_id, provider: job.provider },
        'supplier outcome requires verification',
      );
    }
    if (attempt < config.SUPPLIER_MAX_ATTEMPTS) await sleep(config.SUPPLIER_BACKOFF_MS * 2 ** (attempt - 1));
  }
  return resolveProvider(job, config, reason);
}

async function claimJob(): Promise<DeliveryJobRow | undefined> {
  return transaction(async (client) => {
    const result = await client.query<DeliveryJobRow>(`WITH candidate AS (
      SELECT j.order_id FROM delivery_jobs j JOIN orders o ON o.id=j.order_id
      WHERE ((j.state IN ('pending','retry') AND j.next_attempt_at<=now()) OR (j.state='processing' AND j.locked_until<now()))
      AND o.payment_state='paid' AND o.status<>'refunded' AND (o.status<>'delivered' OR o.refund_requested)
      ORDER BY o.refund_requested DESC,j.next_attempt_at,j.created_at,j.order_id FOR UPDATE OF j SKIP LOCKED LIMIT 1)
      UPDATE delivery_jobs j SET state='processing',attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now()
      FROM candidate c,orders o WHERE j.order_id=c.order_id AND o.id=j.order_id
      RETURNING j.order_id,j.request_id,j.attempts,j.provider,j.issue_attempts,j.generation,j.phase,o.sku,o.assigned_provider,o.refund_requested`);
    return result.rows[0];
  });
}

async function prepareOrder(job: DeliveryJobRow) {
  return transaction(async (client) => {
    // Consistent lock order everywhere: order first, then job.
    const order = (
      await client.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [job.order_id])
    ).rows[0];
    if (!order || !(await ownsLease(client, job))) return false;
    if (
      order.status === 'refunded' ||
      (order.status === 'delivered' && !order.refund_requested) ||
      order.payment_state !== 'paid'
    )
      return false;
    if (!order.refund_requested && order.status !== 'delivering')
      await client.query(
        `UPDATE orders SET status='delivering',version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
        [job.order_id],
      );
    return true;
  });
}

async function postSettlement(client: PoolClient, order: OrderRow, kind: 'delivery_settled' | 'refund') {
  const id = `${kind}:${order.id}`;
  const inserted = await client.query(
    `INSERT INTO ledger_transactions(id,order_id,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [id, order.id, kind],
  );
  if (inserted.rowCount)
    await client.query(
      `INSERT INTO ledger_entries(transaction_id,account,amount,currency)
    VALUES ($1,'customer_clearing',$2,$4),($1,$3,-$2,$4)`,
      [
        id,
        Number(order.amount),
        kind === 'refund' ? (order.user_id ? 'wallet' : 'cash') : 'sales',
        order.currency,
      ],
    );
}

async function commitRefund(client: PoolClient, order: OrderRow, reason: string) {
  // Stub refund, journal posting and wallet credit commit together; order_id is the idempotency key.
  await client.query(
    `INSERT INTO refunds(order_id,amount,currency,destination,reason) VALUES ($1,$2,$3,$4,$5)`,
    [order.id, order.amount, order.currency, order.user_id ? 'wallet' : 'payment_stub', reason],
  );
  if (order.user_id) {
    const user = await client.query(
      `UPDATE users SET points_balance=points_balance+$2,updated_at=now() WHERE id=$1 RETURNING points_balance`,
      [order.user_id, order.amount],
    );
    await client.query(
      `INSERT INTO point_transactions(id,user_id,kind,amount,balance_after) VALUES ($1,$2,'order_refund',$3,$4)`,
      [`refund:${order.id}`, order.user_id, order.amount, user.rows[0].points_balance],
    );
  }
  await postSettlement(client, order, 'refund');
  await client.query(
    `UPDATE orders SET status='refunded',refund_requested=false,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
    [order.id],
  );
  await client.query(
    `UPDATE delivery_jobs SET state='completed',locked_until=NULL,last_error=$2,updated_at=now() WHERE order_id=$1`,
    [order.id, reason],
  );
  await client.query(
    `INSERT INTO audit_events(idempotency_key,event_type,order_id,payload) VALUES ($1,'order_refunded',$2,$3)`,
    [`refund:${order.id}`, order.id, JSON.stringify({ amount: Number(order.amount), reason: reason })],
  );
}

async function persistSuccess(job: DeliveryJobRow, result: Extract<ProviderResult, { kind: 'success' }>) {
  await transaction(async (client) => {
    const order = (
      await client.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [job.order_id])
    ).rows[0];
    if (!order || !(await ownsLease(client, job)) || ['delivered', 'refunded'].includes(order.status)) return;
    if (order.payment_state !== 'paid' || !(await validCode(client, job, result.code)))
      throw new Error('delivery_verification_failed');
    await client.query('INSERT INTO deliveries(order_id,request_id,provider,code) VALUES ($1,$2,$3,$4)', [
      job.order_id,
      job.request_id,
      result.provider,
      result.code,
    ]);
    await postSettlement(client, order, 'delivery_settled');
    await client.query(
      `UPDATE orders SET status='delivered',delivered_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1`,
      [job.order_id],
    );
    await client.query(
      `UPDATE delivery_jobs SET state='completed',locked_until=NULL,last_error=NULL,updated_at=now() WHERE order_id=$1`,
      [job.order_id],
    );
    await client.query(
      `INSERT INTO audit_events(idempotency_key,event_type,order_id,payload) VALUES ($1,'order_delivered',$2,$3) ON CONFLICT DO NOTHING`,
      [
        `order:${job.order_id}:delivered`,
        job.order_id,
        JSON.stringify({ requestId: job.request_id, provider: result.provider }),
      ],
    );
  });
}

async function persistResult(
  job: DeliveryJobRow,
  result: Exclude<ProviderResult, { kind: 'success' }>,
): Promise<boolean> {
  return transaction(async (client) => {
    const order = (
      await client.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [job.order_id])
    ).rows[0];
    if (
      !order ||
      !(await ownsLease(client, job)) ||
      order.status === 'refunded' ||
      (order.status === 'delivered' && !order.refund_requested)
    )
      return false;
    if (result.kind === 'cancelled' && (order.group_id || order.refund_requested)) {
      await commitRefund(client, order, result.reason);
      return false;
    }
    // Preserve A → B fallback once; every paid order has a finite resolution path.
    if (result.kind === 'cancelled' && !order.assigned_provider) {
      if (job.provider !== 'A') {
        await client.query('UPDATE orders SET assigned_provider=$2 WHERE id=$1', [order.id, job.provider]);
        await commitRefund(client, order, result.reason);
        return false;
      }
      await client.query(
        `UPDATE delivery_jobs SET provider='B',issue_attempts=0,phase='issue',state='pending',
        next_attempt_at=now(),locked_until=NULL,last_error=$2,updated_at=now() WHERE order_id=$1`,
        [order.id, result.reason],
      );
      return true;
    }
    const retry = result as Extract<ProviderResult, { kind: 'retry' }>;
    await client.query(
      `UPDATE delivery_jobs SET state='retry',next_attempt_at=now()+($2*interval '1 millisecond'),
      locked_until=NULL,last_error=$3,updated_at=now() WHERE order_id=$1`,
      [order.id, retry.waitMs, retry.reason],
    );
    return false;
  });
}

async function persistManualRefund(
  job: DeliveryJobRow,
  result: Extract<ProviderResult, { kind: 'success' }>,
) {
  await transaction(async (client) => {
    const order = (
      await client.query<OrderRow>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [job.order_id])
    ).rows[0];
    if (!order || !(await ownsLease(client, job)) || !order.refund_requested || order.status === 'refunded')
      return;
    if (!(await validCode(client, job, result.code))) throw new Error('refund_key_verification_failed');
    const reason =
      (await client.query('SELECT reason FROM refund_requests WHERE order_id=$1', [order.id])).rows[0]
        ?.reason ?? 'admin_refund';
    await client.query('INSERT INTO delivery_revocations(order_id,code,reason) VALUES($1,$2,$3)', [
      order.id,
      result.code,
      reason,
    ]);
    await client.query('UPDATE provider_inventory SET revoked_at=clock_timestamp() WHERE code=$1', [
      result.code,
    ]);
    const delivered = await client.query('SELECT 1 FROM deliveries WHERE order_id=$1', [order.id]);
    if (delivered.rowCount) {
      const tx = `delivery_reversed:${order.id}`;
      await client.query(
        `INSERT INTO ledger_transactions(id,order_id,kind) VALUES($1,$2,'delivery_reversed')`,
        [tx, order.id],
      );
      await client.query(
        `INSERT INTO ledger_entries(transaction_id,account,amount,currency)
      VALUES($1,'sales',$2,$3),($1,'customer_clearing',-$2,$3)`,
        [tx, order.amount, order.currency],
      );
    }
    await commitRefund(client, order, reason);
  });
}

export async function runOneDelivery(config: AppConfig, logger: FastifyBaseLogger): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  if (!(await prepareOrder(job))) return true;
  const result = job.refund_requested
    ? await resolveProvider(job, config, 'manual_refund')
    : await callProvider(job, config, logger);
  if (result.kind === 'success' && job.refund_requested) await persistManualRefund(job, result);
  else if (result.kind === 'success') await persistSuccess(job, result);
  else await persistResult(job, result);
  return true;
}
export async function runDeliveryBatch(
  config: AppConfig,
  logger: FastifyBaseLogger,
  limit = 100,
): Promise<number> {
  let processed = 0;
  while (processed < limit && (await runOneDelivery(config, logger))) processed++;
  return processed;
}
export async function retryOrder(orderId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE delivery_jobs j SET state='pending',next_attempt_at=now(),last_error=NULL,updated_at=now()
    FROM orders o WHERE (o.id=$1 OR o.group_id=$1) AND j.order_id=o.id AND o.payment_state='paid'
    AND o.status NOT IN ('delivered','refunded') AND j.state IN ('pending','retry') RETURNING j.order_id`,
    [orderId],
  );
  return Boolean(result.rowCount);
}
