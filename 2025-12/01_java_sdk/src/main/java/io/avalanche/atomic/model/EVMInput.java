package io.avalanche.atomic.model;

import java.util.Arrays;

/**
 * EVMInput defines an input from the EVM state to fund export transactions.
 * Maps to atomic.EVMInput in Go.
 */
public class EVMInput implements Comparable<EVMInput> {
    private final byte[] address;  // 20 bytes
    private final long amount;
    private final byte[] assetId;  // 32 bytes
    private final long nonce;
    
    public EVMInput(byte[] address, long amount, byte[] assetId, long nonce) {
        if (address.length != 20) {
            throw new IllegalArgumentException("Address must be 20 bytes");
        }
        if (assetId.length != 32) {
            throw new IllegalArgumentException("AssetId must be 32 bytes");
        }
        this.address = address.clone();
        this.amount = amount;
        this.assetId = assetId.clone();
        this.nonce = nonce;
    }
    
    public byte[] getAddress() {
        return address.clone();
    }
    
    public long getAmount() {
        return amount;
    }
    
    public byte[] getAssetId() {
        return assetId.clone();
    }
    
    public long getNonce() {
        return nonce;
    }
    
    @Override
    public int compareTo(EVMInput other) {
        int addrComp = Arrays.compare(this.address, other.address);
        if (addrComp != 0) {
            return addrComp;
        }
        return Arrays.compare(this.assetId, other.assetId);
    }
}

