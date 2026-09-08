import type { PoolClient } from 'pg';
import { transaction } from '../db.js';
import type { PublicUser } from './accounts.js';
async function conversationOrder(client: PoolClient, user: PublicUser, orderId: string) {
  const result = await client.query(
    `SELECT o.*,COALESCE(d.provider,o.assigned_provider) AS seller FROM orders o
  LEFT JOIN deliveries d ON d.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o`,
    [orderId],
  );
  const order = result.rows[0];
  if (
    !order ||
    !(
      user.role === 'admin' ||
      order.user_id === user.id ||
      (user.role === 'seller' && order.seller === user.seller_id)
    )
  )
    throw Object.assign(new Error('conversation_not_found'), { statusCode: 404 });
  return order;
}
export async function conversation(user: PublicUser, orderId: string) {
  return transaction(async (client) => {
    const order = await conversationOrder(client, user, orderId);
    const messages = await client.query(
      `SELECT m.id,m.body,m.created_at,m.sender_id,u.username,CASE WHEN m.sender_id=$2 THEN 'buyer' ELSE u.role END AS role
   FROM (SELECT * FROM order_messages WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200) m
   JOIN users u ON u.id=m.sender_id ORDER BY m.created_at,m.id`,
      [orderId, order.user_id],
    );
    return {
      order_id: orderId,
      status: order.status,
      can_send: order.payment_state === 'paid' && order.status !== 'refunded' && Boolean(order.user_id),
      closed_reason: order.status === 'refunded' ? 'refunded' : null,
      messages: messages.rows,
    };
  });
}
export async function sendOrderMessage(user: PublicUser, orderId: string, id: string, body: string) {
  return transaction(async (client) => {
    const order = await conversationOrder(client, user, orderId);
    const existing = (await client.query('SELECT * FROM order_messages WHERE id=$1', [id])).rows[0];
    if (existing) {
      if (existing.order_id !== orderId || existing.sender_id !== user.id || existing.body !== body)
        throw Object.assign(new Error('message_id_conflict'), { statusCode: 409 });
      return existing;
    }
    if (order.status === 'refunded')
      throw Object.assign(new Error('conversation_closed_after_refund'), { statusCode: 409 });
    if (order.payment_state !== 'paid' || !order.user_id)
      throw Object.assign(new Error('conversation_requires_purchase'), { statusCode: 409 });
    return (
      await client.query(
        'INSERT INTO order_messages(id,order_id,sender_id,body) VALUES($1,$2,$3,$4) RETURNING *',
        [id, orderId, user.id, body],
      )
    ).rows[0];
  });
}
