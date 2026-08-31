import assert from 'node:assert/strict';
import { addScenarioKey, configureSupplier, createPaidOrder, request, waitForOrder } from './http-client.js';

const sku = 'KEY-GTA5';
await addScenarioKey(sku, 'B', 'FALLBACK');
await configureSupplier('A', 'always_fail');
await configureSupplier('B', 'normal');

try {
  const order = await createPaidOrder(sku);
  const delivered = await waitForOrder(order.id, ['delivered'], 15_000);
  const evidence = await request<Record<string, any>>(`/api/admin/orders/${order.id}/evidence`);
  assert.equal(delivered.provider, 'B');
  assert.equal(evidence.evidence.deliveries, 1);
  assert.equal(evidence.evidence.provider_issuances, 1);
  console.log(JSON.stringify({ scenario: 'fallback_A_to_B', order_id: order.id, result: 'PASS', evidence: evidence.evidence }, null, 2));
} finally {
  await configureSupplier('A', 'normal');
  await configureSupplier('B', 'normal');
}
