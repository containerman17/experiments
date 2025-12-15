package io.avalanche.atomic.codec;

import io.avalanche.atomic.constants.AvalancheConstants;
import io.avalanche.atomic.model.EVMOutput;
import io.avalanche.atomic.model.TransferableInput;
import io.avalanche.atomic.model.UnsignedImportTx;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for LinearCodec using test vectors from Go's import_tx_test.go.
 */
class LinearCodecTest {
    
    private final LinearCodec codec = new LinearCodec();
    
    /**
     * Test vector from "simple import" in TestImportTxGasCost.
     * Expected: 230 bytes for unsigned tx (before credentials).
     * Gas calculation: txBytes=230, numSigs=1, total gas = 230 + 1000 = 1230 (pre-AP5)
     */
    @Test
    void testSimpleImportSerialization() {
        // Network setup
        int networkId = 5; // Fuji
        byte[] cChainId = new byte[32]; // Simplified for test
        byte[] pChainId = new byte[32]; // All zeros
        byte[] avaxAssetId = new byte[32]; // Simplified
        byte[] testAddress = new byte[20]; // Simplified
        
        // Create test UTXO input
        byte[] txId = new byte[32];
        int[] sigIndices = {0};
        TransferableInput input = new TransferableInput(
            txId, 0, avaxAssetId, 5_000_000L, sigIndices
        );
        
        // Create output
        EVMOutput output = new EVMOutput(testAddress, 5_000_000L, avaxAssetId);
        
        // Build transaction
        UnsignedImportTx tx = new UnsignedImportTx(
            networkId, cChainId, pChainId, List.of(input), List.of(output)
        );
        
        // Serialize
        byte[] serialized = codec.serializeUnsignedImportTx(tx);
        
        // Verify structure
        assertNotNull(serialized);
        
        ByteBuffer buf = ByteBuffer.wrap(serialized);
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Verify codec version
        assertEquals(AvalancheConstants.CODEC_VERSION, buf.getShort());
        
        // Verify type ID
        assertEquals(AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX, buf.getInt());
        
        // Verify network ID
        assertEquals(networkId, buf.getInt());
        
        // Expected size breakdown:
        // Version(2) + TypeID(4) + NetworkID(4) + BlockchainID(32) + SourceChain(32) = 74
        // InputsLen(4) + [TxID(32) + OutputIdx(4) + AssetID(32) + TypeID(4) + Amt(8) + SigIndicesLen(4) + SigIdx(4)] = 4 + 88 = 92
        // OutsLen(4) + [Address(20) + Amt(8) + AssetID(32)] = 4 + 60 = 64
        // Total = 74 + 92 + 64 = 230
        assertEquals(230, serialized.length, "Serialized tx should be 230 bytes to match Go test");
    }
    
    /**
     * Test round-trip serialization/deserialization.
     */
    @Test
    void testRoundTrip() {
        // Create test transaction
        int networkId = 1;
        byte[] cChainId = new byte[32];
        byte[] pChainId = new byte[32];
        byte[] avaxAssetId = new byte[32];
        byte[] address = new byte[20];
        
        byte[] txId = new byte[32];
        txId[0] = 1; // Make it non-zero for distinction
        
        TransferableInput input = new TransferableInput(
            txId, 0, avaxAssetId, 1_000_000L, new int[]{0}
        );
        
        EVMOutput output = new EVMOutput(address, 500_000L, avaxAssetId);
        
        UnsignedImportTx original = new UnsignedImportTx(
            networkId, cChainId, pChainId, List.of(input), List.of(output)
        );
        
        // Serialize
        byte[] serialized = codec.serializeUnsignedImportTx(original);
        
        // Deserialize
        UnsignedImportTx deserialized = codec.deserializeUnsignedImportTx(serialized);
        
        // Verify
        assertEquals(original.getNetworkId(), deserialized.getNetworkId());
        assertArrayEquals(original.getBlockchainId(), deserialized.getBlockchainId());
        assertArrayEquals(original.getSourceChain(), deserialized.getSourceChain());
        assertEquals(original.getImportedInputs().size(), deserialized.getImportedInputs().size());
        assertEquals(original.getOuts().size(), deserialized.getOuts().size());
        
        // Verify input details
        TransferableInput origInput = original.getImportedInputs().get(0);
        TransferableInput deserInput = deserialized.getImportedInputs().get(0);
        assertArrayEquals(origInput.getTxId(), deserInput.getTxId());
        assertEquals(origInput.getOutputIndex(), deserInput.getOutputIndex());
        assertEquals(origInput.getAmount(), deserInput.getAmount());
        
        // Verify output details
        EVMOutput origOutput = original.getOuts().get(0);
        EVMOutput deserOutput = deserialized.getOuts().get(0);
        assertArrayEquals(origOutput.getAddress(), deserOutput.getAddress());
        assertEquals(origOutput.getAmount(), deserOutput.getAmount());
    }
    
    /**
     * Test that codec version is included in serialization.
     */
    @Test
    void testCodecVersionIncluded() {
        UnsignedImportTx tx = new UnsignedImportTx(
            5,
            new byte[32],
            new byte[32],
            List.of(new TransferableInput(new byte[32], 0, new byte[32], 1000L, new int[]{0})),
            List.of(new EVMOutput(new byte[20], 500L, new byte[32]))
        );
        
        byte[] serialized = codec.serializeUnsignedImportTx(tx);
        
        // First 2 bytes should be codec version (0x0000)
        ByteBuffer buf = ByteBuffer.wrap(serialized);
        buf.order(ByteOrder.BIG_ENDIAN);
        short version = buf.getShort();
        
        assertEquals(0, version, "Codec version should be 0");
    }
}

