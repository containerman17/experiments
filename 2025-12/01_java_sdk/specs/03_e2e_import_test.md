# Spec 03: End-to-End Import Test

## Purpose

Validate the complete P→C atomic import cycle using real Fuji testnet transactions. This test proves the Java SDK can:
1. Query pending UTXOs from shared memory
2. Build a valid ImportTx
3. Sign it correctly
4. Submit it to the network
5. Verify acceptance

## Prerequisites

### Manual Setup (Done by Human Before Test)

1. **Generate test wallet** using the utility from Spec 04
2. **Fund the P-Chain address** with Fuji AVAX (use faucet or existing wallet)
3. **Export from P-Chain to C-Chain** using:
   - Avalanche Wallet (wallet.avax.network)
   - Or Core wallet
   - Or avalanche-cli
4. **Record the export details**:
   - Export transaction ID
   - Amount exported (in nAVAX)
   - Source P-Chain address
   - Destination C-Chain address (Bech32 format: `C-fuji1...`)

After export, funds sit in "shared memory" waiting to be claimed by a C-Chain ImportTx.

### Environment Requirements

- Java 21+
- Maven 3.8+
- Network access to Fuji testnet (`https://api.avax-test.network`)
- Test wallet credentials (private key)

---

## Test Scenario

### Context: The "Humiliation" Use Case

From the brainstorm document:
> If users export to your custodial P-Chain address and YOU need to import

**Scenario**: A sophisticated user exports AVAX from their P-Chain wallet to the bank's P-Chain address (converted to C-Chain Bech32). The bank must programmatically import these funds to their C-Chain EVM address, or the funds remain stuck.

### Flow

```
[Human: Export on P-Chain]
         │
         ▼
[Shared Memory: UTXOs waiting]
         │
         ▼
[Java SDK: Query UTXOs]  ←── avax.getUTXOs
         │
         ▼
[Java SDK: Build ImportTx]
         │
         ▼
[Java SDK: Sign]
         │
         ▼
[Java SDK: Submit]  ←── avax.issueTx
         │
         ▼
[Java SDK: Poll Status]  ←── avax.getTxStatus
         │
         ▼
[Verify: Funds in EVM balance]  ←── eth_getBalance
```

---

## Test Configuration

### Config File: `e2e-test-config.properties`

```properties
# Network
avalanche.node.url=https://api.avax-test.network
avalanche.network.id=5

# Chain IDs (Fuji testnet - decode from CB58 or fetch via info.getBlockchainID)
# C-Chain Fuji: yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp
avalanche.cchain.id=<32-byte-hex>

# P-Chain is always all zeros
avalanche.pchain.id=0000000000000000000000000000000000000000000000000000000000000000

# AVAX Asset ID (Fuji - decode from CB58)
# U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK
avalanche.avax.asset.id=<32-byte-hex>

# Test wallet (KEEP SECRET - use env vars in production)
test.private.key=<64-hex-chars>
test.bech32.address=C-fuji1...
test.evm.address=0x...

# Expected state after manual export
test.expected.utxo.count=1
test.expected.amount.navax=1000000000
```

### Environment Variables (Preferred for Secrets)

```bash
export E2E_PRIVATE_KEY="0x..."
export E2E_BECH32_ADDRESS="C-fuji1..."
export E2E_EVM_ADDRESS="0x..."
export E2E_EXPECTED_AMOUNT="1000000000"
```

---

## Test Steps

### Step 1: Query Pending UTXOs

**API Call**: `POST /ext/bc/C/avax`

```json
{
    "jsonrpc": "2.0",
    "method": "avax.getUTXOs",
    "params": {
        "addresses": ["C-fuji1..."],
        "sourceChain": "P",
        "encoding": "hex"
    },
    "id": 1
}
```

**Expected Response**:
```json
{
    "result": {
        "numFetched": "1",
        "utxos": ["0x0000..."],
        "endIndex": {...}
    }
}
```

**Validation**:
- `numFetched` >= 1
- Each UTXO hex can be parsed by `UtxoParser`
- Total amount matches expected

**Failure Modes**:
- `numFetched: 0` → Export not completed or wrong address
- Parse error → UTXO format mismatch

### Step 2: Parse UTXOs

Use `UtxoParser.parseUtxo(hexString)` for each UTXO.

**Validation**:
- `codecVersion` = 0
- `typeId` = 7 (SECP256K1TransferOutput)
- `assetId` matches AVAX asset ID
- `amount` > 0
- `threshold` = 1 (single-sig)

### Step 3: Get Current Base Fee

**API Call**: `POST /ext/bc/C/rpc`

```json
{
    "jsonrpc": "2.0",
    "method": "eth_baseFee",
    "params": [],
    "id": 1
}
```

**Expected**: Hex value like `0x5d21dba00` (25 GWei)

**Validation**:
- Non-zero
- Reasonable range (1-1000 GWei)

### Step 4: Build Unsigned ImportTx

Use `ImportTxBuilder.buildImportTx(...)`.

**Inputs**:
- `networkId`: 5 (Fuji)
- `cChainId`: 32 bytes from config
- `pChainId`: 32 zero bytes
- `utxos`: From step 2
- `toAddress`: EVM address (20 bytes)
- `avaxAssetId`: 32 bytes from config
- `baseFee`: From step 3

**Validation**:
- Output amount = total input - fee
- Fee calculation matches: `ceil((gasUsed * baseFee) / 1e9)`
- Gas used = `txBytes + (numInputs * 1000) + 10000`

### Step 5: Sign Transaction

Use `TxSigner.signImportTx(unsignedBytes, keyPairs)`.

**Validation**:
- One credential per input
- Each signature is 65 bytes
- Recovery ID (`v`) is in [0, 3], NOT [27, 30]
- Signature can recover to the expected public key

### Step 6: Submit Transaction

**API Call**: `POST /ext/bc/C/avax`

```json
{
    "jsonrpc": "2.0",
    "method": "avax.issueTx",
    "params": {
        "tx": "0x<signed-tx-hex>",
        "encoding": "hex"
    },
    "id": 1
}
```

**Expected Response**:
```json
{
    "result": {
        "txID": "2QouvFWUbjuySRxeX5xMbNCuAaKWfbk5FeEa2JmoF85RKLnC8"
    }
}
```

**Failure Modes**:
- `insufficient funds` → Fee calculation wrong
- `invalid signature` → Signing or serialization bug
- `invalid tx` → Codec format wrong
- `utxo not found` → Already imported or wrong UTXO reference

### Step 7: Poll for Acceptance

**API Call**: `POST /ext/bc/C/avax`

```json
{
    "jsonrpc": "2.0",
    "method": "avax.getTxStatus",
    "params": {
        "txID": "<txID-from-step-6>"
    },
    "id": 1
}
```

**Expected Status Progression**:
1. `Processing` (initial)
2. `Accepted` (final - success)

**Timeout**: 60 seconds with 2-second polling interval.

**Failure Modes**:
- `Rejected` → Transaction invalid
- `Unknown` → Transaction lost (rare)

### Step 8: Verify EVM Balance

**API Call**: `POST /ext/bc/C/rpc`

```json
{
    "jsonrpc": "2.0",
    "method": "eth_getBalance",
    "params": ["0x<evm-address>", "latest"],
    "id": 1
}
```

**Validation**:
- Balance increased by approximately (inputAmount - fee)
- Allow for pre-existing balance

---

## Test Class Structure

```
src/test/java/io/avalanche/atomic/e2e/
└── ImportCycleE2ETest.java
```

### Test Methods

```java
@Tag("e2e")  // Only run with: mvn test -Dgroups=e2e
class ImportCycleE2ETest {
    
    @BeforeAll
    static void loadConfig() { ... }
    
    @Test
    @Order(1)
    void step1_queryPendingUtxos() { ... }
    
    @Test
    @Order(2)
    void step2_parseUtxos() { ... }
    
    @Test
    @Order(3)
    void step3_getBaseFee() { ... }
    
    @Test
    @Order(4)
    void step4_buildImportTx() { ... }
    
    @Test
    @Order(5)
    void step5_signTransaction() { ... }
    
    @Test
    @Order(6)
    void step6_submitTransaction() { ... }
    
    @Test
    @Order(7)
    void step7_waitForAcceptance() { ... }
    
    @Test
    @Order(8)
    void step8_verifyEvmBalance() { ... }
}
```

### Running the Test

```bash
# Ensure env vars are set
export E2E_PRIVATE_KEY="0x..."
export E2E_BECH32_ADDRESS="C-fuji1..."
export E2E_EVM_ADDRESS="0x..."
export E2E_EXPECTED_AMOUNT="1000000000"

# Run E2E tests only
cd experiments/java_p_to_c_import
mvn test -Dgroups=e2e

# Or run specific test
mvn test -Dtest=ImportCycleE2ETest
```

---

## Success Criteria

| Step | Criterion |
|------|-----------|
| 1 | At least 1 UTXO found |
| 2 | All UTXOs parse without error |
| 3 | Base fee is reasonable |
| 4 | ImportTx builds without exception |
| 5 | Signature format is correct |
| 6 | Transaction ID returned |
| 7 | Status becomes "Accepted" within 60s |
| 8 | EVM balance increased |

---

## Troubleshooting Guide

### "No UTXOs found"

1. Verify export transaction is confirmed on P-Chain
2. Check address format (must be Bech32 `C-fuji1...`, not hex)
3. Wait 1-2 minutes for cross-chain propagation
4. Verify sourceChain is "P" not "X"

### "Invalid signature"

1. Check `v` value is 0-3, not 27-30
2. Verify signing the SHA256 hash, not raw bytes
3. Check key corresponds to UTXO owner address

### "Insufficient funds"

1. Fee calculation may be wrong
2. Check gas constants match spec
3. Verify output amount = inputs - fee

### "Invalid tx format"

1. Compare serialized bytes with Go reference
2. Check codec version prefix (2 bytes)
3. Verify type IDs for all nested structures
4. Check array length prefixes (4 bytes each)

### Transaction stuck in "Processing"

1. Network congestion - wait longer
2. Check base fee isn't too low
3. Verify transaction was actually broadcast

---

## Test Data Cleanup

After successful test:
1. Record the import transaction ID for audit
2. The imported funds are now in EVM balance
3. Can be used for future tests or sent back to P-Chain

---

## Notes for Implementing Agent

### Key Files to Reference

- `AvalancheAtomicSDK.java` - Main entry point
- `AvalancheRpcClient.java` - HTTP client for avax.* methods
- `UtxoParser.java` - Parse UTXO hex
- `ImportTxBuilder.java` - Build unsigned tx
- `TxSigner.java` - Sign with correct v value
- `LinearCodec.java` - Serialization format

### Critical Implementation Details

1. **Signature v value**: Web3j returns 27/28, Avalanche expects 0/1. Must subtract 27.

2. **Inputs must be sorted**: By (txId, outputIndex) lexicographically.

3. **Fee calculation**: `ceil((gas * baseFee) / 1e9)` where gas includes:
   - Transaction bytes × 1
   - Per-signature cost × 1000
   - Intrinsic gas = 10,000

4. **P-Chain ID is all zeros**: Don't use CB58-decoded value, use `new byte[32]`.

5. **Codec version prefix**: Every serialized message starts with 2-byte version (0x0000).

