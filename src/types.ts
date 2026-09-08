export type OrderStatus =
  | 'created'
  | 'paid'
  | 'delivering'
  | 'delivered'
  | 'payment_failed'
  | 'out_of_stock'
  | 'delivery_failed'
  | 'refunded';

export type PaymentState = 'pending' | 'paid' | 'failed';
export type Provider = string;

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
  refund_requested: boolean;
  funding_source: 'wallet' | 'sbp' | 'crypto' | 'payment_stub';
  group_id: string | null;
  assigned_provider: Provider | null;
  assigned_offer_id: string | null;
  offer_name: string | null;
  user_id: string | null;
}

export interface PaymentEventInput {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: number;
  currency: string;
  created_at: string;
}
