# Avalanche Atomic SDK for Java

Minimal Java SDK for P-Chain → C-Chain atomic imports on Avalanche. This is a focused port of specific functionality from [avalanchego](https://github.com/ava-labs/avalanchego) — not a full SDK, just what's needed to programmatically import AVAX to C-Chain.

**Why this exists**: When users export AVAX to your custodial C-Chain address, you need to import it or the funds stay stuck in shared memory. The official Go and Typescript SDKs handles this, no implementation in Java yet.

**Design philosophy**: Minimal port from Go source to reduce implementation errors. No abstractions beyond what avalanchego uses. Every struct, codec, and signing detail matches the Go implementation as close as possible.


## RPC Client

TODO: Document `AvalancheRpcClient` usage



## Import to C-Chain

TODO: Document full import flow



## Block ExtData Decoding

Parse atomic transactions (ImportTx/ExportTx) embedded in C-Chain block bodies.

### CLI Demo

```bash
mvn exec:java -Dexec.mainClass="io.avalanche.atomic.util.BlockExtDataDecoder" \
  -Dexec.args="71982634 https://api.avax.network/ext/bc/C/rpc" -q
```

Output:
```
Block 71982634: 1 atomic tx(s)

Tx 1: ImportTx
TxID: 64067cd0432252e2e76530bc73f8a88bb4315b6569a4591073c849196a19a971
Source: P-Chain
Inputs: 1 (62.640920 AVAX)
  → 0xf3bea6ee245b402d60fdb419eaabd63fc17c02d2: 62.640908 AVAX
```

### Test Coverage

Analyzed 116K blocks from a year of mainnet data and selected one representative example for each unique combination of:

- Batch size (1–6 transactions per block)
- Transaction type (Import / Export)
- Input count (1–31)
- Output count (1–2)  
- Source/destination chain (P-Chain / X-Chain)

This cartesian product of structural variations yielded **47 distinct test fixtures** covering all real-world scenarios observed on mainnet.

Fixtures: [src/test/resources/block_extra_data_fixtures.json](src/test/resources/block_extra_data_fixtures.json)



## Key Generator

Generate test wallets. **For testing only** — production should use HSM/KMS.

```bash
mvn compile -q
mvn exec:java -Dexec.mainClass="io.avalanche.atomic.util.KeyGenerator" -q
```

Output:
```
Private Key:      0x...
P-Chain Mainnet:  P-avax1...
P-Chain Fuji:     P-fuji1...
C-Chain Bech32:   C-avax1...
C-Chain EVM:      0x...
Written to .env
```

If `.env` exists, prints `.env already exists` and exits.

### Address Formats

| Address | Used For |
||-|
| P-Chain | Receiving exports, staking |
| C-Chain Bech32 | `avax.getUTXOs` queries |
| C-Chain EVM | ImportTx destination, EVM balance |

Bech32 addresses share the same 20-byte short ID (`RIPEMD160(SHA256(compressed_pubkey))`), only prefix differs between networks. EVM address uses `keccak256(uncompressed_pubkey)[12:32]`.



## Requirements

- Java 21+
- Maven 3.8+

## Build

```bash
mvn clean package -DskipTests
```

## Test

```bash
# Unit tests only (excludes E2E tests that require testnet setup)
mvn test

# E2E tests (requires manual setup — see specs/03_e2e_import_test.md)
mvn test -Dgroups=e2e
```

