-- ICM (Interchain Messaging) Messages
-- Tracks all send and receive cross-chain messages via Teleporter

CREATE TABLE IF NOT EXISTS icm_messages
(
    block_time DateTime,
    block_number UInt32,
    block_date Date,
    tx_hash FixedString(66),
    log_index UInt16,
    tx_index UInt16,
    message_type LowCardinality(String), -- 'send' or 'receive'
    destination_chain_id FixedString(66), -- topic2: destination blockchain ID
    message_id FixedString(66), -- topic1: unique message identifier
    tx_from FixedString(42),
    tx_to FixedString(42),
    data String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (message_type, destination_chain_id, block_number, log_index);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_icm_messages
TO icm_messages
AS
SELECT
    block_time,
    block_number,
    block_date,
    tx_hash,
    log_index,
    tx_index,
    multiIf(
        topic0 = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8', 'send',
        topic0 = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34', 'receive',
        'unknown'
    ) as message_type,
    topic2 as destination_chain_id,
    topic1 as message_id,
    tx_from,
    tx_to,
    data
FROM logs
WHERE contract_address = '0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf'
  AND (topic0 = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8'
   OR topic0 = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34');

-- Query examples:
-- 
-- Total messages by type:
-- SELECT message_type, count() as total FROM icm_messages GROUP BY message_type;
--
-- Messages per chain:
-- SELECT destination_chain_id, message_type, count() as total 
-- FROM icm_messages 
-- GROUP BY destination_chain_id, message_type 
-- ORDER BY total DESC;
--
-- Daily message volume:
-- SELECT block_date, message_type, count() as total
-- FROM icm_messages
-- GROUP BY block_date, message_type
-- ORDER BY block_date DESC;

