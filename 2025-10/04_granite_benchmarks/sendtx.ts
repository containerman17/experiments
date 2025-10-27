import { createWalletClient, createPublicClient, http, parseEther, keccak256, toHex, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getBalance } from 'viem/actions';
import { defineChain } from 'viem';
import { Worker } from 'worker_threads';

const rpcUrl = "http://localhost:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/rpc";
const wsUrl = rpcUrl.replace('http', 'ws').replace('/rpc', '/ws');
const SEND_AMOUNT = parseEther("1");

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

for (let i = 0; i < 10; i++) {
    const targetPrivateKey = getDeterministicPrivateKey(i);
    const targetAccount = privateKeyToAccount(targetPrivateKey);
    privateKeys.push(targetPrivateKey);

    const balance = await getBalance(client, { address: targetAccount.address });

    if (balance < SEND_AMOUNT / 2n) {
        const hash = await client.sendTransaction({
            to: targetAccount.address,
            value: SEND_AMOUNT,
        });
        console.log(`Sent 1 AVAX to wallet ${i} (${targetAccount.address}): ${hash}`);
    } else {
        console.log(`Skipped wallet ${i} (${targetAccount.address}): balance ${balance} >= ${SEND_AMOUNT / 2n}`);
    }
}

console.log("\nFunding complete. Starting workers...\n");

const workers: Worker[] = [];

for (let i = 0; i < privateKeys.length; i += 2) {
    const workerId = i / 2;
    const worker = new Worker('./worker-thread.ts', {
        workerData: {
            privateKey1: privateKeys[i],
            privateKey2: privateKeys[i + 1],
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

let lastBlockTime = Date.now();

publicClient.watchBlocks({
    onBlock: async (block) => {
        const now = Date.now();
        const timeSinceLastBlock = now - lastBlockTime;
        lastBlockTime = now;

        const transactions = Array.isArray(block.transactions) ? block.transactions : [];
        let minedHashes: string[];

        if (transactions.length > 0 && typeof transactions[0] === 'string') {
            minedHashes = transactions as unknown as string[];
        } else {
            minedHashes = transactions.map((tx: any) => tx.hash as string);
        }

        const txCount = minedHashes.length;

        console.log(`Block #${block.number}: ${txCount} txs (${timeSinceLastBlock}ms since last block)`);

        workers.forEach(worker => {
            worker.postMessage({ type: 'mined', hashes: minedHashes });
        });
    },
    includeTransactions: true,
});

process.on('SIGINT', () => {
    console.log('\nShutting down workers...');
    workers.forEach(worker => worker.terminate());
    process.exit(0);
});
