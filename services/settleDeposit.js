//services>settleDeposit.js

// One shared decision handler for all deposit approval entry points.
// Uses the existing deposits, user_balances and balance_history tables.
const pool = require('../db');

class DecisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function settleDeposit(id, decision) {
  if (!/^\d+$/.test(String(id)) || !['approved', 'rejected'].includes(decision)) {
    throw new DecisionError(400, 'Invalid deposit or status');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock while checking the previous status so repeated requests cannot double-credit.
    const { rows } = await client.query(
      'SELECT id, user_id, coin, amount, status FROM deposits WHERE id = $1 FOR UPDATE',
      [id]
    );
    const deposit = rows[0];
    if (!deposit) throw new DecisionError(404, 'Deposit not found');

    if (deposit.status === decision) {
      await client.query('COMMIT');
      return { success: true, id: deposit.id, status: decision, alreadyProcessed: true, balanceAdded: false };
    }
    if (deposit.status !== 'pending') {
      throw new DecisionError(409, `Deposit is already ${deposit.status}`);
    }

    const amount = Number(deposit.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new DecisionError(400, 'Invalid stored deposit amount');

    await client.query('UPDATE deposits SET status = $1 WHERE id = $2', [decision, id]);
    if (decision === 'approved') {
      await client.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, coin)
         DO UPDATE SET balance = user_balances.balance + EXCLUDED.balance`,
        [deposit.user_id, deposit.coin, deposit.amount]
      );
      const { rows: balanceRows } = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [deposit.user_id, deposit.coin]
      );
      const newBalance = balanceRows[0]?.balance;
      let priceUsd = 1;
      if (deposit.coin !== 'USDT') {
        const { rows: prices } = await client.query(
          'SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1',
          [deposit.coin]
        );
        priceUsd = Number(prices[0]?.price_usd) || 1;
      }
      await client.query(
        `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [deposit.user_id, deposit.coin, newBalance, priceUsd]
      );
    }
    await client.query('COMMIT');
    return { success: true, id: deposit.id, status: decision, alreadyProcessed: false, balanceAdded: decision === 'approved' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function respondToDepositDecision(req, res, decision) {
  try {
    res.json(await settleDeposit(req.params.id, decision));
  } catch (error) {
    if (!error.status) console.error('Deposit decision error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Deposit decision failed' });
  }
}

module.exports = { settleDeposit, respondToDepositDecision };
