import { registerUser } from './services/accounts.js';
import { loadConfig } from './config.js';
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
      [
        product.sku,
        product.name,
        product.type,
        product.price,
        product.currency,
        product.image,
        product.description,
        JSON.stringify(product.features),
      ],
    );
  }

  await db.query(
    `INSERT INTO supplier_configs (provider,display_name) VALUES ('A','Pixel Market'), ('B','Game Point')
     ON CONFLICT (provider) DO NOTHING`,
  );

  await db.query(`INSERT INTO seller_offers(provider,sku,price_minor,currency)
    SELECT s.provider,p.sku,CASE WHEN s.provider='B' AND p.sku='KEY-GTA5' THEN 1890
      WHEN s.provider='B' AND p.sku='KEY-EFT' THEN 3290 ELSE p.price_minor END,p.currency
    FROM supplier_configs s CROSS JOIN products p WHERE s.provider IN ('A','B') ON CONFLICT DO NOTHING`);

  const splitAt = Math.ceil(keys.length / 2);
  for (let index = 0; index < keys.length; index += 1) {
    const provider = index < splitAt ? 'A' : 'B';
    const providerIndex = index < splitAt ? index : index - splitAt;
    const product = products[providerIndex % products.length];
    if (!product) throw new Error('Catalog cannot be empty');
    await db.query(
      `INSERT INTO provider_inventory (code, provider, sku) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
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
  const config = loadConfig();
  for (const account of [
    { username: config.ADMIN_USERNAME, password: config.ADMIN_PASSWORD, role: 'admin' as const },
    { username: 'seller_a', password: config.SELLER_PASSWORD, role: 'seller' as const, seller: 'A' },
    { username: 'seller_b', password: config.SELLER_PASSWORD, role: 'seller' as const, seller: 'B' },
  ]) {
    const existing = await db.query('SELECT 1 FROM users WHERE username_normalized=$1', [
      account.username.toLowerCase(),
    ]);
    if (!existing.rowCount)
      await registerUser(
        account.username,
        account.password,
        account.role,
        'seller' in account ? account.seller : undefined,
      );
  }
}

export async function resetBusinessData(db: DbClient): Promise<void> {
  await db.query(`TRUNCATE seller_lot_operations,withdrawals,withdrawal_events,refund_wallet_transfers,payment_intent_events,payment_intents,business_operations,order_messages,refund_requests,delivery_revocations,supplier_incidents, seller_reviews, order_history, order_groups, refunds, supplier_requests, supplier_cancellations, auth_sessions, cart_items, point_transactions, checkouts,
    payment_codes, users, audit_events, deliveries, delivery_attempts, delivery_jobs,
    provider_issuances, provider_inventory, ledger_entries, ledger_transactions,
    payment_events, orders RESTART IDENTITY CASCADE`);
  await db.query(`DELETE FROM seller_offers WHERE NOT is_default OR provider NOT IN ('A','B')`);
  await db.query(`DELETE FROM supplier_configs WHERE provider NOT IN ('A','B')`);
  await db.query(
    `UPDATE seller_offers f SET price_minor=p.price_minor,active=true FROM products p WHERE p.sku=f.sku`,
  );
  await db.query(`UPDATE supplier_configs SET banned_at=NULL,ban_reason=NULL, requests_per_minute = 120, mode = 'normal', failure_rate = 0, timeout_rate = 0,
    min_delay_ms = 0, timeout_delay_ms = 1000, updated_at = now()`);
  await seedDatabase(db);
}
