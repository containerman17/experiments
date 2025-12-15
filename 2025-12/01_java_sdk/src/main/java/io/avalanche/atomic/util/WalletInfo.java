package io.avalanche.atomic.util;

import org.web3j.utils.Numeric;

/**
 * WalletInfo contains all derived addresses for an Avalanche wallet.
 * Same private key derives multiple address formats for different chains.
 */
public class WalletInfo {
    private final String privateKeyHex;     // 0x<64-hex>
    private final String pChainAddress;     // P-fuji1... or P-avax1...
    private final String cChainBech32;      // C-fuji1... or C-avax1...
    private final String cChainEvm;         // 0x<40-hex>
    private final byte[] shortId;           // 20 bytes (raw address for Bech32)
    private final String network;           // "fuji" or "mainnet"
    
    public WalletInfo(String privateKeyHex, String pChainAddress, String cChainBech32,
                      String cChainEvm, byte[] shortId, String network) {
        this.privateKeyHex = privateKeyHex;
        this.pChainAddress = pChainAddress;
        this.cChainBech32 = cChainBech32;
        this.cChainEvm = cChainEvm;
        this.shortId = shortId.clone();
        this.network = network;
    }
    
    public String getPrivateKeyHex() {
        return privateKeyHex;
    }
    
    public String getPChainAddress() {
        return pChainAddress;
    }
    
    public String getCChainBech32() {
        return cChainBech32;
    }
    
    public String getCChainEvm() {
        return cChainEvm;
    }
    
    public byte[] getShortId() {
        return shortId.clone();
    }
    
    public String getNetwork() {
        return network;
    }
    
    /**
     * Get EVM address as 20 bytes.
     */
    public byte[] getEvmAddressBytes() {
        return Numeric.hexStringToByteArray(cChainEvm);
    }
    
    @Override
    public String toString() {
        return String.format(
            "========================================\n" +
            "Avalanche Test Wallet\n" +
            "Network: %s\n" +
            "========================================\n" +
            "Private Key: %s\n" +
            "\n" +
            "P-Chain Address: %s\n" +
            "C-Chain Address (Bech32): %s\n" +
            "C-Chain Address (EVM): %s\n" +
            "========================================\n" +
            "\n" +
            "KEEP THE PRIVATE KEY SECRET!\n" +
            "Fund the P-Chain address with testnet AVAX.\n" +
            "After export, use C-Chain Bech32 address for getUTXOs.\n" +
            "ImportTx will credit the EVM address.",
            network, privateKeyHex, pChainAddress, cChainBech32, cChainEvm
        );
    }
}

