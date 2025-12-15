package network.avax.build.atomic.model;

import java.util.Arrays;

/**
 * EVMOutput defines an output added to the EVM state in import transactions.
 * Maps to atomic.EVMOutput in Go.
 */
public class EVMOutput implements Comparable<EVMOutput> {
    private final byte[] address;  // 20 bytes
    private final long amount;
    private final byte[] assetId;  // 32 bytes
    
    public EVMOutput(byte[] address, long amount, byte[] assetId) {
        if (address.length != 20) {
            throw new IllegalArgumentException("Address must be 20 bytes");
        }
        if (assetId.length != 32) {
            throw new IllegalArgumentException("AssetId must be 32 bytes");
        }
        this.address = address.clone();
        this.amount = amount;
        this.assetId = assetId.clone();
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
    
    @Override
    public int compareTo(EVMOutput other) {
        // Compare by address first
        int addrComp = Arrays.compare(this.address, other.address);
        if (addrComp != 0) {
            return addrComp;
        }
        // Then by assetId
        return Arrays.compare(this.assetId, other.assetId);
    }
}

