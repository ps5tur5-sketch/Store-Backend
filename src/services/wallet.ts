import type { PoolClient } from 'pg';

export async function postWalletCredit(
  client: PoolClient,
  userId: string,
  amount: number,
  kind: 'registration_bonus' | 'wallet_topup' | 'code_credit',
  id: string,
) {
  if (amount <= 0) return;
  const result = await client.query(
    `INSERT INTO ledger_transactions(id,user_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [id, userId, kind],
  );
  if (!result.rowCount) return;
  await client.query(
    `INSERT INTO ledger_entries(transaction_id,account,amount,currency)
   VALUES($1,$2,$3,'RUB'),($1,'wallet',-$3,'RUB')`,
    [id, kind === 'wallet_topup' ? 'cash' : 'demo_funding', amount],
  );
}
