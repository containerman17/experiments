package io.avalanche.atomic.rpc;

import io.avalanche.atomic.model.UTXO;
import org.web3j.utils.Numeric;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RPC client for Avalanche-specific endpoints.
 * 
 * Handles calls to /ext/bc/C/avax for atomic operations:
 * - avax.getUTXOs: Query shared memory UTXOs
 * - avax.issueTx: Submit atomic transactions
 * - avax.getTxStatus: Check transaction status
 */
public class AvalancheRpcClient {
    
    private static final String AVAX_ENDPOINT = "/ext/bc/C/avax";
    private static final Duration TIMEOUT = Duration.ofSeconds(30);
    
    private final String baseUrl;
    private final HttpClient httpClient;
    private final UtxoParser utxoParser;
    private final AtomicInteger requestId;
    
    /**
     * Create RPC client.
     * 
     * @param baseUrl Avalanche node base URL (e.g., "https://api.avax.network" or "https://api.avax-test.network")
     */
    public AvalancheRpcClient(String baseUrl) {
        this.baseUrl = baseUrl != null ? baseUrl.replaceAll("/$", "") : null;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(TIMEOUT)
            .build();
        this.utxoParser = new UtxoParser();
        this.requestId = new AtomicInteger(1);
    }
    
    /**
     * Query UTXOs in shared memory.
     * 
     * @param addresses Bech32 addresses (e.g., "C-avax1..." or "C-fuji1...")
     * @param sourceChain Source chain ID ("P" for P-Chain)
     * @return List of spendable UTXOs
     */
    public List<UTXO> getUTXOs(List<String> addresses, String sourceChain) {
        if (baseUrl == null) {
            throw new IllegalStateException("RPC client created without baseUrl");
        }
        
        // Build addresses array for JSON
        StringBuilder addressesJson = new StringBuilder("[");
        for (int i = 0; i < addresses.size(); i++) {
            if (i > 0) addressesJson.append(",");
            addressesJson.append("\"").append(addresses.get(i)).append("\"");
        }
        addressesJson.append("]");
        
        String requestBody = String.format(
            "{\"jsonrpc\":\"2.0\",\"method\":\"avax.getUTXOs\",\"params\":{\"addresses\":%s,\"sourceChain\":\"%s\",\"encoding\":\"hex\"},\"id\":%d}",
            addressesJson, sourceChain, requestId.getAndIncrement()
        );
        
        String response = doRequest(requestBody);
        return parseUtxosResponse(response);
    }
    
    /**
     * Submit a signed atomic transaction.
     * 
     * @param signedTx Signed transaction bytes
     * @return Transaction ID (CB58 encoded string)
     */
    public String issueTx(byte[] signedTx) {
        if (baseUrl == null) {
            throw new IllegalStateException("RPC client created without baseUrl");
        }
        
        String txHex = Numeric.toHexStringNoPrefix(signedTx);
        
        String requestBody = String.format(
            "{\"jsonrpc\":\"2.0\",\"method\":\"avax.issueTx\",\"params\":{\"tx\":\"0x%s\",\"encoding\":\"hex\"},\"id\":%d}",
            txHex, requestId.getAndIncrement()
        );
        
        String response = doRequest(requestBody);
        return parseTxIdResponse(response);
    }
    
    /**
     * Check status of a submitted transaction.
     * 
     * @param txId Transaction ID (CB58 encoded)
     * @return Status string ("Accepted", "Processing", "Rejected", "Unknown")
     */
    public String getTxStatus(String txId) {
        if (baseUrl == null) {
            throw new IllegalStateException("RPC client created without baseUrl");
        }
        
        String requestBody = String.format(
            "{\"jsonrpc\":\"2.0\",\"method\":\"avax.getTxStatus\",\"params\":{\"txID\":\"%s\"},\"id\":%d}",
            txId, requestId.getAndIncrement()
        );
        
        String response = doRequest(requestBody);
        return parseStatusResponse(response);
    }
    
    /**
     * Execute HTTP request to Avalanche node.
     */
    private String doRequest(String body) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + AVAX_ENDPOINT))
                .header("Content-Type", "application/json")
                .timeout(TIMEOUT)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
            
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            
            if (response.statusCode() != 200) {
                throw new RuntimeException("HTTP error " + response.statusCode() + ": " + response.body());
            }
            
            return response.body();
        } catch (Exception e) {
            throw new RuntimeException("RPC request failed: " + e.getMessage(), e);
        }
    }
    
    /**
     * Parse avax.getUTXOs response.
     * 
     * Response format:
     * {"jsonrpc":"2.0","result":{"numFetched":"1","utxos":["0x..."],"endIndex":{...}},"id":1}
     */
    private List<UTXO> parseUtxosResponse(String response) {
        // Check for error
        if (response.contains("\"error\"")) {
            String errorMsg = extractJsonValue(response, "message");
            throw new RuntimeException("RPC error: " + (errorMsg != null ? errorMsg : response));
        }
        
        // Extract utxos array - simple regex approach (no external JSON library needed)
        Pattern utxosPattern = Pattern.compile("\"utxos\"\\s*:\\s*\\[(.*?)\\]", Pattern.DOTALL);
        Matcher matcher = utxosPattern.matcher(response);
        
        if (!matcher.find()) {
            // No UTXOs found or empty result
            return new ArrayList<>();
        }
        
        String utxosContent = matcher.group(1).trim();
        if (utxosContent.isEmpty()) {
            return new ArrayList<>();
        }
        
        // Parse individual hex strings
        List<String> hexUtxos = new ArrayList<>();
        Pattern hexPattern = Pattern.compile("\"(0x[0-9a-fA-F]+)\"");
        Matcher hexMatcher = hexPattern.matcher(utxosContent);
        
        while (hexMatcher.find()) {
            hexUtxos.add(hexMatcher.group(1));
        }
        
        return utxoParser.parseUtxos(hexUtxos);
    }
    
    /**
     * Parse avax.issueTx response.
     * 
     * Response format:
     * {"jsonrpc":"2.0","result":{"txID":"2QouvFWUbjuySRxeX5xMbNCuAaKWfbk5FeEa2JmoF85RKLnC8"},"id":1}
     */
    private String parseTxIdResponse(String response) {
        // Check for error
        if (response.contains("\"error\"")) {
            String errorMsg = extractJsonValue(response, "message");
            throw new RuntimeException("RPC error: " + (errorMsg != null ? errorMsg : response));
        }
        
        String txId = extractJsonValue(response, "txID");
        if (txId == null) {
            throw new RuntimeException("Failed to parse txID from response: " + response);
        }
        
        return txId;
    }
    
    /**
     * Parse avax.getTxStatus response.
     * 
     * Response format:
     * {"jsonrpc":"2.0","result":{"status":"Accepted"},"id":1}
     */
    private String parseStatusResponse(String response) {
        // Check for error
        if (response.contains("\"error\"")) {
            String errorMsg = extractJsonValue(response, "message");
            throw new RuntimeException("RPC error: " + (errorMsg != null ? errorMsg : response));
        }
        
        String status = extractJsonValue(response, "status");
        return status != null ? status : "Unknown";
    }
    
    /**
     * Simple JSON value extraction (avoids external dependency).
     */
    private String extractJsonValue(String json, String key) {
        Pattern pattern = Pattern.compile("\"" + key + "\"\\s*:\\s*\"([^\"]+)\"");
        Matcher matcher = pattern.matcher(json);
        return matcher.find() ? matcher.group(1) : null;
    }
}

