CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('topup', 'key', 'subscription', 'giftcard')),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  currency char(3) NOT NULL,
  image_path text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_storefront
  ON products (active, type, sku) INCLUDE (name, price_minor, currency, image_path);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  sku text NOT NULL REFERENCES products(sku),
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'paid', 'delivering', 'delivered', 'payment_failed', 'out_of_stock', 'delivery_failed')
  ),
  payment_state text NOT NULL DEFAULT 'pending' CHECK (payment_state IN ('pending', 'paid', 'failed')),
  payment_event_id text,
  payment_event_created_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_orders_recovery
  ON orders (status, updated_at) WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');
CREATE INDEX IF NOT EXISTS idx_orders_payment_reconciliation
  ON orders (payment_state, status, created_at);

-- Intentionally no FK to orders: an at-least-once webhook may precede order creation.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('paid', 'failed')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  event_created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_result text
);

CREATE INDEX IF NOT EXISTS idx_payment_events_pending_order
  ON payment_events (order_id, event_created_at, event_id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  source_event_id text NOT NULL UNIQUE REFERENCES payment_events(event_id),
  kind text NOT NULL CHECK (kind IN ('payment_received', 'payment_reversed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account text NOT NULL CHECK (account IN ('cash', 'customer_clearing')),
  amount bigint NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, account)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_order ON ledger_transactions (order_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_configs (
  provider char(1) PRIMARY KEY CHECK (provider IN ('A', 'B')),
  mode text NOT NULL DEFAULT 'normal' CHECK (
    mode IN ('normal', 'always_fail', 'out_of_stock', 'timeout_before_issue', 'timeout_after_issue')
  ),
  failure_rate double precision NOT NULL DEFAULT 0 CHECK (failure_rate BETWEEN 0 AND 1),
  timeout_rate double precision NOT NULL DEFAULT 0 CHECK (timeout_rate BETWEEN 0 AND 1),
  min_delay_ms integer NOT NULL DEFAULT 0 CHECK (min_delay_ms >= 0),
  timeout_delay_ms integer NOT NULL DEFAULT 1000 CHECK (timeout_delay_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_inventory (
  code text PRIMARY KEY,
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  sku text NOT NULL REFERENCES products(sku),
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- This partial covering index makes the hot stock aggregation touch only available rows.
CREATE INDEX IF NOT EXISTS idx_provider_inventory_available_sku_provider
  ON provider_inventory (sku, provider) INCLUDE (code) WHERE claimed_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_inventory_claimed_by
  ON provider_inventory (claimed_by) WHERE claimed_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_issuances (
  provider char(1) NOT NULL REFERENCES supplier_configs(provider),
  request_id text NOT NULL,
  order_id text NOT NULL,
  sku text NOT NULL REFERENCES products(sku),
  code text NOT NULL UNIQUE REFERENCES provider_inventory(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, request_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_issuances_order ON provider_issuances (order_id);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  order_id text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'retry', 'completed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_claim
  ON delivery_jobs (next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry', 'processing');

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  request_id text NOT NULL,
  provider char(1) NOT NULL CHECK (provider IN ('A', 'B')),
  attempt_no integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'explicit_failure', 'out_of_stock', 'timeout', 'invalid_response')),
  http_status integer,
  latency_ms integer NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_order ON delivery_attempts (order_id, created_at);

CREATE TABLE IF NOT EXISTS deliveries (
  order_id text PRIMARY KEY REFERENCES orders(id),
  request_id text NOT NULL UNIQUE,
  provider char(1) NOT NULL CHECK (provider IN ('A', 'B')),
  code text NOT NULL UNIQUE,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  order_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_order ON audit_events (order_id, created_at);
