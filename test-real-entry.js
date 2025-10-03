// Test the actual entry handler function
// Make sure you have a valid tradeId in your database first!

import 'dotenv/config';
import { handleEntryEvent } from './handlers/entry.js';
import mysql from 'mysql2/promise';

const dbConfig = {
    user: process.env.DB_USER || 'prod2',
    password: process.env.DB_PASS || 'UnCAyyVACM',
    database: process.env.DB_NAME || 'main',
    host: '35.229.104.1',
    port: 3306,
    connectTimeout: 10000,
    ssl: false, // Disable SSL to avoid deprecation warning with IP addresses
    waitForConnections: true,
    connectionLimit: 5
};

const mockEvent = {
    symbol: "AAPL",
    eventType: "entry-hit",
    tradeId: 1,
    direction: "Long",
    data: {
        entryLevel: 1,
        entryThreshold: 150.7,
        price: 150.52
    }
};

async function testEntryHandler() {
    console.log('🚀 Starting test...');

    // You can set breakpoints here and step through without DB timeout
    console.log('Mock event:', JSON.stringify(mockEvent, null, 2));

    let pool;
    try {
        // Create connection right before we need it
        console.log('Creating database connection...');
        pool = mysql.createPool(dbConfig);

        console.log('Testing database connection...');
        const [rows] = await pool.query('SELECT 1 as test');
        console.log('✅ Database connected successfully:', rows);

        console.log('Testing entry handler with real DB...');
        await handleEntryEvent(mockEvent, pool);
        console.log('✅ Test completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error);
        console.error('Error stack:', error.stack);
    } finally {
        if (pool) {
            await pool.end();
            console.log('🏁 Test finished, connection closed');
        }
    }
}

console.log('About to start test...');
testEntryHandler()
    .then(() => console.log('Test function completed'))
    .catch(err => console.error('Test function error:', err));