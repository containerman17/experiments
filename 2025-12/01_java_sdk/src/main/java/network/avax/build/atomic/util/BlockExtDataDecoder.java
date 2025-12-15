package network.avax.build.atomic.util;

import network.avax.build.atomic.model.AtomicTx;
import network.avax.build.atomic.model.EVMInput;
import network.avax.build.atomic.model.EVMOutput;
import network.avax.build.atomic.model.TransferableInput;
import network.avax.build.atomic.model.TransferableOutput;
import network.avax.build.atomic.parser.ExtDataDecoder;
import org.web3j.utils.Numeric;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CLI utility to decode atomic transactions from C-Chain block ExtData.
 */
public class BlockExtDataDecoder {
    
    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println("Usage: BlockExtDataDecoder <block_number> <rpc_url>");
            return;
        }
        
        long blockNumber = Long.parseLong(args[0].replace(",", "").replace("_", ""));
        String rpcUrl = args[1];
        
        try {
            byte[] extData = fetchBlockExtraData(blockNumber, rpcUrl);
            
            if (extData == null || extData.length == 0) {
                System.out.println("No atomic transactions in block " + blockNumber);
                return;
            }
            
            ExtDataDecoder decoder = new ExtDataDecoder();
            List<AtomicTx> txs = decoder.parseAtomicTransactions(extData);
            
            System.out.println("Block " + blockNumber + ": " + txs.size() + " atomic tx(s)");
            
            for (int i = 0; i < txs.size(); i++) {
                AtomicTx tx = txs.get(i);
                System.out.println();
                System.out.println("Tx " + (i + 1) + ": " + (tx.isImportTx() ? "ImportTx" : "ExportTx"));
                System.out.println("TxID: " + Numeric.toHexStringNoPrefix(tx.getTxId()));
                
                if (tx.isImportTx()) {
                    printImportTx(tx);
                } else {
                    printExportTx(tx);
                }
            }
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
        }
    }
    
    private static byte[] fetchBlockExtraData(long blockNumber, String rpcUrl) throws Exception {
        HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .build();
        
        String blockHex = "0x" + Long.toHexString(blockNumber);
        String body = String.format(
            "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"%s\",false],\"id\":1}",
            blockHex
        );
        
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(rpcUrl))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        
        Pattern pattern = Pattern.compile("\"blockExtraData\"\\s*:\\s*\"(0x[0-9a-fA-F]*)\"");
        Matcher matcher = pattern.matcher(response.body());
        
        if (matcher.find()) {
            String hex = matcher.group(1);
            if (hex.equals("0x") || hex.isEmpty()) {
                return null;
            }
            return Numeric.hexStringToByteArray(hex);
        }
        return null;
    }
    
    private static void printImportTx(AtomicTx tx) {
        var importTx = tx.getImportTx();
        System.out.println("Source: " + formatChainId(importTx.getSourceChain()));
        
        long totalIn = importTx.getImportedInputs().stream().mapToLong(TransferableInput::getAmount).sum();
        System.out.println("Inputs: " + importTx.getImportedInputs().size() + " (" + formatAvax(totalIn) + ")");
        
        for (EVMOutput out : importTx.getOuts()) {
            System.out.println("  → " + Numeric.toHexString(out.getAddress()) + ": " + formatAvax(out.getAmount()));
        }
    }
    
    private static void printExportTx(AtomicTx tx) {
        var exportTx = tx.getExportTx();
        System.out.println("Destination: " + formatChainId(exportTx.getDestinationChain()));
        
        long totalIn = exportTx.getIns().stream().mapToLong(EVMInput::getAmount).sum();
        long totalOut = exportTx.getExportedOutputs().stream().mapToLong(TransferableOutput::getAmount).sum();
        
        for (EVMInput in : exportTx.getIns()) {
            System.out.println("  ← " + Numeric.toHexString(in.getAddress()) + ": " + formatAvax(in.getAmount()));
        }
        System.out.println("Output: " + formatAvax(totalOut) + ", Fee: " + formatAvax(totalIn - totalOut));
    }
    
    private static String formatChainId(byte[] chainId) {
        for (byte b : chainId) {
            if (b != 0) return Numeric.toHexStringNoPrefix(chainId).substring(0, 8) + "...";
        }
        return "P-Chain";
    }
    
    private static String formatAvax(long nAvax) {
        return String.format("%.6f AVAX", nAvax / 1_000_000_000.0);
    }
}
