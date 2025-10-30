## Active Addresses Metric

**activeAddresses**: The number of distinct addresses seen within the selected timeInterval starting at the timestamp. Addresses counted are those that appear in the "from" and "to" fields of a transaction or ERC20/ERC721/ERC1155 transfer log event.

### Token Transfer Detection

**ERC20 vs ERC721 Distinction:**
Both use the same event signature (`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`), but:
- **ERC20**: `Transfer(address indexed from, address indexed to, uint256 value)` - value is NOT indexed
  - Has topics: [signature, from, to] and value in data field
- **ERC721**: `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` - tokenId IS indexed  
  - Has topics: [signature, from, to, tokenId]

To distinguish: Check if `topic[3]` exists. If yes → ERC721, if no → ERC20.

**ERC1155 Detection:**
Uses different event signatures:
- `TransferSingle`: `0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62`
  - Topics: [signature, operator, from, to]
- `TransferBatch`: `0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb`
  - Topics: [signature, operator, from, to]

### Implementation

The materialized view `mv_active_addresses` aggregates addresses hourly from:
1. Transaction `from` and `to` fields
2. ERC20/721 Transfer events (extracting addresses from topic1 and topic2)
3. ERC1155 TransferSingle/Batch events (extracting addresses from topic2 and topic3)

Addresses are extracted from topics using `substr(topic, 13, 20)` since addresses are 20 bytes padded to 32 bytes in topics.

activeSenders: This metric follows the same structure as activeAddresses, but instead only counts addresses that appear in the “from” field of the respective transaction or transfer log event.

cumulativeTxCount: The cumulative transaction count from genesis up until 24 hours after the timestamp. This aggregation can be considered a “rolling sum” of the transaction count metric (txCount). Only timeInterval=day supported.

cumulativeAddresses: The cumulative count of unique addresses from genesis up until 24 hours after the timestamp. Addresses counted are those that appear in the “from” and “to” fields of a transaction or ERC20/ERC721/ERC1155 transfer log event. Only timeInterval=day supported.

cumulativeContracts: The cumulative count of contracts created from genesis up until the timestamp. Contracts are counted by looking for the CREATE, CREATE2, and CREATE3 call types in all transaction traces (aka internal transactions). Only timeInterval=day supported.

cumulativeDeployers: The cumulative count of unique contract deployers from genesis up until 24 hours after the timestamp. Deployers counted are those that appear in the “from” field of transaction traces with the CREATE, CREATE2, and CREATE3 call types. Only timeInterval=day supported.

gasUsed: The amount of gas used by transactions within the requested timeInterval starting at the timestamp.

txCount: The amount of transactions within the requested timeInterval starting at the timestamp.

avgGps: The average Gas used Per Second (GPS) within the day beginning at the timestamp. The average is calculated by taking the sum of gas used by all blocks within the day and dividing it by the time interval between the last block of the previous day and the last block of the day that begins at the timestamp. Only timeInterval=day supported.

maxGps: The max Gas used Per Second (GPS) measured within the day beginning at the timestamp. Each GPS data point is calculated using the gas used in a single block divided by the time since the last block. Only timeInterval=day supported.

avgTps: The average Transactions Per Second (TPS) within the day beginning at the timestamp. The average is calculated by taking the sum of transactions within the day and dividing it by the time interval between the last block of the previous day and the last block of the day that begins at the timestamp. Only timeInterval=day supported.

maxTps: The max Transactions Per Second (TPS) measured within the day beginning at the timestamp. Each TPS data point is calculated by taking the number of transactions in a single block and dividing it by the time since the last block. Only timeInterval=day supported.

avgGasPrice: The average gas price within the day beginning at the timestamp. The gas price used is the price reported in transaction receipts. Only timeInterval=day supported.

maxGasPrice: The max gas price seen within the day beginning at the timestamp. The gas price used is the price reported in transaction receipts. Only timeInterval=day supported.

feesPaid: The sum of transaction fees paid within the day beginning at the timestamp. The fee is calculated as the gas used multiplied by the gas price as reported in all transaction receipts. Only timeInterval=day supported.