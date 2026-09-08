import assert from 'node:assert/strict';

export const baseUrl = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

let adminToken: string | undefined;
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (/^\/api\/(admin|test|reconciliation)(\/|$)/.test(path) && !adminToken) {
    const login = await request<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME ?? 'admin_demo',
        password: process.env.ADMIN_PASSWORD ?? 'AdminDemo2026!',
      }),
    });
    adminToken = login.token;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(
    response.ok,
    true,
    `${init?.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`,
  );
  return body as T;
}

export async function createPaidOrder(
  sku: string,
): Promise<{ id: string; amount: number; currency: string }> {
  const order = await request<{ id: string; amount: number; currency: string }>('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ sku }),
  });
  await request(`/api/orders/${order.id}/simulate-payment`, {
    method: 'POST',
    body: JSON.stringify({ status: 'paid' }),
  });
  return order;
}

export async function waitForOrder(
  orderId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await request<Record<string, any>>(`/api/orders/${orderId}`);
    if (statuses.includes(order.status)) return order;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Order ${orderId} did not reach ${statuses.join('/')} in ${timeoutMs}ms`);
}

export async function configureSupplier(
  provider: 'A' | 'B',
  mode: string,
  timeoutDelayMs = 1000,
): Promise<void> {
  await request(`/api/admin/suppliers/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({
      mode,
      failure_rate: 0,
      timeout_rate: 0,
      min_delay_ms: 0,
      timeout_delay_ms: timeoutDelayMs,
    }),
  });
}

export async function addScenarioKey(sku: string, provider: 'A' | 'B', prefix: string): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  await request('/api/admin/inventory', {
    method: 'POST',
    body: JSON.stringify({ provider, sku, codes: [`${prefix}-${suffix}`] }),
  });
}
