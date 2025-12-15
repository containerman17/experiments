package io.avalanche.atomic.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * AtomicTx represents a complete signed atomic transaction (Import or Export).
 * Contains the unsigned transaction plus credentials.
 */
public class AtomicTx {
    
    public enum TxType {
        IMPORT_TX,
        EXPORT_TX
    }
    
    private final TxType type;
    private final UnsignedImportTx importTx;
    private final UnsignedExportTx exportTx;
    private final List<Credential> credentials;
    private final byte[] txId;  // SHA256 hash of serialized tx
    
    /**
     * Create an AtomicTx for an ImportTx.
     */
    public AtomicTx(UnsignedImportTx importTx, List<Credential> credentials, byte[] txId) {
        this.type = TxType.IMPORT_TX;
        this.importTx = importTx;
        this.exportTx = null;
        this.credentials = new ArrayList<>(credentials);
        this.txId = txId != null ? txId.clone() : new byte[32];
    }
    
    /**
     * Create an AtomicTx for an ExportTx.
     */
    public AtomicTx(UnsignedExportTx exportTx, List<Credential> credentials, byte[] txId) {
        this.type = TxType.EXPORT_TX;
        this.importTx = null;
        this.exportTx = exportTx;
        this.credentials = new ArrayList<>(credentials);
        this.txId = txId != null ? txId.clone() : new byte[32];
    }
    
    public TxType getType() {
        return type;
    }
    
    public boolean isImportTx() {
        return type == TxType.IMPORT_TX;
    }
    
    public boolean isExportTx() {
        return type == TxType.EXPORT_TX;
    }
    
    public UnsignedImportTx getImportTx() {
        if (type != TxType.IMPORT_TX) {
            throw new IllegalStateException("Not an ImportTx");
        }
        return importTx;
    }
    
    public UnsignedExportTx getExportTx() {
        if (type != TxType.EXPORT_TX) {
            throw new IllegalStateException("Not an ExportTx");
        }
        return exportTx;
    }
    
    public List<Credential> getCredentials() {
        return Collections.unmodifiableList(credentials);
    }
    
    public byte[] getTxId() {
        return txId.clone();
    }
}

