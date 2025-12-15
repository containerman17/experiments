package io.avalanche.atomic.demo;

import io.avalanche.atomic.model.AtomicTx;
import io.avalanche.atomic.model.EVMOutput;
import io.avalanche.atomic.parser.ExtDataDecoder;

import java.util.HexFormat;
import java.util.List;

/**
 * Demo showing how to decode BlockExtraData from C-Chain blocks.
 * Uses the production SDK code to parse atomic transactions.
 */
public class BlockExtraDataDemo {
    
    public static void main(String[] args) {
        String hexData;
        if (args.length > 0) {
            hexData = args[0];
            if (hexData.startsWith("0x")) {
                hexData = hexData.substring(2);
            }
        } else {
            // Example from real C-Chain block with ImportTx
            hexData = "00000000000100000001000000010427D4B22A2A78BCDDD456742CAF91B56BADBFF985EE19AEF14573E7343FD652000000000000000000000000000000000000000000000000000000000000000000000001565F0FE9715E3CB0DF579F186C299D6707887E830000000DC7D44F6F21E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF0000000000025FCD0000000121E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF000000070000000DC7D42391000000000000000000000001000000015CF998275803A7277926912DEFDF177B2E97B0B4000000010000000900000001C1B39952DF371D6AC3CB7615630DC279DEC7A471C1C355738C0FA087B41FD5C317AC85D312B4DC01C9B37513BCAC98465CF7A834F8A291536AAB1C6403D29D1B01";
        }
        
        try {
            byte[] data = HexFormat.of().parseHex(hexData);
            
            System.out.println("=".repeat(70));
            System.out.println("Avalanche C-Chain BlockExtraData Decoder");
            System.out.println("=".repeat(70));
            System.out.println();
            System.out.println("ExtData length: " + data.length + " bytes");
            System.out.println();
            
            // Use the SDK to decode
            ExtDataDecoder decoder = new ExtDataDecoder();
            List<AtomicTx> transactions = decoder.parseAtomicTransactions(data);
            
            System.out.println("Found " + transactions.size() + " atomic transaction(s)");
            System.out.println();
            
            for (int i = 0; i < transactions.size(); i++) {
                AtomicTx tx = transactions.get(i);
                
                System.out.println("─".repeat(70));
                System.out.println("Transaction " + i);
                System.out.println("─".repeat(70));
                System.out.println("Type: " + tx.getType());
                System.out.println("ID: " + formatHex(tx.getTxId()));
                System.out.println("Credentials: " + tx.getCredentials().size());
                System.out.println();
                
                if (tx.isImportTx()) {
                    printImportTx(tx);
                } else if (tx.isExportTx()) {
                    printExportTx(tx);
                }
                
                System.out.println();
            }
            
            System.out.println("=".repeat(70));
            
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            e.printStackTrace();
        }
    }
    
    private static void printImportTx(AtomicTx tx) {
        var importTx = tx.getImportTx();
        
        System.out.println("NetworkID: " + importTx.getNetworkId());
        System.out.println("BlockchainID: " + formatHex(importTx.getBlockchainId()));
        System.out.println("SourceChain: " + formatHex(importTx.getSourceChain()));
        System.out.println();
        
        System.out.println("Imported Inputs: " + importTx.getImportedInputs().size());
        for (int i = 0; i < importTx.getImportedInputs().size(); i++) {
            var input = importTx.getImportedInputs().get(i);
            System.out.println("  [" + i + "] UTXO: " + formatHex(input.getTxId()) + ":" + input.getOutputIndex());
            System.out.println("      AssetID: " + formatHex(input.getAssetId()));
            System.out.println("      Amount: " + input.getAmount() + " nAVAX");
            System.out.print("      SigIndices: [");
            for (int idx : input.getSigIndices()) {
                System.out.print(idx + " ");
            }
            System.out.println("]");
        }
        System.out.println();
        
        System.out.println("EVM Outputs: " + importTx.getOuts().size());
        for (int i = 0; i < importTx.getOuts().size(); i++) {
            EVMOutput out = importTx.getOuts().get(i);
            System.out.println("  [" + i + "] Address: " + formatHex(out.getAddress()));
            System.out.println("      Amount: " + out.getAmount() + " nAVAX");
            System.out.println("      AssetID: " + formatHex(out.getAssetId()));
        }
    }
    
    private static void printExportTx(AtomicTx tx) {
        var exportTx = tx.getExportTx();
        
        System.out.println("NetworkID: " + exportTx.getNetworkId());
        System.out.println("BlockchainID: " + formatHex(exportTx.getBlockchainId()));
        System.out.println("DestinationChain: " + formatHex(exportTx.getDestinationChain()));
        System.out.println();
        
        System.out.println("EVM Inputs: " + exportTx.getIns().size());
        for (int i = 0; i < exportTx.getIns().size(); i++) {
            var input = exportTx.getIns().get(i);
            System.out.println("  [" + i + "] Address: " + formatHex(input.getAddress()));
            System.out.println("      Amount: " + input.getAmount() + " nAVAX");
            System.out.println("      AssetID: " + formatHex(input.getAssetId()));
            System.out.println("      Nonce: " + input.getNonce());
        }
        System.out.println();
        
        System.out.println("Exported Outputs: " + exportTx.getExportedOutputs().size());
        for (int i = 0; i < exportTx.getExportedOutputs().size(); i++) {
            var out = exportTx.getExportedOutputs().get(i);
            System.out.println("  [" + i + "] AssetID: " + formatHex(out.getAssetId()));
            System.out.println("      Amount: " + out.getAmount() + " nAVAX");
            System.out.println("      Locktime: " + out.getLocktime());
            System.out.println("      Threshold: " + out.getThreshold());
            System.out.println("      Addresses: " + out.getAddresses().size());
            for (byte[] addr : out.getAddresses()) {
                System.out.println("        - " + formatHex(addr));
            }
        }
    }
    
    private static String formatHex(byte[] bytes) {
        return "0x" + HexFormat.of().formatHex(bytes);
    }
}

