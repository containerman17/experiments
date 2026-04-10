# 01_block_fetcher

Small April 2026 prototype for fetching C-Chain blocks and storing them in Pebble.

This is intentionally narrow:
- fetch current validators from a local AvalancheGo node RPC
- fetch blocks from a C-Chain EVM RPC endpoint
- store raw block JSON by hash
- maintain a number -> hash index
- record the validator RPC response as metadata for later P2P work

What this does not do yet:
- no P2P transport
- no execution
- no receipts
- no reorg handling beyond overwriting the number -> hash pointer

## Storage layout

Pebble keys:
- `meta/rpc_url` -> source RPC URL
- `meta/node_uri` -> local AvalancheGo base URI used for PlatformVM RPC
- `meta/subnet_id` -> subnet ID used for validator fetch
- `meta/validators_json` -> raw `platform.getCurrentValidators` result JSON
- `meta/validators_sha256` -> checksum of that validator JSON
- `meta/next_block` -> next block number to fetch, as 8-byte big-endian
- `block/num/<20-digit-decimal>` -> canonical block hash string
- `block/hash/<0xhash>` -> raw `eth_getBlockByNumber` JSON response

## Usage

Start from the current head and follow live blocks:

```bash
go run . \
  -rpc-url http://127.0.0.1:9650/ext/bc/C/rpc \
  -node-uri http://127.0.0.1:9650 \
  -db-dir ./data \
  -start-block latest
```

Start from a fixed block:

```bash
go run . \
  -rpc-url http://127.0.0.1:9650/ext/bc/C/rpc \
  -node-uri http://127.0.0.1:9650 \
  -db-dir ./data \
  -start-block 50000000
```

Use the primary network validator set by default, or override the subnet:

```bash
go run . \
  -rpc-url http://127.0.0.1:9650/ext/bc/C/rpc \
  -node-uri http://127.0.0.1:9650 \
  -db-dir ./data \
  -subnet-id 11111111111111111111111111111111LpoYY
```

Limit the run for testing:

```bash
go run . \
  -rpc-url http://127.0.0.1:9650/ext/bc/C/rpc \
  -node-uri http://127.0.0.1:9650 \
  -db-dir ./data \
  -max-blocks 10
```

## Notes

- validators are fetched once at startup from `platform.getCurrentValidators`
- the validator response is stored but not used for transport yet
- This prototype is meant to be the storage/bootstrap seed, not the final downloader.
