import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Test BlockExtraDataDemo against fixtures generated from Go reference implementation.
 * 
 * Usage: java -cp .:jackson-databind.jar:jackson-core.jar:jackson-annotations.jar BlockExtraDataTest
 * Or if using Maven/Gradle with web3j dependency, Jackson is already available.
 */
public class BlockExtraDataTest {

    private static final ObjectMapper mapper = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        JsonNode fixtures = mapper.readTree(new File("test_fixtures.json"));
        
        int passed = 0;
        int failed = 0;
        List<String> failures = new ArrayList<>();

        for (JsonNode fixture : fixtures) {
            String blockNumber = fixture.get("blockNumber").asText();
            String hexData = fixture.get("hexData").asText();
            JsonNode expected = fixture.get("expected");

            try {
                boolean ok = testFixture(blockNumber, hexData, expected);
                if (ok) {
                    passed++;
                } else {
                    failed++;
                    failures.add(blockNumber);
                }
            } catch (Exception e) {
                failed++;
                failures.add(blockNumber + " (exception: " + e.getMessage() + ")");
            }

            if ((passed + failed) % 10 == 0) {
                System.out.printf("Progress: %d/%d\n", passed + failed, fixtures.size());
            }
        }

        System.out.println("\n=== Results ===");
        System.out.printf("Passed: %d/%d\n", passed, passed + failed);
        
        if (!failures.isEmpty()) {
            System.out.println("\nFailed blocks:");
            for (String f : failures) {
                System.out.println("  - " + f);
            }
            System.exit(1);
        }
        
        System.out.println("\nAll tests passed!");
    }

    private static boolean testFixture(String blockNumber, String hexData, JsonNode expected) {
        // Decode using BlockExtraDataDemo
        if (hexData.startsWith("0x")) {
            hexData = hexData.substring(2);
        }
        byte[] data = hexStringToBytes(hexData);
        List<BlockExtraDataDemo.Tx> txs = BlockExtraDataDemo.decode(data);

        // Compare data length
        int expectedLength = expected.get("dataLength").asInt();
        if (data.length != expectedLength) {
            System.err.printf("Block %s: data length mismatch: got %d, expected %d\n", 
                blockNumber, data.length, expectedLength);
            return false;
        }

        // Compare tx count
        int expectedTxCount = expected.get("txCount").asInt();
        if (txs.size() != expectedTxCount) {
            System.err.printf("Block %s: tx count mismatch: got %d, expected %d\n", 
                blockNumber, txs.size(), expectedTxCount);
            return false;
        }

        // Compare each transaction
        JsonNode expectedTxs = expected.get("transactions");
        for (int i = 0; i < txs.size(); i++) {
            BlockExtraDataDemo.Tx tx = txs.get(i);
            JsonNode expectedTx = expectedTxs.get(i);

            if (!compareTx(blockNumber, i, tx, expectedTx)) {
                return false;
            }
        }

        return true;
    }

    private static boolean compareTx(String blockNumber, int txIndex, 
            BlockExtraDataDemo.Tx tx, JsonNode expected) {
        
        // Compare ID
        String expectedId = expected.get("id").asText();
        if (!tx.transactionID.equals(expectedId)) {
            System.err.printf("Block %s tx %d: ID mismatch\n  got:      %s\n  expected: %s\n", 
                blockNumber, txIndex, tx.transactionID, expectedId);
            return false;
        }

        // Compare type
        String expectedType = expected.get("type").asText();
        String actualType = tx.unsignedTx.getTypeName();
        if (!actualType.equals(expectedType)) {
            System.err.printf("Block %s tx %d: type mismatch: got %s, expected %s\n", 
                blockNumber, txIndex, actualType, expectedType);
            return false;
        }

        // Compare based on type
        if (tx.unsignedTx instanceof BlockExtraDataDemo.UnsignedImportTx) {
            return compareImportTx(blockNumber, txIndex, 
                (BlockExtraDataDemo.UnsignedImportTx) tx.unsignedTx, expected);
        } else if (tx.unsignedTx instanceof BlockExtraDataDemo.UnsignedExportTx) {
            return compareExportTx(blockNumber, txIndex, 
                (BlockExtraDataDemo.UnsignedExportTx) tx.unsignedTx, expected);
        }

        return true;
    }

    private static boolean compareImportTx(String blockNumber, int txIndex,
            BlockExtraDataDemo.UnsignedImportTx tx, JsonNode expected) {
        
        // NetworkID
        long expectedNetworkId = expected.get("networkId").asLong();
        if (Integer.toUnsignedLong(tx.networkID) != expectedNetworkId) {
            System.err.printf("Block %s tx %d: networkId mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, Integer.toUnsignedLong(tx.networkID), expectedNetworkId);
            return false;
        }

        // BlockchainID
        String expectedBlockchainId = expected.get("blockchainId").asText();
        String actualBlockchainId = "0x" + tx.blockchainID;
        if (!actualBlockchainId.equals(expectedBlockchainId)) {
            System.err.printf("Block %s tx %d: blockchainId mismatch\n", blockNumber, txIndex);
            return false;
        }

        // SourceChain
        String expectedSourceChain = expected.get("sourceChain").asText();
        String actualSourceChain = "0x" + tx.sourceChain;
        if (!actualSourceChain.equals(expectedSourceChain)) {
            System.err.printf("Block %s tx %d: sourceChain mismatch\n", blockNumber, txIndex);
            return false;
        }

        // Inputs
        JsonNode expectedInputs = expected.get("inputs");
        if (tx.importedInputs.size() != expectedInputs.size()) {
            System.err.printf("Block %s tx %d: input count mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, tx.importedInputs.size(), expectedInputs.size());
            return false;
        }

        for (int i = 0; i < tx.importedInputs.size(); i++) {
            BlockExtraDataDemo.TransferableInput input = tx.importedInputs.get(i);
            JsonNode expectedInput = expectedInputs.get(i);

            String expectedUtxoTxId = expectedInput.get("utxoTxId").asText();
            String actualUtxoTxId = "0x" + input.txID;
            if (!actualUtxoTxId.equals(expectedUtxoTxId)) {
                System.err.printf("Block %s tx %d input %d: utxoTxId mismatch\n", blockNumber, txIndex, i);
                return false;
            }

            String expectedAssetId = expectedInput.get("assetId").asText();
            String actualAssetId = "0x" + input.assetID;
            if (!actualAssetId.equals(expectedAssetId)) {
                System.err.printf("Block %s tx %d input %d: assetId mismatch\n", blockNumber, txIndex, i);
                return false;
            }

            // Check input amount (nested in SECP256K1TransferInput)
            long expectedAmount = expectedInput.get("amount").asLong();
            if (input.input.amount != expectedAmount) {
                System.err.printf("Block %s tx %d input %d: amount mismatch: got %d, expected %d\n", 
                    blockNumber, txIndex, i, input.input.amount, expectedAmount);
                return false;
            }
        }

        // Outputs
        JsonNode expectedOutputs = expected.get("outputs");
        if (tx.outs.size() != expectedOutputs.size()) {
            System.err.printf("Block %s tx %d: output count mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, tx.outs.size(), expectedOutputs.size());
            return false;
        }

        for (int i = 0; i < tx.outs.size(); i++) {
            BlockExtraDataDemo.EVMOutput output = tx.outs.get(i);
            JsonNode expectedOutput = expectedOutputs.get(i);

            String expectedAddress = expectedOutput.get("address").asText();
            if (!output.address.equals(expectedAddress)) {
                System.err.printf("Block %s tx %d output %d: address mismatch: got %s, expected %s\n", 
                    blockNumber, txIndex, i, output.address, expectedAddress);
                return false;
            }

            long expectedAmount = expectedOutput.get("amount").asLong();
            if (output.amount != expectedAmount) {
                System.err.printf("Block %s tx %d output %d: amount mismatch: got %d, expected %d\n", 
                    blockNumber, txIndex, i, output.amount, expectedAmount);
                return false;
            }

            String expectedAssetId = expectedOutput.get("assetId").asText();
            String actualAssetId = "0x" + output.assetID;
            if (!actualAssetId.equals(expectedAssetId)) {
                System.err.printf("Block %s tx %d output %d: assetId mismatch\n", blockNumber, txIndex, i);
                return false;
            }
        }

        return true;
    }

    private static boolean compareExportTx(String blockNumber, int txIndex,
            BlockExtraDataDemo.UnsignedExportTx tx, JsonNode expected) {
        
        // NetworkID
        long expectedNetworkId = expected.get("networkId").asLong();
        if (Integer.toUnsignedLong(tx.networkID) != expectedNetworkId) {
            System.err.printf("Block %s tx %d: networkId mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, Integer.toUnsignedLong(tx.networkID), expectedNetworkId);
            return false;
        }

        // BlockchainID
        String expectedBlockchainId = expected.get("blockchainId").asText();
        String actualBlockchainId = "0x" + tx.blockchainID;
        if (!actualBlockchainId.equals(expectedBlockchainId)) {
            System.err.printf("Block %s tx %d: blockchainId mismatch\n", blockNumber, txIndex);
            return false;
        }

        // DestinationChain
        String expectedDestChain = expected.get("destinationChain").asText();
        String actualDestChain = "0x" + tx.destinationChain;
        if (!actualDestChain.equals(expectedDestChain)) {
            System.err.printf("Block %s tx %d: destinationChain mismatch\n", blockNumber, txIndex);
            return false;
        }

        // Inputs (EVMInput for ExportTx)
        JsonNode expectedInputs = expected.get("inputs");
        if (tx.ins.size() != expectedInputs.size()) {
            System.err.printf("Block %s tx %d: input count mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, tx.ins.size(), expectedInputs.size());
            return false;
        }

        for (int i = 0; i < tx.ins.size(); i++) {
            BlockExtraDataDemo.EVMInput input = tx.ins.get(i);
            JsonNode expectedInput = expectedInputs.get(i);

            String expectedAddress = expectedInput.get("address").asText();
            if (!input.address.equals(expectedAddress)) {
                System.err.printf("Block %s tx %d input %d: address mismatch: got %s, expected %s\n", 
                    blockNumber, txIndex, i, input.address, expectedAddress);
                return false;
            }

            long expectedAmount = expectedInput.get("amount").asLong();
            if (input.amount != expectedAmount) {
                System.err.printf("Block %s tx %d input %d: amount mismatch: got %d, expected %d\n", 
                    blockNumber, txIndex, i, input.amount, expectedAmount);
                return false;
            }

            String expectedAssetId = expectedInput.get("assetId").asText();
            String actualAssetId = "0x" + input.assetID;
            if (!actualAssetId.equals(expectedAssetId)) {
                System.err.printf("Block %s tx %d input %d: assetId mismatch\n", blockNumber, txIndex, i);
                return false;
            }

            long expectedNonce = expectedInput.get("nonce").asLong();
            if (input.nonce != expectedNonce) {
                System.err.printf("Block %s tx %d input %d: nonce mismatch: got %d, expected %d\n", 
                    blockNumber, txIndex, i, input.nonce, expectedNonce);
                return false;
            }
        }

        // Outputs (TransferableOutput for ExportTx)
        JsonNode expectedOutputs = expected.get("outputs");
        if (tx.exportedOutputs.size() != expectedOutputs.size()) {
            System.err.printf("Block %s tx %d: output count mismatch: got %d, expected %d\n", 
                blockNumber, txIndex, tx.exportedOutputs.size(), expectedOutputs.size());
            return false;
        }

        for (int i = 0; i < tx.exportedOutputs.size(); i++) {
            BlockExtraDataDemo.TransferableOutput output = tx.exportedOutputs.get(i);
            JsonNode expectedOutput = expectedOutputs.get(i);

            String expectedAssetId = expectedOutput.get("assetId").asText();
            String actualAssetId = "0x" + output.assetID;
            if (!actualAssetId.equals(expectedAssetId)) {
                System.err.printf("Block %s tx %d output %d: assetId mismatch\n", blockNumber, txIndex, i);
                return false;
            }

            // Check output amount (nested in SECP256K1TransferOutput)
            long expectedAmount = expectedOutput.get("amount").asLong();
            if (output.output.amount != expectedAmount) {
                System.err.printf("Block %s tx %d output %d: amount mismatch: got %d, expected %d\n", 
                    blockNumber, txIndex, i, output.output.amount, expectedAmount);
                return false;
            }
        }

        return true;
    }

    private static byte[] hexStringToBytes(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
    }
}

