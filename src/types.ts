export type OrderStatus =
  | 'created'
  | 'paid'
  | 'delivering'
  | 'delivered'
  | 'payment_failed'
  | 'out_of_stock'
  | 'delivery_failed';

export type PaymentState = 'pending' | 'paid' | 'failed';
export type Provider = 'A' | 'B';

export interface OrderRow {
  id: string;
  sku: string;
  amount: string;
  currency: string;
  status: OrderStatus;
  payment_state: PaymentState;
  payment_event_id: string | null;
  payment_event_created_at: Date | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
}

export interface PaymentEventInput {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: number;
  currency: string;
  created_at: string;
}
