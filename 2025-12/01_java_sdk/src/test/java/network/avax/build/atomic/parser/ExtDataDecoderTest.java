package network.avax.build.atomic.parser;

import network.avax.build.atomic.constants.AvalancheConstants;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for ExtDataDecoder.
 */
class ExtDataDecoderTest {
    
    private final ExtDataDecoder decoder = new ExtDataDecoder();
    
    /**
     * Test parsing empty ExtData.
     */
    @Test
    void testEmptyExtData() {
        var result = decoder.parseAtomicTransactions(null);
        assertTrue(result.isEmpty());
        
        result = decoder.parseAtomicTransactions(new byte[0]);
        assertTrue(result.isEmpty());
    }
    
    /**
     * Test parsing ExtData with wrong version.
     */
    @Test
    void testWrongVersion() {
        ByteBuffer buf = ByteBuffer.allocate(10);
        buf.order(ByteOrder.BIG_ENDIAN);
        buf.putShort((short) 99); // Wrong version
        buf.putInt(0); // Count
        
        var result = decoder.parseAtomicTransactions(buf.array());
        assertTrue(result.isEmpty(), "Should return empty for unsupported version");
    }
    
    /**
     * Test parsing ExtData with zero transactions.
     */
    @Test
    void testZeroTransactions() {
        ByteBuffer buf = ByteBuffer.allocate(6);
        buf.order(ByteOrder.BIG_ENDIAN);
        buf.putShort(AvalancheConstants.CODEC_VERSION);
        buf.putInt(0); // Zero transactions
        
        var result = decoder.parseAtomicTransactions(buf.array());
        assertTrue(result.isEmpty());
    }
}

