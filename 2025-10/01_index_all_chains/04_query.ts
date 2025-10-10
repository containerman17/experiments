import { createClient as createClickHouseClient } from '@clickhouse/client';

const CLICKHOUSE_HOST = 'http://localhost:8123';
const CLICKHOUSE_DATABASE = 'default';
const CLICKHOUSE_PASSWORD = 'nopassword';

const clickhouse = createClickHouseClient({
    host: CLICKHOUSE_HOST,
    database: CLICKHOUSE_DATABASE,
    password: CLICKHOUSE_PASSWORD,
});

console.log('Starting queries...\n');

// Query 1: Total rows in traces table
const countStart = Date.now();
const countResult = await clickhouse.query({
    query: 'SELECT COUNT(*) as total FROM traces',
});
const countData = await countResult.json<{ total: string }>();
const totalRows = countData.data[0]?.total || '0';
const countTime = Date.now() - countStart;

console.log(`Total rows in traces table: ${Math.round(parseInt(totalRows) / 1000000)}M`);
console.log(`Count query took: ${countTime}ms\n`);

// Query 2: Total net_gas by address (from field)
console.log('Querying net_gas by address...');
const gasStart = Date.now();
const gasResult = await clickhouse.query({
    query: `
        SELECT 
            lower(hex(from)) as address,
            SUM(net_gas) as total_net_gas,
            COUNT(*) as trace_count
        FROM traces
        GROUP BY from
        ORDER BY total_net_gas DESC
        LIMIT 100
    `,
});
const gasData = await gasResult.json<{
    address: string;
    total_net_gas: string;
    trace_count: string;
}>();
const gasTime = Date.now() - gasStart;

console.log(`\nTop 5 addresses by net_gas spent:`);
console.log(`Query took: ${gasTime}ms\n`);
console.log('Address'.padEnd(44) + 'Total Net Gas'.padStart(20) + 'Trace Count'.padStart(15));
console.log('-'.repeat(79));

for (const row of gasData.data.slice(0, 5)) {
    const addr = '0x' + row.address;
    const gas = parseInt(row.total_net_gas).toLocaleString();
    const count = parseInt(row.trace_count).toLocaleString();
    console.log(addr.padEnd(44) + gas.padStart(20) + count.padStart(15));
}

// Query 3: Count unique tx_hash
console.log('\nCounting unique tx_hash...');
const txHashStart = Date.now();
const txHashResult = await clickhouse.query({
    query: 'SELECT COUNT(DISTINCT tx_hash) as unique_tx_hash FROM traces',
});
const txHashData = await txHashResult.json<{ unique_tx_hash: string }>();
const uniqueTxHash = txHashData.data[0]?.unique_tx_hash || '0';
const txHashTime = Date.now() - txHashStart;

console.log(`Unique tx_hash count: ${parseInt(uniqueTxHash).toLocaleString()}`);
console.log(`Query took: ${txHashTime}ms`);

// Query 4: Count unique block numbers
console.log('\nCounting unique block numbers...');
const blockStart = Date.now();
const blockResult = await clickhouse.query({
    query: 'SELECT COUNT(DISTINCT block_number) as unique_blocks FROM traces',
});
const blockData = await blockResult.json<{ unique_blocks: string }>();
const uniqueBlocks = blockData.data[0]?.unique_blocks || '0';
const blockTime = Date.now() - blockStart;

console.log(`Unique block numbers count: ${parseInt(uniqueBlocks).toLocaleString()}`);
console.log(`Query took: ${blockTime}ms`);

console.log(`\n${'='.repeat(79)}`);
console.log(`Total unique addresses in result: ${gasData.data.length}`);
console.log(`Total query time: ${countTime + gasTime + txHashTime + blockTime}ms`);

await clickhouse.close();

