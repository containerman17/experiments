# Avalanche P-Chain Export & C-Chain Import: Java Reimplementation Report

---

## ⚠️ ACTUAL REQUIREMENT (from Slack) ⚠️

The user wants to **detect deposits**, not necessarily create them.

**Specifically:** When a customer exports from P-Chain and imports to C-Chain, crediting YOUR C-Chain addresses, you need to:
1. Detect that ImportTx in C-Chain blocks
2. Parse the EVMOutput amounts and addresses
3. Credit the customer's account in your database

**Creating ImportTx is only needed if:**
- Customers export to YOUR custodial P-Chain addresses
- You need to programmatically claim/import them

**Priority order:**
1. **Detection (read-only)** - Parse BlockExtraData from C-Chain blocks
2. **Auto-import (write)** - Build and sign ImportTx (may not be needed)

---

## Executive Summary

After deep-diving into the AvalancheGo codebase, here's the minimal surface you need to implement in Java to:
1. **Detect deposits** (parse ImportTx from C-Chain BlockExtraData)
2. **Optionally execute imports** (if users export to your P-Chain addresses)

The good news: this is a well-defined, constrained problem. The bad news: there's still a fair bit of cryptographic and serialization work.

---

## The Flow

```
P-Chain Export Tx ──> Creates UTXOs in "shared memory" ──> C-Chain Import Tx consumes them
                      (indexed by destination address)
```

When someone exports from P-Chain to C-Chain specifying your address, UTXOs are created in shared memory. You must execute a C-Chain import transaction to claim them.

---

## 1. Cryptographic Requirements

### Curve: **secp256k1** (same as Bitcoin/Ethereum)

```go
// From utils/crypto/secp256k1/secp256k1.go
const (
    SignatureLen  = 65   // [r || s || v] format
    PrivateKeyLen = 32
    PublicKeyLen  = 33   // compressed
)
```

### Signing Process

```go
// Sign hash using secp256k1, producing recoverable signature
func (k *PrivateKey) SignHash(hash []byte) ([]byte, error) {
    sig := ecdsa.SignCompact(k.sk, hash, false) // returns [v || r || s]
    return rawSigToSig(sig)  // converts to [r || s || v]
}
```

**Java equivalent**: Use **BouncyCastle** with `ECDSASigner` + recovery ID calculation, or use web3j's `Sign` class which already handles secp256k1 recoverable signatures.

### Address Derivation

```go
// From utils/hashing/hashing.go
func PubkeyBytesToAddress(key []byte) []byte {
    return ComputeHash160(ComputeHash256(key))  // RIPEMD160(SHA256(pubkey))
}
```

**Java**: `RIPEMD160(SHA256(compressedPublicKey))` → 20-byte address

---

## 2. Address Encoding: Bech32

P-Chain addresses use **Bech32** encoding with HRP (Human Readable Part):

```go
// From utils/constants/network_ids.go
MainnetHRP = "avax"
FujiHRP    = "fuji"
```

Format: `P-{hrp}1{bech32data}` (e.g., `P-avax1...`)

**Java**: Use any Bech32 library (e.g., `bitcoinj` has one).

---

## 3. Transaction Structures

### 3.1 C-Chain Import Transaction (What you need to build)

```go
// From graft/coreth/plugin/evm/atomic/import_tx.go
type UnsignedImportTx struct {
    Metadata              // Internal tracking
    NetworkID    uint32   // 1 for mainnet, 5 for fuji
    BlockchainID ids.ID   // C-Chain ID (32 bytes)
    SourceChain  ids.ID   // Source chain ID being imported from (e.g. P-Chain ID), NOT "all zeros"
    ImportedInputs []*avax.TransferableInput  // UTXOs to consume
    Outs         []EVMOutput                   // EVM addresses to credit
}

type EVMOutput struct {
    Address common.Address  // 20-byte EVM address
    Amount  uint64          // Amount in nAVAX
    AssetID ids.ID          // AVAX asset ID
}
```

### 3.2 TransferableInput Structure

```go
// From vms/components/avax/transferables.go
type TransferableInput struct {
    UTXOID              // TxID (32 bytes) + OutputIndex (4 bytes)
    Asset               // AssetID (32 bytes)
    In   TransferableIn // The actual input data
}

// From vms/secp256k1fx/transfer_input.go
type TransferInput struct {
    Amt   uint64    // Amount being spent
    Input           // Contains SigIndices []uint32
}
```

### 3.3 Credential Structure

```go
// From vms/secp256k1fx/credential.go
type Credential struct {
    Sigs [][65]byte  // Array of 65-byte secp256k1 signatures
}
```

---

## 4. Serialization Format (Codec)

AvalancheGo uses a **linear codec** with type IDs. Key rules:

1. **Codec version**: `uint16` = 0
2. **Type IDs**: `uint32` prefixed before polymorphic types
3. **Arrays**: `uint32` length prefix
4. **Integers**: Big-endian

### Type IDs for C-Chain Atomic Transactions

```go
// From graft/coreth/plugin/evm/atomic/codec.go
lc.RegisterType(&UnsignedImportTx{})    // typeID = 0
lc.RegisterType(&UnsignedExportTx{})    // typeID = 1
// Skip 3
lc.RegisterType(&secp256k1fx.TransferInput{})  // typeID = 5
// Skip 1
lc.RegisterType(&secp256k1fx.TransferOutput{}) // typeID = 7
// Skip 1
lc.RegisterType(&secp256k1fx.Credential{})     // typeID = 9
```

### Example Serialization (Pseudocode)

```
UnsignedImportTx bytes (via codec.Manager.Marshal):
  [codecVersion: 2 bytes = 0x0000]     // YES, this IS included! See codec/manager.go:129
  [typeID: 4 bytes = 0]                // UnsignedImportTx
  [networkID: 4 bytes]
  [blockchainID: 32 bytes]
  [sourceChain: 32 bytes]              // P-Chain = all zeros
  [importedInputs length: 4 bytes]
  [for each input:
    [txID: 32 bytes]
    [outputIndex: 4 bytes]
    [assetID: 32 bytes]
    [typeID: 4 bytes = 5]              // secp256k1fx.TransferInput
    [amount: 8 bytes]
    [sigIndices length: 4 bytes]
    [sigIndices: n * 4 bytes]
  ]
  [outs length: 4 bytes]
  [for each out:
    [address: 20 bytes]
    [amount: 8 bytes]
    [assetID: 32 bytes]
  ]

Signed Tx bytes:
  [codecVersion: 2 bytes = 0x0000]
  [typeID: 4 bytes = 0]                // UnsignedImportTx
  [...unsigned tx fields...]
  [credentials length: 4 bytes]
  [for each credential:
    [typeID: 4 bytes = 9]              // secp256k1fx.Credential
    [sigs length: 4 bytes]
    [sigs: n * 65 bytes]               // [r(32) || s(32) || v(1)]
  ]
```

---

## 5. Signing Process

```go
// From graft/coreth/plugin/evm/atomic/tx.go
func (tx *Tx) Sign(c codec.Manager, signers [][]*secp256k1.PrivateKey) error {
    // 1. Marshal unsigned tx
    unsignedBytes, _ := c.Marshal(CodecVersion, &tx.UnsignedAtomicTx)
    
    // 2. Hash the unsigned bytes
    hash := hashing.ComputeHash256(unsignedBytes)  // SHA256
    
    // 3. Sign the hash for each input
    for _, keys := range signers {
        cred := &secp256k1fx.Credential{}
        for _, key := range keys {
            sig, _ := key.SignHash(hash)
            cred.Sigs = append(cred.Sigs, sig)
        }
        tx.Creds = append(tx.Creds, cred)
    }
    
    // 4. Marshal the full signed tx
    signedBytes, _ := c.Marshal(CodecVersion, tx)
    tx.Initialize(unsignedBytes, signedBytes)
}
```

**Key insight**: Sign `SHA256(unsignedTxBytes)`, NOT the raw bytes.

---

## 6. API Endpoints Required

### 6.1 Get UTXOs (to detect pending imports)

For "funds waiting to be imported to C-Chain", you must query the atomic/shared-memory UTXOs.
Those are exposed by the C-Chain atomic API as `avax.getUTXOs` and REQUIRE `sourceChain`.

**Endpoint**: `POST /ext/bc/C/avax` (C-Chain Atomic API)

```json
{
    "jsonrpc": "2.0",
    "method": "avax.getUTXOs",
    "params": {
        "addresses": ["P-avax1..."],
        "sourceChain": "P",
        "encoding": "hex"
    },
    "id": 1
}
```

### 6.2 Issue Import Transaction

**Endpoint**: `POST /ext/bc/C/avax` (C-Chain Atomic API)

```json
{
    "jsonrpc": "2.0",
    "method": "avax.issueTx",
    "params": {
        "tx": "0x...",
        "encoding": "hex"
    },
    "id": 1
}
```

### 6.3 Get Base Fee (for dynamic fee calculation)

**Endpoint**: `POST /ext/bc/C/rpc` (C-Chain EVM API)

```json
{
    "jsonrpc": "2.0",
    "method": "eth_baseFee",
    "params": [],
    "id": 1
}
```

---

## 7. Fee Calculation

```go
// From graft/coreth/plugin/evm/atomic/tx.go
func CalculateDynamicFee(cost uint64, baseFee *big.Int) (uint64, error) {
    // fee = ceil((cost * baseFee) / 1e9)
    fee := new(big.Int).SetUint64(cost)
    fee.Mul(fee, baseFee)
    fee.Add(fee, big.NewInt(999999999))  // Round up
    fee.Div(fee, big.NewInt(1000000000))
    return fee.Uint64(), nil
}

// Gas calculation
const (
    TxBytesGas   = 1       // per byte
    EVMOutputGas = 60      // (AddressLen=20 + LongLen=8 + HashLen=32) * 1 = 60 ← VERIFIED
    AtomicTxIntrinsicGas = 10000  // fixed overhead (post-AP5)
)

func (utx *UnsignedImportTx) GasUsed(fixedFee bool) (uint64, error) {
    cost := len(utx.Bytes()) * TxBytesGas
    for _, in := range utx.ImportedInputs {
        cost += in.In.Cost()  // ~1100 per sig
    }
    if fixedFee {
        cost += AtomicTxIntrinsicGas
    }
    return cost, nil
}
```

---

## 8. Minimal Java Implementation Checklist

### Core Classes Needed:

| Class | Purpose |
|-------|---------|
| `Secp256k1Signer` | Key management, signing with recovery |
| `Bech32Address` | Address encoding/decoding |
| `AvalancheCodec` | Binary serialization |
| `UTXO` | UTXO data structure |
| `TransferableInput` | Input structure |
| `EVMOutput` | Output structure |
| `UnsignedImportTx` | Import transaction |
| `Credential` | Signature credential |
| `AtomicTx` | Signed transaction wrapper |
| `AvalancheClient` | JSON-RPC API client |

### External Libraries:

```xml
<dependencies>
    <!-- Web3j - USE THIS (RLP, signing, JSON-RPC all in one) -->
    <dependency>
        <groupId>org.web3j</groupId>
        <artifactId>core</artifactId>
        <version>4.10.3</version>
    </dependency>
    
    <!-- Bech32 for P-Chain addresses (optional) -->
    <dependency>
        <groupId>org.bitcoinj</groupId>
        <artifactId>bitcoinj-core</artifactId>
        <version>0.16.2</version>
    </dependency>
</dependencies>
```

### Web3j Integration Guide (Since You Already Use It)

**What Web3j Gives You For Free:**

| Component | Web3j Class | Notes |
|-----------|-------------|-------|
| RLP Decode | `org.web3j.rlp.RlpDecoder` | Use for BlockBody → ExtData extraction |
| RLP Encode | `org.web3j.rlp.RlpEncoder` | Not needed for detection |
| secp256k1 Sign | `org.web3j.crypto.Sign` | Returns `v+27`, subtract 27 for Avalanche |
| Key Management | `org.web3j.crypto.ECKeyPair` | Standard secp256k1 |
| JSON-RPC | `org.web3j.protocol.Web3j` | For `eth_getBlockByNumber`, `eth_baseFee` |
| SHA256 | `org.web3j.crypto.Hash.sha256()` | For tx signing |

**What You MUST Write Custom:**

| Component | Why |
|-----------|-----|
| Linear Codec Deserializer | Avalanche-specific format, no library exists |
| ExtData Parser | Avalanche batch format, not RLP inside |
| Linear Codec Serializer | Only if you need to create ImportTx |

**Web3j Signature Fix:**

```java
import org.web3j.crypto.Sign;
import org.web3j.crypto.ECKeyPair;

public byte[] signForAvalanche(byte[] hash, ECKeyPair keyPair) {
    Sign.SignatureData sig = Sign.signMessage(hash, keyPair, false);
    
    byte[] result = new byte[65];
    System.arraycopy(sig.getR(), 0, result, 0, 32);
    System.arraycopy(sig.getS(), 0, result, 32, 32);
    
    // CRITICAL: Web3j returns v as 27 or 28, Avalanche expects 0 or 1
    result[64] = (byte) (sig.getV()[0] - 27);
    
    return result;
}
```

**Web3j RLP for Block Parsing:**

```java
import org.web3j.rlp.*;

public byte[] extractExtDataFromBlock(byte[] blockBodyRlp) {
    RlpList decoded = RlpDecoder.decode(blockBodyRlp);
    RlpList body = (RlpList) decoded.getValues().get(0);
    
    // Avalanche C-Chain has 4 elements, not 2
    if (body.getValues().size() < 4) {
        return null; // No atomic txs in this block
    }
    
    // Index 3 = ExtData
    RlpString extData = (RlpString) body.getValues().get(3);
    return extData.getBytes();
}
```

**Web3j for C-Chain RPC:**

```java
import org.web3j.protocol.Web3j;
import org.web3j.protocol.http.HttpService;

Web3j web3 = Web3j.build(new HttpService("https://api.avax.network/ext/bc/C/rpc"));

// Get block with full body
EthBlock block = web3.ethGetBlockByNumber(
    DefaultBlockParameter.valueOf(BigInteger.valueOf(blockNum)), 
    true
).send();

// Get base fee for fee calculation
EthBaseFee baseFee = web3.ethBaseFee().send();
```

---

## 9. Key Constants

```java
public class AvalancheConstants {
    // Chain IDs
    // Do NOT hardcode these as "all zeros".
    // Parse the CB58 string form of the chain IDs into 32-byte ids.ID at runtime.
    // (P-Chain is constants.PlatformChainID in avalanchego; C-Chain differs per network.)
    
    // Network IDs
    public static final int MAINNET_ID = 1;
    public static final int FUJI_ID = 5;
    
    // Bech32 HRPs
    public static final String MAINNET_HRP = "avax";
    public static final String FUJI_HRP = "fuji";
    
    // C-Chain ID (from genesis)
    // Mainnet: 2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5
    // Fuji: yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp
    
    // AVAX Asset ID (from genesis)
    // Mainnet: FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z
    
    // Codec type IDs for C-Chain atomic txs
    public static final int TYPE_UNSIGNED_IMPORT_TX = 0;
    public static final int TYPE_UNSIGNED_EXPORT_TX = 1;
    public static final int TYPE_TRANSFER_INPUT = 5;
    public static final int TYPE_TRANSFER_OUTPUT = 7;
    public static final int TYPE_CREDENTIAL = 9;
    
    // Gas constants - VERIFIED from source
    public static final long TX_BYTES_GAS = 1;
    public static final long EVM_OUTPUT_GAS = 60;  // (20 + 8 + 32) * 1
    public static final long EVM_INPUT_GAS = 1060; // EVMOutputGas + CostPerSignature
    public static final long ATOMIC_TX_INTRINSIC_GAS = 10_000;  // post-AP5
    public static final long SECP256K1_FX_COST_PER_SIG = 1000;
}
```

---

## 10. Workflow Summary

```java
// 1. Get pending UTXOs from shared memory
List<UTXO> utxos = client.getAtomicUTXOs(myPChainAddress, "P"); // Source = P-Chain

// 2. If UTXOs exist, build import tx
if (!utxos.isEmpty()) {
    BigInteger baseFee = client.getBaseFee();
    
    // Calculate total amount
    long totalAmount = utxos.stream()
        .mapToLong(UTXO::getAmount)
        .sum();
    
    // Build inputs from UTXOs
    List<TransferableInput> inputs = utxos.stream()
        .map(utxo -> new TransferableInput(
            utxo.getTxId(),
            utxo.getOutputIndex(),
            AVAX_ASSET_ID,
            new TransferInput(utxo.getAmount(), new int[]{0})
        ))
        .sorted()  // Must be sorted!
        .collect(toList());
    
    // Build unsigned tx
    UnsignedImportTx unsignedTx = new UnsignedImportTx(
        MAINNET_ID,
        C_CHAIN_ID,
        P_CHAIN_ID,  // Source chain (importing FROM P)
        inputs,
        List.of(new EVMOutput(myEvmAddress, totalAmount - fee, AVAX_ASSET_ID))
    );
    
    // 3. Serialize and sign
    byte[] unsignedBytes = codec.marshal(unsignedTx);
    byte[] hash = sha256(unsignedBytes);
    
    List<Credential> credentials = inputs.stream()
        .map(input -> {
            byte[] sig = privateKey.signRecoverable(hash);
            return new Credential(List.of(sig));
        })
        .collect(toList());

    // IMPORTANT: signature bytes must match avalanchego's format: [r || s || v]
    // where v is the recovery id in [0..3] (NOT +27). See utils/crypto/secp256k1/rawSigToSig.
    
    AtomicTx signedTx = new AtomicTx(unsignedTx, credentials);
    byte[] signedBytes = codec.marshal(signedTx);
    
    // 4. Submit
    String txId = client.issueTx(Hex.encode(signedBytes));
    System.out.println("Import tx submitted: " + txId);
}
```

---

## 11. Estimated Implementation Effort

| Component | Complexity | Lines of Java (est.) |
|-----------|------------|---------------------|
| Codec/Serialization | Medium | 300-400 |
| Crypto (secp256k1) | Low (use library) | 50-100 |
| Address encoding | Low | 50-100 |
| Transaction structures | Medium | 200-300 |
| API client | Low | 100-150 |
| Fee calculation | Low | 50 |
| **Total** | | **~800-1100** |

This is a focused, achievable scope. The main complexity is getting the binary serialization exactly right—the codec format is specific to Avalanche.

---

## 12. Testing Strategy

1. **Unit test serialization** against known good bytes from Go implementation
2. **Test on Fuji testnet** before mainnet
3. **Compare tx hashes** between your Java impl and Go SDK for same inputs
4. **Start with small amounts** to validate the full flow

---

## 13. References

Key source files in AvalancheGo:
- `graft/coreth/plugin/evm/atomic/import_tx.go` - Import tx structure
- `graft/coreth/plugin/evm/atomic/tx.go` - Signing logic
- `graft/coreth/plugin/evm/atomic/codec.go` - Type registration
- `utils/crypto/secp256k1/secp256k1.go` - Crypto primitives
- `vms/secp256k1fx/transfer_input.go` - Input structures
- `vms/components/avax/transferables.go` - UTXO structures
- `wallet/chain/c/builder.go` - Transaction building example
- `wallet/chain/c/signer.go` - Signing example

---

## 14. ⚠️ CRITICAL CODE REVIEW CORRECTIONS ⚠️

**The following corrections came from peer review and are MUST-FIX before implementation.**

---

### 14.1 Chain ID Clarification

**P-Chain ID IS all zeros.** From `utils/constants/network_ids.go`:
```go
PlatformChainID = ids.Empty  // [32]byte{0,0,0...0}
```

The CB58 string `11111111111111111111111111111111LpoYY` is simply the encoding of 32 zero bytes.

**However, C-Chain and X-Chain IDs are NOT zeros** - they're derived from genesis and differ per network:
```java
// P-Chain: all zeros (same for all networks)
public static final byte[] P_CHAIN_ID = new byte[32];

// C-Chain: network-specific, decode from CB58
// Mainnet: "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5"
// Fuji:    "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp"
```

**Safe approach:** Fetch chain IDs from the node at runtime via `info.getBlockchainID`.

---

### 14.2 THE ACTUAL REQUIREMENT: Detection, Not Just Creation

Re-reading the original Slack:
> "We need to parse BlockExtraData to detect deposits from the importTx so we can credit our customer."

The plan above focuses on **creating** ImportTx. But the actual ask has TWO parts:

#### Part A: Detect Deposits (read-only)
When someone else executes an ImportTx that credits YOUR C-Chain address:
1. Poll C-Chain blocks
2. Extract `BlockExtraData` from the block
3. Decode atomic transactions
4. Find ImportTx where `Outs` contains your EVM addresses
5. Credit customer balances

#### Part B: Execute Imports (write)
If users export to your P-Chain address and YOU need to import:
1. Query pending UTXOs from shared memory
2. Build and sign ImportTx
3. Submit to C-Chain

**Most likely you need Part A.** Part B is only needed if users directly export to your custodial P-Chain address, which is unusual.

---

### 14.3 BlockExtraData Structure (NOT Standard RLP)

Standard Ethereum Block Body: `[Transactions, Uncles]`

**Avalanche C-Chain Block Body**: `[Transactions, Uncles, Version, ExtData]`

```
RLP List:
  [0] Transactions  - Standard ETH txs
  [1] Uncles        - Standard ETH uncles (usually empty)
  [2] Version       - uint32, currently 0
  [3] ExtData       - byte[] containing Avalanche atomic txs
```

**If you feed a C-Chain block into standard Web3j/Ethereum decoder, it will FAIL or discard ExtData.**

You need a custom RLP decoder that expects 4 elements:

```java
import org.web3j.rlp.RlpDecoder;
import org.web3j.rlp.RlpList;
import org.web3j.rlp.RlpString;

public byte[] extractExtData(byte[] blockBodyRlp) {
    RlpList decoded = RlpDecoder.decode(blockBodyRlp);
    RlpList body = (RlpList) decoded.getValues().get(0);
    
    if (body.getValues().size() < 4) {
        // Standard ETH block or pre-atomic block
        return null;
    }
    
    // Index 0: Transactions
    // Index 1: Uncles
    // Index 2: Version (uint32)
    // Index 3: ExtData (bytes)
    
    RlpString extDataRlp = (RlpString) body.getValues().get(3);
    return extDataRlp.getBytes();  // Raw ExtData bytes
}
```

**TRAP:** `ExtData` is RLP-encoded as bytes. The RLP prefix wraps the raw bytes. After extracting, you parse with Avalanche's linear codec, NOT more RLP.

---

### 14.4 ExtData Internal Structure

**ALWAYS assume Post-ApricotPhase5 (AP5).** Mainnet passed AP5 years ago. Do not write hybrid code.

**Format (Post-AP5 Batch):**
```
[count: 4 bytes]
[Tx1 bytes...]
[Tx2 bytes...]
...
```

Each Tx is a complete signed atomic tx with codec version prefix.

**Parsing pseudocode:**
```java
List<Tx> parseExtData(byte[] extData) {
    if (extData == null || extData.length == 0) {
        return Collections.emptyList();
    }
    
    ByteBuffer buf = ByteBuffer.wrap(extData).order(BIG_ENDIAN);
    int count = buf.getInt();
    
    List<Tx> txs = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
        txs.add(parseSingleAtomicTx(buf));
    }
    return txs;
}
```

**Note:** If you encounter ancient pre-AP5 blocks where this fails, log and skip them. Do not over-engineer legacy support.

---

### 14.5 Type ID Collision When Parsing

When scanning ExtData, you'll encounter both:
- `ImportTx` (Type ID 0) - what you want
- `ExportTx` (Type ID 1) - other people's exports, SKIP these

You don't need to fully decode ExportTx, but you need to:
1. Read the type ID
2. If type != 0, skip to next tx
3. If type == 0, decode as ImportTx and check addresses

---

### 14.6 EVMOutputGas Constant Correction

**WRONG:**
```java
public static final long EVM_OUTPUT_GAS = 88;  // ❌ WRONG
```

**CORRECT:**
```go
// From tx.go
EVMOutputGas = (common.AddressLength + wrappers.LongLen + hashing.HashLen) * TxBytesGas
             = (20 + 8 + 32) * 1
             = 60
```

```java
public static final long EVM_OUTPUT_GAS = 60;  // ✅ CORRECT
```

---

### 14.7 Nested Input Structure

The TransferableInput has more nesting than shown:

```
TransferableInput {
  UTXOID {
    TxID: [32]byte
    OutputIndex: uint32
  }
  Asset {
    ID: [32]byte
  }
  FxID: [32]byte  // NOT serialized, but needed for type routing
  In: TransferInput {
    Amt: uint64
    Input {           // ← This layer was missing!
      SigIndices: []uint32
    }
  }
}
```

---

### 14.8 Fee Calculation is Iterative

You can't calculate fee without knowing tx size, but tx size depends on fee (output amount changes). Solution:

```java
// 1. Build tx with output = totalAmount (assume 0 fee)
UnsignedImportTx tx1 = buildTx(totalAmount);
byte[] bytes1 = serialize(tx1);

// 2. Calculate gas from tx size
long gas = bytes1.length * TX_BYTES_GAS 
         + numInputs * COST_PER_SIG 
         + ATOMIC_TX_INTRINSIC_GAS;

// 3. Calculate fee
long fee = ceilDiv(gas * baseFee, 1_000_000_000L);

// 4. Rebuild tx with correct output amount
UnsignedImportTx tx2 = buildTx(totalAmount - fee);

// 5. Verify gas didn't change significantly (it shouldn't for same input count)
```

---

### 14.9 Don't Build a Generic Codec

**YAGNI.** You need exactly:
- **Deserializer**: Parse ImportTx from ExtData (for detection) - PRIORITY
- **Serializer**: Serialize ImportTx + Credentials (for submission) - if needed

Don't build a reflection-based generic codec. Hardcode the byte packing:

```java
public class ImportTxCodec {
    private static final short CODEC_VERSION = 0;
    private static final int TYPE_UNSIGNED_IMPORT_TX = 0;
    private static final int TYPE_TRANSFER_INPUT = 5;
    private static final int TYPE_CREDENTIAL = 9;
    
    public byte[] serializeUnsigned(UnsignedImportTx tx) {
        ByteBuffer buf = ByteBuffer.allocate(estimateSize(tx));
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Codec version prefix - REQUIRED
        buf.putShort(CODEC_VERSION);          // 2 bytes
        
        // Type ID
        buf.putInt(TYPE_UNSIGNED_IMPORT_TX);  // 4 bytes = 0
        
        // Fields
        buf.putInt(tx.networkId);
        buf.put(tx.blockchainId);             // 32 bytes
        buf.put(tx.sourceChain);              // 32 bytes
        
        // Inputs
        buf.putInt(tx.inputs.size());
        for (TransferableInput in : tx.inputs) {
            buf.put(in.txId);                 // 32 bytes (UTXOID.TxID)
            buf.putInt(in.outputIndex);       // 4 bytes  (UTXOID.OutputIndex)
            buf.put(in.assetId);              // 32 bytes (Asset.ID)
            buf.putInt(TYPE_TRANSFER_INPUT);  // 4 bytes = 5 (nested type!)
            buf.putLong(in.amount);           // 8 bytes
            buf.putInt(in.sigIndices.length); // 4 bytes
            for (int idx : in.sigIndices) {
                buf.putInt(idx);              // 4 bytes each
            }
        }
        
        // EVMOutputs (no type ID - not polymorphic)
        buf.putInt(tx.outs.size());
        for (EVMOutput out : tx.outs) {
            buf.put(out.address);             // 20 bytes
            buf.putLong(out.amount);          // 8 bytes
            buf.put(out.assetId);             // 32 bytes
        }
        
        return Arrays.copyOf(buf.array(), buf.position());
    }
    
    public byte[] serializeSigned(UnsignedImportTx tx, List<Credential> creds) {
        byte[] unsigned = serializeUnsigned(tx);
        
        // Calculate signed size
        int credsSize = 4; // creds length
        for (Credential c : creds) {
            credsSize += 4 + 4 + (c.sigs.size() * 65); // typeID + sigsLen + sigs
        }
        
        ByteBuffer buf = ByteBuffer.allocate(unsigned.length + credsSize);
        buf.order(ByteOrder.BIG_ENDIAN);
        buf.put(unsigned);
        
        // Credentials
        buf.putInt(creds.size());
        for (Credential cred : creds) {
            buf.putInt(TYPE_CREDENTIAL);      // 4 bytes = 9
            buf.putInt(cred.sigs.size());
            for (byte[] sig : cred.sigs) {
                buf.put(sig);                 // 65 bytes [r||s||v]
            }
        }
        
        return Arrays.copyOf(buf.array(), buf.position());
    }
}
```

~100 lines for serializer. Deserializer is similar but reads instead of writes.

---

### 14.10 Corrected Constants

```java
public class AvalancheConstants {
    // Network IDs
    public static final int MAINNET_ID = 1;
    public static final int FUJI_ID = 5;
    
    // Chain IDs - fetch from node or decode CB58
    // P-Chain: "11111111111111111111111111111111LpoYY" → ids.Empty (all zeros)
    // C-Chain Mainnet: "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5"
    // C-Chain Fuji: "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp"
    
    // AVAX Asset ID (CB58)
    // Mainnet: "FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z"
    
    // Type IDs (C-Chain atomic codec)
    public static final int TYPE_UNSIGNED_IMPORT_TX = 0;
    public static final int TYPE_UNSIGNED_EXPORT_TX = 1;
    public static final int TYPE_SECP256K1_TRANSFER_INPUT = 5;
    public static final int TYPE_SECP256K1_TRANSFER_OUTPUT = 7;
    public static final int TYPE_SECP256K1_CREDENTIAL = 9;
    
    // Gas constants
    public static final long TX_BYTES_GAS = 1;
    public static final long EVM_OUTPUT_GAS = 60;  // CORRECTED from 88
    public static final long EVM_INPUT_GAS = 1000 + 60;  // sig cost + metadata
    public static final long ATOMIC_TX_INTRINSIC_GAS = 10_000;
}
```

---

### 14.11 Revised Effort Estimate

| Component | Original | Revised |
|-----------|----------|---------|
| Codec (hardcoded, not generic) | 300-400 | **100-150** |
| RLP decoder for BlockExtraData | 0 | **100-150** |
| Crypto | 50-100 | 50-100 |
| Transaction structures | 200-300 | 150-200 |
| API client | 100-150 | 100-150 |
| Fee calculation | 50 | 50 |
| Test harness & debugging | 0 | **200-300** |
| **Total** | 800-1100 | **750-1100** |

Estimate is similar but composition changed significantly.

---

### 14.12 Alternative: Use Go SDK via Subprocess

If this is getting complex, consider:

```java
// Shell out to Go for the hard parts
ProcessBuilder pb = new ProcessBuilder(
    "go", "run", "decoder.go", 
    Hex.encode(extDataBytes)
);
String json = readProcessOutput(pb.start());
List<ImportTx> txs = parseJson(json);
```

Write 50 lines of Go to decode BlockExtraData, call it from Java. 
This is not elegant but it's **guaranteed correct** and ships faster.

---

### 14.13 Signature Generation with Recovery ID

The signature format `[r || s || v]` where `v` is recovery ID `[0..3]` (NOT +27):

```java
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;

public byte[] signRecoverable(byte[] hash, ECPrivateKeyParameters privateKey, ECPoint publicKey) {
    ECDSASigner signer = new ECDSASigner(new HMacDSAKCalculator(new SHA256Digest()));
    signer.init(true, privateKey);
    BigInteger[] components = signer.generateSignature(hash);
    
    BigInteger r = components[0];
    BigInteger s = components[1];
    
    // Ensure s is in lower half of curve order (BIP-62 malleability fix)
    BigInteger halfN = CURVE.getN().shiftRight(1);
    if (s.compareTo(halfN) > 0) {
        s = CURVE.getN().subtract(s);
    }
    
    // Find recovery ID by trying all 4 possibilities
    int recId = -1;
    for (int i = 0; i < 4; i++) {
        ECPoint recovered = recoverPublicKey(hash, r, s, i);
        if (recovered != null && recovered.equals(publicKey)) {
            recId = i;
            break;
        }
    }
    if (recId == -1) {
        throw new IllegalStateException("Could not find recovery ID");
    }
    
    // Assemble [r(32) || s(32) || v(1)]
    byte[] sig = new byte[65];
    byte[] rBytes = toBytesPadded(r, 32);
    byte[] sBytes = toBytesPadded(s, 32);
    System.arraycopy(rBytes, 0, sig, 0, 32);
    System.arraycopy(sBytes, 0, sig, 32, 32);
    sig[64] = (byte) recId;  // NOT recId + 27!
    
    return sig;
}

// Helper to pad BigInteger to fixed byte length
private byte[] toBytesPadded(BigInteger value, int length) {
    byte[] bytes = value.toByteArray();
    if (bytes.length == length) return bytes;
    if (bytes.length > length) {
        // Remove leading zero
        return Arrays.copyOfRange(bytes, bytes.length - length, bytes.length);
    }
    // Pad with leading zeros
    byte[] padded = new byte[length];
    System.arraycopy(bytes, 0, padded, length - bytes.length, bytes.length);
    return padded;
}
```

**Alternative:** Use web3j's `Sign.signMessage()` which handles this, but returns `v+27`. Subtract 27.

---

### 14.14 Final Architecture Recommendation

```
┌─────────────────────────────────────────────────────────┐
│                    Java Application                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────┐    ┌──────────────────────────┐   │
│  │ Block Poller     │    │ UTXO Checker             │   │
│  │ (eth_getBlock)   │    │ (avax.getUTXOs)          │   │
│  └────────┬─────────┘    └────────────┬─────────────┘   │
│           │                           │                  │
│           ▼                           ▼                  │
│  ┌──────────────────┐    ┌──────────────────────────┐   │
│  │ ExtData Parser   │    │ ImportTx Builder         │   │
│  │ (detect credits) │    │ (claim pending UTXOs)    │   │
│  └────────┬─────────┘    └────────────┬─────────────┘   │
│           │                           │                  │
│           ▼                           ▼                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Customer Credit Logic                │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Priority order:**
1. ExtData Parser (for deposit detection) - THIS IS THE CORE ASK
2. UTXO Checker (to see pending imports)
3. ImportTx Builder (only if you actually need to execute imports)

---

## 15. TESTING STRATEGY (Based on Go Tests)

The Go codebase has excellent tests in `graft/coreth/plugin/evm/atomic/vm/import_tx_test.go` and `graft/coreth/plugin/evm/atomic/tx_test.go`. Use these as your verification source.

### 15.1 Test Vectors from Go (Use These Exactly)

From `TestImportTxGasCost`:

| Test Case | Inputs | Outputs | Expected Gas | Expected Fee (baseFee=25 GWei) |
|-----------|--------|---------|--------------|-------------------------------|
| simple import | 1 UTXO, 1 sig | 1 EVMOutput | 1230 | 30750 nAVAX |
| simple import (1 wei) | 1 UTXO, 1 sig | 1 EVMOutput | 1230 | 1 nAVAX |
| simple import + fixedFee | 1 UTXO, 1 sig | 1 EVMOutput | **11230** | 1 nAVAX |
| multisig (2 sigs) | 1 UTXO, 2 sigs | 1 EVMOutput | 2234 | 55850 nAVAX |
| large import | 10 UTXOs, 10 sigs | 1 EVMOutput | 11022 | 275550 nAVAX |

**Test #1: Verify gas = 1230 for simple import (pre-AP5)**
- Build tx with: 1 input (1 sig), 1 output
- Call `GasUsed(false)` → must equal 1230
- Formula check: `len(txBytes) * 1 + 1 * 1000 = 230 + 1000 = 1230`

**Test #2: Verify gas = 11230 for simple import (post-AP5)**
- Same tx
- Call `GasUsed(true)` → must equal 11230
- Formula: `230 + 1000 + 10000 = 11230`

### 15.2 Serialization Test Strategy

1. **Golden bytes test**: Serialize an ImportTx in Go, save the bytes, deserialize in Java
2. **Round-trip test**: Create tx in Java, serialize, deserialize, verify all fields match
3. **Hash test**: Compare `SHA256(unsignedBytes)` between Go and Java for same input

```java
// Example test data from Go tests
@Test
void testImportTxSerialization() {
    UnsignedImportTx tx = new UnsignedImportTx();
    tx.networkId = 5;  // Fuji
    tx.blockchainId = /* C-Chain Fuji ID */;
    tx.sourceChain = new byte[32];  // P-Chain = zeros
    tx.importedInputs = List.of(
        new TransferableInput(
            /* txId */ randomBytes(32),
            /* outputIndex */ 0,
            /* assetId */ avaxAssetId,
            new TransferInput(5_000_000L, new int[]{0})
        )
    );
    tx.outs = List.of(
        new EVMOutput(testEthAddress, 5_000_000L, avaxAssetId)
    );
    
    byte[] serialized = codec.serialize(tx);
    
    // Verify structure
    ByteBuffer buf = ByteBuffer.wrap(serialized);
    assertEquals(0, buf.getShort());      // codec version
    assertEquals(0, buf.getInt());         // type ID = ImportTx
    assertEquals(5, buf.getInt());         // networkId
    // ... continue verifying each field
}
```

### 15.3 Critical Validation Tests

From `TestImportTxVerify`:

| Condition | Expected Error |
|-----------|---------------|
| nil tx | `ErrNilTx` |
| no inputs | `ErrNoImportInputs` |
| wrong network ID | `ErrWrongNetworkID` |
| wrong blockchain ID | `ErrWrongChainID` |
| P-chain source pre-AP5 | `ErrWrongChainID` |
| P-chain source post-AP5 | **valid** |
| inputs not sorted | `ErrInputsNotSortedUnique` |
| outputs not sorted (AP2+) | `ErrOutputsNotSortedUnique` |
| no outputs (AP3+) | `ErrNoEVMOutputs` |
| non-AVAX input (Banff+) | `ErrImportNonAVAXInputBanff` |

### 15.4 Integration Test with Real Data

1. **Get a real block with atomic tx** from Fuji testnet:
   - Use `eth_getBlockByNumber` with `true` for full tx
   - C-Chain blocks with atomic txs have non-empty ExtData

2. **Parse ExtData and verify**:
   ```java
   byte[] extData = extractExtData(blockBodyRlp);
   List<AtomicTx> txs = parseExtData(extData);
   
   for (AtomicTx tx : txs) {
       if (tx.typeId == TYPE_IMPORT_TX) {
           ImportTx importTx = (ImportTx) tx;
           System.out.println("Found ImportTx:");
           System.out.println("  Source: " + hex(importTx.sourceChain));
           for (EVMOutput out : importTx.outs) {
               System.out.println("  -> " + out.address + ": " + out.amount);
           }
       }
   }
   ```

3. **Cross-reference with explorer** to verify parsed amounts/addresses match

### 15.5 Signature Verification Test

```java
@Test
void testSignatureFormat() {
    // Generate key pair
    ECKeyPair keyPair = Keys.createEcKeyPair();
    byte[] privateKey = keyPair.getPrivateKey().toByteArray();
    byte[] publicKey = compressPublicKey(keyPair.getPublicKey());
    
    // Create and sign
    byte[] unsignedBytes = codec.serialize(tx);
    byte[] hash = sha256(unsignedBytes);
    byte[] signature = signRecoverable(hash, privateKey);
    
    // Verify format: [r(32) || s(32) || v(1)]
    assertEquals(65, signature.length);
    
    // Verify recovery
    byte[] recovered = recoverPublicKey(hash, signature);
    assertArrayEquals(publicKey, recovered);
    
    // Verify v is in [0,3], NOT [27,30]
    assertTrue(signature[64] <= 3);
}
```

---

## 16. SELF-REVIEW VERIFICATION SUMMARY

I verified the following against 20+ source files:

| Claim | Source File | Verified |
|-------|-------------|----------|
| Codec version = 2 bytes | `codec/manager.go:129` | ✅ |
| Type IDs = 4 bytes | `linearcodec/codec.go:92` | ✅ |
| P-Chain ID = all zeros | `constants/network_ids.go:50` | ✅ |
| AtomicTxIntrinsicGas = 10,000 | `upgrade/ap5/params.go:38` | ✅ |
| EVMOutputGas = 60 | `atomic/tx.go:53` | ✅ |
| CostPerSignature = 1000 | `secp256k1fx/input.go:14` | ✅ |
| Signature = [r\|\|s\|\|v], v∈[0,3] | `secp256k1/secp256k1.go:293-301` | ✅ |
| TransferInput has nested Input | `secp256k1fx/transfer_input.go:14-17` | ✅ |
| FxID not serialized | `avax/transferables.go:144` | ✅ |
| BlockBodyExtra has Version, ExtData | `customtypes/block_ext.go:26-29` | ✅ |
| ExtData batch format post-AP5 | `atomic/codec.go:61-74` | ✅ |

---

## 17. STOP DOCUMENTING, START CODING

This document is now comprehensive enough. Further refinement is procrastination.

**Day 1:** Write RLP decoder, test on actual C-Chain block with atomic txs
**Day 2:** Write ExtData/ImportTx deserializer, verify you can extract EVMOutputs
**Day 3:** Integrate into your system, test E2E

If by Day 2 you're stuck on codec details despite this doc, the doc isn't the problem - you need to compare bytes side-by-side with what AvalancheGo produces.

**Test data:** Find a real ImportTx on C-Chain explorer (snowtrace.io for mainnet, testnet.snowtrace.io for Fuji), get the block, dump ExtData, compare your parsing against the expected fields.

