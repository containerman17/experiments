package network.avax.build.atomic.parser;

import network.avax.build.atomic.codec.LinearCodec;
import network.avax.build.atomic.constants.AvalancheConstants;
import network.avax.build.atomic.model.AtomicTx;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * ExtDataDecoder parses atomic transactions from BlockExtraData.
 * Post-ApricotPhase5 format: [Version][Count][Tx1][Tx2]...
 * Integrated from BlockExtraDataDemo with production quality error handling.
 */
public class ExtDataDecoder {
    private final LinearCodec codec;
    
    public ExtDataDecoder() {
        this.codec = new LinearCodec();
    }
    
    /**
     * Parse ExtData and extract all atomic transactions (ImportTx and ExportTx).
     * 
     * @param extData Raw ExtData bytes from C-Chain block
     * @return List of all atomic transactions with computed IDs
     */
    public List<AtomicTx> parseAtomicTransactions(byte[] extData) {
        List<AtomicTx> transactions = new ArrayList<>();
        
        if (extData == null || extData.length == 0) {
            return transactions;
        }
        
        try {
            ByteBuffer buf = ByteBuffer.wrap(extData);
            buf.order(ByteOrder.BIG_ENDIAN);
            
            // Read codec version at batch level (2 bytes)
            short batchVersion = buf.getShort();
            if (batchVersion != AvalancheConstants.CODEC_VERSION) {
                System.err.println("Warning: Unsupported batch codec version: " + batchVersion);
                return transactions;
            }
            
            // Read count of transactions (4 bytes)
            int count = buf.getInt();
            
            if (count <= 0 || count > 1000) {
                System.err.println("Warning: Suspicious transaction count: " + count);
                return transactions;
            }
            
            // Parse each complete transaction
            for (int i = 0; i < count; i++) {
                try {
                    byte[] txBytes = extractCompleteTransaction(buf);
                    AtomicTx tx = codec.deserializeAtomicTx(txBytes);
                    transactions.add(tx);
                } catch (Exception e) {
                    System.err.println("Warning: Failed to parse transaction " + i + ": " + e.getMessage());
                    break;
                }
            }
            
        } catch (Exception e) {
            System.err.println("Error parsing ExtData: " + e.getMessage());
        }
        
        return transactions;
    }
    
    /**
     * Extract one complete transaction (unsigned + credentials) from buffer.
     * NOTE: Transactions in batch do NOT have individual version prefixes.
     */
    private byte[] extractCompleteTransaction(ByteBuffer buf) {
        int startPos = buf.position();
        
        // Peek at type ID (NO version prefix for txs in batch)
        int typeId = buf.getInt();
        buf.position(startPos); // Reset
        
        // Skip unsigned portion based on type
        if (typeId == AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX) {
            skipUnsignedImportTxNoVersion(buf);
        } else if (typeId == AvalancheConstants.TYPE_UNSIGNED_EXPORT_TX) {
            skipUnsignedExportTxNoVersion(buf);
        } else {
            throw new IllegalArgumentException("Unknown tx type: " + typeId);
        }
        
        // Skip credentials
        skipCredentials(buf);
        
        // Extract bytes
        int endPos = buf.position();
        byte[] txBytes = new byte[endPos - startPos];
        buf.position(startPos);
        buf.get(txBytes);
        
        return txBytes;
    }
    
    private void skipUnsignedImportTxNoVersion(ByteBuffer buf) {
        // TypeID (4) + NetworkID (4) + BlockchainID (32) + SourceChain (32)
        buf.position(buf.position() + 4 + 4 + 32 + 32);
        
        // ImportedInputs
        int inputsLen = buf.getInt();
        for (int i = 0; i < inputsLen; i++) {
            // TxID (32) + OutputIndex (4) + AssetID (32) + TypeID (4) + Amount (8)
            buf.position(buf.position() + 32 + 4 + 32 + 4 + 8);
            int sigIndicesLen = buf.getInt();
            buf.position(buf.position() + sigIndicesLen * 4);
        }
        
        // Outs
        int outsLen = buf.getInt();
        buf.position(buf.position() + outsLen * (20 + 8 + 32));
    }
    
    private void skipUnsignedExportTxNoVersion(ByteBuffer buf) {
        // TypeID (4) + NetworkID (4) + BlockchainID (32) + DestinationChain (32)
        buf.position(buf.position() + 4 + 4 + 32 + 32);
        
        // Ins (EVMInput array)
        int insLen = buf.getInt();
        buf.position(buf.position() + insLen * (20 + 8 + 32 + 8));
        
        // ExportedOutputs (TransferableOutput array)
        int outsLen = buf.getInt();
        for (int i = 0; i < outsLen; i++) {
            // AssetID (32) + TypeID (4) + Amount (8) + Locktime (8) + Threshold (4)
            buf.position(buf.position() + 32 + 4 + 8 + 8 + 4);
            int addrLen = buf.getInt();
            buf.position(buf.position() + addrLen * 20);
        }
    }
    
    private void skipCredentials(ByteBuffer buf) {
        int credsLen = buf.getInt();
        for (int i = 0; i < credsLen; i++) {
            int credTypeId = buf.getInt();
            if (credTypeId != AvalancheConstants.TYPE_SECP256K1_CREDENTIAL) {
                throw new IllegalArgumentException("Unknown credential type: " + credTypeId);
            }
            int sigsLen = buf.getInt();
            buf.position(buf.position() + sigsLen * 65);
        }
    }
}
