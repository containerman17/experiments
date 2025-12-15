package io.avalanche.atomic.constants;

/**
 * Constants for Avalanche atomic transactions.
 * Values verified against avalanchego source code.
 */
public final class AvalancheConstants {
    
    private AvalancheConstants() {
        // Utility class
    }
    
    // Network IDs
    public static final int MAINNET_ID = 1;
    public static final int FUJI_ID = 5;
    
    // Codec version
    public static final short CODEC_VERSION = 0;
    
    // Type IDs for C-Chain atomic codec
    public static final int TYPE_UNSIGNED_IMPORT_TX = 0;
    public static final int TYPE_UNSIGNED_EXPORT_TX = 1;
    public static final int TYPE_SECP256K1_TRANSFER_INPUT = 5;
    public static final int TYPE_SECP256K1_TRANSFER_OUTPUT = 7;
    public static final int TYPE_SECP256K1_CREDENTIAL = 9;
    
    // Gas constants (verified from atomic/tx.go)
    public static final long TX_BYTES_GAS = 1;
    public static final long EVM_OUTPUT_GAS = 60;  // (20 + 8 + 32) * 1
    public static final long EVM_INPUT_GAS = 1060; // EVMOutputGas + CostPerSignature
    public static final long ATOMIC_TX_INTRINSIC_GAS = 10_000;  // post-AP5
    public static final long SECP256K1_FX_COST_PER_SIG = 1000;
    
    // P-Chain ID is all zeros (constants.PlatformChainID = ids.Empty)
    public static final byte[] P_CHAIN_ID = new byte[32];
    
    // Signature length
    public static final int SIGNATURE_LENGTH = 65;  // [r(32) || s(32) || v(1)]
    
    // ID lengths
    public static final int ID_LENGTH = 32;
    public static final int SHORT_ID_LENGTH = 20;
    
    // X2C conversion rate (1 nAVAX = 1 gWei)
    public static final long X2C_RATE = 1_000_000_000L;
}

