import { getPool } from '../db.js';

export interface CatalogQuery {
  limit: number;
  offset: number;
  type?: string;
  search?: string;
}

export async function listCatalog(query: CatalogQuery): Promise<{ items: unknown[]; limit: number; offset: number }> {
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
       SELECT p.sku, p.name, p.type, p.price_minor, p.currency, p.image_path, p.description, p.features
       FROM products p
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.sku LIMIT $${params.length - 1} OFFSET $${params.length}
     )
     SELECT p.sku, p.name, p.type, p.price_minor::bigint AS price, p.currency,
       p.image_path AS image, p.description, p.features,
       COALESCE(s.available, 0)::integer AS available
     FROM selected_products p
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS available FROM provider_inventory i
       WHERE i.sku = p.sku AND i.claimed_by IS NULL
     ) s ON true
     ORDER BY p.sku`,
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
                 WHERE i.sku = p.sku AND i.claimed_by IS NULL), 0) AS available
     FROM products p WHERE p.sku = $1 AND p.active = true`,
    [sku],
  );
  const row = result.rows[0];
  return row ? { ...row, price: Number(row.price), available: Number(row.available) } : undefined;
}
