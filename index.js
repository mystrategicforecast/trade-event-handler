import functions from '@google-cloud/functions-framework';
import fetch from 'node-fetch';
import mysql from 'mysql2/promise';
import { handleEntryEvent } from './handlers/entry.js';
import { handleProfitEvent } from './handlers/profit.js';
import { handleStopWarningEvent, handleStopOutEvent } from './handlers/stop.js';
import { handleJumpEvent } from './handlers/jump.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Database config for Cloud SQL
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    socketPath: '/cloudsql/cloud-functions-441521:us-east1:inside-the-numbers-prod',
    waitForConnections: true,
    connectionLimit: 10
};

let pool;

async function getPool() {
    if (!pool) {
        pool = mysql.createPool(dbConfig);
    }
    return pool;
}

// Register the Pub/Sub triggered function
functions.cloudEvent('handleTradeEvent', async (cloudEvent) => {
    try {
        // Parse the Pub/Sub message
        const eventData = JSON.parse(
            Buffer.from(cloudEvent.data.message.data, 'base64').toString()
        );

        console.log('Received event:', JSON.stringify(eventData));

        // Start timing
        const startTime = Date.now();

        // Send Slack notification
        const slackMessage = buildSlackMessage(eventData);
        await postToSlack(slackMessage);

        // Route to specific handler based on event type
        const pool = await getPool();

        switch (eventData.eventType) {
            case 'entry-hit':
                await handleEntryEvent(eventData, pool);
                break;
            case 'profit-hit':
                await handleProfitEvent(eventData, pool);
                break;
            case 'stop-out':
                await handleStopOutEvent(eventData, pool);
                break;
            case 'stop-warning':
                await handleStopWarningEvent(eventData, pool);
                break;
            case 'jump-target':
                await handleJumpEvent(eventData, pool);
                break;
            default:
                console.log(`Unknown event type: ${eventData.eventType}`);
                // Already logged above
        }

        // Calculate execution time and log to database
        const executionTimeMs = Date.now() - startTime;
        await logEventToDatabase(eventData, executionTimeMs);

        console.log('Event processed successfully in', executionTimeMs, 'ms');
    } catch (error) {
        console.error('Error processing event:', error);
        // Cloud Functions will automatically retry on error
        throw error;
    }
});



function buildSlackMessage(event) {
    const { symbol, eventType, direction, data } = event;

    switch (eventType) {
        case 'jump-target':
            const levels = data.jumpedEntries.map(e => e.entryLevel).join(', ');
            return `🎯 Jump: ${symbol} ${direction} opened at ${data.openPrice}, jumped entries: ${levels}`;

        case 'entry-hit':
            return `📈 ${symbol} (${direction}) crossed entry_${data.entryLevel} (${data.entryThreshold})`;

        case 'profit-hit':
            return `💰 Profit ${data.profitLevel} hit: ${symbol} ${direction} at ${data.profitThreshold}`;

        case 'stop-out':
            return `🛑 Stop out: ${symbol} ${direction} at ${data.stopPrice}`;
            
        case 'stop-warning':
            return `⚠️ Stop warning: ${symbol} ${direction} at ${data.stopPrice}`;

        case 'reset-detected':
            return `🔄 Reset: ${symbol} ${direction} - ${data.resetReason}`;

        default:
            return `📊 ${eventType}: ${symbol} ${direction}`;
    }
}

async function postToSlack(message) {
    const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
    });

    if (!response.ok) {
        const error = `Slack webhook failed: ${response.status}`;
        console.error(error);
        throw new Error(error);
    }

    console.log('Slack notification sent:', message);
}

async function logEventToDatabase(event, executionTimeMs) {
    try {
        const pool = await getPool();

        const eventTypeMap = {
            'jump-target': 'entry',
            'entry-hit': 'entry',
            'profit-hit': 'profit',
            'stop-hit': 'stop',
            'reset-detected': 'reset'
        };

        const [result] = await pool.query(
            `INSERT INTO lazy_swing_trade_events
       (trade_id, symbol, event_type, target_number, price, notes, execution_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                event.tradeId || null,
                event.symbol,
                eventTypeMap[event.eventType] || 'entry',
                event.data.entryLevel || event.data.profitLevel || null,
                event.data.entryThreshold || event.data.profitTarget || event.data.stopPrice || null,
                buildSlackMessage(event),
                executionTimeMs
            ]
        );

        console.log('Event logged to database with execution time:', executionTimeMs, 'ms - insert ID:', result.insertId);
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    }
}