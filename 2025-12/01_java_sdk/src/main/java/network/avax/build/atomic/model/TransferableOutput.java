package network.avax.build.atomic.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * TransferableOutput represents an output in export transactions.
 * Maps to avax.TransferableOutput + secp256k1fx.TransferOutput in Go.
 */
public class TransferableOutput {
    private final byte[] assetId;       // 32 bytes
    private final long amount;          // uint64
    private final long locktime;        // uint64
    private final int threshold;        // uint32
    private final List<byte[]> addresses; // []ShortID (20 bytes each)
    
    public TransferableOutput(byte[] assetId, long amount, long locktime, 
                              int threshold, List<byte[]> addresses) {
        if (assetId.length != 32) {
            throw new IllegalArgumentException("AssetId must be 32 bytes");
        }
        this.assetId = assetId.clone();
        this.amount = amount;
        this.locktime = locktime;
        this.threshold = threshold;
        this.addresses = new ArrayList<>();
        for (byte[] addr : addresses) {
            if (addr.length != 20) {
                throw new IllegalArgumentException("Address must be 20 bytes");
            }
            this.addresses.add(addr.clone());
        }
    }
    
    public byte[] getAssetId() {
        return assetId.clone();
    }
    
    public long getAmount() {
        return amount;
    }
    
    public long getLocktime() {
        return locktime;
    }
    
    public int getThreshold() {
        return threshold;
    }
    
    public List<byte[]> getAddresses() {
        List<byte[]> copy = new ArrayList<>();
        for (byte[] addr : addresses) {
            copy.add(addr.clone());
        }
        return copy;
    }
}

