package network.avax.build.atomic.rpc;

import network.avax.build.atomic.constants.AvalancheConstants;
import network.avax.build.atomic.model.UTXO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.web3j.utils.Numeric;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for UtxoParser.
 */
class UtxoParserTest {
    
    private UtxoParser parser;
    
    @BeforeEach
    void setUp() {
        parser = new UtxoParser();
    }
    
    @Test
    void testParseValidUtxo() {
        // Build a valid UTXO in the expected binary format
        byte[] utxoBytes = buildTestUtxo(
            new byte[32],  // txId (zeros)
            0,             // outputIndex
            new byte[32],  // assetId (zeros)
            1_000_000_000L, // 1 AVAX in nAVAX
            new byte[20]   // address (zeros)
        );
        
        UTXO utxo = parser.parseUtxo(utxoBytes);
        
        assertNotNull(utxo);
        assertEquals(0, utxo.getOutputIndex());
        assertEquals(1_000_000_000L, utxo.getAmount());
    }
    
    @Test
    void testParseUtxoWithSpecificValues() {
        // Create specific test values
        byte[] txId = new byte[32];
        txId[0] = 0x11;
        txId[31] = 0x22;
        
        byte[] assetId = new byte[32];
        assetId[0] = (byte) 0xAA;
        assetId[31] = (byte) 0xBB;
        
        byte[] address = new byte[20];
        address[0] = (byte) 0xCC;
        address[19] = (byte) 0xDD;
        
        byte[] utxoBytes = buildTestUtxo(txId, 42, assetId, 5_000_000_000L, address);
        
        UTXO utxo = parser.parseUtxo(utxoBytes);
        
        assertNotNull(utxo);
        assertEquals(42, utxo.getOutputIndex());
        assertEquals(5_000_000_000L, utxo.getAmount());
        assertEquals(0x11, utxo.getTxId()[0]);
        assertEquals(0x22, utxo.getTxId()[31]);
        assertEquals((byte) 0xAA, utxo.getAssetId()[0]);
        assertEquals((byte) 0xBB, utxo.getAssetId()[31]);
        assertEquals((byte) 0xCC, utxo.getAddress()[0]);
        assertEquals((byte) 0xDD, utxo.getAddress()[19]);
    }
    
    @Test
    void testParseUtxoFromHexString() {
        byte[] utxoBytes = buildTestUtxo(
            new byte[32], 1, new byte[32], 2_000_000_000L, new byte[20]
        );
        String hexUtxo = Numeric.toHexString(utxoBytes);
        
        UTXO utxo = parser.parseUtxo(hexUtxo);
        
        assertNotNull(utxo);
        assertEquals(1, utxo.getOutputIndex());
        assertEquals(2_000_000_000L, utxo.getAmount());
    }
    
    @Test
    void testParseUtxoFromHexWithoutPrefix() {
        byte[] utxoBytes = buildTestUtxo(
            new byte[32], 2, new byte[32], 3_000_000_000L, new byte[20]
        );
        String hexUtxo = Numeric.toHexStringNoPrefix(utxoBytes);
        
        UTXO utxo = parser.parseUtxo(hexUtxo);
        
        assertNotNull(utxo);
        assertEquals(2, utxo.getOutputIndex());
        assertEquals(3_000_000_000L, utxo.getAmount());
    }
    
    @Test
    void testParseMultipleUtxos() {
        byte[] utxo1 = buildTestUtxo(new byte[32], 0, new byte[32], 1_000_000_000L, new byte[20]);
        byte[] utxo2 = buildTestUtxo(new byte[32], 1, new byte[32], 2_000_000_000L, new byte[20]);
        
        List<String> hexUtxos = Arrays.asList(
            Numeric.toHexString(utxo1),
            Numeric.toHexString(utxo2)
        );
        
        List<UTXO> utxos = parser.parseUtxos(hexUtxos);
        
        assertEquals(2, utxos.size());
        assertEquals(1_000_000_000L, utxos.get(0).getAmount());
        assertEquals(2_000_000_000L, utxos.get(1).getAmount());
    }
    
    @Test
    void testRejectInvalidCodecVersion() {
        byte[] utxoBytes = buildTestUtxo(new byte[32], 0, new byte[32], 1_000_000_000L, new byte[20]);
        // Corrupt codec version
        utxoBytes[0] = 0x00;
        utxoBytes[1] = 0x01;  // Version 1 instead of 0
        
        assertThrows(IllegalArgumentException.class, () -> parser.parseUtxo(utxoBytes));
    }
    
    @Test
    void testRejectInvalidOutputType() {
        byte[] utxoBytes = buildTestUtxo(new byte[32], 0, new byte[32], 1_000_000_000L, new byte[20]);
        // Corrupt type ID (offset: 2 + 32 + 4 + 32 = 70)
        utxoBytes[70] = 0x00;
        utxoBytes[71] = 0x00;
        utxoBytes[72] = 0x00;
        utxoBytes[73] = 0x05;  // Type 5 (input) instead of 7 (output)
        
        assertThrows(IllegalArgumentException.class, () -> parser.parseUtxo(utxoBytes));
    }
    
    @Test
    void testRejectTooShortBytes() {
        byte[] shortBytes = new byte[50];  // Way too short
        
        assertThrows(IllegalArgumentException.class, () -> parser.parseUtxo(shortBytes));
    }
    
    @Test
    void testUtxoFormat() {
        // Verify the exact byte layout
        byte[] utxoBytes = buildTestUtxo(new byte[32], 0, new byte[32], 1_000_000_000L, new byte[20]);
        
        // Expected minimum size: 2 + 32 + 4 + 32 + 4 + 8 + 8 + 4 + 4 + 20 = 118 bytes
        assertEquals(118, utxoBytes.length);
        
        ByteBuffer buf = ByteBuffer.wrap(utxoBytes);
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Verify codec version
        assertEquals(0, buf.getShort());
        
        // Skip txId
        buf.position(buf.position() + 32);
        
        // Verify output index
        assertEquals(0, buf.getInt());
        
        // Skip assetId
        buf.position(buf.position() + 32);
        
        // Verify type ID
        assertEquals(AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT, buf.getInt());
        
        // Verify amount
        assertEquals(1_000_000_000L, buf.getLong());
    }
    
    /**
     * Build a test UTXO in the expected binary format.
     */
    private byte[] buildTestUtxo(byte[] txId, int outputIndex, byte[] assetId, long amount, byte[] address) {
        ByteBuffer buf = ByteBuffer.allocate(118);  // Minimum size for single address
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // CodecVersion (2 bytes)
        buf.putShort(AvalancheConstants.CODEC_VERSION);
        
        // TxID (32 bytes)
        buf.put(txId);
        
        // OutputIndex (4 bytes)
        buf.putInt(outputIndex);
        
        // AssetID (32 bytes)
        buf.put(assetId);
        
        // TypeID (4 bytes) - SECP256K1TransferOutput
        buf.putInt(AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT);
        
        // Amount (8 bytes)
        buf.putLong(amount);
        
        // Locktime (8 bytes)
        buf.putLong(0L);
        
        // Threshold (4 bytes)
        buf.putInt(1);
        
        // AddressesLen (4 bytes)
        buf.putInt(1);
        
        // Address (20 bytes)
        buf.put(address);
        
        return buf.array();
    }
}

