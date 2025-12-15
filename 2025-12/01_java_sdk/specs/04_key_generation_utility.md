# Spec 04: Key Generation Utility

## Purpose

Generate a test wallet with:
- Private key (secp256k1)
- P-Chain address (Bech32)
- C-Chain address (Bech32 and EVM hex)

This utility is needed to create test wallets for E2E testing without relying on external wallet software.

---

## Background: Avalanche Address Derivation

### The Cryptographic Foundation

Avalanche uses **secp256k1** (same curve as Bitcoin/Ethereum).

```
Private Key (32 bytes)
    │
    ▼ secp256k1 multiplication
Public Key (33 bytes compressed, or 65 bytes uncompressed)
    │
    ▼ SHA256
Hash1 (32 bytes)
    │
    ▼ RIPEMD160
Short ID (20 bytes)  ←── This is the "address" in raw form
    │
    ▼ Bech32 encode
Bech32 Address (human-readable)
```

### Address Format

| Chain | Format | Example |
|-------|--------|---------|
| P-Chain | `P-{hrp}1{bech32data}` | `P-fuji1abc123...` |
| C-Chain (Bech32) | `C-{hrp}1{bech32data}` | `C-fuji1abc123...` |
| C-Chain (EVM) | `0x{40-hex}` | `0x1234...abcd` |

### HRP (Human Readable Part)

| Network | HRP |
|---------|-----|
| Mainnet | `avax` |
| Fuji | `fuji` |
| Local | `local` |

### Critical Insight: Same Key, Multiple Addresses

The **same private key** derives:
- P-Chain address: `RIPEMD160(SHA256(compressed_pubkey))` → Bech32
- C-Chain Bech32: Same as P-Chain, different prefix
- C-Chain EVM: `keccak256(uncompressed_pubkey)[12:32]` → Hex

**For atomic transactions**, the P-Chain and C-Chain Bech32 addresses are derived identically (same 20-byte short ID), just with different chain prefixes.

---

## Derivation Steps

### Step 1: Generate Private Key

```
Random 32 bytes (cryptographically secure)
```

**Constraints**:
- Must be in range [1, secp256k1.N - 1]
- N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

### Step 2: Derive Public Key

```
Public Key = privateKey × G (elliptic curve multiplication)
```

Where G is the secp256k1 generator point.

**Output formats**:
- Compressed (33 bytes): `[02|03] + x-coordinate`
- Uncompressed (65 bytes): `04 + x-coordinate + y-coordinate`

### Step 3: Derive Short ID (20 bytes)

```
shortId = RIPEMD160(SHA256(compressedPublicKey))
```

This is the canonical Avalanche "address" in raw form.

### Step 4: Encode Bech32 Address

```
P-Chain: "P-" + bech32.encode(hrp, shortId)
C-Chain: "C-" + bech32.encode(hrp, shortId)
```

**Bech32 encoding**:
1. Convert 20 bytes to 5-bit groups
2. Add checksum
3. Encode as alphanumeric string

### Step 5: Derive EVM Address (C-Chain Hex)

```
evmAddress = keccak256(uncompressedPublicKey[1:65])[12:32]
```

Note: Uncompressed key without the 0x04 prefix (just the 64 bytes of x,y coordinates).

This is the standard Ethereum address derivation.

---

## Utility Interface

### Command Line

```bash
# Generate new wallet
java -cp ... io.avalanche.atomic.util.KeyGenerator --network fuji

# Output:
# ========================================
# Avalanche Test Wallet
# Network: fuji
# ========================================
# Private Key: 0x<64-hex-chars>
# 
# P-Chain Address: P-fuji1<bech32>
# C-Chain Address (Bech32): C-fuji1<bech32>
# C-Chain Address (EVM): 0x<40-hex-chars>
# ========================================
# 
# KEEP THE PRIVATE KEY SECRET!
# Fund the P-Chain address with testnet AVAX.
# After export, use C-Chain Bech32 address for getUTXOs.
# ImportTx will credit the EVM address.
```

### Programmatic API

```java
public class KeyGenerator {
    
    /**
     * Generate a new random wallet.
     * 
     * @param network "mainnet" or "fuji"
     * @return WalletInfo with all derived addresses
     */
    public static WalletInfo generate(String network);
    
    /**
     * Derive addresses from existing private key.
     * 
     * @param privateKeyHex 64-character hex string (with or without 0x)
     * @param network "mainnet" or "fuji"
     * @return WalletInfo with all derived addresses
     */
    public static WalletInfo fromPrivateKey(String privateKeyHex, String network);
}

public class WalletInfo {
    String privateKeyHex;       // 0x<64-hex>
    String pChainAddress;       // P-fuji1...
    String cChainBech32;        // C-fuji1...
    String cChainEvm;           // 0x<40-hex>
    byte[] shortId;             // 20 bytes (raw address)
}
```

---

## Implementation Notes

### Dependencies

Already in `pom.xml`:
- **Web3j**: `ECKeyPair`, `Keys`, `Hash.sha3()` (keccak256)
- **Bitcoinj**: `Bech32` encoding

### Key Generation

```java
// Using Web3j
ECKeyPair keyPair = Keys.createEcKeyPair();
BigInteger privateKey = keyPair.getPrivateKey();
BigInteger publicKey = keyPair.getPublicKey();
```

### Public Key Compression

Web3j's `ECKeyPair.getPublicKey()` returns uncompressed (64 bytes, no prefix).

To get compressed:
```java
byte[] compressedPubKey = compressPublicKey(publicKey);
// Returns 33 bytes: [02|03] + x-coordinate
```

### SHA256 + RIPEMD160

```java
byte[] sha256 = Hash.sha256(compressedPubKey);
byte[] shortId = ripemd160(sha256);  // Need to implement or use Bitcoinj
```

### Bech32 Encoding

```java
import org.bitcoinj.core.Bech32;

String hrp = "fuji";  // or "avax" for mainnet
byte[] converted = convertBits(shortId, 8, 5, true);  // 8-bit to 5-bit
String bech32 = Bech32.encode(hrp, converted);
// Result: "fuji1<rest>"

String pChainAddr = "P-" + bech32;
String cChainAddr = "C-" + bech32;
```

### EVM Address

```java
// Web3j handles this
String evmAddress = Keys.getAddress(publicKey);
// Returns 40-hex without 0x prefix
```

---

## Validation Tests

### Test 1: Known Vector

Use a known private key and verify all derived addresses match expected values.

**Test vector** (generate one using Go SDK or avalanche-cli):
```
Private Key: 0x...
Expected P-Chain (Fuji): P-fuji1...
Expected C-Chain (Fuji): C-fuji1...
Expected EVM: 0x...
```

### Test 2: Round-Trip

1. Generate wallet
2. Export P-Chain and C-Chain Bech32
3. Verify both have same short ID (20 bytes)
4. Verify EVM address is different derivation

### Test 3: Cross-Platform Verification

1. Generate key in Java
2. Import same private key into Avalanche Wallet
3. Verify all addresses match

---

## File Location

```
src/main/java/io/avalanche/atomic/util/
├── KeyGenerator.java       # Main utility class
└── WalletInfo.java         # Result data class
```

---

## Security Considerations

1. **Never log private keys in production**
2. **Use SecureRandom for key generation**
3. **Clear private key from memory after use** (Java makes this hard)
4. **This utility is for TESTING ONLY** - production should use HSM/KMS

---

## Usage in E2E Test Setup

```bash
# 1. Generate test wallet
java -cp target/classes:... io.avalanche.atomic.util.KeyGenerator --network fuji > wallet.txt

# 2. Extract addresses
P_CHAIN_ADDR=$(grep "P-Chain" wallet.txt | awk '{print $NF}')
C_CHAIN_BECH32=$(grep "Bech32" wallet.txt | awk '{print $NF}')
EVM_ADDR=$(grep "EVM" wallet.txt | awk '{print $NF}')
PRIVATE_KEY=$(grep "Private" wallet.txt | awk '{print $NF}')

# 3. Fund P-Chain address using faucet
# https://faucet.avax.network/ → Enter P_CHAIN_ADDR

# 4. Export from P-Chain to C-Chain (manual step)
# Use wallet.avax.network or Core wallet
# Export TO the C_CHAIN_BECH32 address

# 5. Set env vars for E2E test
export E2E_PRIVATE_KEY="$PRIVATE_KEY"
export E2E_BECH32_ADDRESS="$C_CHAIN_BECH32"
export E2E_EVM_ADDRESS="$EVM_ADDR"

# 6. Run E2E test
mvn test -Dgroups=e2e
```

---

## Notes for Implementing Agent

### Why Both C-Chain Addresses?

- **Bech32 (`C-fuji1...`)**: Used for `avax.getUTXOs` API - identifies UTXOs in shared memory
- **EVM (`0x...`)**: Used as destination in ImportTx - where funds land on EVM side

They derive from the same key but via different paths:
- Bech32: `RIPEMD160(SHA256(compressed_pubkey))`
- EVM: `keccak256(uncompressed_pubkey)[12:32]`

### The Flow Clarified

```
[P-Chain Export]
    │
    │ Destination: C-fuji1abc... (Bech32)
    ▼
[Shared Memory UTXOs]
    │
    │ Query: avax.getUTXOs(addresses: ["C-fuji1abc..."])
    ▼
[Java SDK builds ImportTx]
    │
    │ EVMOutput.address: 0x1234... (EVM hex)
    ▼
[C-Chain EVM Balance]
    │
    │ Check: eth_getBalance(0x1234...)
    ▼
[Funds available as EVM balance]
```

The Bech32 address is for the Avalanche atomic layer.
The EVM address is for the Ethereum-compatible layer.
Same key controls both.

