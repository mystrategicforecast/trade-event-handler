import { PubSub } from '@google-cloud/pubsub';

let pubsubClient;

function getPubSubClient() {
    if (!pubsubClient) {
        pubsubClient = new PubSub();
    }
    return pubsubClient;
}

/**
 * Close a trade and publish trade-deleted event to stop price tracking
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

        // Publish trade-deleted event to stop price worker tracking
        const pubsub = getPubSubClient();
        const topic = pubsub.topic('trade-event');

        const event = {
            eventType: 'trade-deleted',
            symbol,
            tradeId,
            timestamp: new Date().toISOString(),
            data: {
                outcome,
                reason: notes
            }
        };

        const messageBuffer = Buffer.from(JSON.stringify(event));
        await topic.publishMessage({ data: messageBuffer });

        console.log(`✅ Trade ${tradeId} (${symbol}) closed with outcome '${outcome}' and trade-deleted event published`);

    } catch (error) {
        console.error(`Error closing trade ${tradeId}:`, error);
        throw error;
    }
}

