import type { PoolClient } from 'pg';
import { transaction } from '../db.js';

// A key's sale price is its real offer price, used by catalog, cart and delivery.
// Isolate only this key when its current offer is shared; never reprice its neighbours.
export async function updateKeyPrice(provider: string, code: string, price: number, active: boolean) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `key-price:${provider}:${code}`,
    ]);
    const initial = (
      await client.query('SELECT offer_id FROM provider_inventory WHERE provider=$1 AND code=$2', [
        provider,
        code,
      ])
    ).rows[0];
    if (!initial) throw Object.assign(new Error('inventory_key_not_found'), { statusCode: 404 });
    // Same lock order as splitting and checkout. FOR UPDATE also fences inventory FK inserts.
    const source = (
      await client.query('SELECT * FROM seller_offers WHERE id=$1 AND provider=$2 FOR UPDATE', [
        initial.offer_id,
        provider,
      ])
    ).rows[0];
    const key = (
      await client.query('SELECT * FROM provider_inventory WHERE provider=$1 AND code=$2 FOR UPDATE', [
        provider,
        code,
      ])
    ).rows[0];
    if (key.offer_id !== initial.offer_id)
      throw Object.assign(new Error('inventory_offer_changed'), { statusCode: 409 });
    if (key.claimed_by || key.revoked_at || key.reserved_order_id)
      throw Object.assign(new Error('inventory_price_locked'), { statusCode: 409 });
    let offerId = source.id;
    if (Number(source.price_minor) !== price || source.active !== active) {
      const count = (
        await client.query('SELECT count(*)::int AS n FROM provider_inventory WHERE offer_id=$1', [source.id])
      ).rows[0].n;
      if (!source.is_default && count === 1) {
        await client.query(
          'UPDATE seller_offers SET price_minor=$2,active=$3,updated_at=clock_timestamp() WHERE id=$1',
          [source.id, price, active],
        );
      } else {
        offerId = (
          await client.query(
            `INSERT INTO seller_offers(sku,provider,name,price_minor,currency,active,is_default)
           VALUES($1,$2,'Отдельный ключ',$3,$4,$5,false) RETURNING id`,
            [key.sku, provider, price, source.currency, active],
          )
        ).rows[0].id;
        await client.query('UPDATE provider_inventory SET offer_id=$2 WHERE code=$1', [code, offerId]);
      }
    }
    return { code, offer_id: offerId, price, active };
  });
}

export interface LotPart {
  name: string;
  quantity: number;
  price: number;
  active: boolean;
}
export async function splitLot(provider: string, requestId: string, sourceId: string, parts: LotPart[]) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `lot-split:${provider}:${requestId}`,
    ]);
    const payload = { source_offer_id: sourceId, parts };
    const previous = (
      await client.query(
        'SELECT result,payload=$3::jsonb AS same FROM seller_lot_operations WHERE provider=$1 AND request_id=$2',
        [provider, requestId, JSON.stringify(payload)],
      )
    ).rows[0];
    if (previous) {
      if (!previous.same) throw Object.assign(new Error('lot_request_conflict'), { statusCode: 409 });
      return previous.result;
    }
    const source = (
      await client.query('SELECT * FROM seller_offers WHERE id=$1 AND provider=$2 FOR UPDATE', [
        sourceId,
        provider,
      ])
    ).rows[0];
    if (!source) throw Object.assign(new Error('seller_offer_not_found'), { statusCode: 404 });
    const total = parts.reduce((n, p) => n + p.quantity, 0);
    const keys = (
      await client.query(
        `SELECT code FROM provider_inventory WHERE offer_id=$1
      AND claimed_by IS NULL AND revoked_at IS NULL AND reserved_order_id IS NULL
      ORDER BY created_at,code FOR UPDATE SKIP LOCKED LIMIT $2`,
        [sourceId, total],
      )
    ).rows;
    if (keys.length !== total)
      throw Object.assign(new Error('lot_insufficient_free_keys'), { statusCode: 409 });
    const lots = [];
    let offset = 0;
    for (const part of parts) {
      const lot = (
        await client.query(
          `INSERT INTO seller_offers(sku,provider,name,price_minor,currency,active,is_default)
        VALUES($1,$2,$3,$4,$5,$6,false) RETURNING id AS offer_id,name,price_minor::float AS price,active`,
          [source.sku, provider, part.name, part.price, source.currency, part.active],
        )
      ).rows[0];
      await client.query('UPDATE provider_inventory SET offer_id=$1 WHERE code=ANY($2::text[])', [
        lot.offer_id,
        keys.slice(offset, offset + part.quantity).map((k) => k.code),
      ]);
      offset += part.quantity;
      lots.push({ ...lot, quantity: part.quantity, sku: source.sku });
    }
    const result = { source_offer_id: sourceId, moved: total, lots };
    await client.query(
      'INSERT INTO seller_lot_operations(provider,request_id,payload,result) VALUES($1,$2,$3,$4)',
      [provider, requestId, JSON.stringify(payload), JSON.stringify(result)],
    );
    return result;
  });
}
export async function updateLot(
  provider: string,
  offerId: string,
  price: number,
  active: boolean,
  name?: string,
) {
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE seller_offers SET price_minor=$3,active=$4,name=COALESCE($5,name),updated_at=clock_timestamp()
      WHERE id=$1 AND provider=$2 RETURNING id AS offer_id,name,price_minor::float AS price,active`,
      [offerId, provider, price, active, name ?? null],
    );
    if (!result.rowCount) throw Object.assign(new Error('seller_offer_not_found'), { statusCode: 404 });
    return result.rows[0];
  });
}

// Checkout reserves exact keys. Failed/expired/cancelled payment releases them via the order trigger.
// Retrying payment re-reserves the same lot at the order's original price, before any charge.
export async function reserveGroupKeys(client: PoolClient, groupId: string) {
  const orders = (
    await client.query(
      `SELECT o.id,o.assigned_offer_id FROM orders o
    WHERE o.group_id=$1 AND o.assigned_offer_id IS NOT NULL AND o.status NOT IN ('delivered','refunded')
    ORDER BY o.assigned_offer_id,o.id`,
      [groupId],
    )
  ).rows;
  for (const order of orders) {
    const offer = (
      await client.query(
        `SELECT f.id FROM seller_offers f JOIN supplier_configs s ON s.provider=f.provider
      WHERE f.id=$1 AND f.active AND s.banned_at IS NULL FOR SHARE OF f,s`,
        [order.assigned_offer_id],
      )
    ).rows[0];
    if (!offer) throw Object.assign(new Error('cart_offer_unavailable'), { statusCode: 409 });
    if (
      (await client.query('SELECT 1 FROM provider_inventory WHERE reserved_order_id=$1', [order.id])).rowCount
    )
      continue;
    const key = (
      await client.query(
        `SELECT code FROM provider_inventory WHERE offer_id=$1
      AND claimed_by IS NULL AND revoked_at IS NULL AND reserved_order_id IS NULL
      ORDER BY created_at,code FOR UPDATE SKIP LOCKED LIMIT 1`,
        [order.assigned_offer_id],
      )
    ).rows[0];
    if (!key) throw Object.assign(new Error('lot_insufficient_stock'), { statusCode: 409 });
    await client.query('UPDATE provider_inventory SET reserved_order_id=$2 WHERE code=$1', [
      key.code,
      order.id,
    ]);
  }
}
