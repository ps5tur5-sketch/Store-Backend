ALTER TABLE checkouts
  ADD COLUMN IF NOT EXISTS code_value_points bigint NOT NULL DEFAULT 0 CHECK (code_value_points >= 0),
  ADD COLUMN IF NOT EXISTS code_applied_points bigint NOT NULL DEFAULT 0 CHECK (code_applied_points >= 0),
  ADD COLUMN IF NOT EXISTS points_charged bigint NOT NULL DEFAULT 0 CHECK (points_charged >= 0);

UPDATE checkouts
SET points_charged = total_points,
    code_value_points = 0,
    code_applied_points = 0
WHERE method = 'points'
  AND points_charged = 0
  AND code_applied_points = 0;

UPDATE checkouts c
SET code_value_points = GREATEST(c.total_points, COALESCE(pc.value_points, c.total_points)),
    code_applied_points = c.total_points,
    points_charged = 0
FROM payment_codes pc
WHERE c.method = 'code'
  AND c.payment_code = pc.code
  AND c.code_applied_points = 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkouts_payment_split_check') THEN
    ALTER TABLE checkouts ADD CONSTRAINT checkouts_payment_split_check
      CHECK (code_applied_points + points_charged = total_points);
  END IF;
END $$;
