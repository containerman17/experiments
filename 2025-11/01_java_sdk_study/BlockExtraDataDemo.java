package com.avax.demo;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Java 21 Demo for decoding Avalanche C-Chain BlockExtraData.
 * Usage: java BlockExtraDataDemo.java
 */
public class BlockExtraDataDemo {

    // Codec Type IDs based on coreth/plugin/evm/atomic/codec.go
    private static final int TYPE_ID_IMPORT_TX = 0;
    private static final int TYPE_ID_EXPORT_TX = 1;
    private static final int TYPE_ID_SECP256K1_TRANSFER_INPUT = 5;
    private static final int TYPE_ID_SECP256K1_TRANSFER_OUTPUT = 7;
    private static final int TYPE_ID_SECP256K1_CREDENTIAL = 9;
    private static final int TYPE_ID_SECP256K1_INPUT = 10;
    private static final int TYPE_ID_SECP256K1_OUTPUT_OWNERS = 11;

    public static void main(String[] args) {
        String hexData;
        if (args.length > 0) {
            hexData = args[0];
            if (hexData.startsWith("0x")) {
                hexData = hexData.substring(2);
            }
        } else {
            // Example 2 from decode_extra.go
            hexData = "00000000000100000001000000010427D4B22A2A78BCDDD456742CAF91B56BADBFF985EE19AEF14573E7343FD652000000000000000000000000000000000000000000000000000000000000000000000001565F0FE9715E3CB0DF579F186C299D6707887E830000000DC7D44F6F21E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF0000000000025FCD0000000121E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF000000070000000DC7D42391000000000000000000000001000000015CF998275803A7277926912DEFDF177B2E97B0B4000000010000000900000001C1B39952DF371D6AC3CB7615630DC279DEC7A471C1C355738C0FA087B41FD5C317AC85D312B4DC01C9B37513BCAC98465CF7A834F8A291536AAB1C6403D29D1B01";
        }

        System.out.println("Decoding BlockExtraData...");
        System.out.println("Input Hex: " + (hexData.length() > 60 ? hexData.substring(0, 60) + "..." : hexData));
        System.out.println("Length: " + hexData.length() / 2 + " bytes");

        try {
            byte[] data = HexFormat.of().parseHex(hexData);
            List<Tx> txs = decode(data);
            
            System.out.println("\nDecoded " + txs.size() + " atomic transaction(s):");
            for (int i = 0; i < txs.size(); i++) {
                System.out.println("\n=== Transaction " + i + " ===");
                System.out.println(txs.get(i));
            }
            
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public static List<Tx> decode(byte[] data) {
        LinearDecoder decoder = new LinearDecoder(data);
        
        // Check for Codec Version (2 bytes)
        // Avalanche codec often packs a version (uint16).
        // Based on analysis, the first 2 bytes '00 00' are likely the version.
        short codecVersion = decoder.readShort();
        if (codecVersion != 0) {
            System.out.println("Warning: Unexpected Codec Version: " + codecVersion);
        }

        // Try to decode as a Batch (Slice of Tx)
        // Format: [Len: uint32] [Tx1] [Tx2] ...
        // Note: In the observed data, the next 4 bytes are 00 00 00 01 (Length 1).
        
        try {
            long sliceLen = decoder.readInt() & 0xFFFFFFFFL; // Read uint32
            List<Tx> txs = new ArrayList<>();
            
            for (int i = 0; i < sliceLen; i++) {
                txs.add(Tx.decode(decoder));
            }
            return txs;
        } catch (Exception e) {
            throw new RuntimeException("Failed to decode batch", e);
        }
    }

    // --- Decoder Helper ---
    static class LinearDecoder {
        private final ByteBuffer buffer;

        public LinearDecoder(byte[] data) {
            this.buffer = ByteBuffer.wrap(data);
            this.buffer.order(ByteOrder.BIG_ENDIAN); // Avalanche Linear Codec uses Big Endian
        }

        public byte readByte() {
            return buffer.get();
        }

        public short readShort() {
            return buffer.getShort();
        }

        public int readInt() {
            return buffer.getInt();
        }

        public long readLong() {
            return buffer.getLong();
        }

        public byte[] readBytes(int length) {
            byte[] b = new byte[length];
            buffer.get(b);
            return b;
        }

        public String readString() {
            int len = buffer.getShort() & 0xFFFF; // uint16 length
            byte[] b = new byte[len];
            buffer.get(b);
            return new String(b, StandardCharsets.UTF_8);
        }
        
        // Helper to read ID as Hex String
        public String readID() {
            byte[] id = readBytes(32);
            // Format as CB58 or just Hex? Guide uses CB58 (e.g. "2q9e...") but for simplicity hex is fine
            // or we can use HexFormat.
            return HexFormat.of().formatHex(id);
        }
        
        public String readShortID() {
             byte[] id = readBytes(20);
             return "0x" + HexFormat.of().formatHex(id);
        }
    }

    // --- Models ---

    static class Tx {
        UnsignedAtomicTx unsignedTx;
        List<Credential> credentials;

        static Tx decode(LinearDecoder d) {
            Tx tx = new Tx();
            // UnsignedAtomicTx is an interface, so it starts with Type ID
            int typeId = d.readInt();
            switch (typeId) {
                case TYPE_ID_IMPORT_TX:
                    tx.unsignedTx = UnsignedImportTx.decode(d);
                    break;
                case TYPE_ID_EXPORT_TX:
                    tx.unsignedTx = UnsignedExportTx.decode(d);
                    break;
                default:
                    throw new IllegalArgumentException("Unknown Tx Type ID: " + typeId);
            }

            // Credentials (Slice)
            long credsLen = d.readInt() & 0xFFFFFFFFL;
            tx.credentials = new ArrayList<>();
            for (int i = 0; i < credsLen; i++) {
                int credTypeId = d.readInt();
                if (credTypeId == TYPE_ID_SECP256K1_CREDENTIAL) {
                    tx.credentials.add(Credential.decode(d));
                } else {
                    throw new IllegalArgumentException("Unknown Credential Type ID: " + credTypeId);
                }
            }
            return tx;
        }

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            sb.append("Type: ").append(unsignedTx.getTypeName()).append("\n");
            sb.append(unsignedTx.toString());
            sb.append("Credentials: ").append(credentials.size());
            return sb.toString();
        }
    }

    interface UnsignedAtomicTx {
        String getTypeName();
    }

    static class UnsignedImportTx implements UnsignedAtomicTx {
        int networkID;
        String blockchainID;
        String sourceChain;
        List<TransferableInput> importedInputs;
        List<EVMOutput> outs;

        static UnsignedImportTx decode(LinearDecoder d) {
            UnsignedImportTx tx = new UnsignedImportTx();
            tx.networkID = d.readInt();
            tx.blockchainID = d.readID();
            tx.sourceChain = d.readID();

            // ImportedInputs (Slice of TransferableInput)
            long inputsLen = d.readInt() & 0xFFFFFFFFL;
            tx.importedInputs = new ArrayList<>();
            for (int i = 0; i < inputsLen; i++) {
                tx.importedInputs.add(TransferableInput.decode(d));
            }

            // Outs (Slice of EVMOutput)
            long outsLen = d.readInt() & 0xFFFFFFFFL;
            tx.outs = new ArrayList<>();
            for (int i = 0; i < outsLen; i++) {
                tx.outs.add(EVMOutput.decode(d));
            }
            return tx;
        }

        @Override
        public String getTypeName() { return "ImportTx"; }

        @Override
        public String toString() {
            return "NetworkID: " + networkID + "\n" +
                   "BlockchainID: " + blockchainID + "\n" +
                   "SourceChain: " + sourceChain + "\n" +
                   "ImportedInputs: " + importedInputs.size() + "\n" +
                   "Outputs: " + outs.size() + "\n";
        }
    }

    static class UnsignedExportTx implements UnsignedAtomicTx {
        int networkID;
        String blockchainID;
        String destinationChain;
        List<EVMInput> ins;
        List<TransferableOutput> exportedOutputs;

        static UnsignedExportTx decode(LinearDecoder d) {
            UnsignedExportTx tx = new UnsignedExportTx();
            tx.networkID = d.readInt();
            tx.blockchainID = d.readID();
            tx.destinationChain = d.readID();

            // Ins (Slice of EVMInput)
            long insLen = d.readInt() & 0xFFFFFFFFL;
            tx.ins = new ArrayList<>();
            for (int i = 0; i < insLen; i++) {
                tx.ins.add(EVMInput.decode(d));
            }

            // ExportedOutputs (Slice of TransferableOutput)
            long outsLen = d.readInt() & 0xFFFFFFFFL;
            tx.exportedOutputs = new ArrayList<>();
            for (int i = 0; i < outsLen; i++) {
                tx.exportedOutputs.add(TransferableOutput.decode(d));
            }
            return tx;
        }

        @Override
        public String getTypeName() { return "ExportTx"; }

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            sb.append("NetworkID: ").append(networkID).append("\n");
            sb.append("BlockchainID: ").append(blockchainID).append("\n");
            sb.append("DestinationChain: ").append(destinationChain).append("\n");
            sb.append("Inputs: ").append(ins.size()).append("\n");
            for (int i = 0; i < ins.size(); i++) {
                sb.append("  Input ").append(i).append(": ").append(ins.get(i)).append("\n");
            }
            sb.append("ExportedOutputs: ").append(exportedOutputs.size()).append("\n");
            for (int i = 0; i < exportedOutputs.size(); i++) {
                sb.append("  Output ").append(i).append(": ").append(exportedOutputs.get(i)).append("\n");
            }
            return sb.toString();
        }
    }

    static class EVMInput {
        String address;
        long amount;
        String assetID;
        long nonce;

        static EVMInput decode(LinearDecoder d) {
            EVMInput in = new EVMInput();
            in.address = d.readShortID();
            in.amount = d.readLong();
            in.assetID = d.readID();
            in.nonce = d.readLong();
            return in;
        }

        @Override
        public String toString() {
            return String.format("Address=%s, Amount=%d, AssetID=...%s, Nonce=%d", 
                address, amount, assetID.substring(58), nonce);
        }
    }

    static class EVMOutput {
        String address;
        long amount;
        String assetID;

        static EVMOutput decode(LinearDecoder d) {
            EVMOutput out = new EVMOutput();
            out.address = d.readShortID();
            out.amount = d.readLong();
            out.assetID = d.readID();
            return out;
        }
    }

    static class TransferableInput {
        String txID;
        int outputIndex;
        String assetID;
        // In field is an Interface
        Object input; // Likely SECP256K1TransferInput

        static TransferableInput decode(LinearDecoder d) {
            TransferableInput ti = new TransferableInput();
            ti.txID = d.readID();
            ti.outputIndex = d.readInt();
            ti.assetID = d.readID();
            
            int typeId = d.readInt();
            if (typeId == TYPE_ID_SECP256K1_TRANSFER_INPUT) {
                ti.input = SECP256K1TransferInput.decode(d);
            } else {
                throw new RuntimeException("Unsupported TransferInput Type: " + typeId);
            }
            return ti;
        }
    }

    static class SECP256K1TransferInput {
        long amount;
        List<Integer> sigIndices;

        static SECP256K1TransferInput decode(LinearDecoder d) {
            SECP256K1TransferInput in = new SECP256K1TransferInput();
            in.amount = d.readLong();
            // Embedded SECP256K1Input
            long sigsLen = d.readInt() & 0xFFFFFFFFL;
            in.sigIndices = new ArrayList<>();
            for (int i = 0; i < sigsLen; i++) {
                in.sigIndices.add(d.readInt());
            }
            return in;
        }
    }

    static class TransferableOutput {
        String assetID;
        // Out field is an Interface
        Object output; // Likely SECP256K1TransferOutput

        static TransferableOutput decode(LinearDecoder d) {
            TransferableOutput to = new TransferableOutput();
            to.assetID = d.readID();
            
            int typeId = d.readInt();
            if (typeId == TYPE_ID_SECP256K1_TRANSFER_OUTPUT) {
                to.output = SECP256K1TransferOutput.decode(d);
            } else {
                throw new RuntimeException("Unsupported TransferOutput Type: " + typeId);
            }
            return to;
        }

        @Override
        public String toString() {
            return "AssetID=..." + assetID.substring(58);
        }
    }

    static class SECP256K1TransferOutput {
        long amount;
        long locktime;
        int threshold;
        List<String> addresses;

        static SECP256K1TransferOutput decode(LinearDecoder d) {
            SECP256K1TransferOutput out = new SECP256K1TransferOutput();
            out.amount = d.readLong();
            // Embedded OutputOwners
            out.locktime = d.readLong();
            out.threshold = d.readInt();
            
            long addrLen = d.readInt() & 0xFFFFFFFFL;
            out.addresses = new ArrayList<>();
            for (int i = 0; i < addrLen; i++) {
                out.addresses.add(d.readShortID());
            }
            return out;
        }
    }

    static class Credential {
        List<String> signatures;

        static Credential decode(LinearDecoder d) {
            Credential c = new Credential();
            // Credential has fields? 
            // secp256k1fx.Credential struct: Sigs [][65]byte
            long sigsLen = d.readInt() & 0xFFFFFFFFL;
            c.signatures = new ArrayList<>();
            for (int i = 0; i < sigsLen; i++) {
                byte[] sig = d.readBytes(65);
                c.signatures.add(HexFormat.of().formatHex(sig));
            }
            return c;
        }
    }
}

