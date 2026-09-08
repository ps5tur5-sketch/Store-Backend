import { z } from 'zod';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value !== 'false');

const schema = z.object({
  ADMIN_USERNAME: z.string().default('admin_demo'),
  ADMIN_PASSWORD: z.string().min(10).default('AdminDemo2026!'),
  SELLER_PASSWORD: z.string().min(10).default('SellerDemo2026!'),
  DATABASE_URL: z.string().default('postgresql://hr:hr@127.0.0.1:5432/hr'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  WORKER_ENABLED: booleanFromEnv,
  WORKER_POLL_MS: z.coerce.number().int().positive().default(200),
  RECOVERY_POLL_MS: z.coerce.number().int().positive().default(5000),
  SUPPLIER_SHARED_SECRET: z.string().min(16).default('LocalSupplierDemo2026!'),
  SUPPLIER_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(300),
  SUPPLIER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  SUPPLIER_BACKOFF_MS: z.coerce.number().int().min(0).default(50),
  ENABLE_TEST_CONTROLS: booleanFromEnv,
  DEMO_MARKETPLACE: booleanFromEnv,
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  return schema.parse({ ...process.env, ...overrides });
}
