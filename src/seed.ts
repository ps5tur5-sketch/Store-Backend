import type { DbClient } from './db.js';
import { keys, products } from './data/catalog.js';

export async function seedDatabase(db: DbClient): Promise<void> {
  for (const product of products) {
    await db.query(
      `INSERT INTO products (sku, name, type, price_minor, currency, image_path, description, features)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name, type = EXCLUDED.type, price_minor = EXCLUDED.price_minor,
         currency = EXCLUDED.currency, image_path = EXCLUDED.image_path,
         description = EXCLUDED.description, features = EXCLUDED.features, updated_at = now()`,
      [product.sku, product.name, product.type, product.price, product.currency, product.image, product.description, JSON.stringify(product.features)],
    );
  }

  await db.query(
    `INSERT INTO supplier_configs (provider) VALUES ('A'), ('B')
     ON CONFLICT (provider) DO NOTHING`,
  );

  const splitAt = Math.ceil(keys.length / 2);
  for (let index = 0; index < keys.length; index += 1) {
    const provider = index < splitAt ? 'A' : 'B';
    const providerIndex = index < splitAt ? index : index - splitAt;
    const product = products[providerIndex % products.length];
    if (!product) throw new Error('Catalog cannot be empty');
    await db.query(
      `INSERT INTO provider_inventory (code, provider, sku) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET provider = EXCLUDED.provider, sku = EXCLUDED.sku`,
      [keys[index], provider, product.sku],
    );
  }

  // The storefront accepts the concrete codes supplied in the assignment.
  // Payment-code usage and inventory-code usage are tracked separately:
  // entering a payment code never reserves the product key delivered later.
  await db.query(`DELETE FROM payment_codes WHERE code LIKE 'DEMO-CART-%' AND used_by IS NULL`);
  for (const code of keys) {
    const index = keys.indexOf(code);
    const providerIndex = index < splitAt ? index : index - splitAt;
    const product = products[providerIndex % products.length];
    if (!product) throw new Error('Catalog cannot be empty');
    await db.query(
      `INSERT INTO payment_codes (code, value_points, source_sku) VALUES ($1, 5000, $2)
       ON CONFLICT (code) DO UPDATE SET
         value_points = EXCLUDED.value_points,
         source_sku = EXCLUDED.source_sku
       WHERE payment_codes.used_by IS NULL`,
      [code, product.sku],
    );
  }
}

export async function resetBusinessData(db: DbClient): Promise<void> {
  await db.query(`TRUNCATE auth_sessions, cart_items, point_transactions, checkouts,
    payment_codes, users, audit_events, deliveries, delivery_attempts, delivery_jobs,
    provider_issuances, provider_inventory, ledger_entries, ledger_transactions,
    payment_events, orders RESTART IDENTITY CASCADE`);
  await db.query(`UPDATE supplier_configs SET mode = 'normal', failure_rate = 0, timeout_rate = 0,
    min_delay_ms = 0, timeout_delay_ms = 1000, updated_at = now()`);
  await seedDatabase(db);
}
