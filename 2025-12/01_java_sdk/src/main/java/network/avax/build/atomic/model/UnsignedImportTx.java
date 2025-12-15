package network.avax.build.atomic.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * UnsignedImportTx represents an unsigned atomic import transaction.
 * Maps to atomic.UnsignedImportTx in Go.
 */
public class UnsignedImportTx {
    private final int networkId;           // uint32
    private final byte[] blockchainId;     // 32 bytes
    private final byte[] sourceChain;      // 32 bytes
    private final List<TransferableInput> importedInputs;
    private final List<EVMOutput> outs;
    
    public UnsignedImportTx(int networkId, byte[] blockchainId, byte[] sourceChain,
                            List<TransferableInput> importedInputs, List<EVMOutput> outs) {
        if (blockchainId.length != 32) {
            throw new IllegalArgumentException("BlockchainId must be 32 bytes");
        }
        if (sourceChain.length != 32) {
            throw new IllegalArgumentException("SourceChain must be 32 bytes");
        }
        this.networkId = networkId;
        this.blockchainId = blockchainId.clone();
        this.sourceChain = sourceChain.clone();
        this.importedInputs = new ArrayList<>(importedInputs);
        this.outs = new ArrayList<>(outs);
    }
    
    public int getNetworkId() {
        return networkId;
    }
    
    public byte[] getBlockchainId() {
        return blockchainId.clone();
    }
    
    public byte[] getSourceChain() {
        return sourceChain.clone();
    }
    
    public List<TransferableInput> getImportedInputs() {
        return Collections.unmodifiableList(importedInputs);
    }
    
    public List<EVMOutput> getOuts() {
        return Collections.unmodifiableList(outs);
    }
}

