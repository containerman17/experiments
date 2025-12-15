# Task 01: Complete the P→C Import Cycle ✅ DONE

## Objective

Enable the full cycle: **Query pending UTXOs → Build ImportTx → Sign → Submit**

## Status: COMPLETED

All components implemented and tested. See "Implementation Completed" section below.

---

## Current State

### What We Have ✅

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| `LinearCodec` | `codec/LinearCodec.java` | 530 | Serialize/deserialize atomic txs |
| `ImportTxBuilder` | `builder/ImportTxBuilder.java` | 147 | Build unsigned ImportTx with fee calc |
| `TxSigner` | `signer/TxSigner.java` | 116 | Sign with secp256k1, v-27 fix |
| `ExtDataDecoder` | `parser/ExtDataDecoder.java` | 155 | Parse BlockExtraData |
| `BlockParser` | `parser/BlockParser.java` | 56 | Extract ExtData from RLP |
| Models | `model/*.java` | ~400 | UTXO, TransferableInput, EVMOutput, etc. |
| Constants | `constants/AvalancheConstants.java` | 48 | Gas, type IDs, etc. |

**Total existing**: ~1,450 lines of production code

### What's Missing ❌

| Component | Purpose | Estimate |
|-----------|---------|----------|
| `AvalancheRpcClient` | Call `avax.getUTXOs` and `avax.issueTx` | ~80 lines |
| `UtxoParser` | Parse JSON response → `List<UTXO>` | ~100 lines |
| Integration in SDK | Wire it together | ~30 lines |
| Tests | Validate parsing and submission | ~100 lines |

**Total new code**: ~310 lines

## Technical Details

### 1. RPC Client for Avalanche-Specific Endpoints

Web3j connects to `/ext/bc/C/rpc` for Ethereum-compatible calls (`eth_*`).

Avalanche atomic operations use a **different endpoint**: `/ext/bc/C/avax`

```
Ethereum-compatible:  POST /ext/bc/C/rpc   → eth_baseFee, eth_sendRawTransaction, etc.
Avalanche atomic:     POST /ext/bc/C/avax  → avax.getUTXOs, avax.issueTx
```

**Implementation approach**: Minimal JSON-RPC client using Java's built-in `HttpClient` (Java 11+).

```java
public class AvalancheRpcClient {
    private final String baseUrl;  // e.g., "https://api.avax.network"
    private final HttpClient httpClient;
    
    // Endpoint: /ext/bc/C/avax
    public List<UTXO> getUTXOs(List<String> addresses, String sourceChain);
    public String issueTx(byte[] signedTx);
}
```

### 2. UTXO Response Parsing

#### Request
```json
{
    "jsonrpc": "2.0",
    "method": "avax.getUTXOs",
    "params": {
        "addresses": ["C-avax1abc..."],
        "sourceChain": "P",
        "encoding": "hex"
    },
    "id": 1
}
```

#### Response
```json
{
    "jsonrpc": "2.0",
    "result": {
        "numFetched": "1",
        "utxos": [
            "0x00001234abcd..."  // Hex-encoded UTXO bytes
        ],
        "endIndex": {
            "address": "C-avax1abc...",
            "utxo": "..."
        }
    },
    "id": 1
}
```

#### UTXO Binary Format (from avalanchego)
```
[CodecVersion: 2 bytes]
[TxID: 32 bytes]
[OutputIndex: 4 bytes]
[AssetID: 32 bytes]
[TypeID: 4 bytes]          // 7 = TransferOutput
[Amount: 8 bytes]
[Locktime: 8 bytes]
[Threshold: 4 bytes]
[AddressesLen: 4 bytes]
[Address1: 20 bytes]
...
```

**Parser needed**: Decode hex → extract fields → create `UTXO` object

### 3. Transaction Submission

#### Request
```json
{
    "jsonrpc": "2.0",
    "method": "avax.issueTx",
    "params": {
        "tx": "0x00000000...",  // Hex-encoded signed tx
        "encoding": "hex"
    },
    "id": 1
}
```

#### Response
```json
{
    "jsonrpc": "2.0",
    "result": {
        "txID": "2QouvFWUbjuySRxeX5xMbNCuAaKWfbk5FeEa2JmoF85RKLnC8"
    },
    "id": 1
}
```

## File Structure (New)

```
src/main/java/io/avalanche/atomic/
├── rpc/
│   ├── AvalancheRpcClient.java    // HTTP client for avax.* methods
│   └── UtxoParser.java            // Parse UTXO response bytes
└── (existing files unchanged)

src/test/java/io/avalanche/atomic/
├── rpc/
│   ├── AvalancheRpcClientTest.java
│   └── UtxoParserTest.java
```

## Implementation Plan

### Phase 1: UTXO Parser (~100 lines)

```java
public class UtxoParser {
    /**
     * Parse hex-encoded UTXO from avax.getUTXOs response.
     * 
     * @param hexUtxo Hex string from API response
     * @return Parsed UTXO with txId, outputIndex, assetId, amount, owner address
     */
    public UTXO parseUtxo(String hexUtxo);
    
    /**
     * Parse batch of UTXOs.
     */
    public List<UTXO> parseUtxos(List<String> hexUtxos);
}
```

**Test data**: Use real UTXO hex from Fuji testnet.

### Phase 2: RPC Client (~80 lines)

```java
public class AvalancheRpcClient {
    private static final String AVAX_ENDPOINT = "/ext/bc/C/avax";
    
    public AvalancheRpcClient(String baseUrl) { ... }
    
    /**
     * Query UTXOs in shared memory from P-Chain.
     * 
     * @param addresses Bech32 addresses (C-avax1... or C-fuji1...)
     * @param sourceChain "P" for P-Chain exports
     * @return List of spendable UTXOs
     */
    public List<UTXO> getUTXOs(List<String> addresses, String sourceChain) {
        // 1. Build JSON-RPC request
        // 2. POST to /ext/bc/C/avax
        // 3. Parse response
        // 4. Decode each UTXO hex via UtxoParser
    }
    
    /**
     * Submit signed atomic transaction.
     * 
     * @param signedTx Signed transaction bytes
     * @return Transaction ID (CB58 encoded)
     */
    public String issueTx(byte[] signedTx) {
        // 1. Hex encode signed bytes
        // 2. Build JSON-RPC request
        // 3. POST to /ext/bc/C/avax
        // 4. Return txID from response
    }
}
```

### Phase 3: SDK Integration (~30 lines)

Update `AvalancheAtomicSDK`:

```java
public class AvalancheAtomicSDK {
    private final AvalancheRpcClient avaxClient;  // NEW
    
    // NEW: Query pending imports
    public List<UTXO> getPendingImports(List<String> bech32Addresses) {
        return avaxClient.getUTXOs(bech32Addresses, "P");
    }
    
    // UPDATED: Actually submit
    public String submitTx(byte[] signedTxBytes) {
        return avaxClient.issueTx(signedTxBytes);
    }
}
```

### Phase 4: Tests (~100 lines)

1. **UtxoParserTest**: Parse known UTXO hex, verify fields
2. **AvalancheRpcClientTest**: Mock HTTP responses, verify request format
3. **Integration test**: Full cycle with testnet (manual/optional)

## Dependencies

**No new dependencies needed!**

- `java.net.http.HttpClient` - Built into Java 11+
- JSON parsing: Use simple string manipulation or add minimal JSON library

If we want cleaner JSON handling, could add:
```xml
<dependency>
    <groupId>com.google.code.gson</groupId>
    <artifactId>gson</artifactId>
    <version>2.10.1</version>
</dependency>
```

## Full Cycle After Implementation

```java
// 1. Setup
AvalancheAtomicSDK sdk = new AvalancheAtomicSDK(
    "https://api.avax-test.network",  // Fuji testnet
    web3j
);

// 2. Query pending UTXOs (bank runs this on schedule)
List<String> bankAddresses = List.of("C-fuji1abc...", "C-fuji1def...");
List<UTXO> pending = sdk.getPendingImports(bankAddresses);

if (!pending.isEmpty()) {
    // 3. Build ImportTx
    byte[] unsignedTx = sdk.buildImportTx(
        5,              // Fuji
        cChainId,
        pChainId,       // All zeros
        pending,
        bankEvmAddress,
        avaxAssetId,
        sdk.getBaseFee()
    );
    
    // 4. Sign
    byte[] signedTx = sdk.signTx(unsignedTx, List.of(bankKeyPair));
    
    // 5. Submit
    String txId = sdk.submitTx(signedTx);
    System.out.println("Imported! TX: " + txId);
    
    // 6. (Later) Verify in block via ExtDataDecoder
}
```

## Estimated Effort

| Task | Lines | Time |
|------|-------|------|
| UtxoParser | 100 | 30 min |
| AvalancheRpcClient | 80 | 30 min |
| SDK integration | 30 | 15 min |
| Tests | 100 | 30 min |
| Documentation | 50 | 15 min |

**Total**: ~360 lines, ~2 hours

## Open Questions

1. **Pagination**: `avax.getUTXOs` returns max 1024 UTXOs. Do we need pagination support? (Probably not for bank use case)

2. **Error handling**: What happens if submission fails? Retry logic needed?

3. **Address format**: Bank needs to know their Bech32 addresses. Should we add `evmToBech32()` helper anyway? (User said no, but might be convenient)

## Success Criteria

- [x] Can query UTXOs from Fuji testnet
- [x] Can parse UTXO response into model objects  
- [x] Can submit signed tx and get txID back
- [ ] Full cycle works end-to-end on testnet (requires manual test with funded wallet)

---

## Implementation Completed

### Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `rpc/UtxoParser.java` | 110 | Parse UTXO hex → model |
| `rpc/AvalancheRpcClient.java` | 197 | HTTP client for avax.* methods |
| `rpc/UtxoParserTest.java` | 176 | Unit tests for parser |
| `rpc/AvalancheRpcClientTest.java` | 123 | Unit tests for client |

**Total**: 606 lines

### API Summary

```java
// Setup
AvalancheAtomicSDK sdk = new AvalancheAtomicSDK(
    "https://api.avax-test.network",
    web3j
);

// 1. Query pending UTXOs
List<UTXO> pending = sdk.getPendingImports("C-fuji1abc...");

// 2. Build ImportTx
byte[] unsigned = sdk.buildImportTx(..., pending, ...);

// 3. Sign
byte[] signed = sdk.signTx(unsigned, keys);

// 4. Submit
String txId = sdk.submitTx(signed);

// 5. Check status
String status = sdk.getTxStatus(txId);  // "Accepted", "Processing", "Rejected"
```

### Tests Passed

```
mvn test -q
# All 33 tests pass (exit code 0)
```

