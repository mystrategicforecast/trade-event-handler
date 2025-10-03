import { publishAlert } from '../utils/alerts.js';
import { sendToPromoSystem } from '../utils/promo.js';

export async function handleEntryEvent(event, pool) {
    const { symbol, tradeId, data, direction } = event;
    const { entryLevel, entryThreshold } = data;

    console.log(`Processing entry-hit event for ${symbol} (${direction}), entry level ${entryLevel}`);

    try {
        // ============================================================
        // 1. IDEMPOTENCY CHECK — Has this entry event already been logged?
        // ============================================================
        const [existingEntry] = await pool.query(
            `SELECT id FROM lazy_swing_trade_events
             WHERE trade_id = ? AND event_type = 'entry' AND price = ?`,
            [tradeId, entryThreshold]
        );

        if (existingEntry.length > 0) {
            console.log(`Entry ${entryThreshold} for trade ${tradeId} already processed, skipping`);
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

        // ============================================================
        // 3. UPDATE TRADE RECORD — Mark this entry as filled
        // ============================================================
        const entryFilledAtField = `entry_${entryLevel}_filled_at`;
        await pool.query(
            `UPDATE lazy_swing_trades
             SET ${entryFilledAtField} = NOW()
             WHERE id = ?`,
            [tradeId]
        );

        // ============================================================
        // 4. SET DEFAULT STOP (if none exist) — Breakeven daily stop
        // ============================================================
        const [stops] = await pool.query(
            `SELECT * FROM lazy_swing_trade_stops WHERE trade_id = ?`,
            [tradeId]
        );

        if (!stops.length) {
            console.log(`No stop set for trade ${tradeId}, setting breakeven stop at ${entryThreshold}`);
            await pool.query(
                `INSERT INTO lazy_swing_trade_stops (trade_id, stop_type, operator, price)
                 VALUES (?, 'daily', ?, ?)`,
                [tradeId, direction === 'Long' ? 'below' : 'above', entryThreshold]
            );
        }

        // ============================================================
        // 5. SET DEFAULT PROFITS (if missing) — Profit 1 and Profit 2
        // ============================================================
        if (!trade.profit_1 && !trade.profit_2) {
            const profit1 = direction === 'Long' ? entryThreshold * 1.03 : entryThreshold * 0.97;
            const profit2 = direction === 'Long' ? entryThreshold * 1.06 : entryThreshold * 0.94;
            console.log(`Setting default profit targets for trade ${tradeId}: profit_1=${profit1}, profit_2=${profit2}`);

            await pool.query(
                `UPDATE lazy_swing_trades
                 SET profit_1 = ?, profit_2 = ?
                 WHERE id = ?`,
                [profit1, profit2, tradeId]
            );
        }

        // ============================================================
        // 6. NOTIFY EXTERNAL SYSTEMS — Promo system + Alerts
        // ============================================================
        await sendToPromoSystem({
            symbol,
            direction,
            stopPrice: trade.stop_price,
            profit1: trade.profit_1,
            profit2: trade.profit_2
        }, 'entry').catch(err => console.error('Promo system error:', err));

        await publishAlert({
            symbol,
            eventType: 'entry-hit',
            data: { entryLevel }
        });

        console.log(`Entry event processed successfully for ${symbol} entry ${entryLevel}`);

    } catch (error) {
        console.error('Error processing entry event:', error);
        throw error;
    }
}
