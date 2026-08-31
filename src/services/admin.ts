import { getPool, transaction } from '../db.js';
import type { Provider } from '../types.js';

export async function addInventory(provider: Provider, sku: string, codes: string[]): Promise<{
  inserted: string[];
  duplicates: string[];
  payment_codes_inserted: string[];
  payment_code_value_points: number;
}> {
  return transaction(async (client) => {
    const product = await client.query<{ price_minor: string }>('SELECT price_minor FROM products WHERE sku = $1', [sku]);
    const productRow = product.rows[0];
    if (!productRow) throw Object.assign(new Error(`Unknown SKU: ${sku}`), { statusCode: 404 });
    const inserted: string[] = [];
    const duplicates: string[] = [];
    const normalizedCodes = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
    for (const code of normalizedCodes) {
      const result = await client.query<{ code: string }>(
        `INSERT INTO provider_inventory (code, provider, sku) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING RETURNING code`,
        [code, provider, sku],
      );
      if (result.rows[0]) inserted.push(result.rows[0].code);
      else duplicates.push(code);
    }

    const paymentCodes = await client.query<{ code: string }>(
      `INSERT INTO payment_codes (code, value_points, source_sku)
       SELECT i.code, p.price_minor, i.sku
       FROM provider_inventory i JOIN products p ON p.sku = i.sku
       WHERE i.code = ANY($1::text[])
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [normalizedCodes],
    );
    await client.query(
      `UPDATE payment_codes pc SET source_sku = i.sku
       FROM provider_inventory i
       WHERE pc.code = i.code AND pc.source_sku IS NULL AND i.code = ANY($1::text[])`,
      [normalizedCodes],
    );

    return {
      inserted,
      duplicates,
      payment_codes_inserted: paymentCodes.rows.map((row) => row.code),
      payment_code_value_points: Number(productRow.price_minor),
    };
  });
}

export async function inventoryReport(sku?: string): Promise<Record<string, unknown>> {
  const params = sku ? [sku] : [];
  const where = sku ? 'WHERE i.sku = $1' : '';
  const [summary, keys] = await Promise.all([
    getPool().query(
      `SELECT i.sku, p.name, i.provider,
         count(*) FILTER (WHERE i.claimed_by IS NULL)::integer AS available,
         count(*) FILTER (WHERE i.claimed_by IS NOT NULL)::integer AS issued,
         count(*)::integer AS total
       FROM provider_inventory i JOIN products p ON p.sku = i.sku ${where}
       GROUP BY i.sku, p.name, i.provider ORDER BY i.sku, i.provider`,
      params,
    ),
    getPool().query(
      `SELECT code, provider, sku, claimed_by, claimed_at FROM provider_inventory i ${where}
       ORDER BY sku, provider, created_at, code`,
      params,
    ),
  ]);
  return { summary: summary.rows, keys: keys.rows };
}
