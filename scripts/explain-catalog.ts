import { closePool, getPool } from '../src/db.js';

const result = await getPool().query(
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
   WITH selected_products AS (
     SELECT sku, name, price_minor FROM products
     WHERE active = true ORDER BY sku LIMIT 50
   )
   SELECT p.sku, p.name, p.price_minor, COALESCE(s.available, 0)
   FROM selected_products p
   LEFT JOIN LATERAL (
     SELECT count(*)::integer AS available FROM provider_inventory i
     WHERE i.sku = p.sku AND i.claimed_by IS NULL
   ) s ON true ORDER BY p.sku`,
);
console.log(result.rows.map((row) => row['QUERY PLAN']).join('\n'));
await closePool();
