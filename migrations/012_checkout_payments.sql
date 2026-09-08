ALTER TABLE orders ADD COLUMN funding_source text NOT NULL DEFAULT 'payment_stub' CHECK(funding_source IN ('wallet','sbp','crypto','payment_stub'));
UPDATE orders SET funding_source='wallet' WHERE user_id IS NOT NULL;
ALTER TABLE checkouts DROP CONSTRAINT checkouts_method_check;
ALTER TABLE checkouts ADD CONSTRAINT checkouts_method_check CHECK(method IN ('points','code','sbp','crypto'));
ALTER TABLE checkouts ADD COLUMN status text NOT NULL DEFAULT 'paid' CHECK(status IN ('pending','paid','failed','cancelled','expired'));
ALTER TABLE checkouts ADD COLUMN external_amount bigint NOT NULL DEFAULT 0 CHECK(external_amount>=0);
ALTER TABLE checkouts ADD COLUMN payment_intent_id text;
ALTER TABLE checkouts DROP CONSTRAINT checkouts_payment_split_check;
ALTER TABLE checkouts ADD CONSTRAINT checkouts_payment_split_check CHECK(code_applied_points+points_charged+external_amount=total_points);
CREATE TABLE payment_intents (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 purpose text NOT NULL CHECK(purpose IN ('checkout','wallet_topup')),
 group_id text REFERENCES order_groups(id),
 retry_of text UNIQUE REFERENCES payment_intents(id),
 method text NOT NULL CHECK(method IN ('sbp','crypto')),
 amount bigint NOT NULL CHECK(amount>0),
 currency char(3) NOT NULL DEFAULT 'RUB',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','cancelled','expired')),
 details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 completed_at timestamptz,
 CHECK((purpose='checkout' AND group_id IS NOT NULL) OR (purpose='wallet_topup' AND group_id IS NULL))
);
CREATE UNIQUE INDEX one_pending_checkout_payment ON payment_intents(group_id) WHERE status='pending' AND group_id IS NOT NULL;
CREATE INDEX pending_payment_expiry ON payment_intents(expires_at) WHERE status='pending';
CREATE TABLE payment_intent_events (
 id text PRIMARY KEY,
 payment_intent_id text NOT NULL REFERENCES payment_intents(id),
 status text NOT NULL CHECK(status IN ('created','paid','failed','cancelled','expired')),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_payment_events BEFORE UPDATE OR DELETE ON payment_intent_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE checkouts ADD CONSTRAINT checkout_payment_intent_fk FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id);
ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_kind_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_kind_check CHECK(kind IN ('registration_bonus','cart_purchase','order_refund','wallet_topup'));
ALTER TABLE ledger_transactions ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE ledger_transactions ADD COLUMN user_id text REFERENCES users(id);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK(kind IN
 ('payment_received','payment_reversed','delivery_settled','delivery_reversed','refund','wallet_topup','registration_bonus','code_credit','wallet_baseline'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK(account IN ('cash','customer_clearing','sales','refunds','wallet','demo_funding'));
-- Bring existing test wallets into the journal without modifying their past transactions.
DO $$ DECLARE adjustment bigint; BEGIN
 SELECT COALESCE((SELECT sum(points_balance) FROM users),0)+COALESCE((SELECT sum(amount) FROM ledger_entries WHERE account='wallet'),0) INTO adjustment;
 IF adjustment<>0 THEN
  INSERT INTO ledger_transactions(id,kind) VALUES('wallet-baseline-v2','wallet_baseline');
  INSERT INTO ledger_entries(transaction_id,account,amount,currency) VALUES
   ('wallet-baseline-v2','demo_funding',adjustment,'RUB'),('wallet-baseline-v2','wallet',-adjustment,'RUB');
 END IF;
END $$;
CREATE FUNCTION protect_payment_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'status'-'completed_at')<>(to_jsonb(OLD)-'status'-'completed_at') OR OLD.status<>'pending' THEN
  RAISE EXCEPTION 'immutable_payment_intent_terms_or_final_state';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_intent_terms BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION protect_payment_intent();
