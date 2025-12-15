package io.avalanche.atomic.util;

import org.junit.jupiter.api.Test;
import org.web3j.utils.Numeric;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for KeyGenerator utility.
 */
class KeyGeneratorTest {
    
    @Test
    void testGenerateFujiWallet() {
        WalletInfo wallet = KeyGenerator.generate("fuji");
        
        // Verify all fields are populated
        assertNotNull(wallet.getPrivateKeyHex());
        assertNotNull(wallet.getPChainAddress());
        assertNotNull(wallet.getCChainBech32());
        assertNotNull(wallet.getCChainEvm());
        assertNotNull(wallet.getShortId());
        assertEquals("fuji", wallet.getNetwork());
        
        // Verify formats
        assertTrue(wallet.getPrivateKeyHex().startsWith("0x"), "Private key should start with 0x");
        assertEquals(66, wallet.getPrivateKeyHex().length(), "Private key should be 64 hex chars + 0x");
        
        assertTrue(wallet.getPChainAddress().startsWith("P-fuji1"), "P-Chain address should start with P-fuji1");
        assertTrue(wallet.getCChainBech32().startsWith("C-fuji1"), "C-Chain Bech32 should start with C-fuji1");
        assertTrue(wallet.getCChainEvm().startsWith("0x"), "EVM address should start with 0x");
        assertEquals(42, wallet.getCChainEvm().length(), "EVM address should be 40 hex chars + 0x");
        
        assertEquals(20, wallet.getShortId().length, "Short ID should be 20 bytes");
        assertEquals(20, wallet.getEvmAddressBytes().length, "EVM address bytes should be 20 bytes");
    }
    
    @Test
    void testGenerateMainnetWallet() {
        WalletInfo wallet = KeyGenerator.generate("mainnet");
        
        assertTrue(wallet.getPChainAddress().startsWith("P-avax1"), "P-Chain address should start with P-avax1");
        assertTrue(wallet.getCChainBech32().startsWith("C-avax1"), "C-Chain Bech32 should start with C-avax1");
        assertEquals("mainnet", wallet.getNetwork());
    }
    
    @Test
    void testFromPrivateKey() {
        // Use a known private key
        String privateKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        
        WalletInfo wallet = KeyGenerator.fromPrivateKey(privateKey, "fuji");
        
        assertEquals(privateKey, wallet.getPrivateKeyHex());
        
        // Verify determinism - same key should give same addresses
        WalletInfo wallet2 = KeyGenerator.fromPrivateKey(privateKey, "fuji");
        
        assertEquals(wallet.getPChainAddress(), wallet2.getPChainAddress());
        assertEquals(wallet.getCChainBech32(), wallet2.getCChainBech32());
        assertEquals(wallet.getCChainEvm(), wallet2.getCChainEvm());
    }
    
    @Test
    void testBech32RoundTrip() {
        WalletInfo wallet = KeyGenerator.generate("fuji");
        
        // Decode the Bech32 address back to bytes
        byte[] decoded = KeyGenerator.decodeBech32Address(wallet.getCChainBech32());
        
        // Should match the short ID
        assertArrayEquals(wallet.getShortId(), decoded, "Bech32 round-trip should preserve short ID");
    }
    
    @Test
    void testPChainAndCChainShareShortId() {
        WalletInfo wallet = KeyGenerator.generate("fuji");
        
        // P-Chain and C-Chain Bech32 addresses should decode to same short ID
        byte[] pDecoded = KeyGenerator.decodeBech32Address(wallet.getPChainAddress());
        byte[] cDecoded = KeyGenerator.decodeBech32Address(wallet.getCChainBech32());
        
        assertArrayEquals(pDecoded, cDecoded, "P-Chain and C-Chain should share same short ID");
    }
    
    @Test
    void testEvmAddressIsDifferentFromBech32() {
        WalletInfo wallet = KeyGenerator.generate("fuji");
        
        // EVM address is derived differently (keccak256 vs SHA256+RIPEMD160)
        // So the bytes should NOT match
        byte[] shortId = wallet.getShortId();
        byte[] evmBytes = wallet.getEvmAddressBytes();
        
        // Both are 20 bytes but should have different values
        assertEquals(20, shortId.length);
        assertEquals(20, evmBytes.length);
        
        // They should not be equal (different derivation paths)
        assertFalse(java.util.Arrays.equals(shortId, evmBytes), 
            "EVM address bytes should differ from Bech32 short ID (different derivation)");
    }
    
    @Test
    void testWalletInfoToString() {
        WalletInfo wallet = KeyGenerator.generate("fuji");
        String output = wallet.toString();
        
        assertTrue(output.contains("Avalanche Test Wallet"), "Should contain header");
        assertTrue(output.contains("fuji"), "Should contain network");
        assertTrue(output.contains("Private Key:"), "Should contain private key label");
        assertTrue(output.contains("P-Chain Address:"), "Should contain P-Chain label");
        assertTrue(output.contains("C-Chain Address (Bech32):"), "Should contain C-Chain Bech32 label");
        assertTrue(output.contains("C-Chain Address (EVM):"), "Should contain EVM label");
    }
    
    @Test
    void testInvalidNetworkThrows() {
        // The exception is wrapped in RuntimeException, but caused by IllegalArgumentException
        RuntimeException ex = assertThrows(RuntimeException.class, () -> {
            KeyGenerator.generate("invalidnetwork");
        }, "Should throw for invalid network");
        
        assertTrue(ex.getCause() instanceof IllegalArgumentException,
            "Cause should be IllegalArgumentException");
        assertTrue(ex.getCause().getMessage().contains("Unknown network"),
            "Should mention unknown network");
    }
    
    @Test
    void testPrivateKeyWithoutPrefix() {
        // Private key without 0x prefix should also work
        String privateKeyNoPrefix = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        
        WalletInfo wallet = KeyGenerator.fromPrivateKey(privateKeyNoPrefix, "fuji");
        
        assertNotNull(wallet);
        // The stored key should have 0x prefix
        assertTrue(wallet.getPrivateKeyHex().startsWith("0x"));
    }
}

