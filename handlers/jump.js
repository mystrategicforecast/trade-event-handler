import { closeTrade } from './reset.js';

export async function handleJumpEvent(event, pool) {
    const { symbol, tradeId, data, direction } = event;
    const { jumpedEntries = [], openPrice } = data;

    // Extract the THRESHOLD VALUES that were jumped (not just levels)
    const jumpedThresholds = jumpedEntries.map(e => parseFloat(e.entryThreshold));
    const jumpedLevels = jumpedEntries.map(e => e.entryLevel);
    console.log(`Processing jump-target event for ${symbol}, jumped entries: ${jumpedLevels.join(', ')} with thresholds: ${jumpedThresholds.join(', ')}`);

    try {
        // ============================================================
        // 1. GET TRADE DETAILS
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
        // 2. IDEMPOTENCY CHECK — Do these threshold values still exist?
        // ============================================================
        const currentThresholds = [
            parseFloat(trade.entry_1),
            parseFloat(trade.entry_2),
            parseFloat(trade.entry_3)
        ].filter(v => !isNaN(v));

        // Check if ANY of the jumped thresholds still exist in the trade
        // Using 0.00001 tolerance for crypto precision (supports up to 5 decimal places)
        const PRICE_TOLERANCE = 0.00001;
        const anyThresholdExists = jumpedThresholds.some(jumpedValue =>
            currentThresholds.some(currentValue => Math.abs(currentValue - jumpedValue) < PRICE_TOLERANCE)
        );

        if (!anyThresholdExists) {
            console.log(`None of the jumped thresholds (${jumpedThresholds.join(', ')}) exist in trade ${tradeId} anymore. Current: ${currentThresholds.join(', ')}. Skipping (already processed).`);
            return;
        }

        // ============================================================
        // 3. DETERMINE RIGHTMOST ENTRY
        // ============================================================
        let rightmostEntry = null;
        for (let i = 3; i >= 1; i--) {
            if (trade[`entry_${i}`] !== null) {
                rightmostEntry = i;
                break;
            }
        }

        console.log(`Rightmost entry for trade ${tradeId} (${tradeName}): entry_${rightmostEntry}`);

        // ============================================================
        // 4. CHECK IF RIGHTMOST ENTRY WAS JUMPED
        // ============================================================
        const rightmostValue = rightmostEntry ? parseFloat(trade[`entry_${rightmostEntry}`]) : null;
        const rightmostJumped = rightmostValue && jumpedThresholds.some(v => Math.abs(v - rightmostValue) < PRICE_TOLERANCE);

        if (rightmostJumped) {
            console.log(`⚠️  Rightmost entry (entry_${rightmostEntry}) was jumped`);

            // Check if any entries were filled
            const anyFilled = trade.entry_1_filled_at || trade.entry_2_filled_at || trade.entry_3_filled_at;

            if (!anyFilled) {
                // No entries filled → close the trade
                await closeTrade(
                    tradeId,
                    symbol,
                    'jumped',
                    `Rightmost entry (entry_${rightmostEntry}) jumped at ${openPrice} with no entries filled`,
                    pool
                );
                console.log(`Trade ${tradeId} closed - last entry jumped with no entries filled`);
            } else {
                // Has filled entries → keep active, continue monitoring
                console.log(`... but ${tradeName} has filled entries, continuing to monitor for profit/stop`);
            }
            return;
        }

        // ============================================================
        // 5. PROCESS ALL JUMPED ENTRIES AT ONCE (shift remaining entries)
        // ============================================================
        console.log(`Processing ${jumpedEntries.length} jumped thresholds: ${jumpedThresholds.join(', ')}`);

        // Collect remaining unfilled entries (value not in jumped list, not filled)
        const remainingUnfilled = [];
        for (let i = 1; i <= 3; i++) {
            const value = trade[`entry_${i}`];
            const filledAt = trade[`entry_${i}_filled_at`];

            if (value === null) continue;

            const valueFloat = parseFloat(value);
            const isJumped = jumpedThresholds.some(jumpedValue => Math.abs(jumpedValue - valueFloat) < PRICE_TOLERANCE);
            const isFilled = filledAt !== null;

            // Keep if: not in jumped list, not filled
            if (!isJumped && !isFilled) {
                remainingUnfilled.push({ level: i, value });
            }
        }

        console.log(`Remaining unfilled entries after removing jumped thresholds:`,
            remainingUnfilled.map(e => `entry_${e.level}=${e.value}`).join(', ') || 'none');

        // Build new entry values by shifting remaining entries left
        const newEntries = {
            entry_1: remainingUnfilled[0]?.value ?? null,
            entry_2: remainingUnfilled[1]?.value ?? null,
            entry_3: remainingUnfilled[2]?.value ?? null
        };

        // Update the trade with shifted entries (single database update)
        await pool.query(
            `UPDATE lazy_swing_trades
             SET entry_1 = ?, entry_2 = ?, entry_3 = ?
             WHERE id = ?`,
            [newEntries.entry_1, newEntries.entry_2, newEntries.entry_3, tradeId]
        );

        console.log(`✅ Shifted entries for trade ${tradeId}:`,
            `entry_1=${newEntries.entry_1}, entry_2=${newEntries.entry_2}, entry_3=${newEntries.entry_3}`);
        console.log(`Jump event processed successfully for ${symbol}`);

    } catch (error) {
        console.error('Error processing jump event:', error);
        throw error;
    }
}