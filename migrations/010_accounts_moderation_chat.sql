ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'buyer' CHECK(role IN ('buyer','seller','admin'));
ALTER TABLE users ADD COLUMN seller_id text REFERENCES supplier_configs(provider);
ALTER TABLE users ADD COLUMN banned_at timestamptz;
ALTER TABLE users ADD COLUMN ban_reason text;
ALTER TABLE users ADD CONSTRAINT seller_account_binding CHECK((role='seller' AND seller_id IS NOT NULL) OR (role<>'seller' AND seller_id IS NULL));
ALTER TABLE supplier_configs ADD COLUMN banned_at timestamptz;
ALTER TABLE supplier_configs ADD COLUMN ban_reason text;
ALTER TABLE provider_inventory ADD COLUMN revoked_at timestamptz;
ALTER TABLE orders ADD COLUMN refund_requested boolean NOT NULL DEFAULT false;
CREATE TABLE refund_requests (
  order_id text PRIMARY KEY REFERENCES orders(id),
  actor_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE delivery_revocations (
  order_id text PRIMARY KEY REFERENCES orders(id),
  code text NOT NULL UNIQUE REFERENCES provider_inventory(code),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK(kind IN
  ('payment_received','payment_reversed','delivery_settled','delivery_reversed','refund'));
CREATE TABLE order_messages (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  sender_id text NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_order_messages ON order_messages(order_id,created_at,id);
CREATE TRIGGER immutable_order_messages BEFORE UPDATE OR DELETE ON order_messages FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_refund_requests BEFORE UPDATE OR DELETE ON refund_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_delivery_revocations BEFORE UPDATE OR DELETE ON delivery_revocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE OR REPLACE FUNCTION verify_refund_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF o.payment_state<>'paid' OR NEW.amount<>o.amount OR NEW.currency<>o.currency
    OR (EXISTS(SELECT 1 FROM deliveries WHERE order_id=NEW.order_id)
      AND NOT EXISTS(SELECT 1 FROM delivery_revocations WHERE order_id=NEW.order_id)) THEN
    RAISE EXCEPTION 'refund_requires_paid_undelivered_or_revoked_order';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM delivery_jobs j JOIN supplier_cancellations c ON c.provider=j.provider AND c.request_id=j.request_id WHERE j.order_id=NEW.order_id)
    AND NOT EXISTS(SELECT 1 FROM delivery_revocations WHERE order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'refund_requires_confirmed_cancellation_or_revocation';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION capture_order_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO order_history(order_id,group_id,snapshot) VALUES(NEW.id,NEW.group_id,to_jsonb(NEW)||jsonb_build_object(
    'name',(SELECT name FROM products WHERE sku=NEW.sku),'type',(SELECT type FROM products WHERE sku=NEW.sku),
    'image',(SELECT image_path FROM products WHERE sku=NEW.sku),
    'seller_name',(SELECT display_name FROM supplier_configs WHERE provider=NEW.assigned_provider),
    'code',(SELECT code FROM deliveries WHERE order_id=NEW.id AND NOT EXISTS(SELECT 1 FROM delivery_revocations WHERE order_id=NEW.id)),
    'provider',(SELECT provider FROM deliveries WHERE order_id=NEW.id)));
  RETURN NEW;
END $$;
