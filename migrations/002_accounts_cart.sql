CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  points_balance bigint NOT NULL DEFAULT 5000 CHECK (points_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS cart_items (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku text NOT NULL REFERENCES products(sku),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sku)
);

CREATE TABLE IF NOT EXISTS payment_codes (
  code text PRIMARY KEY,
  value_points bigint NOT NULL CHECK (value_points > 0),
  used_by text REFERENCES users(id),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_payment_codes_available ON payment_codes (created_at, code) WHERE used_by IS NULL;

CREATE TABLE IF NOT EXISTS checkouts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  method text NOT NULL CHECK (method IN ('points', 'code')),
  total_points bigint NOT NULL CHECK (total_points > 0),
  payment_code text REFERENCES payment_codes(code),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  order_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkouts_user_date ON checkouts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS point_transactions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  checkout_id text UNIQUE REFERENCES checkouts(id),
  kind text NOT NULL CHECK (kind IN ('registration_bonus', 'cart_purchase')),
  amount bigint NOT NULL CHECK (amount <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_point_transactions_user_date
  ON point_transactions (user_id, created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_user_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_user_date ON orders (user_id, created_at DESC) WHERE user_id IS NOT NULL;
