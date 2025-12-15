# Spec 02: Smoke Test - Decode BlockExtraData

## Purpose

Validate that the Java `ExtDataDecoder` produces identical results to the Go reference implementation (avalanchego) when parsing `BlockExtraData` from real C-Chain blocks.

## Test Approach

**Golden file / fixture-based testing**: Compare Java decoder output against pre-computed expected values generated from Go.

## Fixture File

**Location**: `src/test/resources/block_extra_data_fixtures.json`

**Format**:
```json
[
  {
    "blockNumber": "54362465",
    "hexData": "0x00000000000100000001...",
    "expected": {
      "dataLength": 311,
      "txCount": 1,
      "transactions": [
        {
          "index": 0,
          "id": "0x9aad10df594b4947c7e08056e219f93eaf54a6b7eed13d2f26362ba17244d940",
          "type": "ExportTx",
          "networkId": 1,
          "blockchainId": "0x0427d4b22a2a78bcddd456742caf91b56badbff985ee19aef14573e7343fd652",
          "destinationChain": "0x0000000000000000000000000000000000000000000000000000000000000000",
          "inputs": [
            {
              "index": 0,
              "address": "0x565f0fe9715e3cb0df579f186c299d6707887e83",
              "amount": 119183576965,
              "assetId": "0x21e67317cbc4be2aeb00677ad6462778a8f52274b9d605df2591b23027a87dff",
              "nonce": 106950
            }
          ],
          "outputs": [
            {
              "index": 0,
              "assetId": "0x21e67317cbc4be2aeb00677ad6462778a8f52274b9d605df2591b23027a87dff"
            }
          ],
          "credentialCount": 1
        }
      ]
    }
  }
]
```

## Test Class

**Location**: `src/test/java/io/avalanche/atomic/parser/BlockExtraDataFixtureTest.java`

**What it validates**:
- Data length matches expected
- Transaction count matches expected
- For each transaction:
  - Transaction ID (SHA256 hash of serialized unsigned tx)
  - Transaction type (ImportTx vs ExportTx)
  - NetworkID
  - BlockchainID
  - SourceChain (ImportTx) or DestinationChain (ExportTx)
  - Input count, addresses, amounts, assetIDs, nonces
  - Output count, addresses, amounts, assetIDs
  - Credential count

## Running the Test

```bash
# Run only fixture tests
mvn test -Dtest=BlockExtraDataFixtureTest

# Run with verbose output
mvn test -Dtest=BlockExtraDataFixtureTest -DtrimStackTrace=false
```

## Current Status

| Metric | Value |
|--------|-------|
| Total fixtures | 47 |
| Passing | 47 |
| Coverage | ImportTx + ExportTx, single and multi-tx blocks |

## Adding New Fixtures

1. Get the raw `BlockExtraData` hex from a C-Chain block
2. Decode it using the Go reference implementation
3. Add a new entry to `block_extra_data_fixtures.json` with the expected values
4. Run the test to validate

**Go command to decode** (if you have avalanchego):
```go
// Use the ExtDataDecoder from coreth/plugin/evm/customtypes
extData := customtypes.DecodeExtData(hexBytes)
```

## Bank Employee Usage

```bash
# Quick validation after deployment
cd experiments/java_p_to_c_import
mvn test -Dtest=BlockExtraDataFixtureTest -q

# Expected output:
# === Results ===
# Passed: 47/47
```

## Fixture Source

Fixtures generated from mainnet C-Chain blocks using Go tooling. Block numbers span:
- **54362465** - **54465634** (mainnet)
- Covers both `ImportTx` and `ExportTx` types
- Includes single-tx and multi-tx blocks
- Tests various input/output configurations

## Dependencies

- Jackson (`com.fasterxml.jackson.core:jackson-databind`) - JSON parsing
- JUnit 5 - Test framework

