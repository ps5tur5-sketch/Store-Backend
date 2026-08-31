import assert from 'node:assert/strict';
import { addScenarioKey, baseUrl, request, waitForOrder } from './http-client.js';

const sku = 'STEAM-TOPUP-500';
await addScenarioKey(sku, 'A', 'RACE');
const order = await request<{ id: string; amount: number; currency: string }>('/api/orders', {
  method: 'POST', body: JSON.stringify({ sku }),
});
const createdAt = new Date().toISOString();
const events = Array.from({ length: 50 }, (_, index) => ({
  event_id: `evt_race_${order.id}_${String(index).padStart(2, '0')}`,
  order_id: order.id,
  status: 'paid',
  amount: order.amount,
  currency: order.currency,
  created_at: createdAt,
}));

const responses = await Promise.all(events.map((event) => fetch(`${baseUrl}/webhook/payment`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
})));
assert.equal(responses.every((response) => response.status === 200), true, 'all 50 webhooks must return 200');
await waitForOrder(order.id, ['delivered']);

const beforeDuplicate = await request<Record<string, any>>(`/api/admin/orders/${order.id}/evidence`);
assert.equal(beforeDuplicate.evidence.payment_events, 50);
assert.equal(beforeDuplicate.evidence.deliveries, 1);
assert.equal(beforeDuplicate.evidence.provider_issuances, 1);
assert.equal(beforeDuplicate.evidence.delivery_facts, 1);
assert.equal(beforeDuplicate.evidence.ledger_balance, 0);

await request('/webhook/payment', { method: 'POST', body: JSON.stringify(events[0]) });
const afterDuplicate = await request<Record<string, any>>(`/api/admin/orders/${order.id}/evidence`);
assert.deepEqual(afterDuplicate.evidence, beforeDuplicate.evidence, 'duplicate event_id must not mutate evidence');

console.log(JSON.stringify({ scenario: '50_parallel_webhooks', order_id: order.id, result: 'PASS', evidence: afterDuplicate.evidence }, null, 2));
