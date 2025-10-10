import { createClient as createClickHouseClient } from '@clickhouse/client';

const CLICKHOUSE_HOST = 'http://localhost:8123';
const CLICKHOUSE_DATABASE = 'default';
const CLICKHOUSE_PASSWORD = 'nopassword';

// Create ClickHouse client
const clickhouse = createClickHouseClient({
    host: CLICKHOUSE_HOST,
    database: CLICKHOUSE_DATABASE,
    password: CLICKHOUSE_PASSWORD,
});

async function estimateDataSize() {
    console.log('='.repeat(60));
    console.log('Data Size Estimator');
    console.log('='.repeat(60));

    try {
        // Get total count of blocks
        const countResult = await clickhouse.query({
            query: 'SELECT count() as total_blocks FROM blocks_data',
        });
        const countData = await countResult.json<{ total_blocks: string }>();
        const totalBlocks = parseInt(countData.data[0].total_blocks, 10);

        console.log(`Total blocks in database: ${totalBlocks.toLocaleString()}`);

        if (totalBlocks === 0) {
            console.log('No data found in the database.');
            return;
        }

        // Get total size of data column (in bytes)
        const sizeResult = await clickhouse.query({
            query: 'SELECT sum(length(data)) as total_bytes FROM blocks_data',
        });
        const sizeData = await sizeResult.json<{ total_bytes: string }>();
        const totalBytes = parseInt(sizeData.data[0].total_bytes, 10);

        // Count total transactions
        console.log('Counting transactions...');
        const txCountResult = await clickhouse.query({
            query: `
                SELECT sum(length(JSONExtractArrayRaw(data, 'transactions'))) as total_txs
                FROM blocks_data
            `,
        });
        const txCountData = await txCountResult.json<{ total_txs: string }>();
        const totalTransactions = parseInt(txCountData.data[0].total_txs, 10);

        // Format bytes in human readable format
        function formatBytes(bytes: number): string {
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let size = bytes;
            let unitIndex = 0;

            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex++;
            }

            return `${size.toFixed(2)} ${units[unitIndex]}`;
        }

        // Calculate bytes per transaction
        const bytesPerTx = totalTransactions > 0 ? totalBytes / totalTransactions : 0;

        console.log('='.repeat(60));
        console.log('RESULTS');
        console.log('='.repeat(60));
        console.log(`Total blocks: ${totalBlocks.toLocaleString()}`);
        console.log(`Total transactions: ${totalTransactions.toLocaleString()}`);
        console.log(`Total data size: ${formatBytes(totalBytes)}`);
        console.log(`Bytes per transaction: ${formatBytes(bytesPerTx)}`);
        console.log('='.repeat(60));

    } catch (error) {
        console.error('Error estimating data size:', error);
    } finally {
        await clickhouse.close();
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await clickhouse.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await clickhouse.close();
    process.exit(0);
});

estimateDataSize().catch(async (error) => {
    console.error('Fatal error:', error);
    await clickhouse.close();
    process.exit(1);
});
