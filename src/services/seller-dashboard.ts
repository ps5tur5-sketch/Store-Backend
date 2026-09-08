import { getPool, transaction } from '../db.js';
import { sellerReport } from './sellers.js';

export async function sellerInventory(provider: string, page: number, search: string, status: string) {
  const result = await getPool().query(
    `WITH keys AS MATERIALIZED (
      SELECT i.code,i.sku,p.name,p.image_path AS image,i.offer_id,f.name AS offer_name,
        f.price_minor::float AS price,f.active,i.unit_cost_minor::float AS unit_cost,i.created_at,
        (i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) AS can_edit_price,
        CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.claimed_by IS NOT NULL THEN 'issued'
          WHEN i.reserved_order_id IS NOT NULL THEN 'reserved' ELSE 'available' END AS status,
        CASE WHEN i.revoked_at IS NOT NULL THEN 'Отозван' WHEN i.claimed_by IS NOT NULL THEN 'Продан'
          WHEN i.reserved_order_id IS NOT NULL THEN 'В резерве заказа' WHEN s.banned_at IS NOT NULL THEN 'Магазин заблокирован'
          WHEN NOT p.active THEN 'Товар скрыт' WHEN NOT f.active THEN 'Снят с продажи' ELSE 'В продаже' END AS listing_label
      FROM provider_inventory i JOIN seller_offers f ON f.id=i.offer_id JOIN products p ON p.sku=i.sku
      JOIN supplier_configs s ON s.provider=i.provider WHERE i.provider=$1
        AND ($2='' OR strpos(lower(i.code || ' ' || p.name || ' ' || i.sku),lower($2))>0)
    ), filtered AS (SELECT * FROM keys WHERE $3='all' OR status=$3)
    SELECT (SELECT count(*)::int FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(x ORDER BY x.created_at DESC,x.code) FROM (
        SELECT * FROM filtered ORDER BY created_at DESC,code LIMIT 50 OFFSET $4
      ) x),'[]') AS items`,
    [provider, search, status, (page - 1) * 50],
  );
  const data = result.rows[0];
  return {
    items: data.items,
    pagination: { page, page_size: 50, total: data.total, pages: Math.ceil(data.total / 50) },
  };
}

export async function updateOffer(sku: string, provider: string, price: number, active: boolean) {
  const result = await getPool().query(
    `INSERT INTO seller_offers(sku,provider,price_minor,currency,active)
  SELECT p.sku,s.provider,$3,p.currency,$4 FROM products p CROSS JOIN supplier_configs s WHERE p.sku=$1 AND s.provider=$2
  ON CONFLICT(sku,provider) WHERE is_default DO UPDATE SET price_minor=EXCLUDED.price_minor,active=EXCLUDED.active,updated_at=clock_timestamp() RETURNING *`,
    [sku, provider, price, active],
  );
  if (!result.rowCount) throw Object.assign(new Error('seller_offer_not_found'), { statusCode: 404 });
  return result.rows[0];
}
export async function updateInventoryCost(provider: string, code: string, unitCost: number | null) {
  return transaction(async (client) => {
    const key = (
      await client.query(
        'SELECT claimed_by,revoked_at,reserved_order_id FROM provider_inventory WHERE provider=$1 AND code=$2 FOR UPDATE',
        [provider, code],
      )
    ).rows[0];
    if (!key) throw Object.assign(new Error('inventory_key_not_found'), { statusCode: 404 });
    if (key.claimed_by || key.revoked_at || key.reserved_order_id)
      throw Object.assign(new Error('inventory_cost_locked'), { statusCode: 409 });
    await client.query('UPDATE provider_inventory SET unit_cost_minor=$3 WHERE provider=$1 AND code=$2', [
      provider,
      code,
      unitCost,
    ]);
    return { code, unit_cost: unitCost };
  });
}

export async function sellerDashboard(provider: string, page = 1) {
  const [seller, result] = await Promise.all([
    sellerReport(provider),
    getPool().query(
      `WITH sales AS MATERIALIZED (
      SELECT s.*,COALESCE(s.assigned_offer_id,f.id) AS report_offer_id FROM seller_order_financials s
      LEFT JOIN seller_offers f ON f.sku=s.sku AND f.provider=s.seller_provider AND f.is_default
      WHERE seller_provider=$1
    ), stock AS (
      SELECT offer_id,count(*)::int AS total,
        count(*) FILTER(WHERE claimed_by IS NULL AND revoked_at IS NULL AND reserved_order_id IS NULL)::int AS available,
        count(*) FILTER(WHERE reserved_order_id IS NOT NULL)::int AS reserved,
        count(*) FILTER(WHERE claimed_by IS NOT NULL AND revoked_at IS NULL)::int AS issued,
        count(*) FILTER(WHERE revoked_at IS NOT NULL)::int AS revoked
      FROM provider_inventory WHERE provider=$1 GROUP BY offer_id
    ), product_sales AS (
      SELECT report_offer_id,count(*) FILTER(WHERE was_delivered)::int AS sold,
        count(*) FILTER(WHERE status='refunded')::int AS refunds,
        COALESCE(sum(net_income),0)::float AS net_income,
        CASE WHEN bool_or(cost_unknown) THEN NULL ELSE COALESCE(sum(profit),0)::float END AS profit
      FROM sales GROUP BY report_offer_id
    ), offers AS (
      SELECT p.sku,p.name,p.image_path AS image,p.currency,f.id AS offer_id,f.name AS offer_name,COALESCE(f.is_default,true) AS is_default,
        COALESCE(f.price_minor,p.price_minor)::float AS price,COALESCE(f.active,false) AS active,
        (f.sku IS NOT NULL OR COALESCE(i.total,0)>0) AS is_mine,
        COALESCE(i.available,0) AS available,COALESCE(i.reserved,0) AS reserved,COALESCE(i.issued,0) AS issued,
        COALESCE(i.revoked,0) AS revoked,COALESCE(i.total,0) AS total,
        COALESCE(ps.sold,0) AS sold,COALESCE(ps.refunds,0) AS refunds,
        COALESCE(ps.net_income,0) AS net_income,CASE WHEN ps.report_offer_id IS NULL THEN 0 ELSE ps.profit END AS profit,
        CASE WHEN s.banned_at IS NOT NULL THEN 'blocked' WHEN NOT p.active THEN 'product_hidden'
          WHEN NOT COALESCE(f.active,false) THEN 'paused'
          WHEN COALESCE(i.available,0)=0 THEN 'out_of_stock' ELSE 'selling' END AS listing_status
      FROM products p CROSS JOIN supplier_configs s
      LEFT JOIN seller_offers f ON f.sku=p.sku AND f.provider=$1
      LEFT JOIN stock i ON i.offer_id=f.id LEFT JOIN product_sales ps ON ps.report_offer_id=f.id WHERE s.provider=$1
    ), summary AS (
      SELECT count(*)::int AS orders,count(*) FILTER(WHERE payment_state='paid')::int AS paid_orders,
        count(*) FILTER(WHERE status='refunded')::int AS refunds,
        COALESCE(sum(paid_amount),0)::float AS paid,
        COALESCE(sum(refunded_amount),0)::float AS refunded,
        COALESCE(sum(net_income),0)::float AS sales,
        COALESCE(sum(net_income),0)::float AS net_income,
        COALESCE(sum(paid_amount-net_income-refunded_amount),0)::float AS pending,
        COALESCE(sum(cost_amount),0)::float AS known_cost,
        count(*) FILTER(WHERE cost_unknown)::int AS unknown_cost_count,
        CASE WHEN bool_or(cost_unknown) THEN NULL ELSE COALESCE(sum(profit),0)::float END AS profit,
        0 AS commission
      FROM sales
    )
    SELECT (SELECT to_jsonb(summary) FROM summary) AS summary,
      COALESCE((SELECT jsonb_agg(offers ORDER BY is_mine DESC, (listing_status='selling') DESC,name) FROM offers),'[]') AS offers,
      COALESCE((SELECT jsonb_agg(x ORDER BY x.created_at DESC,x.id DESC) FROM (
        SELECT o.id,o.group_id,o.sku,o.assigned_offer_id,o.offer_name,p.name,o.amount::float AS amount,o.currency,o.status,o.refund_requested,
          o.payment_state,o.created_at,u.username AS buyer,o.paid_amount::float AS paid_amount,
          o.refunded_amount::float AS refunded_amount,o.net_income::float AS net_income,
          o.cost_amount::float AS cost_amount,o.profit::float AS profit,o.commission_amount::float AS commission_amount,
          (o.user_id IS NOT NULL AND o.payment_state='paid' AND o.status<>'refunded') AS can_chat,
          (SELECT count(*)::int FROM order_messages m WHERE m.order_id=o.id) AS message_count
        FROM sales o JOIN products p ON p.sku=o.sku LEFT JOIN users u ON u.id=o.user_id
        ORDER BY o.created_at DESC,o.id DESC LIMIT 50 OFFSET $2
      ) x),'[]') AS orders,
      COALESCE((SELECT jsonb_agg(x ORDER BY x.created_at DESC,x.code) FROM (
        SELECT i.code,i.sku,p.name,i.offer_id,f.name AS offer_name,f.price_minor::float AS price,f.active,
          (i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) AS can_edit_price,
          i.reserved_order_id,i.claimed_by,i.claimed_at,i.revoked_at,i.created_at,
          i.unit_cost_minor::float AS unit_cost,(i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) AS can_edit_cost,
          CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.claimed_by IS NOT NULL THEN 'issued' WHEN i.reserved_order_id IS NOT NULL THEN 'reserved' ELSE 'available' END AS status
        FROM provider_inventory i JOIN products p ON p.sku=i.sku JOIN seller_offers f ON f.id=i.offer_id WHERE i.provider=$1
        ORDER BY i.created_at DESC,i.code LIMIT 500
      ) x),'[]') AS inventory`,
      [provider, (page - 1) * 50],
    ),
  ]);
  const data = result.rows[0];
  const labels: Record<string, string> = {
    selling: 'В продаже',
    paused: 'Снято с продажи',
    out_of_stock: 'Ключи закончились',
    blocked: 'Магазин заблокирован',
    product_hidden: 'Товар скрыт администрацией',
  };
  const offers = data.offers.map((offer: Record<string, any>) => ({
    ...offer,
    listing_label: labels[offer.listing_status],
  }));
  return {
    seller,
    ...data,
    offers,
    products_summary: {
      total: new Set(
        offers.filter((o: Record<string, any>) => o.is_mine).map((o: Record<string, any>) => o.sku),
      ).size,
      lots: offers.filter((o: Record<string, any>) => o.is_mine).length,
      selling: new Set(
        offers
          .filter((o: Record<string, any>) => o.listing_status === 'selling')
          .map((o: Record<string, any>) => o.sku),
      ).size,
      reserved: offers.reduce((sum: number, o: Record<string, any>) => sum + o.reserved, 0),
      available: offers.reduce((sum: number, o: Record<string, any>) => sum + o.available, 0),
    },
    pagination: {
      page,
      page_size: 50,
      total: data.summary.orders,
      pages: Math.ceil(data.summary.orders / 50),
    },
    accounting_note:
      'Доход — выданные продажи за вычетом возвратов. Комиссия площадки — 0 ₽. Прибыль — доход минус закупочная стоимость выданных ключей; отозванный ключ остаётся расходом. Налоги и другие расходы продавца не учитываются. Это отчёт о продажах, а не выписка о выводе средств.',
  };
}
