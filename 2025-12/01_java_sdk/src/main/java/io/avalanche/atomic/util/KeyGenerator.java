package io.avalanche.atomic.util;

import org.bitcoinj.core.Bech32;
import org.bouncycastle.crypto.digests.RIPEMD160Digest;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Hash;
import org.web3j.crypto.Keys;
import org.web3j.utils.Numeric;

import java.math.BigInteger;
import java.security.SecureRandom;

/**
 * KeyGenerator creates and derives Avalanche wallet addresses.
 * 
 * Same private key derives:
 * - P-Chain address: RIPEMD160(SHA256(compressed_pubkey)) → Bech32
 * - C-Chain Bech32: Same as P-Chain, different prefix
 * - C-Chain EVM: keccak256(uncompressed_pubkey)[12:32] → Hex
 */
public class KeyGenerator {
    
    private static final String MAINNET_HRP = "avax";
    private static final String FUJI_HRP = "fuji";
    
    private KeyGenerator() {
        // Utility class
    }
    
    /**
     * Generate a new random wallet.
     * 
     * @param network "mainnet" or "fuji"
     * @return WalletInfo with all derived addresses
     */
    public static WalletInfo generate(String network) {
        try {
            // Generate random private key using secure random
            SecureRandom random = new SecureRandom();
            byte[] privateKeyBytes = new byte[32];
            random.nextBytes(privateKeyBytes);
            
            // Ensure key is in valid range for secp256k1
            BigInteger privateKey = new BigInteger(1, privateKeyBytes);
            ECKeyPair keyPair = ECKeyPair.create(privateKey);
            
            return deriveAddresses(keyPair, network);
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate wallet", e);
        }
    }
    
    /**
     * Derive addresses from existing private key.
     * 
     * @param privateKeyHex 64-character hex string (with or without 0x prefix)
     * @param network "mainnet" or "fuji"
     * @return WalletInfo with all derived addresses
     */
    public static WalletInfo fromPrivateKey(String privateKeyHex, String network) {
        try {
            BigInteger privateKey = Numeric.toBigInt(privateKeyHex);
            ECKeyPair keyPair = ECKeyPair.create(privateKey);
            return deriveAddresses(keyPair, network);
        } catch (Exception e) {
            throw new RuntimeException("Failed to derive addresses from private key", e);
        }
    }
    
    /**
     * Derive all addresses from a key pair.
     */
    private static WalletInfo deriveAddresses(ECKeyPair keyPair, String network) {
        String hrp = getHrp(network);
        
        // Get private key hex
        String privateKeyHex = Numeric.toHexStringWithPrefixZeroPadded(
            keyPair.getPrivateKey(), 64
        );
        
        // Get compressed public key (33 bytes)
        byte[] compressedPubKey = compressPublicKey(keyPair.getPublicKey());
        
        // Derive short ID: RIPEMD160(SHA256(compressed_pubkey))
        byte[] sha256 = Hash.sha256(compressedPubKey);
        byte[] shortId = ripemd160(sha256);
        
        // Encode Bech32 addresses
        String bech32Data = encodeBech32(hrp, shortId);
        String pChainAddress = "P-" + bech32Data;
        String cChainBech32 = "C-" + bech32Data;
        
        // Derive EVM address (standard Ethereum derivation)
        String evmAddressRaw = Keys.getAddress(keyPair.getPublicKey());
        String cChainEvm = "0x" + evmAddressRaw;
        
        return new WalletInfo(
            privateKeyHex,
            pChainAddress,
            cChainBech32,
            cChainEvm,
            shortId,
            network
        );
    }
    
    /**
     * Get HRP (Human Readable Part) for network.
     */
    private static String getHrp(String network) {
        return switch (network.toLowerCase()) {
            case "mainnet", "main" -> MAINNET_HRP;
            case "fuji", "testnet", "test" -> FUJI_HRP;
            default -> throw new IllegalArgumentException("Unknown network: " + network);
        };
    }
    
    /**
     * Compress a public key from 64-byte (uncompressed without prefix) to 33-byte format.
     */
    private static byte[] compressPublicKey(BigInteger publicKey) {
        // Web3j's publicKey is 64 bytes: x-coord || y-coord
        byte[] pubKeyBytes = Numeric.toBytesPadded(publicKey, 64);
        
        // Get x coordinate (first 32 bytes)
        byte[] x = new byte[32];
        System.arraycopy(pubKeyBytes, 0, x, 0, 32);
        
        // Get y coordinate (last 32 bytes)
        byte[] y = new byte[32];
        System.arraycopy(pubKeyBytes, 32, y, 0, 32);
        
        // Compressed format: [02|03] + x
        // 02 if y is even, 03 if y is odd
        byte prefix = (y[31] & 1) == 0 ? (byte) 0x02 : (byte) 0x03;
        
        byte[] compressed = new byte[33];
        compressed[0] = prefix;
        System.arraycopy(x, 0, compressed, 1, 32);
        
        return compressed;
    }
    
    /**
     * RIPEMD160 hash.
     */
    private static byte[] ripemd160(byte[] input) {
        RIPEMD160Digest digest = new RIPEMD160Digest();
        digest.update(input, 0, input.length);
        byte[] output = new byte[20];
        digest.doFinal(output, 0);
        return output;
    }
    
    /**
     * Encode bytes to Bech32 with given HRP.
     * Uses 5-bit encoding as per BIP-173.
     */
    private static String encodeBech32(String hrp, byte[] data) {
        // Convert 8-bit bytes to 5-bit groups
        byte[] converted = convertBits(data, 8, 5, true);
        return Bech32.encode(Bech32.Encoding.BECH32, hrp, converted);
    }
    
    /**
     * Decode Bech32 address to bytes.
     * 
     * @param address Full address like "C-fuji1abc..." or just "fuji1abc..."
     * @return 20-byte short ID
     */
    public static byte[] decodeBech32Address(String address) {
        // Strip chain prefix if present
        String bech32Part = address;
        if (address.contains("-")) {
            bech32Part = address.substring(address.indexOf("-") + 1);
        }
        
        Bech32.Bech32Data decoded = Bech32.decode(bech32Part);
        // Convert 5-bit groups back to 8-bit bytes
        return convertBits(decoded.data, 5, 8, false);
    }
    
    /**
     * Convert between bit sizes (used for Bech32 encoding/decoding).
     */
    private static byte[] convertBits(byte[] data, int fromBits, int toBits, boolean pad) {
        int acc = 0;
        int bits = 0;
        int maxv = (1 << toBits) - 1;
        java.util.List<Byte> result = new java.util.ArrayList<>();
        
        for (byte b : data) {
            int value = b & 0xff;
            acc = (acc << fromBits) | value;
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                result.add((byte) ((acc >> bits) & maxv));
            }
        }
        
        if (pad) {
            if (bits > 0) {
                result.add((byte) ((acc << (toBits - bits)) & maxv));
            }
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) != 0) {
            throw new IllegalArgumentException("Invalid bit conversion");
        }
        
        byte[] output = new byte[result.size()];
        for (int i = 0; i < result.size(); i++) {
            output[i] = result.get(i);
        }
        return output;
    }
    
    /**
     * Command-line entry point for generating test wallets.
     * Writes to .env file with both mainnet and testnet addresses.
     */
    public static void main(String[] args) {
        java.io.File envFile = new java.io.File(".env");
        
        if (envFile.exists()) {
            System.out.println(".env already exists");
            return;
        }
        
        // Generate key and derive both networks
        SecureRandom random = new SecureRandom();
        byte[] privateKeyBytes = new byte[32];
        random.nextBytes(privateKeyBytes);
        BigInteger privateKey = new BigInteger(1, privateKeyBytes);
        ECKeyPair keyPair = ECKeyPair.create(privateKey);
        
        String privateKeyHex = Numeric.toHexStringWithPrefixZeroPadded(keyPair.getPrivateKey(), 64);
        byte[] compressedPubKey = compressPublicKey(keyPair.getPublicKey());
        byte[] sha256 = Hash.sha256(compressedPubKey);
        byte[] shortId = ripemd160(sha256);
        
        // Bech32 addresses (only prefix differs)
        String mainnetBech32 = encodeBech32(MAINNET_HRP, shortId);
        String fujiBech32 = encodeBech32(FUJI_HRP, shortId);
        
        String pChainMainnet = "P-" + mainnetBech32;
        String pChainFuji = "P-" + fujiBech32;
        String cChainBech32 = "C-" + mainnetBech32;  // Same for queries, use mainnet format
        String cChainEvmAddress = "0x" + Keys.getAddress(keyPair.getPublicKey());
        
        // Write .env
        String envContent = String.format(
            "PRIVATE_KEY=%s\n" +
            "P_CHAIN_MAINNET=%s\n" +
            "P_CHAIN_FUJI=%s\n" +
            "C_CHAIN_BECH32=%s\n" +
            "C_CHAIN_EVM=%s\n",
            privateKeyHex, pChainMainnet, pChainFuji, cChainBech32, cChainEvmAddress
        );
        
        try {
            java.nio.file.Files.writeString(envFile.toPath(), envContent);
        } catch (Exception e) {
            System.err.println("Failed to write .env: " + e.getMessage());
            return;
        }
        
        // Console output
        System.out.println("Private Key:      " + privateKeyHex);
        System.out.println("P-Chain Mainnet:  " + pChainMainnet);
        System.out.println("P-Chain Fuji:     " + pChainFuji);
        System.out.println("C-Chain Bech32:   " + cChainBech32);
        System.out.println("C-Chain EVM:      " + cChainEvmAddress);
        System.out.println("Written to .env");
    }
}

