import { PubSub } from '@google-cloud/pubsub';

let pubsubClient;

function getPubSubClient() {
    if (!pubsubClient) {
        pubsubClient = new PubSub();
    }
    return pubsubClient;
}

export async function publishAlert(alertData) {
    try {
        const pubsub = getPubSubClient();
        const topic = pubsub.topic('alerts');

        // ============================================================
        // SAFETY: Test mode enabled by default
        // Set ALERTS_TEST_MODE=false to send to all users (DANGEROUS)
        // ============================================================
        const testUserOnly = process.env.ALERTS_TEST_MODE !== 'false';

        // Format message for send-alerts GCF
        const alertMessage = {
            newHits: [
                {
                    ticker: alertData.symbol,
                    hitNumber: alertData.data.entryLevel || alertData.data.profitLevel || null
                }
            ],
            alertType: getAlertType(alertData.eventType),
            channels: ['email', 'sms'],
            options: {
                testUserOnly
            }
        };

        const messageBuffer = Buffer.from(JSON.stringify(alertMessage));

        // ============================================================
        // ALERTS DISABLED - Uncomment below to enable alert publishing
        // ============================================================
        // await topic.publishMessage({ data: messageBuffer });

        console.log('Alert prepared (NOT PUBLISHED):', {
            eventType: alertData.eventType,
            symbol: alertData.symbol,
            testUserOnly
        });
    } catch (error) {
        console.error('Error publishing alert:', error);
        throw error;
    }
}

function getAlertType(eventType) {
    switch (eventType) {
        case 'entry-hit':
            return 'entry target';
        case 'profit-hit':
            return 'profit target';
        case 'stop-out':
            return 'stop price';
        case 'stop-warning':
            return 'stop warning';
        default:
            return 'entry target'; // Default fallback
    }
}