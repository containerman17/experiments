const { createWalletClient, http, parseEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { defineChain } = require('viem');

const testPrivateKey = "0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027";
const rpcUrl = "http://localhost:9650/ext/bc/2ZKgmUCP3dELg7uWqGeMdQiVGA79KGP7aCyVR8L8H6CZQiNFQp/rpc";
const destinationAddress = "0x643F2454430E218750b5e6533d9C0e0Dd50B8d68";

const customChain = defineChain({
    id: 112233,
    name: 'Granite benchmark chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: {
        default: { http: [rpcUrl] },
    },
});

const account = privateKeyToAccount(testPrivateKey);

const client = createWalletClient({
    account,
    chain: customChain,
    transport: http(rpcUrl),
});

const hash = await client.sendTransaction({
    to: destinationAddress,
    value: 10n,
});

console.log("Transaction hash:", hash);

