#!/usr/bin/env bun

import { formatUnits } from 'viem';
import { loadPrivateKey, pvmApi, getPChainAddress } from './lib';

const privateKey = loadPrivateKey()
const pChainAddress = getPChainAddress(privateKey)
console.log('Your P-Chain Address:', pChainAddress);

const balance = await pvmApi.getBalance({
    addresses: [pChainAddress],
})

console.log('P Chain Balance:', formatUnits(balance.balance, 9), 'AVAX');
if (balance.balance === BigInt(0)) {
    console.log('Import the private key into Core and transfer some Fuji AVAX to P-Chain Address to continue');
}


