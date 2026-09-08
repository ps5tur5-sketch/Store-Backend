-- Add settlement entries for already delivered first-stage orders, at migration time.
INSERT INTO ledger_transactions(id,order_id,kind)
SELECT 'delivery_settled:'||o.id,o.id,'delivery_settled'
FROM orders o JOIN deliveries d ON d.order_id=o.id
WHERE o.payment_state='paid' ON CONFLICT DO NOTHING;
INSERT INTO ledger_entries(transaction_id,account,amount,currency)
SELECT lt.id,v.account,v.sign*o.amount,o.currency FROM ledger_transactions lt JOIN orders o ON o.id=lt.order_id
CROSS JOIN (VALUES ('customer_clearing',1),('sales',-1)) v(account,sign)
WHERE lt.kind='delivery_settled' ON CONFLICT DO NOTHING;

CREATE FUNCTION check_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx text; n bigint; balance numeric; currencies bigint;
BEGIN
  IF TG_TABLE_NAME='ledger_transactions' THEN tx:=NEW.id; ELSE tx:=NEW.transaction_id; END IF;
  SELECT count(*),sum(amount),count(DISTINCT currency) INTO n,balance,currencies FROM ledger_entries WHERE transaction_id=tx;
  IF n<>2 OR balance<>0 OR currencies<>1 THEN RAISE EXCEPTION 'unbalanced_ledger_transaction: %',tx; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_transaction AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
CREATE CONSTRAINT TRIGGER balanced_entry AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();

CREATE FUNCTION verify_delivery_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF o.payment_state<>'paid' OR EXISTS(SELECT 1 FROM refunds WHERE order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'delivery_requires_paid_unsettled_order';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM provider_inventory i JOIN provider_issuances p ON p.code=i.code
    WHERE i.code=NEW.code AND i.sku=o.sku AND i.provider=NEW.provider AND i.claimed_by=NEW.request_id
      AND p.provider=NEW.provider AND p.request_id=NEW.request_id AND p.order_id=NEW.order_id AND p.sku=o.sku) THEN
    RAISE EXCEPTION 'unverified_delivery_code';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verified_delivery BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION verify_delivery_insert();
CREATE TRIGGER immutable_deliveries BEFORE UPDATE OR DELETE ON deliveries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION verify_refund_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF o.payment_state<>'paid' OR NEW.amount<>o.amount OR NEW.currency<>o.currency
    OR EXISTS(SELECT 1 FROM deliveries WHERE order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'refund_requires_paid_undelivered_order';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM delivery_jobs j JOIN supplier_cancellations c ON c.provider=j.provider AND c.request_id=j.request_id
    WHERE j.order_id=NEW.order_id) THEN RAISE EXCEPTION 'refund_requires_confirmed_cancellation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verified_refund BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION verify_refund_insert();
