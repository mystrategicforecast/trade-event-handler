import { CloudTasksClient } from '@google-cloud/tasks';

let tasksClient;

function getTasksClient() {
    if (!tasksClient) {
        tasksClient = new CloudTasksClient();
    }
    return tasksClient;
}

export async function sendToPromoSystem(tradeData, stage = 'entry') {
    try {
        const client = getTasksClient();

        // Configure your queue (you'll need to create this queue in GCP)
        const project = process.env.GOOGLE_CLOUD_PROJECT || 'cloud-functions-441521';
        const location = 'us-east1';
        const queue = 'promo-system-queue';
        const parent = client.queuePath(project, location, queue);

        // GAS endpoint URL with stage parameter
        const gasUrl = `https://script.google.com/macros/s/AKfycbxgiqUG-pNNrkJFM7J6nwGotJZE_GwV19xffg3m-mK8Qp3zEmVzPXDilNivcjRtNKoP/exec?func=${stage}`;

        // Format payload to match your GAS expectations
        const payload = {
            trade: {
                "Symbol": tradeData.symbol,
                "Long / Short": tradeData.direction,
                "% Profit/Loss": tradeData.pctProfitLoss || null,
                "Profit 1": tradeData.profit1?.toString() || null,
                "Profit 2": tradeData.profit2?.toString() || null,
                "Stop Price": tradeData.stopPrice || null
            },
            testMode: process.env.PROMO_TEST_MODE === 'true'
        };

        const task = {
            httpRequest: {
                httpMethod: 'POST',
                url: gasUrl,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: Buffer.from(JSON.stringify(payload)).toString('base64')
            }
        };

        // Create the task
        const [response] = await client.createTask({ parent, task });
        console.log('Promo task created:', stage, 'for', tradeData.symbol, '- Task name:', response.name);
    } catch (error) {
        console.error('Error creating promo task:', error);
        // Don't throw - we don't want promo system issues to break main flow
    }
}