import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, transaction } from '../db.js';
import type { Provider } from '../types.js';

export async function sellerReport(provider: Provider) {
  const result = await getPool().query(
    `SELECT s.provider AS id,s.display_name AS name,s.banned_at,s.ban_reason,s.demo_scenario,
    (SELECT count(*)::int FROM seller_reviews r WHERE r.provider=s.provider) AS review_count,
    (SELECT round(avg(r.rating),2)::float FROM seller_reviews r WHERE r.provider=s.provider) AS rating,
    (SELECT count(*)::int FROM supplier_incidents i WHERE i.provider=s.provider) AS confirmed_incidents,
    (SELECT count(*)::int FROM supplier_incidents i WHERE i.provider=s.provider AND i.created_at>clock_timestamp()-interval '30 days') AS recent_incidents,
    (SELECT count(*)::int FROM deliveries d WHERE d.provider=s.provider) AS delivered,
    (SELECT count(*)::int FROM refunds r JOIN orders o ON o.id=r.order_id WHERE o.assigned_provider=s.provider) AS refunded,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'created_at',i.created_at,
      'proof',i.evidence-'observed_code_hash'-'expected_code_hash') ORDER BY i.id DESC)
      FROM (SELECT * FROM supplier_incidents WHERE provider=s.provider ORDER BY id DESC LIMIT 30) i),'[]') AS evidence,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('rating',r.rating,'comment',r.comment,'created_at',r.created_at,
      'buyer',u.username,'verified_purchase',true) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM seller_reviews WHERE provider=s.provider ORDER BY created_at DESC LIMIT 30) r JOIN users u ON u.id=r.user_id),'[]') AS reviews
    FROM supplier_configs s WHERE s.provider=$1`,
    [provider],
  );
  const seller = result.rows[0];
  if (!seller) return undefined;
  const reasons = [...new Set((seller.evidence as { kind: string }[]).map((i) => i.kind))];
  return {
    ...seller,
    demo_notice: demoScenarioNotice(seller.demo_scenario),
    flag: seller.banned_at || seller.recent_incidents > 0 ? 'red' : 'none',
    flag_reasons: reasons,
    reputation_note: seller.banned_at
      ? 'Продавец заблокирован администрацией'
      : seller.recent_incidents > 0
        ? 'Есть подтверждённые нарушения за последние 30 дней'
        : 'Подтверждённых нарушений за последние 30 дней нет',
    rating_scale: 5,
  };
}

export async function productOffers(sku: string) {
  const result = await getPool().query(
    `SELECT f.id AS offer_id,f.name AS offer_name,f.is_default,f.provider,f.price_minor::float AS price,f.currency,
    (SELECT count(*)::int FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) AS available
    FROM seller_offers f JOIN supplier_configs s ON s.provider=f.provider WHERE f.sku=$1 AND f.active=true AND s.banned_at IS NULL ORDER BY f.price_minor,f.provider`,
    [sku],
  );
  return Promise.all(
    result.rows.map(async (offer) => ({ ...offer, seller: await sellerReport(offer.provider) })),
  );
}

export async function chooseOffer(
  client: PoolClient,
  sku: string,
  provider?: Provider,
  userId?: string,
  offerId?: string,
) {
  const result = await client.query(
    `SELECT f.*,s.display_name AS seller_name FROM seller_offers f JOIN supplier_configs s ON s.provider=f.provider
    WHERE f.sku=$1 AND ($4::text IS NULL OR f.id=$4) AND f.active=true AND s.banned_at IS NULL AND ($2::text IS NULL OR f.provider=$2) AND ($3::text IS NULL OR f.provider IS DISTINCT FROM (SELECT u.seller_id FROM users u WHERE u.id=$3))
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) THEN 0 ELSE 1 END,
      f.price_minor,f.provider LIMIT 1 FOR SHARE OF f, s`,
    [sku, provider ?? null, userId ?? null, offerId ?? null],
  );
  const offer = result.rows[0];
  if (!offer) throw Object.assign(new Error('seller_offer_not_found'), { statusCode: 404 });
  return offer as {
    id: string;
    name: string;
    provider: Provider;
    sku: string;
    price_minor: string;
    currency: string;
    seller_name: string;
  };
}

export async function reviewPurchase(userId: string, orderId: string, rating: number, comment: string) {
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT o.*,COALESCE(d.provider,o.assigned_provider) AS seller
      FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE OF o`,
      [orderId, userId],
    );
    const order = result.rows[0];
    if (!order) throw Object.assign(new Error('purchase_not_found'), { statusCode: 404 });
    if (!['delivered', 'refunded'].includes(order.status))
      throw Object.assign(new Error('review_requires_completed_purchase'), { statusCode: 409 });
    const existing = await client.query('SELECT * FROM seller_reviews WHERE order_id=$1', [orderId]);
    if (existing.rows[0]) {
      if (existing.rows[0].rating !== rating || existing.rows[0].comment !== comment)
        throw Object.assign(new Error('review_already_submitted'), { statusCode: 409 });
      return existing.rows[0];
    }
    return (
      await client.query(
        `INSERT INTO seller_reviews(order_id,provider,user_id,rating,comment) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orderId, order.seller, userId, rating, comment],
      )
    ).rows[0];
  });
}

export async function recordSupplierIncident(
  input: { provider: Provider; order_id: string; request_id: string },
  kind: 'duplicate_code' | 'wrong_code' | 'error_after_issue',
  evidence: Record<string, unknown>,
  observed?: string,
  expected?: string,
) {
  const hash = (s: string | undefined) => (s ? createHash('sha256').update(s).digest('hex') : undefined);
  await getPool().query(
    `INSERT INTO supplier_incidents(idempotency_key,provider,order_id,request_id,kind,evidence)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [
      `${input.provider}:${input.request_id}:${kind}`,
      input.provider,
      input.order_id,
      input.request_id,
      kind,
      JSON.stringify({ ...evidence, observed_code_hash: hash(observed), expected_code_hash: hash(expected) }),
    ],
  );
}

export function demoScenarioNotice(scenario: string | null | undefined) {
  return scenario === 'refund'
    ? 'Тест возврата: этот продавец не выдаёт ключи. Оплата полностью возвращается на баланс аккаунта.'
    : scenario === 'key_check'
      ? 'Тест проверки ключей: неверный ответ продавца автоматически проверяется по реестру.'
      : null;
}
