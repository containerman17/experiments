import { createPublicClient, webSocket, http } from 'viem';
import { Table } from 'console-table-printer';
import { getProviderConfigs, TEST_TIME } from './config.ts';
import { median } from './math.ts';

const delays: Map<string, number[]> = new Map();


for (const config of getProviderConfigs()) {
    delays.set(config.name, []);

    const client = createPublicClient({
        transport: config.url.startsWith('ws') ? webSocket(config.url) : http(config.url)
    });

    client.watchBlockNumber({
        pollingInterval: config.url.startsWith('ws') ? undefined : 200,
        onBlockNumber: async (blockNumber: bigint) => {
            const block = await client.getBlock({
                blockNumber: blockNumber
            });

            const delay = Date.now() - Number(block.timestamp) * 1000;
            delays.get(config.name)?.push(delay);
        }
    });
}

setInterval(() => {
    const table = new Table();
    for (const [name, delayArr] of delays) {
        if (delayArr.length === 0) {
            table.addRow({ name, min: '-', median: '-', avg: '-', max: '-', samples: '-' });
            continue;
        }
        const min = Math.min(...delayArr);
        const max = Math.max(...delayArr);
        const med = median(delayArr);
        const avg = Math.round(delayArr.reduce((a, b) => a + b, 0) / delayArr.length);
        table.addRow({ name, min, median: med, avg, max, samples: delayArr.length });
    }
    table.printTable();
}, 1000);
