package io.avalanche.atomic.model;

import java.util.Arrays;

/**
 * TransferableInput represents a UTXO being consumed.
 * Maps to avax.TransferableInput + secp256k1fx.TransferInput in Go.
 */
public class TransferableInput implements Comparable<TransferableInput> {
    private final byte[] txId;          // 32 bytes
    private final int outputIndex;      // uint32
    private final byte[] assetId;       // 32 bytes
    private final long amount;          // uint64
    private final int[] sigIndices;     // []uint32
    
    public TransferableInput(byte[] txId, int outputIndex, byte[] assetId, long amount, int[] sigIndices) {
        if (txId.length != 32) {
            throw new IllegalArgumentException("TxId must be 32 bytes");
        }
        if (assetId.length != 32) {
            throw new IllegalArgumentException("AssetId must be 32 bytes");
        }
        this.txId = txId.clone();
        this.outputIndex = outputIndex;
        this.assetId = assetId.clone();
        this.amount = amount;
        this.sigIndices = sigIndices.clone();
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
    
    public int[] getSigIndices() {
        return sigIndices.clone();
    }
    
    @Override
    public int compareTo(TransferableInput other) {
        // Compare by txId first
        int txIdComp = Arrays.compare(this.txId, other.txId);
        if (txIdComp != 0) {
            return txIdComp;
        }
        // Then by outputIndex
        return Integer.compare(this.outputIndex, other.outputIndex);
    }
}

