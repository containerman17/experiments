package io.avalanche.atomic.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * UnsignedExportTx represents an unsigned atomic export transaction.
 * Maps to atomic.UnsignedExportTx in Go.
 */
public class UnsignedExportTx {
    private final int networkId;              // uint32
    private final byte[] blockchainId;        // 32 bytes
    private final byte[] destinationChain;    // 32 bytes
    private final List<EVMInput> ins;
    private final List<TransferableOutput> exportedOutputs;
    
    public UnsignedExportTx(int networkId, byte[] blockchainId, byte[] destinationChain,
                           List<EVMInput> ins, List<TransferableOutput> exportedOutputs) {
        if (blockchainId.length != 32) {
            throw new IllegalArgumentException("BlockchainId must be 32 bytes");
        }
        if (destinationChain.length != 32) {
            throw new IllegalArgumentException("DestinationChain must be 32 bytes");
        }
        this.networkId = networkId;
        this.blockchainId = blockchainId.clone();
        this.destinationChain = destinationChain.clone();
        this.ins = new ArrayList<>(ins);
        this.exportedOutputs = new ArrayList<>(exportedOutputs);
    }
    
    public int getNetworkId() {
        return networkId;
    }
    
    public byte[] getBlockchainId() {
        return blockchainId.clone();
    }
    
    public byte[] getDestinationChain() {
        return destinationChain.clone();
    }
    
    public List<EVMInput> getIns() {
        return Collections.unmodifiableList(ins);
    }
    
    public List<TransferableOutput> getExportedOutputs() {
        return Collections.unmodifiableList(exportedOutputs);
    }
}

