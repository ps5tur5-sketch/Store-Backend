ALTER TABLE supplier_configs ADD COLUMN display_name text NOT NULL DEFAULT 'Продавец';
UPDATE supplier_configs SET display_name=CASE provider WHEN 'A' THEN 'Pixel Market' ELSE 'Game Point' END;
CREATE TABLE seller_offers (
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  sku text NOT NULL REFERENCES products(sku),
  price_minor bigint NOT NULL CHECK(price_minor>0 AND price_minor<=10000000),
  currency char(3) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(sku,provider)
);
INSERT INTO seller_offers(provider,sku,price_minor,currency)
SELECT s.provider,p.sku,p.price_minor,p.currency FROM supplier_configs s CROSS JOIN products p;
UPDATE seller_offers SET price_minor=1890 WHERE provider='B' AND sku='KEY-GTA5';
UPDATE seller_offers SET price_minor=3290 WHERE provider='B' AND sku='KEY-EFT';
ALTER TABLE cart_items ADD COLUMN provider char(1) NOT NULL DEFAULT 'A' REFERENCES supplier_configs(provider);
ALTER TABLE cart_items DROP CONSTRAINT cart_items_pkey;
ALTER TABLE cart_items ADD PRIMARY KEY(user_id,sku,provider);
CREATE TABLE seller_reviews (
  order_id text PRIMARY KEY REFERENCES orders(id),
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  user_id text NOT NULL REFERENCES users(id),
  rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '' CHECK(length(comment)<=1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_seller_reviews_provider ON seller_reviews(provider,created_at DESC);
CREATE TABLE supplier_incidents (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  order_id text NOT NULL REFERENCES orders(id),
  request_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('duplicate_code','wrong_code','error_after_issue')),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_supplier_incidents_provider ON supplier_incidents(provider,created_at DESC);
CREATE TRIGGER immutable_seller_reviews BEFORE UPDATE OR DELETE ON seller_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_supplier_incidents BEFORE UPDATE OR DELETE ON supplier_incidents FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
