package io.avalanche.atomic.model;

/**
 * UTXO represents an unspent transaction output from shared memory.
 * Simplified model for the SDK's purposes.
 */
public class UTXO {
    private final byte[] txId;          // 32 bytes
    private final int outputIndex;      // uint32
    private final byte[] assetId;       // 32 bytes
    private final long amount;          // uint64
    private final byte[] address;       // 20 bytes (P-Chain address as ShortID)
    
    public UTXO(byte[] txId, int outputIndex, byte[] assetId, long amount, byte[] address) {
        if (txId.length != 32) {
            throw new IllegalArgumentException("TxId must be 32 bytes");
        }
        if (assetId.length != 32) {
            throw new IllegalArgumentException("AssetId must be 32 bytes");
        }
        if (address.length != 20) {
            throw new IllegalArgumentException("Address must be 20 bytes");
        }
        this.txId = txId.clone();
        this.outputIndex = outputIndex;
        this.assetId = assetId.clone();
        this.amount = amount;
        this.address = address.clone();
    }
    
    public byte[] getTxId() {
        return txId.clone();
    }
    
    public int getOutputIndex() {
        return outputIndex;
    }
    
    public byte[] getAssetId() {
        return assetId.clone();
    }
    
    public long getAmount() {
        return amount;
    }
    
    public byte[] getAddress() {
        return address.clone();
    }
}

