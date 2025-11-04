import { createWalletClient, createPublicClient, http, parseEther, keccak256, toHex, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getBalance } from 'viem/actions';
import { defineChain } from 'viem';
import { Worker } from 'worker_threads';

const rpcUrl = "http://3.113.2.23:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/rpc";
const wsUrl = rpcUrl.replace('http', 'ws').replace('/rpc', '/ws');
const SEND_AMOUNT = parseEther("1");
const WALLETS_PER_WORKER = 200;
const TOTAL_WALLETS = 14000;

function getDeterministicPrivateKey(index: number): `0x${string}` {
    return keccak256(toHex(`benchmark_secret_${index}`));
}

const customChain = defineChain({
    id: 112233,
    name: 'Granite benchmark chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: {
        default: { http: [rpcUrl] },
    },
});

const seedPrivateKey = "0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027";
const seedAccount = privateKeyToAccount(seedPrivateKey);

console.log("Seed private key:", seedPrivateKey);
console.log("Seed address:", seedAccount.address);

const client = createWalletClient({
    account: seedAccount,
    chain: customChain,
    transport: http(rpcUrl),
});

const privateKeys: `0x${string}`[] = [];
const accounts: { privateKey: `0x${string}`; address: `0x${string}`; index: number }[] = [];

// Generate all accounts
for (let i = 0; i < TOTAL_WALLETS; i++) {
    const targetPrivateKey = getDeterministicPrivateKey(i);
    const targetAccount = privateKeyToAccount(targetPrivateKey);
    privateKeys.push(targetPrivateKey);
    accounts.push({ privateKey: targetPrivateKey, address: targetAccount.address, index: i });
}

console.log(`Checking balances for ${TOTAL_WALLETS} wallets in parallel...`);

// Check all balances in parallel
const balanceChecks = await Promise.all(
    accounts.map(async (acc) => {
        const balance = await getBalance(client, { address: acc.address });
        return { ...acc, balance };
    })
);

console.log(`Balance checks complete. Sending transactions...`);

// Send transactions sequentially for wallets that need funding
for (const { address, balance, index } of balanceChecks) {
    if (balance < SEND_AMOUNT / 2n) {
        const hash = await client.sendTransaction({
            to: address,
            value: SEND_AMOUNT,
        });
        if (index % 100 === 0) {
            console.log(`Sent 1 AVAX to wallet ${index} (${address}): ${hash}`);
        }
    } else {
        if (index % 100 === 0) {
            console.log(`Skipped wallet ${index} (${address}): balance ${balance} >= ${SEND_AMOUNT / 2n}`);
        }
    }
}

console.log("\nFunding complete. Starting workers...\n");

const workers: Worker[] = [];

for (let i = 0; i < privateKeys.length; i += WALLETS_PER_WORKER) {
    const workerId = i / WALLETS_PER_WORKER;
    const workerKeys = privateKeys.slice(i, i + WALLETS_PER_WORKER);

    const worker = new Worker('./worker-thread.ts', {
        workerData: {
            privateKeys: workerKeys,
            workerId
        }
    });

    workers.push(worker);
}

const publicClient = createPublicClient({
    chain: customChain,
    transport: webSocket(wsUrl),
});

console.log("Watching for new blocks...\n");

let lastBlockTime: number | null = null;

const blockTimes: number[] = [];
const blockTxCounts: number[] = [];

publicClient.watchBlocks({
    onBlock: async (block) => {
        const timestampMs = parseInt(block.timestampMilliseconds as string, 16);
        const timeSinceLastBlock = lastBlockTime !== null ? timestampMs - lastBlockTime : 0;
        lastBlockTime = timestampMs;

        const transactions = Array.isArray(block.transactions) ? block.transactions : [];
        let minedHashes: string[];

        if (transactions.length > 0 && typeof transactions[0] === 'string') {
            minedHashes = transactions as unknown as string[];
        } else {
            minedHashes = transactions.map((tx: any) => tx.hash as string);
        }

        const txCount = minedHashes.length;
        blockTimes.push(timestampMs);
        blockTxCounts.push(txCount);

        const cutoff = timestampMs - 10000;
        while (blockTimes.length > 0 && blockTimes[0] < cutoff) {
            blockTimes.shift();
            blockTxCounts.shift();
        }

        const totalTxs = blockTxCounts.reduce((sum, count) => sum + count, 0);
        const tps = totalTxs / 10;

        console.log(`Block #${block.number}: ${txCount} txs (${timeSinceLastBlock}ms since last block) | ${blockTimes.length} blocks in last 10s | ${tps.toFixed(1)} TPS`);

        workers.forEach(worker => {
            worker.postMessage({ type: 'mined', hashes: minedHashes });
        });
    },
    includeTransactions: false,
});

process.on('SIGINT', () => {
    console.log('\nShutting down workers...');
    workers.forEach(worker => worker.terminate());
    process.exit(0);
});
