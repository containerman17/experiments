import * as fs from 'fs';
import * as path from 'path';

export function getNodeIps(): Record<string, string[]> {
    const nodes: Record<string, string[]> = {};
    const stateDir = 'terraform.tfstate.d';

    // Get all cluster directories
    const clusters = fs.readdirSync(stateDir)
        .filter(dir => fs.statSync(path.join(stateDir, dir)).isDirectory()).sort();

    for (const cluster of clusters) {
        const stateFilePath = path.join(stateDir, cluster, 'terraform.tfstate');

        try {
            if (fs.existsSync(stateFilePath)) {
                const stateFile = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));

                if (stateFile.outputs && stateFile.outputs.public_ips && stateFile.outputs.public_ips.value) {
                    // Extract IPs from the output value
                    const ips = Object.values(stateFile.outputs.public_ips.value) as string[];
                    nodes[cluster] = ips;
                }
            }
        } catch (error) {
            console.error(`Error reading state file for cluster ${cluster}:`, error);
        }
    }

    return nodes;
}

import { exec } from "child_process";
import { promisify } from "util";
import { Context, pvm, secp256k1, UnsignedTx, utils } from '@avalabs/avalanchejs';

const execAsync = promisify(exec);

export async function applyDockerCompose(ip: string, subnetId: string = ""): Promise<void> {
    console.log(`Deploying to node ${ip}...`);

    const sshKeyPath = path.resolve("./id_ed25519");

    try {
        // Ensure key has correct permissions
        await execAsync(`chmod 600 ${sshKeyPath}`);

        // Copy docker-compose.yml file to the node using the flags that worked
        console.log("Copying docker-compose.yml...");
        await execAsync(`scp -F /dev/null -o IdentitiesOnly=yes -i ${sshKeyPath} -o StrictHostKeyChecking=no docker-compose.yml ubuntu@${ip}:~/`);

        // Run docker-compose directly via SSH with subnetId variable
        console.log("Starting docker-compose...");
        await execAsync(`ssh -F /dev/null -o IdentitiesOnly=yes -i ${sshKeyPath} -o StrictHostKeyChecking=no ubuntu@${ip} "cd ~/ && export subnetId='${subnetId}' && docker compose up -d"`);

        console.log(`Successfully deployed to ${ip}`);
    } catch (error) {
        console.error(`Error deploying to ${ip}:`, error);
    }
}

export const RPC_ENDPOINT = "https://api.avax-test.network"

export function loadPrivateKey() {
    const seedPrivateKeyHex = process.env.SEED_PRIVATE_KEY_HEX || ""
    const privateKey = utils.hexToBuffer(seedPrivateKeyHex)
    return privateKey
}

export function getPChainAddress(privateKey: Uint8Array) {
    const publicKey = secp256k1.getPublicKey(privateKey);

    const address = utils.formatBech32(
        'fuji',
        secp256k1.publicKeyBytesToAddress(publicKey),
    );

    return `P-${address}`
}

export const addTxSignatures = async ({
    unsignedTx,
    privateKeys,
}: {
    unsignedTx: UnsignedTx;
    privateKeys: Uint8Array[];
}) => {
    const unsignedBytes = unsignedTx.toBytes();

    await Promise.all(
        privateKeys.map(async (privateKey) => {
            const publicKey = secp256k1.getPublicKey(privateKey);

            if (unsignedTx.hasPubkey(publicKey)) {
                console.log('has pubkey')
                const signature = await secp256k1.sign(unsignedBytes, privateKey);
                unsignedTx.addSignature(signature);
            } else {
                console.log('no pubkey')
            }
        }),
    );
};
