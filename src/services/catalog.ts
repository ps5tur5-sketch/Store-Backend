import { productOffers } from './sellers.js';
import { getPool } from '../db.js';

export interface CatalogQuery {
  limit: number;
  offset: number;
  type?: string;
  search?: string;
  sort?: 'default' | 'price_asc' | 'price_desc';
}

export async function listCatalog(
  query: CatalogQuery,
): Promise<{ items: unknown[]; limit: number; offset: number }> {
  const orderBy =
    query.sort === 'price_asc'
      ? 'p.price_minor ASC, p.sku'
      : query.sort === 'price_desc'
        ? 'p.price_minor DESC, p.sku'
        : 'p.sku';
  const params: unknown[] = [];
  const conditions = ['p.active = true'];
  if (query.type) {
    params.push(query.type);
    conditions.push(`p.type = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  params.push(query.limit, query.offset);
  const result = await getPool().query(
    `WITH selected_products AS (
       SELECT p.sku, p.name, p.type, COALESCE((SELECT f.price_minor FROM seller_offers f JOIN supplier_configs sc ON sc.provider=f.provider WHERE f.sku=p.sku AND f.active AND sc.banned_at IS NULL ORDER BY EXISTS(SELECT 1 FROM provider_inventory i WHERE i.offer_id=f.id AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL) DESC,f.price_minor,f.id LIMIT 1),p.price_minor) AS price_minor, p.currency, p.image_path, p.description, p.features
       FROM products p
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy.replaceAll('p.price_minor', 'price_minor')} LIMIT $${params.length - 1} OFFSET $${params.length}
     )
     SELECT p.sku, p.name, p.type, p.price_minor::bigint AS price, p.currency,
       p.image_path AS image, p.description, p.features,
       (SELECT count(DISTINCT f.provider)::int FROM seller_offers f JOIN supplier_configs sc ON sc.provider=f.provider WHERE f.sku=p.sku AND f.active AND sc.banned_at IS NULL) AS seller_count,
       COALESCE(s.available, 0)::integer AS available
     FROM selected_products p
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS available FROM provider_inventory i
       WHERE i.sku = p.sku AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL AND EXISTS(SELECT 1 FROM seller_offers f JOIN supplier_configs sc ON sc.provider=f.provider WHERE f.id=i.offer_id AND f.active AND sc.banned_at IS NULL)
     ) s ON true
     ORDER BY ${orderBy}`,
    params,
  );
  return {
    items: result.rows.map((row) => ({ ...row, price: Number(row.price), available: Number(row.available) })),
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getCatalogItem(sku: string): Promise<Record<string, unknown> | undefined> {
  const result = await getPool().query(
    `SELECT p.sku, p.name, p.type, p.price_minor::bigint AS price, p.currency,
       p.image_path AS image, p.description, p.features,
       COALESCE((SELECT count(*)::integer FROM provider_inventory i
                 WHERE i.sku = p.sku AND i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL AND EXISTS(SELECT 1 FROM seller_offers f JOIN supplier_configs sc ON sc.provider=f.provider WHERE f.id=i.offer_id AND f.active AND sc.banned_at IS NULL)), 0) AS available
     FROM products p WHERE p.sku = $1 AND p.active = true`,
    [sku],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const offers = await productOffers(sku);
  return {
    ...row,
    default_offer_id: (offers.find((o) => o.available > 0) ?? offers[0])?.offer_id ?? null,
    default_provider: (offers.find((o) => o.available > 0) ?? offers[0])?.provider ?? null,
    price: (offers.find((o) => o.available > 0) ?? offers[0])?.price ?? Number(row.price),
    available: offers.reduce((sum, offer) => sum + offer.available, 0),
    offers,
    seller_count: new Set(offers.map((o) => o.provider)).size,
  };
}
