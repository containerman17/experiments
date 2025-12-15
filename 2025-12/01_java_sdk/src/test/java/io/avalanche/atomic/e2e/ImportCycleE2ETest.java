package io.avalanche.atomic.e2e;

import io.avalanche.atomic.AvalancheAtomicSDK;
import io.avalanche.atomic.builder.ImportTxBuilder;
import io.avalanche.atomic.constants.AvalancheConstants;
import io.avalanche.atomic.model.UTXO;
import io.avalanche.atomic.rpc.AvalancheRpcClient;
import io.avalanche.atomic.rpc.UtxoParser;
import io.avalanche.atomic.signer.TxSigner;
import io.avalanche.atomic.util.KeyGenerator;
import io.avalanche.atomic.util.WalletInfo;
import org.junit.jupiter.api.*;
import org.web3j.crypto.ECKeyPair;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameterName;
import org.web3j.protocol.http.HttpService;
import org.web3j.utils.Numeric;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/**
 * End-to-End Import Test for P-Chain to C-Chain atomic imports.
 * 
 * PREREQUISITES (Manual Setup Before Running):
 * 1. Generate test wallet using KeyGenerator
 * 2. Fund the P-Chain address with Fuji AVAX (use faucet)
 * 3. Export from P-Chain to C-Chain using wallet.avax.network or Core wallet
 * 4. Set environment variables:
 *    - E2E_PRIVATE_KEY: Private key hex (with or without 0x)
 *    - E2E_BECH32_ADDRESS: C-Chain Bech32 address (C-fuji1...)
 *    - E2E_EVM_ADDRESS: C-Chain EVM address (0x...)
 *    - E2E_EXPECTED_AMOUNT: Expected amount in nAVAX (optional)
 * 
 * Run with: mvn test -Dgroups=e2e
 */
@Tag("e2e")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ImportCycleE2ETest {
    
    // Fuji testnet configuration
    private static final String FUJI_NODE_URL = "https://api.avax-test.network";
    private static final String FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
    private static final int FUJI_NETWORK_ID = 5;
    
    // C-Chain ID for Fuji (CB58: yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp)
    // Decoded to 32 bytes
    private static final byte[] FUJI_C_CHAIN_ID = decodeBase58Check(
        "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp"
    );
    
    // AVAX Asset ID for Fuji (CB58: U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK)
    private static final byte[] FUJI_AVAX_ASSET_ID = decodeBase58Check(
        "U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK"
    );
    
    // Test state shared across test methods
    private String privateKeyHex;
    private String bech32Address;
    private String evmAddress;
    private long expectedAmount;
    
    private AvalancheRpcClient avaxClient;
    private Web3j web3j;
    private ECKeyPair keyPair;
    private WalletInfo walletInfo;
    
    private List<UTXO> utxos;
    private BigInteger baseFee;
    private byte[] unsignedTxBytes;
    private byte[] signedTxBytes;
    private String submittedTxId;
    private BigInteger initialBalance;
    
    @BeforeAll
    void loadConfig() {
        // Load from environment variables
        privateKeyHex = System.getenv("E2E_PRIVATE_KEY");
        bech32Address = System.getenv("E2E_BECH32_ADDRESS");
        evmAddress = System.getenv("E2E_EVM_ADDRESS");
        String expectedAmountStr = System.getenv("E2E_EXPECTED_AMOUNT");
        
        // Validate required env vars
        assertNotNull(privateKeyHex, 
            "E2E_PRIVATE_KEY environment variable not set. " +
            "Generate a test wallet with: java -cp target/classes io.avalanche.atomic.util.KeyGenerator --network fuji");
        assertNotNull(bech32Address, 
            "E2E_BECH32_ADDRESS environment variable not set (e.g., C-fuji1...)");
        assertNotNull(evmAddress, 
            "E2E_EVM_ADDRESS environment variable not set (e.g., 0x...)");
        
        expectedAmount = expectedAmountStr != null ? Long.parseLong(expectedAmountStr) : 0;
        
        // Initialize clients
        avaxClient = new AvalancheRpcClient(FUJI_NODE_URL);
        web3j = Web3j.build(new HttpService(FUJI_RPC_URL));
        
        // Load key pair
        keyPair = ECKeyPair.create(Numeric.toBigInt(privateKeyHex));
        walletInfo = KeyGenerator.fromPrivateKey(privateKeyHex, "fuji");
        
        System.out.println("=== E2E Test Configuration ===");
        System.out.println("Network: Fuji Testnet");
        System.out.println("Bech32 Address: " + bech32Address);
        System.out.println("EVM Address: " + evmAddress);
        System.out.println("Expected Amount: " + (expectedAmount > 0 ? expectedAmount + " nAVAX" : "any"));
        System.out.println("==============================");
    }
    
    @AfterAll
    void cleanup() {
        if (web3j != null) {
            web3j.shutdown();
        }
    }
    
    // =========================================================================
    // Step 1: Query Pending UTXOs
    // =========================================================================
    
    @Test
    @Order(1)
    @DisplayName("Step 1: Query pending UTXOs from shared memory")
    void step1_queryPendingUtxos() {
        System.out.println("\n=== Step 1: Query Pending UTXOs ===");
        
        utxos = avaxClient.getUTXOs(List.of(bech32Address), "P");
        
        assertFalse(utxos.isEmpty(), 
            "No UTXOs found! Make sure you have:\n" +
            "1. Exported AVAX from P-Chain to C-Chain\n" +
            "2. Used the correct C-Chain Bech32 address: " + bech32Address + "\n" +
            "3. Waited 1-2 minutes for cross-chain propagation");
        
        System.out.println("Found " + utxos.size() + " UTXO(s)");
        
        long totalAmount = 0;
        for (int i = 0; i < utxos.size(); i++) {
            UTXO utxo = utxos.get(i);
            System.out.printf("  UTXO %d: %d nAVAX (%.6f AVAX)%n", 
                i + 1, utxo.getAmount(), utxo.getAmount() / 1e9);
            totalAmount += utxo.getAmount();
        }
        System.out.printf("Total: %d nAVAX (%.6f AVAX)%n", totalAmount, totalAmount / 1e9);
        
        if (expectedAmount > 0) {
            assertEquals(expectedAmount, totalAmount, 
                "Total UTXO amount doesn't match expected");
        }
    }
    
    // =========================================================================
    // Step 2: Parse UTXOs
    // =========================================================================
    
    @Test
    @Order(2)
    @DisplayName("Step 2: Validate parsed UTXO structure")
    void step2_parseUtxos() {
        System.out.println("\n=== Step 2: Validate UTXOs ===");
        
        assertNotNull(utxos, "UTXOs not loaded - run step 1 first");
        
        for (int i = 0; i < utxos.size(); i++) {
            UTXO utxo = utxos.get(i);
            
            // Validate structure
            assertEquals(32, utxo.getTxId().length, "TxId must be 32 bytes");
            assertEquals(32, utxo.getAssetId().length, "AssetId must be 32 bytes");
            assertEquals(20, utxo.getAddress().length, "Address must be 20 bytes");
            assertTrue(utxo.getAmount() > 0, "Amount must be positive");
            assertTrue(utxo.getOutputIndex() >= 0, "OutputIndex must be non-negative");
            
            // Verify asset is AVAX
            assertArrayEquals(FUJI_AVAX_ASSET_ID, utxo.getAssetId(),
                "UTXO asset is not AVAX - only AVAX imports are supported on Fuji");
            
            System.out.printf("UTXO %d: Valid ✓%n", i + 1);
            System.out.printf("  TxId: %s%n", Numeric.toHexString(utxo.getTxId()));
            System.out.printf("  OutputIndex: %d%n", utxo.getOutputIndex());
            System.out.printf("  Amount: %d nAVAX%n", utxo.getAmount());
        }
    }
    
    // =========================================================================
    // Step 3: Get Current Base Fee
    // =========================================================================
    
    @Test
    @Order(3)
    @DisplayName("Step 3: Get current base fee from C-Chain")
    void step3_getBaseFee() throws Exception {
        System.out.println("\n=== Step 3: Get Base Fee ===");
        
        // Use custom RPC call for eth_baseFee (not in standard web3j)
        baseFee = getBaseFeeFromRpc();
        
        assertNotNull(baseFee, "Failed to get base fee");
        assertTrue(baseFee.compareTo(BigInteger.ZERO) > 0, "Base fee must be positive");
        
        // Sanity check: should be in reasonable range (1-1000 GWei)
        BigInteger oneGwei = BigInteger.valueOf(1_000_000_000L);
        BigInteger thousandGwei = BigInteger.valueOf(1000L).multiply(oneGwei);
        
        assertTrue(baseFee.compareTo(oneGwei) >= 0, 
            "Base fee suspiciously low: " + baseFee);
        assertTrue(baseFee.compareTo(thousandGwei) <= 0, 
            "Base fee suspiciously high: " + baseFee);
        
        System.out.printf("Base Fee: %s wei (%.2f GWei)%n", 
            baseFee, baseFee.doubleValue() / 1e9);
    }
    
    // =========================================================================
    // Step 4: Build Unsigned ImportTx
    // =========================================================================
    
    @Test
    @Order(4)
    @DisplayName("Step 4: Build unsigned ImportTx")
    void step4_buildImportTx() {
        System.out.println("\n=== Step 4: Build ImportTx ===");
        
        assertNotNull(utxos, "UTXOs not loaded");
        assertNotNull(baseFee, "Base fee not loaded");
        
        byte[] evmAddressBytes = Numeric.hexStringToByteArray(evmAddress);
        assertEquals(20, evmAddressBytes.length, "EVM address must be 20 bytes");
        
        ImportTxBuilder builder = new ImportTxBuilder();
        
        unsignedTxBytes = builder.buildImportTx(
            FUJI_NETWORK_ID,
            FUJI_C_CHAIN_ID,
            AvalancheConstants.P_CHAIN_ID,  // Source chain (all zeros)
            utxos,
            evmAddressBytes,
            FUJI_AVAX_ASSET_ID,
            baseFee
        );
        
        assertNotNull(unsignedTxBytes, "Failed to build transaction");
        assertTrue(unsignedTxBytes.length > 0, "Transaction bytes empty");
        
        System.out.println("Unsigned tx size: " + unsignedTxBytes.length + " bytes");
        System.out.println("Unsigned tx hex: " + Numeric.toHexString(unsignedTxBytes));
        
        // Calculate and display fee
        long totalInput = utxos.stream().mapToLong(UTXO::getAmount).sum();
        // Fee is deducted from output, so output = totalInput - fee
        // We can estimate from gas calculation
        long gas = unsignedTxBytes.length * AvalancheConstants.TX_BYTES_GAS
                 + utxos.size() * AvalancheConstants.SECP256K1_FX_COST_PER_SIG
                 + AvalancheConstants.ATOMIC_TX_INTRINSIC_GAS;
        long feeEstimate = ceilDiv(gas * baseFee.longValue(), AvalancheConstants.X2C_RATE);
        
        System.out.printf("Estimated gas: %d%n", gas);
        System.out.printf("Estimated fee: %d nAVAX (%.6f AVAX)%n", feeEstimate, feeEstimate / 1e9);
        System.out.printf("Expected output: %d nAVAX (%.6f AVAX)%n", 
            totalInput - feeEstimate, (totalInput - feeEstimate) / 1e9);
    }
    
    // =========================================================================
    // Step 5: Sign Transaction
    // =========================================================================
    
    @Test
    @Order(5)
    @DisplayName("Step 5: Sign transaction")
    void step5_signTransaction() {
        System.out.println("\n=== Step 5: Sign Transaction ===");
        
        assertNotNull(unsignedTxBytes, "Unsigned tx not built");
        
        TxSigner signer = new TxSigner();
        
        // One key per input (all UTXOs owned by same key)
        List<ECKeyPair> keyPairs = utxos.stream()
            .map(utxo -> keyPair)
            .toList();
        
        signedTxBytes = signer.signImportTx(unsignedTxBytes, keyPairs);
        
        assertNotNull(signedTxBytes, "Failed to sign transaction");
        assertTrue(signedTxBytes.length > unsignedTxBytes.length, 
            "Signed tx should be larger than unsigned");
        
        System.out.println("Signed tx size: " + signedTxBytes.length + " bytes");
        System.out.println("Signed tx hex: " + Numeric.toHexString(signedTxBytes));
        
        // Verify signature format
        // Credentials start after unsigned tx
        // Each credential: typeID (4) + sigsLen (4) + sig (65)
        int expectedCredsSize = 4 + (utxos.size() * (4 + 4 + 65)); // creds length + each cred
        int actualCredsSize = signedTxBytes.length - unsignedTxBytes.length;
        
        System.out.printf("Credentials size: %d bytes (expected ~%d)%n", 
            actualCredsSize, expectedCredsSize);
        
        // Verify signature v values are in [0,3]
        // Signatures are at the end of the signed tx
        for (int i = 0; i < utxos.size(); i++) {
            // Each signature is 65 bytes, v is at position 64
            int sigStart = signedTxBytes.length - (utxos.size() - i) * 65;
            byte v = signedTxBytes[sigStart + 64];
            assertTrue(v >= 0 && v <= 3, 
                "Signature " + i + " has invalid v value: " + v + " (expected 0-3)");
            System.out.printf("Signature %d: v=%d ✓%n", i + 1, v);
        }
    }
    
    // =========================================================================
    // Step 6: Submit Transaction
    // =========================================================================
    
    @Test
    @Order(6)
    @DisplayName("Step 6: Submit transaction to network")
    void step6_submitTransaction() throws Exception {
        System.out.println("\n=== Step 6: Submit Transaction ===");
        
        assertNotNull(signedTxBytes, "Signed tx not created");
        
        // Record initial balance before import
        initialBalance = web3j.ethGetBalance(evmAddress, DefaultBlockParameterName.LATEST)
            .send().getBalance();
        System.out.printf("Initial EVM balance: %s wei (%.6f AVAX)%n", 
            initialBalance, initialBalance.doubleValue() / 1e18);
        
        // Submit transaction
        submittedTxId = avaxClient.issueTx(signedTxBytes);
        
        assertNotNull(submittedTxId, "Transaction submission failed");
        assertFalse(submittedTxId.isEmpty(), "Empty transaction ID returned");
        
        System.out.println("Transaction submitted successfully!");
        System.out.println("TxID: " + submittedTxId);
        System.out.println("View on explorer: https://testnet.snowtrace.io/tx/" + submittedTxId);
    }
    
    // =========================================================================
    // Step 7: Wait for Acceptance
    // =========================================================================
    
    @Test
    @Order(7)
    @DisplayName("Step 7: Wait for transaction acceptance")
    void step7_waitForAcceptance() throws Exception {
        System.out.println("\n=== Step 7: Wait for Acceptance ===");
        
        assertNotNull(submittedTxId, "No transaction submitted");
        
        int maxAttempts = 30;  // 60 seconds with 2-second intervals
        int pollIntervalMs = 2000;
        
        String status = "Unknown";
        
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            status = avaxClient.getTxStatus(submittedTxId);
            System.out.printf("Attempt %d/%d: Status = %s%n", attempt, maxAttempts, status);
            
            if ("Accepted".equals(status)) {
                System.out.println("✓ Transaction accepted!");
                return;
            }
            
            if ("Rejected".equals(status)) {
                fail("Transaction was rejected by the network");
            }
            
            if ("Unknown".equals(status)) {
                fail("Transaction status unknown - may have been dropped");
            }
            
            // Processing - wait and retry
            Thread.sleep(pollIntervalMs);
        }
        
        fail("Transaction did not reach Accepted status within timeout. Last status: " + status);
    }
    
    // =========================================================================
    // Step 8: Verify EVM Balance
    // =========================================================================
    
    @Test
    @Order(8)
    @DisplayName("Step 8: Verify EVM balance increased")
    void step8_verifyEvmBalance() throws Exception {
        System.out.println("\n=== Step 8: Verify EVM Balance ===");
        
        // Wait a moment for state to propagate
        Thread.sleep(2000);
        
        BigInteger finalBalance = web3j.ethGetBalance(evmAddress, DefaultBlockParameterName.LATEST)
            .send().getBalance();
        
        System.out.printf("Initial balance: %s wei (%.6f AVAX)%n", 
            initialBalance, initialBalance.doubleValue() / 1e18);
        System.out.printf("Final balance: %s wei (%.6f AVAX)%n", 
            finalBalance, finalBalance.doubleValue() / 1e18);
        
        BigInteger increase = finalBalance.subtract(initialBalance);
        System.out.printf("Balance increase: %s wei (%.6f AVAX)%n", 
            increase, increase.doubleValue() / 1e18);
        
        assertTrue(increase.compareTo(BigInteger.ZERO) > 0, 
            "EVM balance did not increase after import");
        
        // Verify increase is roughly what we expected (total input - fee)
        long totalInput = utxos.stream().mapToLong(UTXO::getAmount).sum();
        // Convert nAVAX to wei (multiply by 1e9)
        BigInteger expectedMin = BigInteger.valueOf(totalInput)
            .multiply(BigInteger.valueOf(1_000_000_000L))
            .multiply(BigInteger.valueOf(90))  // Allow 10% variance for fee
            .divide(BigInteger.valueOf(100));
        
        assertTrue(increase.compareTo(expectedMin) >= 0,
            String.format("Balance increase (%s) is less than expected minimum (%s)", 
                increase, expectedMin));
        
        System.out.println("\n========================================");
        System.out.println("✓ E2E Import Test PASSED!");
        System.out.println("========================================");
        System.out.println("TxID: " + submittedTxId);
        System.out.printf("Imported: %.6f AVAX%n", increase.doubleValue() / 1e18);
        System.out.println("========================================");
    }
    
    // =========================================================================
    // Helper Methods
    // =========================================================================
    
    /**
     * Get base fee via custom RPC call (eth_baseFee not in standard web3j).
     */
    private BigInteger getBaseFeeFromRpc() throws Exception {
        HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        
        String requestBody = "{\"jsonrpc\":\"2.0\",\"method\":\"eth_baseFee\",\"params\":[],\"id\":1}";
        
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(FUJI_RPC_URL))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))
            .build();
        
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        
        // Parse result from JSON response
        Pattern pattern = Pattern.compile("\"result\"\\s*:\\s*\"(0x[0-9a-fA-F]+)\"");
        Matcher matcher = pattern.matcher(response.body());
        
        if (matcher.find()) {
            return Numeric.toBigInt(matcher.group(1));
        }
        
        throw new RuntimeException("Failed to parse eth_baseFee response: " + response.body());
    }
    
    /**
     * Decode CB58 (Base58Check) string to bytes.
     * CB58 = Base58Check with 4-byte checksum.
     */
    private static byte[] decodeBase58Check(String cb58) {
        // Base58 alphabet used by Avalanche
        String alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        
        // Decode base58
        BigInteger value = BigInteger.ZERO;
        for (char c : cb58.toCharArray()) {
            int digit = alphabet.indexOf(c);
            if (digit < 0) {
                throw new IllegalArgumentException("Invalid CB58 character: " + c);
            }
            value = value.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit));
        }
        
        // Convert to bytes
        byte[] decoded = value.toByteArray();
        
        // Handle leading zero bytes
        int leadingZeros = 0;
        for (char c : cb58.toCharArray()) {
            if (c == '1') leadingZeros++;
            else break;
        }
        
        // Remove BigInteger sign byte if present
        int start = (decoded.length > 0 && decoded[0] == 0) ? 1 : 0;
        
        // Build result with leading zeros
        byte[] result = new byte[leadingZeros + decoded.length - start];
        System.arraycopy(decoded, start, result, leadingZeros, decoded.length - start);
        
        // Remove 4-byte checksum
        if (result.length < 4) {
            throw new IllegalArgumentException("CB58 string too short");
        }
        
        byte[] withoutChecksum = new byte[result.length - 4];
        System.arraycopy(result, 0, withoutChecksum, 0, withoutChecksum.length);
        
        return withoutChecksum;
    }
    
    /**
     * Ceiling division for fee calculation.
     */
    private static long ceilDiv(long a, long b) {
        return (a + b - 1) / b;
    }
}

