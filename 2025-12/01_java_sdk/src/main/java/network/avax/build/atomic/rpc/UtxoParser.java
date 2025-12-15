package network.avax.build.atomic.rpc;

import network.avax.build.atomic.constants.AvalancheConstants;
import network.avax.build.atomic.model.UTXO;
import org.web3j.utils.Numeric;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Parser for UTXO binary format from avax.getUTXOs response.
 * 
 * UTXO Binary Format (from avalanchego):
 * [CodecVersion: 2 bytes]
 * [TxID: 32 bytes]
 * [OutputIndex: 4 bytes]
 * [AssetID: 32 bytes]
 * [TypeID: 4 bytes]          // 7 = SECP256K1TransferOutput
 * [Amount: 8 bytes]
 * [Locktime: 8 bytes]
 * [Threshold: 4 bytes]
 * [AddressesLen: 4 bytes]
 * [Address1: 20 bytes]
 * ...
 */
public class UtxoParser {
    
    /**
     * Parse a single UTXO from hex string.
     * 
     * @param hexUtxo Hex-encoded UTXO from API response (with or without 0x prefix)
     * @return Parsed UTXO
     * @throws IllegalArgumentException if format is invalid
     */
    public UTXO parseUtxo(String hexUtxo) {
        byte[] bytes = Numeric.hexStringToByteArray(hexUtxo);
        return parseUtxo(bytes);
    }
    
    /**
     * Parse a single UTXO from bytes.
     * 
     * @param bytes UTXO binary data
     * @return Parsed UTXO
     * @throws IllegalArgumentException if format is invalid
     */
    public UTXO parseUtxo(byte[] bytes) {
        ByteBuffer buf = ByteBuffer.wrap(bytes);
        buf.order(ByteOrder.BIG_ENDIAN);
        
        // Minimum size check: 2 + 32 + 4 + 32 + 4 + 8 + 8 + 4 + 4 + 20 = 118 bytes
        if (bytes.length < 118) {
            throw new IllegalArgumentException("UTXO bytes too short: " + bytes.length);
        }
        
        // CodecVersion (2 bytes)
        short codecVersion = buf.getShort();
        if (codecVersion != AvalancheConstants.CODEC_VERSION) {
            throw new IllegalArgumentException("Unexpected codec version: " + codecVersion);
        }
        
        // TxID (32 bytes)
        byte[] txId = new byte[32];
        buf.get(txId);
        
        // OutputIndex (4 bytes, uint32)
        int outputIndex = buf.getInt();
        
        // AssetID (32 bytes)
        byte[] assetId = new byte[32];
        buf.get(assetId);
        
        // TypeID (4 bytes)
        int typeId = buf.getInt();
        if (typeId != AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT) {
            throw new IllegalArgumentException("Unsupported output type: " + typeId + 
                " (expected SECP256K1TransferOutput=" + AvalancheConstants.TYPE_SECP256K1_TRANSFER_OUTPUT + ")");
        }
        
        // Amount (8 bytes, uint64)
        long amount = buf.getLong();
        
        // Locktime (8 bytes) - we don't use this but need to skip
        buf.getLong(); // skip locktime
        
        // Threshold (4 bytes, uint32)
        int threshold = buf.getInt();
        if (threshold != 1) {
            // We only support single-sig UTXOs for now
            throw new IllegalArgumentException("Unsupported threshold: " + threshold + " (only 1 supported)");
        }
        
        // AddressesLen (4 bytes)
        int addressCount = buf.getInt();
        if (addressCount < 1) {
            throw new IllegalArgumentException("UTXO must have at least one address");
        }
        
        // First address (20 bytes) - we only use the first one
        byte[] address = new byte[20];
        buf.get(address);
        
        // Skip remaining addresses if any (multisig case)
        for (int i = 1; i < addressCount; i++) {
            buf.position(buf.position() + 20);
        }
        
        return new UTXO(txId, outputIndex, assetId, amount, address);
    }
    
    /**
     * Parse multiple UTXOs from hex strings.
     * 
     * @param hexUtxos List of hex-encoded UTXOs
     * @return List of parsed UTXOs
     */
    public List<UTXO> parseUtxos(List<String> hexUtxos) {
        List<UTXO> result = new ArrayList<>();
        for (String hex : hexUtxos) {
            try {
                result.add(parseUtxo(hex));
            } catch (Exception e) {
                // Log and skip invalid UTXOs
                System.err.println("Warning: Failed to parse UTXO: " + e.getMessage());
            }
        }
        return result;
    }
}
