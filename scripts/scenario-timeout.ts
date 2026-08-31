import assert from 'node:assert/strict';
import { addScenarioKey, configureSupplier, createPaidOrder, request, waitForOrder } from './http-client.js';

const sku = 'KEY-CS2-PRIME';
await addScenarioKey(sku, 'A', 'TIMEOUT');
await addScenarioKey(sku, 'B', 'UNUSED');
await configureSupplier('A', 'timeout_after_issue', 1000);
await configureSupplier('B', 'normal');

try {
  const order = await createPaidOrder(sku);
  const delivered = await waitForOrder(order.id, ['delivered'], 15_000);
  const evidence = await request<Record<string, any>>(`/api/admin/orders/${order.id}/evidence`);
  assert.equal(delivered.provider, 'A');
  assert.equal(evidence.evidence.deliveries, 1);
  assert.equal(evidence.evidence.provider_issuances, 1);
  assert.equal(delivered.delivery_attempts.some((attempt: any) => attempt.outcome === 'timeout'), true);
  assert.equal(delivered.delivery_attempts.some((attempt: any) => attempt.outcome === 'ok'), true);
  console.log(JSON.stringify({ scenario: 'timeout_after_real_issue', order_id: order.id, result: 'PASS', evidence: evidence.evidence, attempts: delivered.delivery_attempts }, null, 2));
} finally {
  await configureSupplier('A', 'normal');
  await configureSupplier('B', 'normal');
}
