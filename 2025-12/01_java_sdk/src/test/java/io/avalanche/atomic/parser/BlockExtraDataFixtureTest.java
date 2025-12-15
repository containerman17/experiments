package io.avalanche.atomic.parser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.avalanche.atomic.model.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.web3j.utils.Numeric;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration test for BlockExtraData decoding using fixtures generated from Go reference implementation.
 * 
 * Validates that our Java decoder produces identical results to avalanchego for real mainnet data.
 * Uses JSON comparison (like Go tests typically do) instead of field-by-field checks.
 * 
 * Run with: mvn test -Dtest=BlockExtraDataFixtureTest
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class BlockExtraDataFixtureTest {

    private static final ObjectMapper mapper = new ObjectMapper();
    private ExtDataDecoder decoder;
    private JsonNode fixtures;
    
    @BeforeAll
    void setUp() throws Exception {
        decoder = new ExtDataDecoder();
        
        InputStream is = getClass().getClassLoader().getResourceAsStream("block_extra_data_fixtures.json");
        if (is == null) {
            throw new RuntimeException("block_extra_data_fixtures.json not found in test resources");
        }
        fixtures = mapper.readTree(is);
    }
    
    @Test
    void testAllFixtures() {
        int passed = 0;
        int failed = 0;
        List<String> failures = new ArrayList<>();
        
        for (JsonNode fixture : fixtures) {
            String blockNumber = fixture.get("blockNumber").asText();
            String hexData = fixture.get("hexData").asText();
            JsonNode expected = fixture.get("expected");
            
            try {
                // Decode
                byte[] data = Numeric.hexStringToByteArray(hexData);
                List<AtomicTx> txs = decoder.parseAtomicTransactions(data);
                
                // Convert to JSON
                JsonNode actual = toJson(data.length, txs);
                
                // Compare as normalized strings (avoids Jackson type/ordering quirks)
                String expectedStr = mapper.writeValueAsString(expected);
                String actualStr = mapper.writeValueAsString(actual);
                
                if (expectedStr.equals(actualStr)) {
                    passed++;
                } else {
                    failed++;
                    failures.add(blockNumber);
                    System.err.printf("Block %s: JSON mismatch\nExpected: %s\nActual:   %s\n\n",
                        blockNumber, expectedStr, actualStr);
                }
            } catch (Exception e) {
                failed++;
                failures.add(blockNumber + " (exception: " + e.getMessage() + ")");
            }
            
            if ((passed + failed) % 100 == 0) {
                System.out.printf("Progress: %d/%d\n", passed + failed, fixtures.size());
            }
        }
        
        System.out.printf("\n=== Results ===\nPassed: %d/%d\n", passed, passed + failed);
        
        if (!failures.isEmpty()) {
            System.out.println("\nFailed blocks:");
            for (String f : failures) {
                System.out.println("  - " + f);
            }
        }
        
        assertEquals(0, failed, failed + " fixtures failed out of " + (passed + failed));
    }
    
    /**
     * Convert decoded transactions to JSON matching fixture format.
     */
    private JsonNode toJson(int dataLength, List<AtomicTx> txs) {
        ObjectNode root = mapper.createObjectNode();
        root.put("dataLength", dataLength);
        root.put("txCount", txs.size());
        
        ArrayNode txArray = mapper.createArrayNode();
        for (int i = 0; i < txs.size(); i++) {
            txArray.add(txToJson(i, txs.get(i)));
        }
        root.set("transactions", txArray);
        
        return root;
    }
    
    private JsonNode txToJson(int index, AtomicTx tx) {
        ObjectNode node = mapper.createObjectNode();
        node.put("index", index);
        node.put("id", Numeric.toHexString(tx.getTxId()).toLowerCase());
        node.put("type", tx.isImportTx() ? "ImportTx" : "ExportTx");
        
        // Add type-specific fields (networkId, blockchainId, chain, inputs, outputs)
        if (tx.isImportTx()) {
            importTxToJson(node, tx.getImportTx());
        } else {
            exportTxToJson(node, tx.getExportTx());
        }
        
        // credentialCount comes last in fixture format
        node.put("credentialCount", tx.getCredentials().size());
        
        return node;
    }
    
    private void importTxToJson(ObjectNode node, UnsignedImportTx tx) {
        node.put("networkId", Integer.toUnsignedLong(tx.getNetworkId()));
        node.put("blockchainId", Numeric.toHexString(tx.getBlockchainId()).toLowerCase());
        node.put("sourceChain", Numeric.toHexString(tx.getSourceChain()).toLowerCase());
        
        // Inputs (TransferableInput)
        ArrayNode inputs = mapper.createArrayNode();
        for (int i = 0; i < tx.getImportedInputs().size(); i++) {
            TransferableInput input = tx.getImportedInputs().get(i);
            ObjectNode inputNode = mapper.createObjectNode();
            inputNode.put("index", i);
            inputNode.put("utxoTxId", Numeric.toHexString(input.getTxId()).toLowerCase());
            inputNode.put("utxoIndex", input.getOutputIndex());
            inputNode.put("amount", input.getAmount());
            inputNode.put("assetId", Numeric.toHexString(input.getAssetId()).toLowerCase());
            inputs.add(inputNode);
        }
        node.set("inputs", inputs);
        
        // Outputs (EVMOutput)
        ArrayNode outputs = mapper.createArrayNode();
        for (int i = 0; i < tx.getOuts().size(); i++) {
            EVMOutput output = tx.getOuts().get(i);
            ObjectNode outputNode = mapper.createObjectNode();
            outputNode.put("index", i);
            outputNode.put("address", Numeric.toHexString(output.getAddress()).toLowerCase());
            outputNode.put("amount", output.getAmount());
            outputNode.put("assetId", Numeric.toHexString(output.getAssetId()).toLowerCase());
            outputs.add(outputNode);
        }
        node.set("outputs", outputs);
    }
    
    private void exportTxToJson(ObjectNode node, UnsignedExportTx tx) {
        node.put("networkId", Integer.toUnsignedLong(tx.getNetworkId()));
        node.put("blockchainId", Numeric.toHexString(tx.getBlockchainId()).toLowerCase());
        node.put("destinationChain", Numeric.toHexString(tx.getDestinationChain()).toLowerCase());
        
        // Inputs (EVMInput)
        ArrayNode inputs = mapper.createArrayNode();
        for (int i = 0; i < tx.getIns().size(); i++) {
            EVMInput input = tx.getIns().get(i);
            ObjectNode inputNode = mapper.createObjectNode();
            inputNode.put("index", i);
            inputNode.put("address", Numeric.toHexString(input.getAddress()).toLowerCase());
            inputNode.put("amount", input.getAmount());
            inputNode.put("assetId", Numeric.toHexString(input.getAssetId()).toLowerCase());
            inputNode.put("nonce", input.getNonce());
            inputs.add(inputNode);
        }
        node.set("inputs", inputs);
        
        // Outputs (TransferableOutput)
        ArrayNode outputs = mapper.createArrayNode();
        for (int i = 0; i < tx.getExportedOutputs().size(); i++) {
            TransferableOutput output = tx.getExportedOutputs().get(i);
            ObjectNode outputNode = mapper.createObjectNode();
            outputNode.put("index", i);
            outputNode.put("amount", output.getAmount());
            outputNode.put("assetId", Numeric.toHexString(output.getAssetId()).toLowerCase());
            outputs.add(outputNode);
        }
        node.set("outputs", outputs);
    }
}
