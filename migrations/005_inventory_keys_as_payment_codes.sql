ALTER TABLE payment_codes
  ADD COLUMN IF NOT EXISTS source_sku text REFERENCES products(sku);

-- A key added for a concrete product is also accepted in the cart. Its payment
-- nominal equals the current product price. Existing explicit payment codes keep
-- their configured nominal; only their product source is filled when known.
INSERT INTO payment_codes (code, value_points, source_sku)
SELECT i.code, p.price_minor, i.sku
FROM provider_inventory i
JOIN products p ON p.sku = i.sku
ON CONFLICT (code) DO UPDATE
SET source_sku = COALESCE(payment_codes.source_sku, EXCLUDED.source_sku);

CREATE INDEX IF NOT EXISTS idx_payment_codes_source_sku
  ON payment_codes (source_sku, created_at DESC);
