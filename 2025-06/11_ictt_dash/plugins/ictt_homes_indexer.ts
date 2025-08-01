import { type IndexingPlugin, abiUtils, encodingUtils, evmTypes, viem } from "frostbyte-sdk";
import ERC20TokenHome from './abi/ERC20TokenHome.abi.json';
import type { ContractHomeData, RemoteData } from './types/ictt.types';

interface ContractHomeRow {
    address: string;
    data: string; // JSON string from SQLite
}


const decodeRemoteRegistered = (log: viem.Log) => {
    const args = viem.decodeEventLog({
        abi: ERC20TokenHome as abiUtils.AbiItem[],
        data: log.data,
        topics: log.topics,
    }).args as {
        remoteBlockchainID: string;
        remoteTokenTransferrerAddress: `0x${string}`;
        initialCollateralNeeded: bigint;
        tokenDecimals: number;
    };
    return {
        ...args,
        initialCollateralNeeded: args.initialCollateralNeeded !== 0n,
    };
}


const events: Map<string, string> = abiUtils.getEventHashesMap(ERC20TokenHome as abiUtils.AbiItem[]);
const eventHexes = Array.from(events.keys());


const module: IndexingPlugin = {
    name: "ictt_homes",
    version: Math.floor(Date.now()),
    usesTraces: false,
    filterEvents: [
        ...eventHexes,
        evmTypes.CONTRACT_CREATION_TOPIC
    ],

    initialize: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS contract_to_coin_home (
                contract_address BLOB NOT NULL,
                coin_address BLOB NOT NULL,
                token_decimals INTEGER NOT NULL,
                PRIMARY KEY (contract_address, coin_address)
            )
        `);
    },

    handleTxBatch: (db, blocksDb, batch) => {
        console.log('------------ handleTxBatch ictt_homes', batch.txs.length);
        const deployments: Array<{ contractAddress: string; coinAddress: string; tokenDecimals: number }> = [];

        for (const tx of batch.txs) {
            const originalTx = tx.tx;
            const txReceipt = tx.receipt;

            if (tx.receipt.contractAddress === "0x5260d9ef1f31f11a5f289dd79e032cfc3aa85a1e") {
                console.log(tx);

                try {
                    // Get the constructor ABI
                    const constructorAbi = (ERC20TokenHome as viem.Abi).find(
                        (item) => item.type === 'constructor'
                    ) as viem.AbiConstructor;

                    if (!constructorAbi || !constructorAbi.inputs) {
                        console.error("Constructor ABI not found");
                        return;
                    }

                    // Constructor parameters are ABI-encoded, each parameter is 32 bytes
                    // 5 parameters = 160 bytes = 320 hex chars (plus 0x prefix)
                    const constructorParamsLength = constructorAbi.inputs.length * 64; // 32 bytes = 64 hex chars
                    const input = originalTx.input as string;

                    // Extract constructor params from the end of the input
                    const constructorParams = `0x${input.slice(-constructorParamsLength)}` as `0x${string}`;

                    // Decode the constructor parameters
                    const decoded = viem.decodeAbiParameters(
                        constructorAbi.inputs,
                        constructorParams
                    );

                    console.log("Decoded creation params for a well known contract 0x5260d9ef1f31f11a5f289dd79e032cfc3aa85a1e", {
                        teleporterRegistryAddress: decoded[0],
                        teleporterManager: decoded[1],
                        minTeleporterVersion: decoded[2],
                        tokenAddress: decoded[3],
                        tokenDecimals: decoded[4]
                    });

                    // Store the deployment data
                    deployments.push({
                        contractAddress: tx.receipt.contractAddress!,
                        coinAddress: decoded[3] as string,
                        tokenDecimals: Number(decoded[4])
                    });

                } catch (error) {
                    console.error("Failed to decode constructor params:", error);
                }
                return
            }

            // First, try to check if this is a contract creation
            if (originalTx.to === null && txReceipt.status === '0x1') {

                // Decode constructor parameters from deployment transaction
                try {
                    // The transaction input contains bytecode + encoded constructor params
                    // We need to decode just the constructor parameters at the end
                    const decoded = viem.decodeDeployData({
                        abi: ERC20TokenHome as viem.Abi,
                        bytecode: '0x', // We don't need to verify bytecode
                        data: originalTx.input as `0x${string}`
                    });


                    if (decoded.args && decoded.args.length >= 5 && decoded.bytecode !== '0x') {
                        console.log(decoded);

                        const [, , , tokenAddress, tokenDecimals] = decoded.args;

                        // Store the deployment data
                        deployments.push({
                            contractAddress: txReceipt.contractAddress!,
                            coinAddress: tokenAddress as string,
                            tokenDecimals: Number(tokenDecimals)
                        });
                    }
                } catch (error) {
                    // Not an ERC20TokenHome deployment or decoding failed
                }
            }


            // Now check for typical contract home events
            for (const log of tx.receipt.logs) {
                const eventName = events.get(log.topics[0] || "");
                if (!eventName) continue;

                const contractAddress = log.address.toLowerCase();

                if (eventName === "RemoteRegistered") {
                    const event = decodeRemoteRegistered(log as unknown as viem.Log);
                    const remoteBlockchainId = encodingUtils.hexToCB58(event.remoteBlockchainID);
                    const remoteTokenAddress = event.remoteTokenTransferrerAddress.toLowerCase();

                    console.log(`--------------- Got RemoteRegistered`, { contractAddress, remoteBlockchainId, remoteTokenAddress });
                }
            }
        }
    }
}

export default module;
