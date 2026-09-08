-- Unknown procurement costs stay NULL; historical profit must not be invented.
ALTER TABLE provider_inventory ADD COLUMN unit_cost_minor bigint CHECK (unit_cost_minor >= 0);
ALTER TABLE deliveries ADD COLUMN unit_cost_minor bigint CHECK (unit_cost_minor >= 0);

CREATE FUNCTION protect_claimed_inventory_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.claimed_by IS NOT NULL OR OLD.revoked_at IS NOT NULL)
     AND NEW.unit_cost_minor IS DISTINCT FROM OLD.unit_cost_minor THEN
    RAISE EXCEPTION 'claimed_inventory_cost_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_claimed_inventory_cost BEFORE UPDATE ON provider_inventory
FOR EACH ROW EXECUTE FUNCTION protect_claimed_inventory_cost();

CREATE FUNCTION snapshot_delivery_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT unit_cost_minor INTO NEW.unit_cost_minor FROM provider_inventory
    WHERE code=NEW.code AND provider=NEW.provider;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_delivery_cost BEFORE INSERT ON deliveries
FOR EACH ROW EXECUTE FUNCTION snapshot_delivery_cost();

-- A single snapshot joins actual settlement/reversal postings with the sale's fixed price/cost.
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
