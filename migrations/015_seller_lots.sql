-- Extend the existing offers rather than maintaining a second price source.
ALTER TABLE seller_offers ADD COLUMN id text NOT NULL DEFAULT ('lot_'||replace(gen_random_uuid()::text,'-',''));
ALTER TABLE seller_offers ADD COLUMN name text NOT NULL DEFAULT 'Основная партия' CHECK(length(name) BETWEEN 1 AND 80);
ALTER TABLE seller_offers ADD COLUMN is_default boolean NOT NULL DEFAULT true;
ALTER TABLE seller_offers DROP CONSTRAINT seller_offers_pkey;
ALTER TABLE seller_offers ADD PRIMARY KEY(id);
ALTER TABLE seller_offers ADD UNIQUE(id,sku,provider);
CREATE UNIQUE INDEX seller_default_offer ON seller_offers(sku,provider) WHERE is_default;

-- A private warehouse may have existed without an offer.
INSERT INTO seller_offers(sku,provider,price_minor,currency,active)
SELECT DISTINCT i.sku,i.provider,p.price_minor,p.currency,false
FROM provider_inventory i JOIN products p ON p.sku=i.sku
ON CONFLICT(sku,provider) WHERE is_default DO NOTHING;
ALTER TABLE provider_inventory ADD COLUMN offer_id text;
UPDATE provider_inventory i SET offer_id=f.id FROM seller_offers f
WHERE f.sku=i.sku AND f.provider=i.provider AND f.is_default;
ALTER TABLE provider_inventory ALTER COLUMN offer_id SET NOT NULL;
ALTER TABLE provider_inventory ADD FOREIGN KEY(offer_id,sku,provider) REFERENCES seller_offers(id,sku,provider);
CREATE FUNCTION assign_inventory_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.offer_id IS NULL THEN
    SELECT id INTO NEW.offer_id FROM seller_offers WHERE sku=NEW.sku AND provider=NEW.provider AND is_default;
    IF NEW.offer_id IS NULL THEN
      INSERT INTO seller_offers(sku,provider,price_minor,currency,active)
      SELECT NEW.sku,NEW.provider,p.price_minor,p.currency,false FROM products p WHERE p.sku=NEW.sku
      ON CONFLICT(sku,provider) WHERE is_default DO UPDATE SET sku=EXCLUDED.sku RETURNING id INTO NEW.offer_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_offer_default BEFORE INSERT ON provider_inventory FOR EACH ROW EXECUTE FUNCTION assign_inventory_offer();

ALTER TABLE cart_items ADD COLUMN offer_id text;
UPDATE cart_items c SET offer_id=f.id FROM seller_offers f WHERE f.sku=c.sku AND f.provider=c.provider AND f.is_default;
ALTER TABLE cart_items ALTER COLUMN offer_id SET NOT NULL;
ALTER TABLE cart_items DROP CONSTRAINT cart_items_pkey;
ALTER TABLE cart_items ADD PRIMARY KEY(user_id,offer_id);
ALTER TABLE cart_items ADD FOREIGN KEY(offer_id,sku,provider) REFERENCES seller_offers(id,sku,provider);

-- Old orders retain their original facts. New orders snapshot the chosen lot.
ALTER TABLE orders ADD COLUMN assigned_offer_id text;
ALTER TABLE orders ADD COLUMN offer_name text;
ALTER TABLE orders ADD FOREIGN KEY(assigned_offer_id,sku,assigned_provider) REFERENCES seller_offers(id,sku,provider);
ALTER TABLE orders ADD UNIQUE(id,assigned_offer_id);
ALTER TABLE provider_inventory ADD COLUMN reserved_order_id text UNIQUE;
ALTER TABLE provider_inventory ADD FOREIGN KEY(reserved_order_id,offer_id) REFERENCES orders(id,assigned_offer_id);
ALTER TABLE provider_inventory ADD CHECK(reserved_order_id IS NULL OR (claimed_by IS NULL AND revoked_at IS NULL));
CREATE INDEX inventory_lot_available ON provider_inventory(offer_id,created_at,code)
WHERE claimed_by IS NULL AND revoked_at IS NULL AND reserved_order_id IS NULL;
CREATE INDEX orders_offer ON orders(assigned_offer_id,created_at);

-- Attach only still-open buyer orders to their original default offer at migration time.
-- capture_order_history appends this change; completed orders and past snapshots stay intact.
UPDATE orders o SET assigned_offer_id=f.id,offer_name=f.name
FROM seller_offers f WHERE o.user_id IS NOT NULL AND o.group_id IS NOT NULL
  AND o.assigned_provider=f.provider AND o.sku=f.sku AND f.is_default
  AND o.status NOT IN ('delivered','refunded') AND o.assigned_offer_id IS NULL;
DO $$ DECLARE r record; available_code text;
BEGIN
  FOR r IN SELECT id,assigned_offer_id FROM orders o WHERE o.user_id IS NOT NULL
    AND o.assigned_offer_id IS NOT NULL AND o.payment_state IN ('pending','paid')
    AND o.status NOT IN ('delivered','refunded')
    AND NOT EXISTS(SELECT 1 FROM provider_issuances p WHERE p.order_id=o.id)
    ORDER BY o.created_at,o.id
  LOOP
    SELECT code INTO available_code FROM provider_inventory WHERE offer_id=r.assigned_offer_id
      AND reserved_order_id IS NULL AND claimed_by IS NULL AND revoked_at IS NULL ORDER BY created_at,code LIMIT 1 FOR UPDATE;
    IF available_code IS NOT NULL THEN UPDATE provider_inventory SET reserved_order_id=r.id WHERE code=available_code; END IF;
  END LOOP;
END $$;

CREATE FUNCTION protect_lot_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.sku,NEW.provider,NEW.is_default) IS DISTINCT FROM (OLD.id,OLD.sku,OLD.provider,OLD.is_default) THEN
    RAISE EXCEPTION 'lot_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_lot_identity BEFORE UPDATE ON seller_offers FOR EACH ROW EXECUTE FUNCTION protect_lot_identity();
CREATE FUNCTION protect_order_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.assigned_offer_id,NEW.offer_name) IS DISTINCT FROM (OLD.assigned_offer_id,OLD.offer_name) THEN
    RAISE EXCEPTION 'order_lot_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_lot BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_lot();
CREATE OR REPLACE FUNCTION protect_claimed_inventory_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.claimed_by IS NOT NULL OR OLD.revoked_at IS NOT NULL OR OLD.reserved_order_id IS NOT NULL THEN
    IF NEW.unit_cost_minor IS DISTINCT FROM OLD.unit_cost_minor THEN RAISE EXCEPTION 'claimed_inventory_cost_immutable'; END IF;
    IF NEW.offer_id IS DISTINCT FROM OLD.offer_id THEN RAISE EXCEPTION 'reserved_inventory_lot_immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION release_order_key_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_state='failed' OR NEW.status IN ('refunded','delivered') THEN
    UPDATE provider_inventory SET reserved_order_id=NULL WHERE reserved_order_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_order_key AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION release_order_key_reservation();
CREATE FUNCTION verify_delivery_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM orders o JOIN provider_inventory i ON i.code=NEW.code
    WHERE o.id=NEW.order_id AND o.assigned_offer_id IS NOT NULL AND o.assigned_offer_id<>i.offer_id) THEN
    RAISE EXCEPTION 'delivery_lot_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verified_delivery_lot BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION verify_delivery_lot();

CREATE TABLE seller_lot_operations (
  provider text NOT NULL REFERENCES supplier_configs(provider), request_id text NOT NULL,
  payload jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(provider,request_id)
);
CREATE TRIGGER immutable_lot_operations BEFORE UPDATE OR DELETE ON seller_lot_operations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
DROP VIEW seller_order_financials;
CREATE VIEW seller_order_financials AS
SELECT o.*,COALESCE(d.provider,o.assigned_provider) AS seller_provider,
  CASE WHEN o.payment_state='paid' THEN o.amount ELSE 0 END AS paid_amount,
  COALESCE(r.amount,0) AS refunded_amount,
  COALESCE(m.net_income,0) AS net_income,
  CASE WHEN d.order_id IS NULL THEN 0 ELSE d.unit_cost_minor END AS cost_amount,
  COALESCE(m.net_income,0) - CASE WHEN d.order_id IS NULL THEN 0 ELSE d.unit_cost_minor END AS profit,
  (d.order_id IS NOT NULL AND d.unit_cost_minor IS NULL) AS cost_unknown,
  (d.order_id IS NOT NULL) AS was_delivered,
  0::bigint AS commission_amount
FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id
LEFT JOIN refunds r ON r.order_id=o.id
LEFT JOIN LATERAL (
  SELECT -sum(e.amount) AS net_income FROM ledger_transactions t
  JOIN ledger_entries e ON e.transaction_id=t.id
  WHERE t.order_id=o.id AND e.account='sales'
) m ON true;
