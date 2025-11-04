import { createWalletClient, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import { parentPort, workerData } from 'worker_threads';

const wsUrls = [
    "ws://3.113.2.23:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/ws",
    "ws://18.176.53.107:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/ws",
    "ws://13.159.18.104:9650/ext/bc/24zjPnjqpcyCUPqWe7d1kttyJZ5V9edLUGUJVBoGucQeiqAJws/ws"
];

const customChain = defineChain({
    id: 112233,
    name: 'Granite benchmark chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: {
        default: { http: [] },
    },
});

const { privateKeys, workerId } = workerData as {
    privateKeys: `0x${string}`[],
    workerId: number
};

if (parentPort) {
    parentPort.setMaxListeners(privateKeys.length + 10);
}


const accounts = privateKeys.map(pk => privateKeyToAccount(pk));
const clients = accounts.map((account, i) => createWalletClient({
    account,
    chain: customChain,
    transport: webSocket(wsUrls[i % wsUrls.length]),
}));

console.log(`Worker ${workerId} started with ${accounts.length} addresses`);

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
        const txPromises = clients.map((client, i) => {
            const nextIndex = (i + 1) % clients.length;
            const randomAmount = BigInt(Math.floor(Math.random() * 1000000) + 1);

            return client.sendTransaction({
                to: accounts[nextIndex].address,
                value: randomAmount,
            });
        });

        const hashes = await Promise.all(txPromises);

        await Promise.all(hashes.map(hash => waitForConfirmation(hash, 30000)));

        txCount += hashes.length;

        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 200));
    }
})();
