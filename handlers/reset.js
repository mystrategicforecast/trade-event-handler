export async function handleResetEvent(tradeId, symbol, resetReason, pool, publishAlert) {
    console.log(`Processing reset for trade ${tradeId} (${symbol}): ${resetReason}`);

    try {
        // Get the trade details before reset
        const [tradeRows] = await pool.query(
            `SELECT * FROM lazy_swing_trades WHERE id = ?`,
            [tradeId]
        );

        if (tradeRows.length === 0) {
            throw new Error(`Trade ${tradeId} not found for reset`);
        }

        const trade = tradeRows[0];

        // Clear entry/target/stop fields and mark as eligible again
        await pool.query(
            `UPDATE lazy_swing_trades
             SET entry_1 = NULL, entry_2 = NULL, entry_3 = NULL, entry_4 = NULL,
                 entry_1_filled = 0, entry_2_filled = 0, entry_3_filled = 0, entry_4_filled = 0,
                 entry_1_filled_at = NULL, entry_2_filled_at = NULL, entry_3_filled_at = NULL, entry_4_filled_at = NULL,
                 profit_1 = NULL, profit_2 = NULL, profit_3 = NULL, profit_4 = NULL,
                 profit_1_filled = 0, profit_2_filled = 0, profit_3_filled = 0, profit_4_filled = 0,
                 stop_price = NULL, stop_period = NULL,
                 entry_log = CONCAT(IFNULL(entry_log, ''), 'RESET: ', ?, ' on ', NOW(), '\n'),
                 eligible = 1,
                 updated_at = NOW()
             WHERE id = ?`,
            [resetReason, tradeId]
        );

        // Log the reset event
        await pool.query(
            `INSERT INTO lazy_swing_trade_events
             (trade_id, symbol, event_type, target_number, price, notes)
             VALUES (?, ?, 'reset', ?, ?, ?)`,
            [
                tradeId,
                symbol,
                null,
                null,
                `Reset: ${resetReason}`
            ]
        );

        console.log(`Reset completed for trade ${tradeId} (${symbol}): ${resetReason}`);

    } catch (error) {
        console.error('Error processing reset:', error);
        throw error;
    }
}