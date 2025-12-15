package io.avalanche.atomic.signer;

import org.junit.jupiter.api.Test;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Keys;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for TxSigner.
 */
class TxSignerTest {
    
    private final TxSigner signer = new TxSigner();
    
    /**
     * Test that signature has correct format: 65 bytes with v in [0,3].
     */
    @Test
    void testSignatureFormat() throws Exception {
        // Generate random key pair
        ECKeyPair keyPair = Keys.createEcKeyPair();
        
        // Sign a test hash
        byte[] hash = new byte[32];
        for (int i = 0; i < 32; i++) {
            hash[i] = (byte) i;
        }
        
        byte[] signature = signer.signForAvalanche(hash, keyPair);
        
        // Verify length
        assertEquals(65, signature.length, "Signature must be 65 bytes");
        
        // Verify v is in [0,3] (NOT 27/28)
        byte v = signature[64];
        assertTrue(v >= 0 && v <= 3, "v must be in [0,3], got: " + v);
    }
    
    /**
     * Test that signature format validator works.
     */
    @Test
    void testSignatureFormatValidator() throws Exception {
        ECKeyPair keyPair = Keys.createEcKeyPair();
        byte[] hash = new byte[32];
        
        byte[] validSig = signer.signForAvalanche(hash, keyPair);
        assertTrue(signer.verifySignatureFormat(validSig));
        
        // Test invalid length
        byte[] invalidLength = new byte[64];
        assertFalse(signer.verifySignatureFormat(invalidLength));
        
        // Test invalid v value
        byte[] invalidV = validSig.clone();
        invalidV[64] = 27; // Web3j format, not Avalanche
        assertFalse(signer.verifySignatureFormat(invalidV));
    }
    
    /**
     * Test that v is correctly converted from 27/28 to 0/1.
     */
    @Test
    void testVConversion() throws Exception {
        ECKeyPair keyPair = Keys.createEcKeyPair();
        
        // Sign multiple times to get both v=0 and v=1
        for (int i = 0; i < 10; i++) {
            byte[] hash = new byte[32];
            hash[0] = (byte) i; // Vary the hash
            
            byte[] signature = signer.signForAvalanche(hash, keyPair);
            byte v = signature[64];
            
            // v should never be >= 27
            assertTrue(v < 27, "v should be < 27, got: " + v);
            // v should be 0, 1, 2, or 3
            assertTrue(v >= 0 && v <= 3, "v should be in [0,3], got: " + v);
        }
    }
}

