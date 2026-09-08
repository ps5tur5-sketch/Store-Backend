import assert from 'node:assert/strict';
import { request, waitForOrder } from './http-client.js';

// Isolated seller IDs keep this scenario from changing existing storefront sellers.
const suffix = Date.now().toString(36);
const good = `demo_good_${suffix}`,
  bad = `demo_bad_${suffix}`,
  empty = `demo_empty_${suffix}`;
for (const [id, name, mode, sku, price] of [
  [good, 'Демо: обычная выдача', 'normal', 'STEAM-TOPUP-500', 500],
  [bad, 'Демо: ошибка после выдачи', 'error_after_issue', 'KEY-GTA5', 1490],
  [empty, 'Демо: нет товара', 'out_of_stock', 'SUB-DISCORD-1M', 399],
] as const) {
  await request('/api/admin/sellers', { method: 'POST', body: JSON.stringify({ id, name }) });
  await request(`/api/admin/offers/${sku}/${id}`, { method: 'PUT', body: JSON.stringify({ price }) });
  await request(`/api/admin/suppliers/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ mode, requests_per_minute: 120 }),
  });
  if (id !== empty)
    await request('/api/admin/inventory', {
      method: 'POST',
      body: JSON.stringify({ provider: id, sku, codes: [`STAGE2-${id.replaceAll('_', '-')}-KEY`] }),
    });
}
const order = await request<any>('/api/orders', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { sku: 'STEAM-TOPUP-500', provider: good },
      { sku: 'KEY-GTA5', provider: bad },
      { sku: 'SUB-DISCORD-1M', provider: empty },
    ],
  }),
});
const beforePayment = new Date().toISOString();
await request(`/api/orders/${order.id}/simulate-payment`, {
  method: 'POST',
  body: JSON.stringify({ event_id: `stage2_${suffix}` }),
});
const result = await waitForOrder(order.id, ['partially_refunded'], 30_000);
await request(`/api/orders/${order.id}/simulate-payment`, {
  method: 'POST',
  body: JSON.stringify({ event_id: `stage2_${suffix}` }),
});
await request('/api/reconciliation/recover', { method: 'POST', body: '{}' });
const repeated = await request<any>(`/api/orders/${order.id}`);
assert.deepEqual(repeated.money, result.money);
assert.equal(result.money.paid, result.money.delivered + result.money.refunded);
const seller = await request<any>(`/api/sellers/${bad}`);
assert.equal(seller.flag, 'red');
const past = await request<any>(`/api/orders/${order.id}/history?at=${encodeURIComponent(beforePayment)}`);
assert.equal(past.status, 'created');
console.log(
  JSON.stringify(
    {
      order_id: order.id,
      status: result.status,
      money: result.money,
      items: result.items.map((i: any) => ({
        id: i.id,
        sku: i.sku,
        provider: i.assigned_provider,
        status: i.status,
      })),
      seller: { id: bad, flag: seller.flag, confirmed_incidents: seller.confirmed_incidents },
      history_before_payment: { status: past.status, money: past.money },
      repeat_preserves_money: true,
    },
    null,
    2,
  ),
);
// Keep reports/evidence visible; remove the demo offers from the buyer storefront.
for (const [provider, sku, price] of [
  [good, 'STEAM-TOPUP-500', 500],
  [bad, 'KEY-GTA5', 1490],
  [empty, 'SUB-DISCORD-1M', 399],
] as const)
  await request(`/api/admin/offers/${sku}/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ price, active: false }),
  });
