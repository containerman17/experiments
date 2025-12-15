# Avalanche Atomic Transaction SDK

A minimal, production-ready Java 21 library for detecting and creating P-Chain to C-Chain atomic import/export transactions on Avalanche.

## Features

- **Detection**: Parse C-Chain `BlockExtraData` to detect ImportTx and ExportTx with transaction IDs
- **Creation**: Build and sign ImportTx to claim funds exported from P-Chain  
- **Verification**: Validated against avalanchego source code with test vectors from Go tests
- **Web3j Integration**: Uses existing web3j infrastructure for RLP, signing, and JSON-RPC

## Requirements

- Java 21+
- Maven 3.6+

## Installation

```bash
cd experiments/java_p_to_c_import
mvn clean install
```

## Quick Start

### Decode BlockExtraData from a C-Chain Block

```bash
mvn -q exec:java -Dexec.mainClass="io.avalanche.atomic.demo.BlockExtraDataDemo" \
  -Dexec.args="0x00000000000100000001..."
```

### Detect Imports Programmatically

```java
import io.avalanche.atomic.AvalancheAtomicSDK;
import io.avalanche.atomic.model.AtomicTx;

// Parse raw ExtData
ExtDataDecoder decoder = new ExtDataDecoder();
List<AtomicTx> transactions = decoder.parseAtomicTransactions(extDataBytes);

// Check for ImportTx crediting your addresses
for (AtomicTx tx : transactions) {
    if (tx.isImportTx()) {
        String txId = Numeric.toHexString(tx.getTxId());
        for (EVMOutput out : tx.getImportTx().getOuts()) {
            System.out.printf("Credit %s: %d nAVAX (TX: %s)%n", 
                Numeric.toHexString(out.getAddress()), 
                out.getAmount(), 
                txId);
        }
    }
}
```

### Create and Sign ImportTx

```java
import io.avalanche.atomic.AvalancheAtomicSDK;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.http.HttpService;

// Setup
Web3j web3 = Web3j.build(new HttpService("https://api.avax.network/ext/bc/C/rpc"));
AvalancheAtomicSDK sdk = new AvalancheAtomicSDK(web3);

// Build
byte[] unsignedTx = sdk.buildImportTx(
    1,              // Mainnet
    cChainId,       // 32 bytes from info.getBlockchainID
    pChainId,       // 32 bytes (all zeros for P-Chain)
    utxos,          // List<UTXO> from avax.getUTXOs
    toAddress,      // 20 bytes EVM address
    avaxAssetId,    // 32 bytes from genesis
    baseFee         // From eth_baseFee
);

// Sign
byte[] signedTx = sdk.signTx(unsignedTx, List.of(keyPair));
```

## File Structure and Descriptions

### Core SDK Files (`src/main/java/io/avalanche/atomic/`)

#### `AvalancheAtomicSDK.java` (218 lines)
**Main SDK facade** - Provides high-level API for all operations.
- `detectAtomicTransactions(blockBodyRlp)` - Parse all atomic txs from ExtData
- `detectImportsFromRaw(blockBodyRlp, watchAddresses)` - Filter for ImportTx crediting specific addresses
- `buildImportTx(...)` - Construct unsigned ImportTx with fee calculation
- `signTx(unsignedTx, keyPairs)` - Sign with secp256k1 (v-27 fix applied)
- `submitTx(signedTx)` - Submit to C-Chain (returns hex for avax.issueTx endpoint)
- **Inner class**: `DetectedImport` - Holds matched outputs with transaction ID and total amount

### Codec Package (`codec/`)

#### `LinearCodec.java` (530 lines)
**Avalanche binary serialization/deserialization** - Core encoding engine.

**Serialization (for creating txs):**
- `serializeUnsignedImportTx(tx)` - Marshal ImportTx to bytes with version prefix
- `serializeSignedTx(tx, credentials)` - Add signatures to unsigned tx
- `serializeUnsignedExportTx(tx)` - Marshal ExportTx (for completeness)

**Deserialization (for detecting txs):**
- `deserializeUnsignedImportTx(data)` - Parse ImportTx with version prefix
- `deserializeAtomicTx(data, hasVersionPrefix)` - Parse complete signed tx, compute SHA256 ID
- `deserializeImportTxBody(buf)` - Parse ImportTx fields after typeID
- `deserializeExportTxBody(buf)` - Parse ExportTx fields after typeID

**Private helpers:** Serialization/deserialization for all nested structures:
- `TransferableInput` (UTXO reference + amount + sig indices)
- `EVMOutput` (address + amount + assetID)
- `EVMInput` (address + amount + assetID + nonce)
- `TransferableOutput` (assetID + amount + locktime + threshold + addresses)
- `Credential` (array of 65-byte signatures)

**Critical details:**
- Codec version (0x0000) is 2 bytes at START of serialization
- Type IDs are 4 bytes before polymorphic types
- Arrays have 4-byte length prefix
- All integers are BIG_ENDIAN

### Model Package (`model/`)

#### `AtomicTx.java` (88 lines)
**Signed atomic transaction wrapper** - Represents a complete tx with credentials.
- Holds either `UnsignedImportTx` OR `UnsignedExportTx`
- Includes `List<Credential>` for signatures
- Stores computed transaction ID (SHA256 of signed bytes)
- Type-safe accessors: `isImportTx()`, `getImportTx()`, `isExportTx()`, `getExportTx()`

#### `UnsignedImportTx.java` (54 lines)
**Import transaction model** - Funds moving FROM P/X-Chain TO C-Chain.
- `networkId` - 1=mainnet, 5=fuji
- `blockchainId` - C-Chain ID (32 bytes)
- `sourceChain` - P-Chain ID (32 zero bytes)
- `importedInputs` - UTXOs being consumed from shared memory
- `outs` - EVM addresses being credited

#### `UnsignedExportTx.java` (62 lines)
**Export transaction model** - Funds moving FROM C-Chain TO P/X-Chain.
- `networkId`, `blockchainId`, `destinationChain`
- `ins` - EVM inputs (address + nonce + amount)
- `exportedOutputs` - P/X-Chain outputs being created

#### `TransferableInput.java` (62 lines)
**UTXO reference for imports** - Points to a UTXO in shared memory.
- `txId` + `outputIndex` - UTXO identifier
- `assetId` - Asset being transferred
- `amount` - Amount in nAVAX (or asset units)
- `sigIndices` - Indices of keys that must sign
- **Implements `Comparable`** - Sorted by txID then outputIndex (protocol requirement)

#### `EVMOutput.java` (50 lines)
**EVM output for imports** - Credits an EVM address.
- `address` - 20-byte EVM address
- `amount` - Amount in nAVAX
- `assetId` - Asset identifier (32 bytes)
- **Implements `Comparable`** - Sorted by address then assetID

#### `EVMInput.java` (54 lines)
**EVM input for exports** - Debits an EVM address.
- `address`, `amount`, `assetId`, `nonce`
- **Implements `Comparable`** - Sorted by address then assetID

#### `TransferableOutput.java` (72 lines)
**P/X-Chain output for exports** - Output with ownership rules.
- `assetId`, `amount` - What is being sent
- `locktime` - When output becomes spendable
- `threshold` - How many signatures required (M-of-N multisig)
- `addresses` - List of 20-byte addresses that can spend

#### `Credential.java` (36 lines)
**Signature container** - Holds 65-byte secp256k1 signatures.
- Each signature: `[r(32) || s(32) || v(1)]` where `v ∈ [0,3]`
- Validates signature length on construction

#### `UTXO.java` (52 lines)
**Simplified UTXO model** - Represents unspent output from shared memory.
- Full UTXO identifier (txId + outputIndex + assetId + amount + owner address)
- Used as input to `ImportTxBuilder`

### Parser Package (`parser/`)

#### `BlockParser.java` (56 lines)
**RLP extraction from C-Chain blocks** - Uses web3j to extract ExtData.
- `extractExtData(blockBodyRlp)` - Parses RLP list, returns index 3
- **Critical**: C-Chain blocks have 4 RLP elements `[Txs, Uncles, Version, ExtData]`
- Standard Ethereum blocks have 2 `[Txs, Uncles]`
- Returns null if no atomic transactions in block

#### `ExtDataDecoder.java` (155 lines)
**Atomic transaction batch parser** - Decodes ExtData into typed transactions.
- `parseAtomicTransactions(extData)` - Main entry point, returns `List<AtomicTx>`
- Handles post-ApricotPhase5 batch format: `[Version][Count][Tx1][Tx2]...`
- Supports both ImportTx (typeID=0) and ExportTx (typeID=1)
- Computes transaction IDs via SHA256
- **Error handling**: Gracefully handles malformed data, returns partial results

**Implementation details:**
- `extractCompleteTransaction()` - Extracts one tx (unsigned + credentials)
- `skipUnsignedImportTxNoVersion()`, `skipUnsignedExportTxNoVersion()` - Skip by counting bytes
- `skipCredentials()` - Skip signature data

**Critical fix from integration**: Transactions in batch do NOT have individual version prefixes (only batch has version)

### Builder Package (`builder/`)

#### `ImportTxBuilder.java` (147 lines)
**Transaction construction with dynamic fee calculation**.
- `buildImportTx(...)` - Main builder method
- **Algorithm**:
  1. Sum UTXO amounts
  2. Create sorted inputs
  3. Build temp tx, serialize to get byte count
  4. Calculate gas: `txBytes * 1 + numInputs * 1000 + 10000` (post-AP5)
  5. Calculate fee: `ceil((gas * baseFee) / 1e9)` nAVAX
  6. Rebuild tx with `totalAmount - fee` as output
- **Validation**: Throws if insufficient funds
- Uses `Collections.sort()` to ensure inputs are canonical

### Signer Package (`signer/`)

#### `TxSigner.java` (116 lines)
**secp256k1 signing with Avalanche-specific v correction**.
- `signImportTx(unsignedBytes, keyPairs)` - Complete signing flow
- `signForAvalanche(hash, keyPair)` - **CRITICAL METHOD**
  - Uses web3j's `Sign.signMessage()`
  - **FIX**: Converts `v` from 27/28 to 0/1 (Avalanche format)
  - Pads r/s to exactly 32 bytes each
  - Validates `v ∈ [0,3]`
- `verifySignatureFormat(signature)` - Validates 65-byte format with correct v range

**Why this matters**: Web3j uses Ethereum's v+27 encoding. Avalanche expects raw recovery ID.

### Constants Package (`constants/`)

#### `AvalancheConstants.java` (48 lines)
**All verified constants from avalanchego source**.
- **Network IDs**: Mainnet=1, Fuji=5
- **Type IDs**: ImportTx=0, ExportTx=1, TransferInput=5, TransferOutput=7, Credential=9
- **Gas constants**: 
  - `TX_BYTES_GAS = 1`
  - `EVM_OUTPUT_GAS = 60` (verified: (20 + 8 + 32) * 1, NOT 88)
  - `ATOMIC_TX_INTRINSIC_GAS = 10_000`
  - `SECP256K1_FX_COST_PER_SIG = 1000`
- **Chain IDs**: P_CHAIN_ID = 32 zero bytes
- **Conversion**: X2C_RATE = 1e9 (1 nAVAX = 1 gWei)

### Demo Package (`demo/`)

#### `BlockExtraDataDemo.java` (141 lines)
**Standalone demo** - Shows how to decode real BlockExtraData.
- Accepts hex-encoded ExtData as command-line argument
- Parses and pretty-prints all atomic transactions
- Displays transaction IDs, inputs, outputs, credentials
- **Example data included** - Real ExportTx from C-Chain

**Run:** `mvn -q exec:java -Dexec.mainClass="io.avalanche.atomic.demo.BlockExtraDataDemo"`

## Test Files (`src/test/java/`)

### `codec/LinearCodecTest.java` (153 lines)
**Core serialization tests** - Validates byte-level correctness.
- `testSimpleImportSerialization()` - Verifies 230-byte output (matches Go)
- `testRoundTrip()` - Serialize → Deserialize → field equality
- `testCodecVersionIncluded()` - Confirms 0x0000 prefix exists

### `parser/ExtDataDecoderTest.java` (51 lines)
**ExtData parsing tests**.
- `testEmptyExtData()` - Null/empty handling
- `testWrongVersion()` - Gracefully rejects unsupported versions
- `testZeroTransactions()` - Handles empty batches

### `builder/ImportTxBuilderTest.java` (134 lines)
**Fee calculation verification** - Uses Go test vectors.
- `testGasCalculationSimpleImport()` - Gas=1230 (pre-AP5), 11230 (post-AP5)
- `testFeeCalculation()` - Fee=30750 nAVAX at 25 GWei baseFee
- `testInsufficientFunds()` - Rejects underfunded txs
- `testMultisigGasCalculation()` - ~2234 gas for 2 signatures
- `testInputSorting()` - Verifies canonical ordering

### `signer/TxSignerTest.java` (84 lines)
**Signature format validation**.
- `testSignatureFormat()` - 65 bytes, `v ∈ [0,3]`
- `testSignatureFormatValidator()` - Rejects invalid v values
- `testVConversion()` - Confirms v never ≥ 27

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   AvalancheAtomicSDK                         │
│                      (Facade)                                │
└───┬───────────────┬──────────────┬──────────────┬───────────┘
    │               │              │              │
    ▼               ▼              ▼              ▼
BlockParser   ExtDataDecoder  ImportTxBuilder  TxSigner
    │               │              │              │
    │               │              │              │
    ▼               ▼              ▼              ▼
  web3j         LinearCodec    LinearCodec    web3j Sign
   RLP                                         (v-27 fix)
```

## Critical Implementation Details

### ExtData Batch Format (Post-ApricotPhase5)

```
[CodecVersion: 2 bytes]     // 0x0000 (once for entire batch)
[Count: 4 bytes]            // Number of transactions
[Tx1]                       // No individual version prefix!
[Tx2]
...

Each Tx:
  [TypeID: 4 bytes]         // 0=ImportTx, 1=ExportTx
  [Unsigned Body...]
  [Credentials Length: 4]
  [Credential1]
    [TypeID: 4]             // 9=SECP256K1Credential
    [Sigs Length: 4]
    [Sig1: 65 bytes]
    [Sig2: 65 bytes]
    ...
```

### Transaction ID Computation

```java
// For signed tx, compute ID from full bytes WITH version prefix
byte[] signedTxBytes = codec.serializeSignedTx(tx, credentials);
byte[] txId = SHA256(signedTxBytes);  // This is what goes on-chain
```

### Gas Calculation Formula

```
Gas = (txBytes × 1) + (numInputs × 1000) + 10000

Where:
  txBytes    = Length of unsigned tx bytes
  numInputs  = Number of ImportedInputs
  10000      = Intrinsic gas (post-AP5, always include for future blocks)
```

### Fee Calculation Formula

```
Fee(nAVAX) = ⌈(Gas × BaseFee(wei)) / 1e9⌉

Where:
  BaseFee = From eth_baseFee RPC call
  1e9     = X2C_RATE (conversion from wei to nAVAX)
```

### Signature Format

```
[r: 32 bytes] [s: 32 bytes] [v: 1 byte]

Where:
  r, s = ECDSA signature components (big-endian, padded)
  v    = Recovery ID ∈ [0,3] (NOT 27/28 like Ethereum)
```

**Web3j returns v+27, so subtract 27 before using.**

## Test Results

All 14 tests pass using vectors from `avalanchego/graft/coreth/plugin/evm/atomic/vm/import_tx_test.go`:

| Test Suite | Tests | Key Validations |
|------------|-------|-----------------|
| LinearCodecTest | 3 | 230-byte serialization, round-trip, version prefix |
| ExtDataDecoderTest | 3 | Empty data, wrong version, zero txs |
| ImportTxBuilderTest | 5 | Gas 1230/11230, fee 30750, sorting, multisig |
| TxSignerTest | 3 | v ∈ [0,3], 65 bytes, v-27 conversion |

## Dependencies

### Runtime
- **web3j-core 4.10.3** - RLP, secp256k1, JSON-RPC, SHA256
- **bitcoinj-core 0.16.2** - Bech32 address encoding (for P-Chain addresses)

### Test
- **JUnit 5.10.1** - Test framework

**Total JAR size**: ~150 KB (excluding dependencies)

## Verified Against AvalancheGo Source

Every constant, formula, and byte offset verified against:
- `graft/coreth/plugin/evm/atomic/tx.go` - Fee calculation, gas constants
- `graft/coreth/plugin/evm/atomic/import_tx.go` - ImportTx structure, GasUsed()
- `graft/coreth/plugin/evm/atomic/export_tx.go` - ExportTx structure
- `graft/coreth/plugin/evm/atomic/codec.go` - Type IDs, ExtractAtomicTxs()
- `graft/coreth/plugin/evm/customtypes/block_ext.go` - BlockBodyExtra RLP
- `codec/linearcodec/codec.go` - Type ID serialization
- `codec/manager.go` - Codec version prefix (line 129: `p.PackShort(version)`)
- `vms/secp256k1fx/transfer_input.go` - TransferInput nested structure
- `utils/crypto/secp256k1/secp256k1.go` - Signature format [r||s||v]
- `utils/constants/network_ids.go` - PlatformChainID = ids.Empty

## Key Differences from Standard Ethereum

| Aspect | Ethereum | Avalanche C-Chain |
|--------|----------|-------------------|
| Block Body | 2 RLP elements | 4 RLP elements (+Version, +ExtData) |
| Signature v | 27 or 28 | 0, 1, 2, or 3 |
| Atomic Txs | None | ImportTx/ExportTx in ExtData |
| Fee Units | Wei only | nAVAX (1e9 wei = 1 nAVAX) |

## Production Deployment Notes

### For Detection (Read-Only)
1. Poll C-Chain blocks via `eth_getBlockByNumber` with `fullTransactionObjects=true`
2. Extract raw block body RLP (you may need custom RPC call)
3. Call `sdk.detectAtomicTransactions(blockBodyRlp)`
4. Filter for your addresses, credit customer accounts
5. **No private keys needed** for detection

### For Transaction Creation
1. Query UTXOs: `avax.getUTXOs` on C-Chain with `sourceChain="P"`
2. Get baseFee: `eth_baseFee` RPC call
3. Build: `sdk.buildImportTx(...)`
4. Sign: `sdk.signTx(unsignedTx, keyPairs)`
5. Submit: Call `avax.issueTx` with hex-encoded signed bytes

## Code Alignment Report

**No duplicate code found.** Both use cases (detection + creation) share:
- `LinearCodec` - Single source of truth for serialization
- Model classes - Used by both parser and builder
- `ExtDataDecoder` - Can parse any atomic tx type

**Integration verified:**
- BlockExtraDataDemo successfully decoded real ExportTx
- All 14 tests pass
- Byte offsets match your original trashy demo but with production error handling

## License

Same as avalanchego - see repository root LICENSE file
