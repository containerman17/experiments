import type { IndexingPlugin } from "frostbyte-sdk";
import { encodingUtils } from "frostbyte-sdk";


// Teleporter contract address
const TELEPORTER_ADDRESS = "0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf";

// Event topic signatures
const SEND_CROSS_CHAIN_MESSAGE_TOPIC = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8';
const RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34';


const module: IndexingPlugin = {
    name: "teleporter_messages",
    version: 7,
    usesTraces: false,
    filterEvents: [SEND_CROSS_CHAIN_MESSAGE_TOPIC, RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC],

    // Initialize tables
    initialize: async (db) => {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS teleporter_messages (
                is_outgoing BOOLEAN NOT NULL,
                other_chain_id VARCHAR(64) NOT NULL,
                block_timestamp INT NOT NULL
            )
        `);


        await db.execute(`
                CREATE INDEX idx_teleporter_messages_time_direction_chain 
                ON teleporter_messages(block_timestamp, is_outgoing, other_chain_id)
            `);
    },

    // Process transactions
    handleTxBatch: async (db, blocksDb, batch) => {
        const teleporterMessages: {
            is_outgoing: boolean;
            other_chain_id: string;
            block_timestamp: number;
        }[] = [];

        for (const tx of batch.txs) {
            for (let i = 0; i < tx.receipt.logs.length; i++) {
                const log = tx.receipt.logs[i]!
                if (log.address !== TELEPORTER_ADDRESS) {
                    continue;
                }

                const eventTopic = log.topics[0];
                let chainId: string;

                let is_outgoing = false;

                if (eventTopic === SEND_CROSS_CHAIN_MESSAGE_TOPIC) {
                    is_outgoing = true;
                } else if (eventTopic === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC) {
                    is_outgoing = false;
                } else {
                    continue;
                }

                if (!log.topics[2]) {
                    console.error(log);
                    throw new Error("Invalid log: missing chain id");
                }

                //FIXME: storing chain ids in a separate table might save a bunch of space
                chainId = encodingUtils.hexToCB58(log.topics[2]);

                teleporterMessages.push({
                    is_outgoing,
                    other_chain_id: chainId,
                    block_timestamp: tx.blockTs,
                });
            }
        }

        // Insert messages into table
        if (teleporterMessages.length === 0) {
            return;
        }

        // Insert in batches to avoid "too many SQL variables" error
        // SQLite typically supports 999 variables, so with 3 columns per row, we use 300 rows per batch
        const BATCH_SIZE = 300;

        for (let i = 0; i < teleporterMessages.length; i += BATCH_SIZE) {
            const batch = teleporterMessages.slice(i, i + BATCH_SIZE);

            // Build multi-row insert statement for this batch
            const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
            const insertStmt = `INSERT INTO teleporter_messages (is_outgoing, other_chain_id, block_timestamp) 
                     VALUES ${placeholders}`;

            // Flatten the batch into a single array of values
            const values = batch.flatMap(msg => [
                msg.is_outgoing ? 1 : 0,
                msg.other_chain_id,
                msg.block_timestamp
            ]);

            await db.execute(insertStmt, values);
        }

    }
};

export default module;
