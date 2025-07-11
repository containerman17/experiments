import { type IndexingPlugin, prepQueryCached } from "frostbyte-sdk";
import { keccak_256 } from '@noble/hashes/sha3';

const events: Map<string, string> = new Map()

function addEventSig(eventStr: string) {
    const hash = keccak_256(new TextEncoder().encode(eventStr));
    const hashHex = '0x' + Buffer.from(hash).toString('hex');
    const eventName = eventStr.split('(')[0];
    events.set(hashHex, eventName);
}

addEventSig('CallFailed(address,uint256)');
addEventSig('CallSucceeded(address,uint256)');
addEventSig('CollateralAdded(bytes32,address,uint256,uint256)');
addEventSig('Initialized(uint64)');
addEventSig('MinTeleporterVersionUpdated(uint256,uint256)');
addEventSig('OwnershipTransferred(address,address)');
addEventSig('RemoteRegistered(bytes32,address,uint256,uint8)');
addEventSig('TeleporterAddressPaused(address)');
addEventSig('TeleporterAddressUnpaused(address)');
addEventSig('TokensAndCallRouted(bytes32,(bytes32,address,address,bytes,uint256,uint256,address,address,address,uint256,uint256),uint256)');
addEventSig('TokensAndCallSent(bytes32,address,(bytes32,address,address,bytes,uint256,uint256,address,address,address,uint256,uint256),uint256)');
addEventSig('TokensRouted(bytes32,(bytes32,address,address,address,uint256,uint256,uint256,address),uint256)');
addEventSig('TokensSent(bytes32,address,(bytes32,address,address,address,uint256,uint256,uint256,address),uint256)');
addEventSig('TokensWithdrawn(address,uint256)');
addEventSig('TokensReceived(bytes32,address,address,address,uint256,bytes)');
addEventSig('Deposit(address,uint256)');
addEventSig('ReportBurnedTxFees(bytes32,uint256)');
addEventSig('Withdrawal(address,uint256)');

const module: IndexingPlugin = {
    name: "ictt",
    version: 2,
    usesTraces: false,

    wipe: (db) => {

    },

    initialize: (db) => {

    },

    handleTxBatch: (db, blocksDb, batch) => {
        for (const tx of batch.txs) {
            for (const log of tx.receipt.logs) {
                if (events.has(log.topics[0])) {
                    console.log('DEBUG: Found event', events.get(log.topics[0]), log.topics[0]);
                }
            }
        }
    }
};

export default module;
