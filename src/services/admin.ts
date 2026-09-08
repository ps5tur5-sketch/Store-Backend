import { getPool, transaction } from '../db.js';
import type { Provider } from '../types.js';

export async function addInventory(
  provider: Provider,
  sku: string,
  codes: string[],
  createPaymentCodes = true,
  unitCost: number | null = null,
  offerId?: string,
): Promise<{
  inserted: string[];
  duplicates: string[];
  payment_codes_inserted: string[];
  payment_code_value_points: number;
}> {
  return transaction(async (client) => {
    const product = await client.query<{ price_minor: string }>(
      'SELECT price_minor FROM products WHERE sku = $1',
      [sku],
    );
    const productRow = product.rows[0];
    if (!productRow) throw Object.assign(new Error(`Unknown SKU: ${sku}`), { statusCode: 404 });
    if (
      offerId &&
      !(
        await client.query('SELECT 1 FROM seller_offers WHERE id=$1 AND provider=$2 AND sku=$3 FOR SHARE', [
          offerId,
          provider,
          sku,
        ])
      ).rowCount
    )
      throw Object.assign(new Error('seller_offer_not_found'), { statusCode: 404 });
    const inserted: string[] = [];
    const duplicates: string[] = [];
    const normalizedCodes = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
    for (const code of normalizedCodes) {
      const result = await client.query<{ code: string }>(
        `INSERT INTO provider_inventory (code, provider, sku, unit_cost_minor,offer_id) VALUES ($1, $2, $3, $4,$5)
         ON CONFLICT (code) DO NOTHING RETURNING code`,
        [code, provider, sku, unitCost, offerId ?? null],
      );
      if (result.rows[0]) inserted.push(result.rows[0].code);
      else duplicates.push(code);
    }

    const paymentCodes = createPaymentCodes
      ? await client.query<{ code: string }>(
          `INSERT INTO payment_codes (code, value_points, source_sku)
       SELECT i.code, p.price_minor, i.sku
       FROM provider_inventory i JOIN products p ON p.sku = i.sku
       WHERE i.code = ANY($1::text[])
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
          [normalizedCodes],
        )
      : { rows: [] as { code: string }[] };
    if (createPaymentCodes)
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
         count(*) FILTER (WHERE i.claimed_by IS NULL AND i.revoked_at IS NULL AND i.reserved_order_id IS NULL)::integer AS available,
         count(*) FILTER (WHERE i.reserved_order_id IS NOT NULL)::integer AS reserved,
         count(*) FILTER (WHERE i.claimed_by IS NOT NULL)::integer AS issued,
         count(*)::integer AS total
       FROM provider_inventory i JOIN products p ON p.sku = i.sku ${where}
       GROUP BY i.sku, p.name, i.provider ORDER BY i.sku, i.provider`,
      params,
    ),
    getPool().query(
      `SELECT i.code, i.provider, i.sku, i.claimed_by, i.claimed_at,i.offer_id,f.name AS offer_name,i.reserved_order_id,
       CASE WHEN i.revoked_at IS NOT NULL THEN 'Отозван' WHEN i.claimed_by IS NOT NULL THEN 'Выдан' WHEN i.reserved_order_id IS NOT NULL THEN 'В резерве' ELSE 'Доступен' END AS status_label FROM provider_inventory i JOIN seller_offers f ON f.id=i.offer_id ${where}
       ORDER BY i.sku, i.provider, i.created_at, i.code`,
      params,
    ),
  ]);
  return { summary: summary.rows, keys: keys.rows };
}
