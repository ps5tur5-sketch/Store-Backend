ALTER TABLE supplier_configs ADD COLUMN demo_scenario text CHECK(demo_scenario IN ('refund','key_check'));
UPDATE supplier_configs SET demo_scenario=CASE provider WHEN 'DEMO_REFUND' THEN 'refund' ELSE 'key_check' END WHERE provider IN ('DEMO_REFUND','DEMO_CHECK');
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK(kind IN
 ('payment_received','payment_reversed','delivery_settled','delivery_reversed','refund','wallet_topup','registration_bonus','code_credit','wallet_baseline','refund_wallet_transfer','withdrawal_hold','withdrawal_paid','withdrawal_release'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK(account IN ('cash','customer_clearing','sales','refunds','wallet','demo_funding','withdrawal_clearing'));
ALTER TABLE point_transactions DROP CONSTRAINT point_transactions_kind_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_kind_check CHECK(kind IN ('registration_bonus','cart_purchase','order_refund','wallet_topup','withdrawal_hold','withdrawal_release'));
CREATE TABLE refund_wallet_transfers (
 order_id text PRIMARY KEY REFERENCES refunds(order_id),
 user_id text NOT NULL REFERENCES users(id),
 amount bigint NOT NULL CHECK(amount>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_refund_transfers BEFORE UPDATE OR DELETE ON refund_wallet_transfers FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
-- User-requested policy migration: move already completed simulated external refunds into the wallet.
-- Original refund facts are unchanged; every move has its own balanced transaction.
DO $$ DECLARE item record; balance bigint; BEGIN
 FOR item IN SELECT r.order_id,r.amount,o.user_id FROM refunds r JOIN orders o ON o.id=r.order_id
  WHERE r.destination='payment_stub' AND o.user_id IS NOT NULL ORDER BY r.created_at,r.order_id LOOP
  INSERT INTO refund_wallet_transfers(order_id,user_id,amount) VALUES(item.order_id,item.user_id,item.amount);
  UPDATE users SET points_balance=points_balance+item.amount,updated_at=clock_timestamp() WHERE id=item.user_id RETURNING points_balance INTO balance;
  INSERT INTO point_transactions(id,user_id,kind,amount,balance_after) VALUES('refund-transfer:'||item.order_id,item.user_id,'order_refund',item.amount,balance);
  INSERT INTO ledger_transactions(id,order_id,user_id,kind) VALUES('refund-transfer:'||item.order_id,item.order_id,item.user_id,'refund_wallet_transfer');
  INSERT INTO ledger_entries(transaction_id,account,amount,currency) VALUES
   ('refund-transfer:'||item.order_id,'cash',item.amount,'RUB'),('refund-transfer:'||item.order_id,'wallet',-item.amount,'RUB');
 END LOOP;
END $$;
CREATE TABLE withdrawals (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 method text NOT NULL CHECK(method IN ('card','crypto')),
 amount bigint NOT NULL CHECK(amount>0),
 currency char(3) NOT NULL DEFAULT 'RUB',
 recipient jsonb NOT NULL,
 recipient_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','cancelled','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 completed_at timestamptz
);
CREATE INDEX withdrawals_owner ON withdrawals(user_id,created_at DESC);
CREATE INDEX withdrawals_expiry ON withdrawals(expires_at) WHERE status='pending';
CREATE TABLE withdrawal_events (
 id text PRIMARY KEY,
 withdrawal_id text NOT NULL REFERENCES withdrawals(id),
 status text NOT NULL CHECK(status IN ('created','paid','failed','cancelled','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_withdrawal_events BEFORE UPDATE OR DELETE ON withdrawal_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_withdrawal_terms BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION protect_payment_intent();
CREATE TRIGGER immutable_withdrawals_delete BEFORE DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
