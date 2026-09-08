import { getPool, transaction } from '../db.js';
import type { PublicUser } from './accounts.js';
import { scheduleDelivery } from './payment.js';

export async function setUserBan(actor: PublicUser, userId: string, banned: boolean, reason: string) {
  const seller = (await getPool().query('SELECT seller_id FROM users WHERE id=$1', [userId])).rows[0]
    ?.seller_id;
  if (seller) return setSellerBan(actor, seller, banned, reason);
  return transaction(async (client) => {
    const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
    if (user.role === 'admin')
      throw Object.assign(new Error('cannot_ban_administrator'), { statusCode: 409 });
    await client.query(
      `UPDATE users SET banned_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,ban_reason=$3 WHERE id=$1`,
      [userId, banned, banned ? reason : null],
    );
    if (banned) await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
    if (user.seller_id)
      await client.query(
        `UPDATE supplier_configs SET banned_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,ban_reason=$3 WHERE provider=$1`,
        [user.seller_id, banned, banned ? reason : null],
      );
    await client.query(
      `INSERT INTO audit_events(idempotency_key,event_type,payload) VALUES($1,'user_moderated',$2)`,
      [
        `moderation:${crypto.randomUUID()}`,
        JSON.stringify({ actor_id: actor.id, user_id: userId, banned, reason }),
      ],
    );
    return { user_id: userId, banned };
  });
}
export async function setSellerBan(actor: PublicUser, provider: string, banned: boolean, reason: string) {
  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE supplier_configs SET banned_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,ban_reason=$3
   WHERE provider=$1 RETURNING provider`,
      [provider, banned, banned ? reason : null],
    );
    if (!result.rowCount) throw Object.assign(new Error('seller_not_found'), { statusCode: 404 });
    await client.query(
      `UPDATE users SET banned_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,ban_reason=$3 WHERE seller_id=$1`,
      [provider, banned, banned ? reason : null],
    );
    if (banned)
      await client.query(
        'DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE seller_id=$1)',
        [provider],
      );
    await client.query(
      `INSERT INTO audit_events(idempotency_key,event_type,payload) VALUES($1,'seller_moderated',$2)`,
      [`moderation:${crypto.randomUUID()}`, JSON.stringify({ actor_id: actor.id, provider, banned, reason })],
    );
    return { provider, banned };
  });
}
export async function requestRefund(actor: PublicUser, orderId: string, reason: string) {
  return transaction(async (client) => {
    const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!order) throw Object.assign(new Error('order_not_found'), { statusCode: 404 });
    if (order.status === 'refunded') return { order_id: orderId, already_refunded: true };
    if (order.payment_state !== 'paid')
      throw Object.assign(new Error('refund_requires_paid_order'), { statusCode: 409 });
    const existing = await client.query('SELECT 1 FROM refund_requests WHERE order_id=$1', [orderId]);
    if (existing.rowCount) return { order_id: orderId, scheduled: true };
    await client.query('INSERT INTO refund_requests(order_id,actor_id,reason) VALUES($1,$2,$3)', [
      orderId,
      actor.id,
      reason,
    ]);
    await scheduleDelivery(client, orderId);
    await client.query(
      `UPDATE delivery_jobs j SET state='pending',phase='resolve',attempts=attempts+1,next_attempt_at=now(),locked_until=NULL,
    provider=COALESCE((SELECT provider FROM deliveries WHERE order_id=$1),j.provider),updated_at=now() WHERE order_id=$1`,
      [orderId],
    );
    await client.query(
      'UPDATE orders SET refund_requested=true,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
      [orderId],
    );
    await client.query(
      `INSERT INTO audit_events(idempotency_key,event_type,order_id,payload) VALUES($1,'manual_refund_requested',$2,$3)`,
      [`manual-refund:${orderId}`, orderId, JSON.stringify({ actor_id: actor.id, reason })],
    );
    return { order_id: orderId, scheduled: true };
  });
}
export async function administrationOrders() {
  return {
    orders: (
      await getPool()
        .query(`SELECT o.id,o.group_id,o.sku,p.name,o.amount::float AS amount,o.currency,o.status,o.payment_state,
   o.created_at,o.refund_requested,u.username AS buyer,COALESCE(d.provider,o.assigned_provider) AS provider,
   s.display_name AS seller_name,(SELECT count(*)::int FROM order_messages m WHERE m.order_id=o.id) AS message_count
   FROM orders o JOIN products p ON p.sku=o.sku LEFT JOIN users u ON u.id=o.user_id LEFT JOIN deliveries d ON d.order_id=o.id
   LEFT JOIN supplier_configs s ON s.provider=COALESCE(d.provider,o.assigned_provider)
   ORDER BY o.created_at DESC,o.id DESC LIMIT 300`)
    ).rows,
  };
}
