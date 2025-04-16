#!/usr/bin/env bun

import dotenv from 'dotenv';
import { createPublicClient, http, formatUnits } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { utils, secp256k1, pvm } from '@avalabs/avalanchejs';
import { Buffer as BufferPolyfill } from 'buffer'; // Needed by avalanchejs in some environments
import { Address } from 'micro-eth-signer';

// Assign Buffer to global scope if needed by avalanchejs
global.Buffer = BufferPolyfill;

dotenv.config(); // Load environment variables from .env file

const seedPrivateKeyHex = process.env.SEED_PRIVATE_KEY_HEX || ""
const privateKey = utils.hexToBuffer(seedPrivateKeyHex)

const publicKey = secp256k1.getPublicKey(privateKey);

const address = utils.formatBech32(
    'fuji',
    secp256k1.publicKeyBytesToAddress(publicKey),
);

const cChainAddress = Address.fromPublicKey(publicKey) as `0x${string}`;
const pChainAddress = `P-${address}`
console.log('Your P-Chain Address:', pChainAddress);
console.log('Your C-Chain Address:', cChainAddress);

const viemClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(),
});


const pvmApi = new pvm.PVMApi("https://api.avax-test.network");
const balance = await pvmApi.getBalance({
    addresses: [pChainAddress],
})

console.log('P Chain Balance:', formatUnits(balance.balance, 9), 'AVAX');
console.log('Import the private key into Core and transfer some Fuji AVAX to P-Chain Address to continue');
