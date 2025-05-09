This app is a prototype of an archiver that would be a source of data for an indexer.

## Data stores
1. Config store. Keeps only the last successfuly processed block. May be a couple more values. A simple json file. 
2. Last blocks store. Stored in a separete folder. Each block JSON is stored inside a separate file called 0000000123456.json, where 123456 is a block number.
3. Thousand blocks stores. Stores info as Zstd'd archives of 1000 blocks per archive. Used when we need to replay the info. Example file name is 0000000123xxx.zstd where it contains files for blocks 123000-123999.

## Block JOSN

Has 2 fields: 
1. One field is a block, which is the result of eth_getBlockByNumber with transaction_detail_flag=true. 
2. Another field is an object with transaction hash as a key and transaction receipt as a value. Requests for every tx of the block using eth_getTransactionReceipt method.

## How it works

One by one requests blocks and their transactions from a user given RPC (param RPC_URL). Uses p-throttle for some sane limits (10 requests per second for now, all requests are equal). Once have 1000 blocks in the store #2, moves to store #3 all of those. Works untill hits the current block. Fetches the current block number every 5 seconds. 

## Tech specs
Bun, top level awaits are ok. Assume zstd installed. If rpc starts with ws, should be ws. Use viem. RPC_URL defined in env. Any code you see you can delete, except for this readme - it is all AI generated.
