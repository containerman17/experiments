# Avalanche Atomic SDK for Java

Minimal Java SDK for P-Chain → C-Chain atomic imports on Avalanche. This is a focused port of specific functionality from [avalanchego](https://github.com/ava-labs/avalanchego) — not a full SDK, just what's needed to programmatically import AVAX to C-Chain.

**Why this exists**: When users export AVAX to your custodial C-Chain address, you need to import it or the funds stay stuck in shared memory. The official Go and Typescript SDKs handles this, no implementation in Java yet.

**Design philosophy**: Minimal port from Go source to reduce implementation errors. No abstractions beyond what avalanchego uses. Every struct, codec, and signing detail matches the Go implementation as close as possible.


## Import CLI

### 1. Build Go utilities

```bash
./go_test_setup/build.sh
```

### 2. Generate wallets

```bash
./go_test_setup/bin/go_generate_keys
```

Output:
```
=== Avalanche Test Wallet Generator ===
Network: fuji (ID: 5, HRP: fuji)

Generating User wallet...
Generating Custodian wallet...
...
✓ Wallets saved to: .env
```

### 3. Fund User's C-Chain address

Copy `USER_C_EVM` from `.env` and request AVAX from https://faucet.avax.network/

### 4. Create UTXO for custodian

```bash
./go_test_setup/bin/go_test_setup
```

Output:
```
Avalanche Test Setup: Prepare UTXOs for Java Import

Node: https://api.avax-test.network
Amount: 738302 nAVAX (0.000738 AVAX)
Custodian C-Chain: C-fuji1...

Creating wallet...
User P-Chain address: KDn87iUQqTN8SUA4x82AtQ2QqN8EGkncb

Step 1: C→P Export
  TxID: Ato4CKtNuJv1J4YkdBUN6YAfjiNc51ewKGeEwDKn1yfVSTw9a
  Waiting for acceptance...
Step 2: P Import
  TxID: 2TsLB4oWGb7MFTZbu8p156BW7APCYd78PqnVQvauAfjNLKnhBD
  Waiting for acceptance...
  Refreshing wallet...
Step 3: P→C Export to Custodian
  Available P-Chain balance: 801836 nAVAX, exporting: 701836 nAVAX
  TxID: 2hEFkyW3AKEs4oDBUsXWeHYpDFn2pCv4ZbnaUdkoftxxH3cb63

════════════════════════════════════════════════════════════
Done! UTXO created for custodian.
Amount: 701836 nAVAX (0.000702 AVAX)
Custodian address: C-fuji1...

Java SDK can now import this UTXO.
════════════════════════════════════════════════════════════
```

### 5. Run Java Import CLI

```bash
mvn exec:java -Dexec.mainClass="network.avax.build.atomic.cli.ImportCli" -q
```

Output:
```
═══════════════════════════════════════════════════════════
Avalanche Import CLI - P-Chain → C-Chain
═══════════════════════════════════════════════════════════

Custodian Address: C-fuji13sms9vgl8zx6j7jwecpfv0nqzp8f6y3z74rc8m
EVM Address:       0x30ad244514480955e5470ECB901274c08D3aa495

Balance Before: 0.002012854 AVAX (2012854000000000 wei)

Querying pending UTXOs from P-Chain...
Found 1 UTXO(s), total: 0.000081300 AVAX (81300 nAVAX)
  [1] 81300 nAVAX

Base Fee: 2 wei

Building ImportTx...
Signing transaction...
Submitting transaction...
TxID: yng6Wi4MYxLCibGhhjggaZCgBihmaAatjJEzfFizZ8t7seeAW
Waiting for acceptance (checking balance).
Balance changed - transaction accepted!

Scanning last 50 blocks for import...
Import found in block: 49081588

Balance After:  0.002094153 AVAX (2094153000000000 wei)
Delta:          0.000081299 AVAX

═══════════════════════════════════════════════════════════
Import complete!
═══════════════════════════════════════════════════════════
```


## Block ExtData Decoding

Parse atomic transactions (ImportTx/ExportTx) embedded in C-Chain block bodies.

```bash
mvn exec:java -Dexec.mainClass="network.avax.build.atomic.util.BlockExtDataDecoder" \
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


## Requirements

- Java 21+
- Maven 3.8+
- Go 1.21+ (for test setup utilities)

## Build

```bash
mvn clean package -DskipTests
```

## Test

```bash
mvn test
```
