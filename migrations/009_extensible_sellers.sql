-- A/B remain the seeded sellers; additional sellers use the same stub contract.
DO $$
DECLARE r record; statements text[] := ARRAY[]::text[]; statement text;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tab,conname,pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype='f' AND confrelid='supplier_configs'::regclass
  LOOP
    statements := array_append(statements,format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.tab,r.conname,r.def));
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tab,r.conname);
  END LOOP;
  ALTER TABLE supplier_configs DROP CONSTRAINT supplier_configs_provider_check;
  ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_provider_check;
  ALTER TABLE deliveries DROP CONSTRAINT deliveries_provider_check;
  FOR r IN SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN ('provider','assigned_provider')
  LOOP EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE text',r.table_name,r.column_name); END LOOP;
  FOREACH statement IN ARRAY statements LOOP EXECUTE statement; END LOOP;
END $$;
ALTER TABLE supplier_configs ADD CONSTRAINT supplier_configs_provider_check CHECK(provider ~ '^[A-Za-z0-9_-]{1,48}$');
ALTER TABLE delivery_attempts ADD FOREIGN KEY(provider) REFERENCES supplier_configs(provider);
ALTER TABLE deliveries ADD FOREIGN KEY(provider) REFERENCES supplier_configs(provider);
