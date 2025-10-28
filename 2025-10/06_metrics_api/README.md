# Metric API on ClickHouse PoC

## Data scope

Pre-ingested data for C-Chain from Sept 23 2020 to October 11th 2025. Real time update are easy to achive, but out of scope of this PoC. 

## Corners cut
- Hashes and addresses are stored as strings, not as bytes. Using actual binary could noticably speed up the speed of queries, in theoru up to 2x if memory bandwith is the limit. Same fore memory usage.


## Disk space usage

TODO:

## Data structure

TODO: copy from strcucture. sql.

# Metrics

## activeAddresses

The number of distinct addresses seen within the selected timeInterval starting at the timestamp. Addresses counted are those that appear in the "from" and "to" fields of a transaction or ERC20/ERC721/ERC1155 transfer log event.

## activeSenders

This metric follows the same structure as activeAddresses, but instead only counts addresses that appear in the "from" field of the respective transaction or transfer log event.

## cumulativeTxCount

The cumulative transaction count from genesis up until 24 hours after the timestamp. This aggregation can be considered a "rolling sum" of the transaction count metric (txCount). Only timeInterval=day supported.

## cumulativeAddresses

The cumulative count of unique addresses from genesis up until 24 hours after the timestamp. Addresses counted are those that appear in the "from" and "to" fields of a transaction or ERC20/ERC721/ERC1155 transfer log event. Only timeInterval=day supported.

## cumulativeContracts

The cumulative count of contracts created from genesis up until the timestamp. Contracts are counted by looking for the CREATE, CREATE2, and CREATE3 call types in all transaction traces (aka internal transactions). Only timeInterval=day supported.

## cumulativeDeployers

The cumulative count of unique contract deployers from genesis up until 24 hours after the timestamp. Deployers counted are those that appear in the "from" field of transaction traces with the CREATE, CREATE2, and CREATE3 call types. Only timeInterval=day supported.

## gasUsed

The amount of gas used by transactions within the requested timeInterval starting at the timestamp.

## txCount

The amount of transactions within the requested timeInterval starting at the timestamp.

## avgGps

The average Gas used Per Second (GPS) within the day beginning at the timestamp. The average is calculated by taking the sum of gas used by all blocks within the day and dividing it by the time interval between the last block of the previous day and the last block of the day that begins at the timestamp. Only timeInterval=day supported.

## maxGps

The max Gas used Per Second (GPS) measured within the day beginning at the timestamp. Each GPS data point is calculated using the gas used in a single block divided by the time since the last block. Only timeInterval=day supported.

## avgTps 

The average Transactions Per Second (TPS) within the day beginning at the timestamp. The average is calculated by taking the sum of transactions within the day and dividing it by the time interval between the last block of the previous day and the last block of the day that begins at the timestamp. Only timeInterval=day supported.

## maxTps

The max Transactions Per Second (TPS) measured within the day beginning at the timestamp. Each TPS data point is calculated by taking the number of transactions in a single block and dividing it by the time since the last block. Only timeInterval=day supported.

## avgGasPrice

The average gas price within the day beginning at the timestamp. The gas price used is the price reported in transaction receipts. Only timeInterval=day supported.

## maxGasPrice

The max gas price seen within the day beginning at the timestamp. The gas price used is the price reported in transaction receipts. Only timeInterval=day supported.

## feesPaid

The sum of transaction fees paid within the day beginning at the timestamp. The fee is calculated as the gas used multiplied by the gas price as reported in all transaction receipts. Only timeInterval=day supported.

