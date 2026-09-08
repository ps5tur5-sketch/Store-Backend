-- A business operation becomes visible at PostgreSQL COMMIT, not at the individual INSERTs.
DO $$ BEGIN
 IF current_setting('track_commit_timestamp')<>'on' THEN RAISE EXCEPTION 'Enable track_commit_timestamp=on for exact transaction history'; END IF;
END $$;
CREATE TABLE business_operations (
 operation_key text PRIMARY KEY,
 transaction_id xid8 UNIQUE,
 reconstructed_at timestamptz,
 CHECK ((transaction_id IS NOT NULL)<>(reconstructed_at IS NOT NULL))
);
CREATE TABLE operation_commits (
 operation_key text PRIMARY KEY REFERENCES business_operations(operation_key),
 committed_at timestamptz NOT NULL
);
CREATE INDEX operation_commits_time ON operation_commits(committed_at);
CREATE TABLE history_operations (
 history_id bigint PRIMARY KEY REFERENCES order_history(id),
 operation_key text NOT NULL REFERENCES business_operations(operation_key)
);
CREATE TABLE ledger_operations (
 ledger_id text PRIMARY KEY REFERENCES ledger_transactions(id),
 operation_key text NOT NULL REFERENCES business_operations(operation_key)
);
CREATE TABLE group_operations (
 group_id text PRIMARY KEY REFERENCES order_groups(id),
 operation_key text NOT NULL REFERENCES business_operations(operation_key)
);
-- Preserve old facts; append metadata grouped by their original inserting transaction.
-- COMMIT timestamps before tracking was enabled cannot be recovered and are explicitly labelled.
CREATE TEMP TABLE legacy_origins ON COMMIT DROP AS
 SELECT 'legacy:'||xmin::text AS operation_key,recorded_at AS observed_at FROM order_history
 UNION ALL SELECT 'legacy:'||xmin::text,created_at FROM ledger_transactions
 UNION ALL SELECT 'legacy:'||xmin::text,created_at FROM order_groups;
INSERT INTO business_operations(operation_key,reconstructed_at)
 SELECT operation_key,max(observed_at) FROM legacy_origins GROUP BY operation_key;
INSERT INTO history_operations SELECT id,'legacy:'||xmin::text FROM order_history;
INSERT INTO ledger_operations SELECT id,'legacy:'||xmin::text FROM ledger_transactions;
INSERT INTO group_operations SELECT id,'legacy:'||xmin::text FROM order_groups;
CREATE FUNCTION attach_business_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation text := 'tx:'||pg_current_xact_id()::text;
BEGIN
 INSERT INTO business_operations(operation_key,transaction_id) VALUES(operation,pg_current_xact_id()) ON CONFLICT DO NOTHING;
 IF TG_TABLE_NAME='order_history' THEN INSERT INTO history_operations VALUES(NEW.id,operation);
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN INSERT INTO ledger_operations VALUES(NEW.id,operation);
 ELSE INSERT INTO group_operations VALUES(NEW.id,operation); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER history_operation AFTER INSERT ON order_history FOR EACH ROW EXECUTE FUNCTION attach_business_operation();
CREATE TRIGGER ledger_operation AFTER INSERT ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION attach_business_operation();
CREATE TRIGGER group_operation AFTER INSERT ON order_groups FOR EACH ROW EXECUTE FUNCTION attach_business_operation();
CREATE FUNCTION business_commit_time(operation text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT COALESCE(c.committed_at,o.reconstructed_at,pg_xact_commit_timestamp(o.transaction_id::xid))
 FROM business_operations o LEFT JOIN operation_commits c USING(operation_key) WHERE o.operation_key=operation
$$;
-- Persist timestamps before PostgreSQL eventually prunes its native commit timestamp storage.
-- Also called on recovery: a crash between COMMIT and this archival step loses no business facts.
CREATE FUNCTION archive_business_commits() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE inserted integer;
BEGIN
 INSERT INTO operation_commits(operation_key,committed_at)
 SELECT o.operation_key,pg_xact_commit_timestamp(o.transaction_id::xid) FROM business_operations o
 WHERE o.transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operation_commits c WHERE c.operation_key=o.operation_key)
 AND pg_xact_commit_timestamp(o.transaction_id::xid) IS NOT NULL ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted;
END $$;
CREATE TRIGGER immutable_operations BEFORE UPDATE OR DELETE ON business_operations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_commits BEFORE UPDATE OR DELETE ON operation_commits FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_history_operations BEFORE UPDATE OR DELETE ON history_operations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_ledger_operations BEFORE UPDATE OR DELETE ON ledger_operations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_group_operations BEFORE UPDATE OR DELETE ON group_operations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
