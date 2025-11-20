# BlockExtraData Decoding Guide

## What is BlockExtraData?

`BlockExtraData` (also called `ExtData`) is a field in Avalanche C-Chain blocks that contains **atomic transactions**. These are special transactions that enable cross-chain asset transfers between the C-Chain (EVM) and other Avalanche chains like the X-Chain and P-Chain.

## Structure Overview

The `BlockExtraData` field is stored in the block body's RLP encoding as part of `BlockBodyExtra`:

```go
type BlockBodyExtra struct {
    Version uint32
    ExtData *[]byte  // This is the BlockExtraData
}
```

## What's Inside BlockExtraData?

The `ExtData` bytes contain **serialized atomic transactions** using Avalanche's codec (not Ethereum RLP). There are two transaction types:

### 1. **ImportTx** - Importing assets TO C-Chain
- Brings assets from X-Chain or P-Chain into the C-Chain
- Fields:
  - `NetworkID`: Network identifier (1 for mainnet, 5 for fuji)
  - `BlockchainID`: C-Chain ID
  - `SourceChain`: Which chain assets come from (X-Chain or P-Chain)
  - `ImportedInputs`: UTXOs being consumed from source chain
  - `Outs`: EVM addresses receiving the assets

### 2. **ExportTx** - Exporting assets FROM C-Chain  
- Sends assets from C-Chain to X-Chain or P-Chain
- Fields:
  - `NetworkID`: Network identifier
  - `BlockchainID`: C-Chain ID
  - `DestinationChain`: Target chain ID
  - `Ins`: EVM addresses sending assets (with nonces)
  - `ExportedOutputs`: UTXOs being created on destination chain

## Encoding Format

### Pre-ApricotPhase5 (Single Transaction)
Before the ApricotPhase5 upgrade, `ExtData` could contain **only one atomic transaction**, serialized directly.

### Post-ApricotPhase5 (Batch Transactions)
After ApricotPhase5, `ExtData` contains a **slice of atomic transactions** `[]*Tx`, allowing multiple atomic operations in a single block.

## Decoding Example

Your real example decoded successfully:

```
ExtData length: 311 bytes
Decoded as batch atomic transactions (post-AP5)

Found 1 atomic transaction(s):

=== Transaction 0 ===
ID: 24SGw5q1mVTLWKYXZjqtrNjhhKL8svxKDa4z1q1RkibAog8uLw
Type: ExportTx
NetworkID: 1
BlockchainID: 2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5
DestinationChain: 11111111111111111111111111111111LpoYY
Inputs: 1
  Input 0: Address=0x565F0fe9715E3cb0Df579f186C299D6707887E83, Amount=59187154799, AssetID=FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z, Nonce=155597
ExportedOutputs: 1
  Output 0: AssetID=FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z
Credentials: 1
```

This shows an **ExportTx** sending ~59.19 AVAX from the C-Chain address `0x565F0fe9715E3cb0Df579f186C299D6707887E83` to the P-Chain.

## How to Decode

Use the provided `decode_extra.go` script:

```bash
go run decode_extra.go
```

The code attempts to decode in this order:
1. First tries **batch mode** (post-AP5): `atomic.ExtractAtomicTxs(data, true, atomic.Codec)`
2. If that fails, tries **single mode** (pre-AP5): `atomic.ExtractAtomicTxs(data, false, atomic.Codec)`

## Key Points

- **Codec**: Uses Avalanche's linearcodec, NOT Ethereum RLP
- **Empty blocks**: Most C-Chain blocks have empty `ExtData` (no atomic operations)
- **Verification**: Atomic txs are verified against shared memory and must not conflict
- **Gas accounting**: Atomic txs consume gas and pay fees in AVAX
- **Version field**: Currently always 0, reserved for future protocol changes

## Why Does This Exist?

Avalanche's architecture allows asset transfers between chains. The C-Chain (EVM) needs to coordinate with the X-Chain (UTXO model) and P-Chain (staking). Atomic transactions in `BlockExtraData` are the mechanism that makes these cross-chain transfers atomic and secure.

## Related Code Locations

- Atomic tx definitions: `plugin/evm/atomic/`
- Extraction logic: `plugin/evm/atomic/codec.go`
- Block extra data: `plugin/evm/customtypes/block_ext.go`
- VM processing: `plugin/evm/atomic/vm/vm.go` (see `onExtraStateChange`)

