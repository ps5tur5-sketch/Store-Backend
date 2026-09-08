import assert from 'node:assert/strict';
import { addScenarioKey, createPaidOrder, request, waitForOrder } from './http-client.js';

const sku = 'KEY-EFT';
await request(`/api/test/inventory/${sku}/drain`, { method: 'POST', body: '{}' });
const order = await createPaidOrder(sku);
const empty = await waitForOrder(order.id, ['refunded'], 10_000);
assert.equal(empty.status, 'refunded');

await addScenarioKey(sku, 'A', 'RESTOCK');
const fresh = await createPaidOrder(sku);
const delivered = await waitForOrder(fresh.id, ['delivered'], 10_000);
const evidence = await request<Record<string, any>>(`/api/admin/orders/${fresh.id}/evidence`);
assert.equal(delivered.status, 'delivered');
assert.equal(evidence.evidence.deliveries, 1);
assert.equal(evidence.evidence.provider_issuances, 1);
console.log(
  JSON.stringify(
    {
      scenario: 'out_of_stock_refund_and_new_purchase',
      order_id: order.id,
      result: 'PASS',
      evidence: evidence.evidence,
    },
    null,
    2,
  ),
);
