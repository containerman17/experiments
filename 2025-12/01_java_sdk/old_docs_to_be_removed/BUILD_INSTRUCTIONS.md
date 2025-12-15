# Build Instructions

## Prerequisites

```bash
# Install Java 21
sudo apt update
sudo apt install openjdk-21-jdk

# Install Maven
sudo apt install maven

# Verify installation
java -version  # Should show 21.x
mvn -version   # Should show Maven 3.x
```

## Build

```bash
cd experiments/java_p_to_c_import
mvn clean install
```

## Run Tests

```bash
mvn test
```

## Use as Dependency

Add to your `pom.xml`:

```xml
<dependency>
    <groupId>io.avalanche</groupId>
    <artifactId>avalanche-atomic-sdk</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

## Package Structure

```
io.avalanche.atomic
├── AvalancheAtomicSDK          # Main facade
├── codec
│   └── LinearCodec              # Avalanche serialization
├── model
│   ├── UnsignedImportTx
│   ├── TransferableInput
│   ├── EVMOutput
│   ├── Credential
│   └── UTXO
├── parser
│   ├── BlockParser              # RLP extraction
│   └── ExtDataDecoder           # Atomic tx parsing
├── builder
│   └── ImportTxBuilder          # Tx construction
├── signer
│   └── TxSigner                 # secp256k1 signing
└── constants
    └── AvalancheConstants       # Verified constants
```

## Development

The SDK is designed to work with existing web3j infrastructure. All crypto operations use web3j's battle-tested secp256k1 implementation.

**Critical**: The TxSigner includes the v-27 fix required for Avalanche compatibility.

