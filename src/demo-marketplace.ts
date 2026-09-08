import { getPool, transaction } from './db.js';
import { registerUser } from './services/accounts.js';
import { loadConfig } from './config.js';
// Stable codes make restarts additive: a claimed key is never replenished or reassigned.
export async function seedDemoMarketplace() {
  await transaction(async (client) => {
    await client.query(`INSERT INTO supplier_configs(provider,display_name,mode,demo_scenario) VALUES
 ('DEMO_NOVA','Nova Games','normal',NULL),('DEMO_PLAY','Play Hub','normal',NULL),
 ('DEMO_CHECK','Демо · проверка ключей','wrong_code','key_check'),('DEMO_REFUND','Демо · возврат','out_of_stock','refund')
ON CONFLICT(provider) DO NOTHING;
INSERT INTO seller_offers(sku,provider,price_minor,currency)
SELECT p.sku,s.provider,greatest(1,round(p.price_minor*CASE s.provider WHEN 'DEMO_NOVA' THEN 0.98 WHEN 'DEMO_PLAY' THEN 1.03 WHEN 'DEMO_CHECK' THEN 1.12 ELSE 1.18 END)),p.currency
FROM products p CROSS JOIN supplier_configs s WHERE s.provider IN ('DEMO_NOVA','DEMO_PLAY','DEMO_CHECK','DEMO_REFUND')
ON CONFLICT(sku,provider) WHERE is_default DO NOTHING;
INSERT INTO provider_inventory(code,provider,sku)
SELECT 'DEMO-STOCK-V2-'||replace(s.provider,'_','-')||'-'||p.sku||'-'||lpad(n::text,4,'0'),s.provider,p.sku
FROM products p CROSS JOIN supplier_configs s CROSS JOIN generate_series(1,100) n
WHERE s.provider IN ('A','B','DEMO_NOVA','DEMO_PLAY','DEMO_CHECK','DEMO_REFUND') ON CONFLICT(code) DO NOTHING;
`);
  });
  for (const [username, provider] of [
    ['seller_nova', 'DEMO_NOVA'],
    ['seller_play', 'DEMO_PLAY'],
    ['seller_check', 'DEMO_CHECK'],
    ['seller_refund', 'DEMO_REFUND'],
  ]) {
    if (!(await getPool().query('SELECT 1 FROM users WHERE username_normalized=$1', [username])).rowCount) {
      try {
        await registerUser(username!, loadConfig().SELLER_PASSWORD, 'seller', provider);
      } catch (error) {
        if ((error as Error).message !== 'username_already_exists') throw error;
      }
    }
  }
}
