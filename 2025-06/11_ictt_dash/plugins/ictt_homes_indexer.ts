import { type IndexingPlugin, abiUtils, encodingUtils, evmTypes, viem } from "frostbyte-sdk";
import ERC20TokenHome from './abi/ERC20TokenHome.abi.json';
import type { ContractHomeData, RemoteData } from './types/ictt.types';

interface ContractHomeRow {
    address: string;
    data: string; // JSON string from SQLite
}

/**
 * Decodes constructor parameters from a contract creation transaction
 * @param txInput - The full transaction input data (bytecode + constructor params)
 * @param abi - The contract ABI
 * @returns Decoded constructor parameters or null if decoding fails
 */
const decodeConstructorParams = (txInput: string, abi: viem.Abi): any[] | null => {
    // Find the constructor in the ABI
    const constructorAbi = abi.find(
        (item) => item.type === 'constructor'
    ) as viem.AbiItem & { inputs?: viem.AbiParameter[] };

    if (!constructorAbi || !constructorAbi.inputs || constructorAbi.inputs.length === 0) {
        console.error("Constructor ABI not found or has no inputs");
        return null;
    }

    // For simple types (address, uint, etc), each parameter is 32 bytes (64 hex chars)
    // This is a simplified approach that works for most cases
    // TODO: Handle dynamic types (strings, arrays) properly
    const constructorParamsLength = constructorAbi.inputs.length * 64;

    // Extract constructor params from the end of the input
    const constructorParams = `0x${txInput.slice(-constructorParamsLength)}` as `0x${string}`;

    // Decode the constructor parameters
    const decoded = viem.decodeAbiParameters(
        constructorAbi.inputs,
        constructorParams
    );

    return decoded;
};


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

        const debugContractsToCoins: Map<string, string> = new Map();


        for (const tx of batch.txs) {
            const originalTx = tx.tx;
            const txReceipt = tx.receipt;


            // First, try to check if this is a contract creation
            if (tx.receipt.contractAddress) {
                // Try to decode constructor parameters from deployment transaction
                let decoded: any[] | null = null;
                try {
                    decoded = decodeConstructorParams(originalTx.input as string, ERC20TokenHome as viem.Abi);
                } catch (error) {
                    //skip
                }

                if (tx.receipt.contractAddress.toLowerCase() === '0xbd00e449d05af4210ef9e8bd535d32377dcc1bb9') {
                    console.log(`------------ Well, this is a contract creation`, { decoded, contractAddress: tx.receipt.contractAddress });
                }

                if (decoded && decoded.length === 5 && decoded[4] < 1000) {
                    const [, , , tokenAddress, tokenDecimals] = decoded;
                    // console.log(`------------ Home ${tx.receipt.contractAddress} represents ${tokenAddress} with ${tokenDecimals} decimals`);

                    debugContractsToCoins.set(tx.receipt.contractAddress!.toLowerCase(), tokenAddress.toLowerCase() as string);


                    // Store the deployment data
                    deployments.push({
                        contractAddress: txReceipt.contractAddress!,
                        coinAddress: tokenAddress as string,
                        tokenDecimals: Number(tokenDecimals)
                    });
                }
            }


            // Now check for typical contract home events
            for (const log of tx.receipt.logs) {
                const eventName = events.get(log.topics[0] || "");
                if (!eventName) continue;

                console.log("------------ eventName", eventName);

                const contractAddress = log.address.toLowerCase();

                if (eventName === "RemoteRegistered") {
                    const event = decodeRemoteRegistered(log as unknown as viem.Log);
                    const remoteBlockchainId = encodingUtils.hexToCB58(event.remoteBlockchainID);
                    const remoteTokenAddress = event.remoteTokenTransferrerAddress.toLowerCase();

                    if (debugContractsToCoins.has(contractAddress)) {
                        const coinAddress = debugContractsToCoins.get(contractAddress)!;
                        console.log(`--------------- Got RemoteRegistered WITH coinAddress`, { contractAddress, remoteBlockchainId, remoteTokenAddress, coinAddress });
                    } else {
                        console.log(`--------------- Got RemoteRegistered WITHOUT coinAddress`, { contractAddress, remoteBlockchainId, remoteTokenAddress });
                    }

                }
            }

        }
        console.log(`------------ debugContractsToCoins`, debugContractsToCoins);

    }

}

export default module;
