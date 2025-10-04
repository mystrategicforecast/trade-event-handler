import { publishAlert } from '../utils/alerts.js';
import { closeTrade } from './reset.js';

export async function handleStopWarningEvent(event, pool) {
    const { symbol, tradeId, data, direction } = event;
    const { stopLevel, stopType, currentPrice } = data;

    console.log(`Processing stop-warning event for ${symbol} (${direction}), stop at ${stopLevel}`);

    try {
        // ============================================================
        // 1. SEND MEMBER ALERT — Urgent warning that stop is approaching
        // ============================================================
        await publishAlert({
            symbol,
            eventType: 'stop-warning',
            data: { stopLevel, stopType, currentPrice }
        });

        console.log(`Stop warning alert sent for ${symbol} at ${currentPrice} (stop: ${stopLevel})`);

    } catch (error) {
        console.error('Error processing stop warning event:', error);
        throw error;
    }
}

export async function handleStopOutEvent(event, pool) {
    const { symbol, tradeId, data, direction } = event;
    const { stopLevel, stopType, currentPrice, lossAmount, lossPercent } = data;

    console.log(`Processing stop-out event for ${symbol} (${direction}), stopped at ${currentPrice} (stop: ${stopLevel})`);

    try {
        // ============================================================
        // 1. IDEMPOTENCY CHECK — Has this stop-out already been processed?
        // ============================================================
        const [existingStop] = await pool.query(
            `SELECT id FROM lazy_swing_trade_events
             WHERE trade_id = ? AND event_type = 'stop' AND price = ?`,
            [tradeId, currentPrice]
        );

        if (existingStop.length > 0) {
            console.log(`Stop-out at ${currentPrice} for trade ${tradeId} already processed, skipping`);
            return;
        }

        // ============================================================
        // 2. GET TRADE DETAILS — Verify trade exists
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
        // 3. FIND WHICH STOP WAS HIT — Get stop record for audit trail
        // ============================================================
        const [stops] = await pool.query(
            `SELECT * FROM lazy_swing_trade_stops
             WHERE trade_id = ?
             ORDER BY created_at DESC`,
            [tradeId]
        );

        let triggeredStopId = null;
        const expectedStopType = stopType === 'DC' ? 'daily' : 'weekly';

        if (stops.length > 0) {
            // Find the stop that matches this event by type (must match exactly)
            const matchingStop = stops.find(s => s.stop_type === expectedStopType);

            if (matchingStop) {
                triggeredStopId = matchingStop.id;
                console.log(`Identified stop ID ${triggeredStopId} (${matchingStop.stop_type}) was triggered`);
            } else {
                console.warn(`⚠️ No ${expectedStopType} stop found for trade ${tradeId} (has ${stops.map(s => s.stop_type).join(', ')}), cannot mark stop as triggered`);
            }
        } else {
            console.warn(`⚠️ No stops found for trade ${tradeId}, cannot mark stop as triggered`);
        }

        // ============================================================
        // 4. MARK STOP AS TRIGGERED — Update stop record with timestamp
        // ============================================================
        if (triggeredStopId) {
            await pool.query(
                `UPDATE lazy_swing_trade_stops
                 SET triggered_at = NOW()
                 WHERE id = ? AND triggered_at IS NULL`,
                [triggeredStopId]
            );
            console.log(`Marked stop ${triggeredStopId} as triggered`);
        }

        // ============================================================
        // 5. SEND MEMBER ALERT — Urgent notification of stop hit
        // ============================================================
        await publishAlert({
            symbol,
            eventType: 'stop-out',
            data: { stopLevel, currentPrice, lossAmount, lossPercent }
        });

        // ============================================================
        // 6. CLOSE TRADE — Mark as stopped out
        // ============================================================
        const closeNotes = `Stop hit at ${currentPrice} (${stopType}, stop was ${stopLevel}, loss: ${lossPercent}%)`;

        await closeTrade(
            tradeId,
            symbol,
            'stopped_out',
            closeNotes,
            pool
        );

        console.log(`Trade ${tradeId}: ${tradeName} closed - stopped out at ${currentPrice}`);

    } catch (error) {
        console.error('Error processing stop-out event:', error);
        throw error;
    }
}