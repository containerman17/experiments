package network.avax.build.atomic.codec;

import network.avax.build.atomic.constants.AvalancheConstants;
import network.avax.build.atomic.model.*;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * LinearCodec implements Avalanche's linear codec for serialization/deserialization.
 * Verified against avalanchego/codec/linearcodec.
 */
public class LinearCodec {
    
    /**
     * Serialize an UnsignedImportTx to bytes.
     * Format verified from atomic/import_tx.go and codec/manager.go.
     */
    public byte[] serializeUnsignedImportTx(UnsignedImportTx tx) {
        ByteBuffer buf = ByteBuffer.allocate(estimateSize(tx));
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Codec version (2 bytes)
        buf.putShort(AvalancheConstants.CODEC_VERSION);
        
        // Type ID for UnsignedImportTx (4 bytes)
        buf.putInt(AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX);
        
        // NetworkID (4 bytes)
        buf.putInt(tx.getNetworkId());
        
        // BlockchainID (32 bytes)
        buf.put(tx.getBlockchainId());
        
        // SourceChain (32 bytes)
        buf.put(tx.getSourceChain());
        
        // ImportedInputs (array)
        buf.putInt(tx.getImportedInputs().size());
        for (TransferableInput input : tx.getImportedInputs()) {
            serializeTransferableInput(buf, input);
        }
        
        // EVMOutputs (array)
        buf.putInt(tx.getOuts().size());
        for (EVMOutput out : tx.getOuts()) {
            serializeEVMOutput(buf, out);
        }
        
        // Return only the bytes we wrote
        byte[] result = new byte[buf.position()];
        buf.rewind();
        buf.get(result);
        return result;
    }
    
    /**
     * Serialize a complete signed transaction (UnsignedTx + Credentials).
     */
    public byte[] serializeSignedTx(UnsignedImportTx tx, List<Credential> credentials) {
        byte[] unsignedBytes = serializeUnsignedImportTx(tx);
        return appendCredentials(unsignedBytes, credentials);
    }
    
    /**
     * Serialize an UnsignedExportTx to bytes.
     */
    public byte[] serializeUnsignedExportTx(UnsignedExportTx tx) {
        ByteBuffer buf = ByteBuffer.allocate(estimateExportSize(tx));
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Codec version (2 bytes)
        buf.putShort(AvalancheConstants.CODEC_VERSION);
        
        // Type ID for UnsignedExportTx (4 bytes)
        buf.putInt(AvalancheConstants.TYPE_UNSIGNED_EXPORT_TX);
        
        // NetworkID (4 bytes)
        buf.putInt(tx.getNetworkId());
        
        // BlockchainID (32 bytes)
        buf.put(tx.getBlockchainId());
        
        // DestinationChain (32 bytes)
        buf.put(tx.getDestinationChain());
        
        // Ins (array of EVMInput)
        buf.putInt(tx.getIns().size());
        for (EVMInput input : tx.getIns()) {
            serializeEVMInput(buf, input);
        }
        
        // ExportedOutputs (array of TransferableOutput)
        buf.putInt(tx.getExportedOutputs().size());
        for (TransferableOutput out : tx.getExportedOutputs()) {
            serializeTransferableOutput(buf, out);
        }
        
        byte[] result = new byte[buf.position()];
        buf.rewind();
        buf.get(result);
        return result;
    }
    
    /**
     * Serialize a complete signed ExportTx.
     */
    public byte[] serializeSignedExportTx(UnsignedExportTx tx, List<Credential> credentials) {
        byte[] unsignedBytes = serializeUnsignedExportTx(tx);
        return appendCredentials(unsignedBytes, credentials);
    }
    
    private byte[] appendCredentials(byte[] unsignedBytes, List<Credential> credentials) {
        int credsSize = 4; // Length field
        for (Credential cred : credentials) {
            credsSize += 4 + 4 + (cred.size() * 65); // typeID + sigsLen + sigs
        }
        
        ByteBuffer buf = ByteBuffer.allocate(unsignedBytes.length + credsSize);
        buf.order(ByteOrder.BIG_ENDIAN);
        buf.put(unsignedBytes);
        
        // Credentials array
        buf.putInt(credentials.size());
        for (Credential cred : credentials) {
            buf.putInt(AvalancheConstants.TYPE_SECP256K1_CREDENTIAL);
            buf.putInt(cred.size());
            for (byte[] sig : cred.getSignatures()) {
                buf.put(sig);
            }
        }
        
        byte[] result = new byte[buf.position()];
        buf.rewind();
        buf.get(result);
        return result;
    }
    
    /**
     * Deserialize bytes into an UnsignedImportTx.
     * Used for parsing ExtData when detecting transactions.
     */
    public UnsignedImportTx deserializeUnsignedImportTx(byte[] data) {
        ByteBuffer buf = ByteBuffer.wrap(data);
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Read codec version (2 bytes)
        short version = buf.getShort();
        if (version != AvalancheConstants.CODEC_VERSION) {
            throw new IllegalArgumentException("Unsupported codec version: " + version);
        }
        
        // Read type ID (4 bytes)
        int typeId = buf.getInt();
        if (typeId != AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX) {
            throw new IllegalArgumentException("Expected ImportTx typeId, got: " + typeId);
        }
        
        return deserializeImportTxBody(buf);
    }
    
    /**
     * Deserialize ImportTx body (without version/typeId prefix).
     */
    private UnsignedImportTx deserializeImportTxBody(ByteBuffer buf) {
        // NetworkID (4 bytes)
        int networkId = buf.getInt();
        
        // BlockchainID (32 bytes)
        byte[] blockchainId = new byte[32];
        buf.get(blockchainId);
        
        // SourceChain (32 bytes)
        byte[] sourceChain = new byte[32];
        buf.get(sourceChain);
        
        // ImportedInputs
        int inputsLen = buf.getInt();
        List<TransferableInput> inputs = new ArrayList<>(inputsLen);
        for (int i = 0; i < inputsLen; i++) {
            inputs.add(deserializeTransferableInput(buf));
        }
        
        // EVMOutputs
        int outsLen = buf.getInt();
        List<EVMOutput> outs = new ArrayList<>(outsLen);
        for (int i = 0; i < outsLen; i++) {
            outs.add(deserializeEVMOutput(buf));
        }
        
        return new UnsignedImportTx(networkId, blockchainId, sourceChain, inputs, outs);
    }
    
    /**
     * Deserialize UnsignedExportTx body (without version/typeId prefix).
     */
    private UnsignedExportTx deserializeExportTxBody(ByteBuffer buf) {
        // NetworkID (4 bytes)
        int networkId = buf.getInt();
        
        // BlockchainID (32 bytes)
        byte[] blockchainId = new byte[32];
        buf.get(blockchainId);
        
        // DestinationChain (32 bytes)
        byte[] destinationChain = new byte[32];
        buf.get(destinationChain);
        
        // Ins (array of EVMInput)
        int insLen = buf.getInt();
        List<EVMInput> ins = new ArrayList<>(insLen);
        for (int i = 0; i < insLen; i++) {
            ins.add(deserializeEVMInput(buf));
        }
        
        // ExportedOutputs (array of TransferableOutput)
        int outsLen = buf.getInt();
        List<TransferableOutput> outs = new ArrayList<>(outsLen);
        for (int i = 0; i < outsLen; i++) {
            outs.add(deserializeTransferableOutput(buf));
        }
        
        return new UnsignedExportTx(networkId, blockchainId, destinationChain, ins, outs);
    }
    
    /**
     * Deserialize a complete signed AtomicTx with transaction ID computation.
     * Used for parsing individual txs from ExtData batch.
     * NOTE: Batch txs do NOT have individual version prefixes - only the batch has version.
     */
    public AtomicTx deserializeAtomicTx(byte[] data) {
        return deserializeAtomicTx(data, false);
    }
    
    /**
     * Deserialize AtomicTx with optional version prefix.
     * @param data Transaction bytes
     * @param hasVersionPrefix If true, expects version prefix; if false, expects raw typeID first
     */
    public AtomicTx deserializeAtomicTx(byte[] data, boolean hasVersionPrefix) {
        ByteBuffer buf = ByteBuffer.wrap(data);
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Read codec version if present
        if (hasVersionPrefix) {
            short version = buf.getShort();
            if (version != AvalancheConstants.CODEC_VERSION) {
                throw new IllegalArgumentException("Unsupported codec version: " + version);
            }
        }
        
        // Read type ID (4 bytes)
        int typeId = buf.getInt();
        
        // Deserialize unsigned tx based on type
        Object unsignedTx;
        if (typeId == AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX) {
            unsignedTx = deserializeImportTxBody(buf);
        } else if (typeId == AvalancheConstants.TYPE_UNSIGNED_EXPORT_TX) {
            unsignedTx = deserializeExportTxBody(buf);
        } else {
            throw new IllegalArgumentException("Unknown tx type ID: " + typeId);
        }
        
        // Deserialize credentials
        int credsLen = buf.getInt();
        List<Credential> credentials = new ArrayList<>(credsLen);
        for (int i = 0; i < credsLen; i++) {
            credentials.add(deserializeCredential(buf));
        }
        
        // Compute transaction ID (SHA256 of the full signed bytes)
        // For batch txs, we need to prepend version
        byte[] txBytesForId;
        if (hasVersionPrefix) {
            txBytesForId = data;
        } else {
            // Prepend version for ID computation
            ByteBuffer idBuf = ByteBuffer.allocate(2 + data.length);
            idBuf.order(ByteOrder.BIG_ENDIAN);
            idBuf.putShort(AvalancheConstants.CODEC_VERSION);
            idBuf.put(data);
            txBytesForId = idBuf.array();
        }
        byte[] txId = computeTxId(txBytesForId);
        
        // Build AtomicTx
        if (typeId == AvalancheConstants.TYPE_UNSIGNED_IMPORT_TX) {
            return new AtomicTx((UnsignedImportTx) unsignedTx, credentials, txId);
        } else {
            return new AtomicTx((UnsignedExportTx) unsignedTx, credentials, txId);
        }
    }
    
    private Credential deserializeCredential(ByteBuffer buf) {
        // Read type ID
        int typeId = buf.getInt();
        if (typeId != AvalancheConstants.TYPE_SECP256K1_CREDENTIAL) {
            throw new IllegalArgumentException("Expected Credential typeId, got: " + typeId);
        }
        
        // Read signatures array
        int sigsLen = buf.getInt();
        List<byte[]> signatures = new ArrayList<>(sigsLen);
        for (int i = 0; i < sigsLen; i++) {
            byte[] sig = new byte[65];
            buf.get(sig);
            signatures.add(sig);
        }
        
        return new Credential(signatures);
    }
    
    private byte[] computeTxId(byte[] signedTxBytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest(signedTxBytes);
        } catch (Exception e) {
            throw new RuntimeException("Failed to compute transaction ID", e);
        }
    }
    
    private void serializeTransferableInput(ByteBuffer buf, TransferableInput input) {
        // UTXOID.TxID (32 bytes)
        buf.put(input.getTxId());
        
        // UTXOID.OutputIndex (4 bytes)
        buf.putInt(input.getOutputIndex());
        
        // Asset.ID (32 bytes)
        buf.put(input.getAssetId());
        
        // TransferInput type ID (4 bytes)
        buf.putInt(AvalancheConstants.TYPE_SECP256K1_TRANSFER_INPUT);
        
        // TransferInput.Amt (8 bytes)
        buf.putLong(input.getAmount());
        
        // Input.SigIndices (array)
        int[] sigIndices = input.getSigIndices();
        buf.putInt(sigIndices.length);
        for (int idx : sigIndices) {
            buf.putInt(idx);
        }
    }
    
    private TransferableInput deserializeTransferableInput(ByteBuffer buf) {
        // TxID (32 bytes)
        byte[] txId = new byte[32];
        buf.get(txId);
        
        // OutputIndex (4 bytes)
        int outputIndex = buf.getInt();
        
        // AssetID (32 bytes)
        byte[] assetId = new byte[32];
        buf.get(assetId);
        
        // TransferInput type ID (4 bytes)
        int typeId = buf.getInt();
        if (typeId != AvalancheConstants.TYPE_SECP256K1_TRANSFER_INPUT) {
            throw new IllegalArgumentException("Expected TransferInput typeId, got: " + typeId);
        }
        
        // Amount (8 bytes)
        long amount = buf.getLong();
        
        // SigIndices array
        int sigIndicesLen = buf.getInt();
        int[] sigIndices = new int[sigIndicesLen];
        for (int i = 0; i < sigIndicesLen; i++) {
            sigIndices[i] = buf.getInt();
        }
        
        return new TransferableInput(txId, outputIndex, assetId, amount, sigIndices);
    }
    
    private void serializeEVMOutput(ByteBuffer buf, EVMOutput out) {
        // Address (20 bytes)
        buf.put(out.getAddress());
        
        // Amount (8 bytes)
        buf.putLong(out.getAmount());
        
        // AssetID (32 bytes)
        buf.put(out.getAssetId());
    }
    
    private EVMOutput deserializeEVMOutput(ByteBuffer buf) {
        // Address (20 bytes)
        byte[] address = new byte[20];
        buf.get(address);
        
        // Amount (8 bytes)
        long amount = buf.getLong();
        
        // AssetID (32 bytes)
        byte[] assetId = new byte[32];
        buf.get(assetId);
        
        return new EVMOutput(address, amount, assetId);
    }
    
    private void serializeEVMInput(ByteBuffer buf, EVMInput input) {
        // Address (20 bytes)
        buf.put(input.getAddress());
        
        // Amount (8 bytes)
        buf.putLong(input.getAmount());
        
        // AssetID (32 bytes)
        buf.put(input.getAssetId());
        
        // Nonce (8 bytes)
        buf.putLong(input.getNonce());
    }
    
    private EVMInput deserializeEVMInput(ByteBuffer buf) {
        // Address (20 bytes)
        byte[] address = new byte[20];
        buf.get(address);
        
        // Amount (8 bytes)
        long amount = buf.getLong();
        
        // AssetID (32 bytes)
        byte[] assetId = new byte[32];
        buf.get(assetId);
        
        // Nonce (8 bytes)
        long nonce = buf.getLong();
        
        return new EVMInput(address, amount, assetId, nonce);
    }
    
    private void serializeTransferableOutput(ByteBuffer buf, TransferableOutput out) {
        // AssetID (32 bytes)
        buf.put(out.getAssetId());
        
        // Type ID for TransferOutput (4 bytes)
        buf.putInt(AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT);
        
        // Amount (8 bytes)
        buf.putLong(out.getAmount());
        
        // Locktime (8 bytes)
        buf.putLong(out.getLocktime());
        
        // Threshold (4 bytes)
        buf.putInt(out.getThreshold());
        
        // Addresses array
        buf.putInt(out.getAddresses().size());
        for (byte[] addr : out.getAddresses()) {
            buf.put(addr);
        }
    }
    
    private TransferableOutput deserializeTransferableOutput(ByteBuffer buf) {
        // AssetID (32 bytes)
        byte[] assetId = new byte[32];
        buf.get(assetId);
        
        // Type ID (4 bytes)
        int typeId = buf.getInt();
        if (typeId != AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT) {
            throw new IllegalArgumentException("Expected TransferOutput typeId, got: " + typeId);
        }
        
        // Amount (8 bytes)
        long amount = buf.getLong();
        
        // Locktime (8 bytes)
        long locktime = buf.getLong();
        
        // Threshold (4 bytes)
        int threshold = buf.getInt();
        
        // Addresses array
        int addrLen = buf.getInt();
        List<byte[]> addresses = new ArrayList<>(addrLen);
        for (int i = 0; i < addrLen; i++) {
            byte[] addr = new byte[20];
            buf.get(addr);
            addresses.add(addr);
        }
        
        return new TransferableOutput(assetId, amount, locktime, threshold, addresses);
    }
    
    private int estimateSize(UnsignedImportTx tx) {
        // Codec version (2) + TypeID (4) + NetworkID (4) + BlockchainID (32) + SourceChain (32)
        int size = 2 + 4 + 4 + 32 + 32;
        
        // ImportedInputs: length (4) + each input
        size += 4;
        for (TransferableInput input : tx.getImportedInputs()) {
            // TxID (32) + OutputIndex (4) + AssetID (32) + TypeID (4) + Amount (8) + SigIndices length (4) + indices
            size += 32 + 4 + 32 + 4 + 8 + 4 + (input.getSigIndices().length * 4);
        }
        
        // Outs: length (4) + each output
        size += 4;
        size += tx.getOuts().size() * (20 + 8 + 32); // Address + Amount + AssetID
        
        return size + 100; // Buffer for safety
    }
    
    private int estimateExportSize(UnsignedExportTx tx) {
        // Codec version (2) + TypeID (4) + NetworkID (4) + BlockchainID (32) + DestinationChain (32)
        int size = 2 + 4 + 4 + 32 + 32;
        
        // Ins: length (4) + each input (20 + 8 + 32 + 8)
        size += 4 + tx.getIns().size() * (20 + 8 + 32 + 8);
        
        // ExportedOutputs: length (4) + each output
        size += 4;
        for (TransferableOutput out : tx.getExportedOutputs()) {
            // AssetID (32) + TypeID (4) + Amount (8) + Locktime (8) + Threshold (4) + Addrs length (4) + addrs
            size += 32 + 4 + 8 + 8 + 4 + 4 + (out.getAddresses().size() * 20);
        }
        
        return size + 100; // Buffer for safety
    }
}

