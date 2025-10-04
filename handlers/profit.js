import { closeTrade } from './reset.js';
import { publishAlert } from '../utils/alerts.js';
import { sendToPromoSystem } from '../utils/promo.js';

export async function handleProfitEvent(event, pool) {
    const { symbol, tradeId, data, direction } = event;
    const { profitLevel, profitThreshold } = data;

    console.log(`Processing profit-hit event for ${symbol} (${direction}), profit level ${profitLevel}`);

    try {
        // ============================================================
        // 1. IDEMPOTENCY CHECK — Has this profit event already been logged?
        // ============================================================
        const [existingProfit] = await pool.query(
            `SELECT id FROM lazy_swing_trade_events
             WHERE trade_id = ? AND event_type = 'profit' AND price = ?`,
            [tradeId, profitThreshold]
        );

        if (existingProfit.length > 0) {
            console.log(`Profit ${profitThreshold} for trade ${tradeId} already processed, skipping`);
            return;
        }

        // ============================================================
        // 2. GET TRADE DETAILS — Verify trade exists and load fields
        // ============================================================
        const [tradeRows] = await pool.query(
            `SELECT * FROM lazy_swing_trades WHERE id = ?`,
            [tradeId]
        );

        if (tradeRows.length === 0) {
            throw new Error(`Trade ${tradeId} not found`);
        }

        const trade = tradeRows[0];
        const tradeName = `${symbol} (${direction})`;

        // ============================================================
        // 3. UPDATE TRADE RECORD — Mark this profit as achieved (idempotent)
        // ============================================================
        const profitAchievedAtField = `profit_${profitLevel}_achieved_at`;
        await pool.query(
            `UPDATE lazy_swing_trades
             SET ${profitAchievedAtField} = NOW()
             WHERE id = ? AND ${profitAchievedAtField} IS NULL`,
            [tradeId]
        );

        console.log(`Marked ${profitAchievedAtField} = NOW() for trade ${tradeId}: ${tradeName}`);

        // ============================================================
        // 4. SEND MEMBER ALERT
        // ============================================================
        await publishAlert({
            symbol,
            eventType: 'profit-hit',
            data: { profitLevel }
        });

        // ============================================================
        // 5. SEND TO PROMO SYSTEM (profit_1 only)
        // ============================================================
        if (profitLevel === 1) {
            await sendToPromoSystem({
                symbol,
                direction,
                stopPrice: trade.stop_price,
                profit1: trade.profit_1,
                profit2: trade.profit_2
            }, 'profit').catch(err => console.error('Promo system error:', err));
        }

        // ============================================================
        // 6. CHECK IF MORE PROFIT TARGETS REMAIN
        // ============================================================
        const remainingProfits = [];
        for (let i = 1; i <= 3; i++) {
            const profitPrice = trade[`profit_${i}`];
            const achievedAt = trade[`profit_${i}_achieved_at`];

            // Count as remaining if: has a price AND not yet achieved
            // Note: we just marked current profit, so need to check if this is current level
            if (profitPrice !== null && achievedAt === null && i !== profitLevel) {
                remainingProfits.push(i);
            }
        }

        console.log(`Remaining unfilled profit targets: ${remainingProfits.length > 0 ? remainingProfits.join(', ') : 'none'}`);

        // ============================================================
        // 7. IF PROFIT_1 HIT AND MORE TARGETS REMAIN — Set Breakeven Stop
        // ============================================================
        if (profitLevel === 1 && remainingProfits.length > 0) {
            // Get entry_1 price for breakeven stop
            const breakevenPrice = trade.entry_1;

            if (breakevenPrice) {
                // Upsert: delete existing daily stops, insert new breakeven stop
                await pool.query(
                    `DELETE FROM lazy_swing_trade_stops
                     WHERE trade_id = ? AND stop_type = 'daily'`,
                    [tradeId]
                );

                await pool.query(
                    `INSERT INTO lazy_swing_trade_stops (trade_id, stop_type, operator, price)
                     VALUES (?, 'daily', ?, ?)`,
                    [tradeId, direction === 'Long' ? 'below' : 'above', breakevenPrice]
                );

                console.log(`Set breakeven stop at entry_1 price ${breakevenPrice} for trade ${tradeId}`);
            } else {
                console.warn(`Cannot set breakeven stop: entry_1 is null for trade ${tradeId}`);
            }
        }

        // ============================================================
        // 8. IF NO MORE PROFIT TARGETS REMAIN — Close Trade
        // ============================================================
        if (remainingProfits.length === 0) {
            await closeTrade(
                tradeId,
                symbol,
                'profit',
                `All profit targets achieved, final profit (profit_${profitLevel}) hit at ${profitThreshold}`,
                pool
            );
            console.log(`Trade ${tradeId}: ${tradeName} closed - all profit targets achieved.`);
        }

        console.log(`Profit event processed successfully for ${tradeName} profit ${profitLevel} (${profitThreshold})`);

    } catch (error) {
        console.error('Error processing profit event:', error);
        throw error;
    }
}