-- Extend the first-stage unit orders; existing rows and endpoints remain usable.
CREATE TABLE order_groups (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  request_fingerprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE orders ADD COLUMN group_id text REFERENCES order_groups(id);
ALTER TABLE orders ADD COLUMN assigned_provider char(1) REFERENCES supplier_configs(provider);
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('created','paid','delivering','delivered','payment_failed','out_of_stock','delivery_failed','refunded'));
CREATE INDEX idx_orders_group ON orders(group_id) WHERE group_id IS NOT NULL;
ALTER TABLE checkouts ADD COLUMN group_id text REFERENCES order_groups(id);
ALTER TABLE delivery_jobs ADD COLUMN provider char(1) NOT NULL DEFAULT 'A' REFERENCES supplier_configs(provider);
ALTER TABLE delivery_jobs ADD COLUMN issue_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE delivery_jobs ADD COLUMN generation integer NOT NULL DEFAULT 1;
ALTER TABLE delivery_jobs ADD COLUMN phase text NOT NULL DEFAULT 'issue' CHECK (phase IN ('issue','resolve'));
ALTER TABLE supplier_configs DROP CONSTRAINT supplier_configs_mode_check;
ALTER TABLE supplier_configs ADD CONSTRAINT supplier_configs_mode_check CHECK (mode IN
  ('normal','always_fail','out_of_stock','timeout_before_issue','timeout_after_issue',
   'duplicate_code','wrong_code','error_after_issue'));
ALTER TABLE supplier_configs ADD COLUMN requests_per_minute integer NOT NULL DEFAULT 120 CHECK (requests_per_minute BETWEEN 1 AND 100000);
CREATE TABLE supplier_requests (
  id bigserial PRIMARY KEY,
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_supplier_requests_window ON supplier_requests(provider, requested_at);
CREATE TABLE supplier_cancellations (
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, request_id)
);
CREATE TABLE refunds (
  order_id text PRIMARY KEY REFERENCES orders(id),
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  destination text NOT NULL CHECK (destination IN ('wallet','payment_stub')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ledger_transactions ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK
  (kind IN ('payment_received','payment_reversed','delivery_settled','refund'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK
  (account IN ('cash','customer_clearing','sales','refunds','wallet'));
ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_kind_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_kind_check CHECK
  (kind IN ('registration_bonus','cart_purchase','order_refund'));
CREATE TABLE order_history (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  group_id text REFERENCES order_groups(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb NOT NULL
);
CREATE INDEX idx_order_history_at ON order_history(order_id, recorded_at DESC, id DESC);
CREATE INDEX idx_order_history_group_at ON order_history(group_id, recorded_at DESC, id DESC);
CREATE FUNCTION capture_order_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO order_history(order_id, group_id, snapshot)
  VALUES (NEW.id, NEW.group_id, to_jsonb(NEW) || jsonb_build_object(
    'name', (SELECT name FROM products WHERE sku = NEW.sku),
    'type', (SELECT type FROM products WHERE sku = NEW.sku),
    'code', (SELECT code FROM deliveries WHERE order_id = NEW.id),
    'provider', (SELECT provider FROM deliveries WHERE order_id = NEW.id)));
  RETURN NEW;
END $$;
CREATE TRIGGER orders_history AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION capture_order_history();
-- Honest baseline: pre-migration states are only known from this moment onward.
INSERT INTO order_history(order_id, group_id, snapshot)
SELECT o.id, o.group_id, to_jsonb(o) || jsonb_build_object('code', d.code, 'provider', d.provider)
FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id;
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append_only_table: %', TG_TABLE_NAME; END $$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON order_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_ledger_transactions BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_ledger_entries BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_refunds BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_groups BEFORE UPDATE OR DELETE ON order_groups FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
