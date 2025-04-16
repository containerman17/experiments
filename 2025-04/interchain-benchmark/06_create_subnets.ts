#!/usr/bin/env bun

import { pvm, utils } from "@avalabs/avalanchejs";
import { loadPrivateKey, getPChainAddress, pvmApi, context, feeState, addTxSignatures, getNodeIps } from "./lib";

const privateKey = loadPrivateKey()
const pChainAddress = getPChainAddress(privateKey)

const clusters = getNodeIps();

const clusterNames = Object.keys(clusters)

for (const clusterName of clusterNames) {
    const subnetId = await createSubnet(pChainAddress)
    console.log(`Created subnet ${subnetId} for cluster ${clusterName}`)
    await new Promise(resolve => setTimeout(resolve, 5000))
}

export async function createSubnet(pChainAddress: string) {
    const { utxos } = await pvmApi.getUTXOs({ addresses: [pChainAddress] });

    const testPAddr = utils.bech32ToBytes(pChainAddress);

    const tx = pvm.newCreateSubnetTx(
        {
            feeState,
            fromAddressesBytes: [testPAddr],
            utxos,
            subnetOwners: [testPAddr],
        },
        context,
    );

    await addTxSignatures({
        unsignedTx: tx,
        privateKeys: [privateKey],
    });

    return pvmApi.issueSignedTx(tx.getSignedTx()).then(tx => tx.txID)
}
