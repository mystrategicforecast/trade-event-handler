import { PubSub } from '@google-cloud/pubsub';

let pubsubClient;

function getPubSubClient() {
    if (!pubsubClient) {
        pubsubClient = new PubSub();
    }
    return pubsubClient;
}

/**
 * Close a trade and publish symbol-untrack event to stop price worker tracking
 *
 * @param {number} tradeId - Trade ID
 * @param {string} symbol - Stock symbol
 * @param {string} outcome - 'profit', 'stopped_out', 'jumped', 'manual_reset', 'expired'
 * @param {string} notes - Reason/notes for closing
 * @param {object} pool - Database connection pool
 */
export async function closeTrade(tradeId, symbol, outcome, notes, pool) {
    console.log(`Closing trade ${tradeId} (${symbol}) with outcome: ${outcome}`);

    try {
        // Update trade status to closed
        await pool.query(
            `UPDATE lazy_swing_trades
             SET status = 'closed',
                 outcome = ?,
                 closed_at = NOW(),
                 closed_notes = ?
             WHERE id = ?`,
            [outcome, notes, tradeId]
        );

        // Publish symbol-untrack event to stop price worker tracking
        const pubsub = getPubSubClient();
        const topic = pubsub.topic('symbol-untrack');

        const event = {
            symbol,
            timestamp: new Date().toISOString(),
            reason: outcome
        };

        const messageBuffer = Buffer.from(JSON.stringify(event));
        await topic.publishMessage({ data: messageBuffer });

        console.log(`✅ Trade ${tradeId} (${symbol}) closed with outcome '${outcome}' and symbol-untrack event published`);

    } catch (error) {
        console.error(`Error closing trade ${tradeId}:`, error);
        throw error;
    }
}

