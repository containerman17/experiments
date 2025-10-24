import { createWalletClient, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import { parentPort, workerData } from 'worker_threads';

const wsUrl = "ws://localhost:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/ws";

const customChain = defineChain({
    id: 112233,
    name: 'Granite benchmark chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: {
        default: { http: [] },
    },
});

const { privateKey1, privateKey2, workerId } = workerData as {
    privateKey1: `0x${string}`,
    privateKey2: `0x${string}`,
    workerId: number
};

const account1 = privateKeyToAccount(privateKey1);
const account2 = privateKeyToAccount(privateKey2);

const client1 = createWalletClient({
    account: account1,
    chain: customChain,
    transport: webSocket(wsUrl),
});

const client2 = createWalletClient({
    account: account2,
    chain: customChain,
    transport: webSocket(wsUrl),
});

console.log(`Worker ${workerId} started: ${account1.address} <-> ${account2.address}`);

let txCount = 0;

async function waitForConfirmation(hash: string, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
        const listener = (msg: any) => {
            if (msg.type === 'mined' && msg.hashes.includes(hash)) {
                clearTimeout(timer);
                parentPort?.off('message', listener);
                resolve(true);
            }
        };

        const timer = setTimeout(() => {
            parentPort?.off('message', listener);
            resolve(false);
        }, timeout);

        parentPort?.on('message', listener);
    });
}

(async () => {
    while (true) {
        const randomAmount = BigInt(Math.floor(Math.random() * 1000000) + 1);

        const hash1 = await client1.sendTransaction({
            to: account2.address,
            value: randomAmount,
        });

        await waitForConfirmation(hash1, 30000);

        txCount++;

        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));

        const randomAmount2 = BigInt(Math.floor(Math.random() * 1000000) + 1);

        const hash2 = await client2.sendTransaction({
            to: account1.address,
            value: randomAmount2,
        });

        await waitForConfirmation(hash2, 30000);

        txCount++;

        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
    }
})();
