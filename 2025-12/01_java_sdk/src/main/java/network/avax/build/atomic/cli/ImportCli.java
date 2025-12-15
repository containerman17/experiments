package network.avax.build.atomic.cli;

import network.avax.build.atomic.AvalancheAtomicSDK;
import network.avax.build.atomic.constants.AvalancheConstants;
import network.avax.build.atomic.model.AtomicTx;
import network.avax.build.atomic.model.UTXO;
import network.avax.build.atomic.parser.ExtDataDecoder;
import network.avax.build.atomic.util.KeyGenerator;
import org.web3j.crypto.ECKeyPair;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameter;
import org.web3j.protocol.core.methods.response.EthBlock;
import org.web3j.protocol.http.HttpService;
import org.web3j.utils.Numeric;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * CLI utility to import UTXOs from P-Chain to C-Chain.
 * 
 * Usage: ImportCli
 * 
 * Reads .env file for:
 * - CUSTODIAN_PRIVATE_KEY
 * - CUSTODIAN_C_BECH32
 * - CUSTODIAN_C_EVM
 */
public class ImportCli {
    
    // Fuji testnet constants (CB58 decoded)
    // C-Chain ID: yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp
    private static final byte[] FUJI_C_CHAIN_ID = decodeCb58("yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp");
    
    // AVAX Asset ID: U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK
    private static final byte[] FUJI_AVAX_ASSET_ID = decodeCb58("U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK");
    
    private static final String FUJI_NODE_URL = "https://api.avax-test.network";
    private static final String FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
    
    public static void main(String[] args) {
        try {
            run();
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            e.printStackTrace();
            System.exit(1);
        }
    }
    
    private static void run() throws Exception {
        System.out.println("═══════════════════════════════════════════════════════");
        System.out.println("Avalanche Import CLI - P-Chain → C-Chain");
        System.out.println("═══════════════════════════════════════════════════════\n");
        
        // Load .env
        Map<String, String> env = loadEnv();
        
        String privateKeyHex = env.get("CUSTODIAN_PRIVATE_KEY");
        String cBech32 = env.get("CUSTODIAN_C_BECH32");
        String cEvm = env.get("CUSTODIAN_C_EVM");
        
        if (privateKeyHex == null || cBech32 == null || cEvm == null) {
            throw new IllegalStateException("Missing CUSTODIAN_PRIVATE_KEY, CUSTODIAN_C_BECH32, or CUSTODIAN_C_EVM in .env");
        }
        
        System.out.println("Custodian Address: " + cBech32);
        System.out.println("EVM Address:       " + cEvm);
        System.out.println();
        
        // Create key pair
        ECKeyPair keyPair = ECKeyPair.create(Numeric.toBigInt(privateKeyHex));
        byte[] evmAddressBytes = Numeric.hexStringToByteArray(cEvm);
        
        // Initialize SDK and Web3j
        Web3j web3j = Web3j.build(new HttpService(FUJI_RPC_URL));
        AvalancheAtomicSDK sdk = new AvalancheAtomicSDK(FUJI_NODE_URL, web3j);
        
        // Step 1: Get balance before
        BigInteger balanceBefore = web3j.ethGetBalance(cEvm, DefaultBlockParameter.valueOf("latest")).send().getBalance();
        System.out.println("Balance Before: " + formatAvax(balanceBefore) + " (" + balanceBefore + " wei)");
        
        // Step 2: Query UTXOs
        System.out.println("\nQuerying pending UTXOs from P-Chain...");
        List<UTXO> utxos = sdk.getPendingImports(cBech32);
        
        if (utxos.isEmpty()) {
            System.out.println("No pending UTXOs found. Nothing to import.");
            return;
        }
        
        long totalNAvax = utxos.stream().mapToLong(UTXO::getAmount).sum();
        System.out.println("Found " + utxos.size() + " UTXO(s), total: " + formatNAvax(totalNAvax));
        
        for (int i = 0; i < utxos.size(); i++) {
            UTXO utxo = utxos.get(i);
            System.out.printf("  [%d] %d nAVAX\n", i + 1, utxo.getAmount());
        }
        
        // Step 3: Get base fee
        BigInteger baseFee = sdk.getBaseFee();
        System.out.println("\nBase Fee: " + baseFee + " wei");
        
        // Step 4: Build tx
        System.out.println("\nBuilding ImportTx...");
        byte[] unsignedTx = sdk.buildImportTx(
            AvalancheConstants.FUJI_ID,
            FUJI_C_CHAIN_ID,
            AvalancheConstants.P_CHAIN_ID,
            utxos,
            evmAddressBytes,
            FUJI_AVAX_ASSET_ID,
            baseFee
        );
        
        // Step 5: Sign tx
        System.out.println("Signing transaction...");
        List<ECKeyPair> keys = utxos.stream().map(u -> keyPair).toList();
        byte[] signedTx = sdk.signTx(unsignedTx, keys);
        
        // Step 6: Get current block number before submitting
        BigInteger blockBeforeSubmit = web3j.ethBlockNumber().send().getBlockNumber();
        
        // Step 7: Submit tx
        System.out.println("Submitting transaction...");
        String txId = sdk.submitTx(signedTx);
        System.out.println("TxID: " + txId);
        
        // Step 8: Poll for acceptance by checking balance
        System.out.print("Waiting for acceptance (checking balance)");
        BigInteger newBalance = balanceBefore;
        int attempts = 0;
        while (newBalance.equals(balanceBefore) && attempts < 60) {
            Thread.sleep(2000);
            newBalance = web3j.ethGetBalance(cEvm, DefaultBlockParameter.valueOf("latest")).send().getBalance();
            System.out.print(".");
            attempts++;
        }
        System.out.println();
        
        if (newBalance.equals(balanceBefore)) {
            System.err.println("Transaction may not have been accepted (balance unchanged after 2 minutes)");
        } else {
            System.out.println("Balance changed - transaction accepted!");
        }
        
        // Step 9: Scan recent blocks for our import
        System.out.println("\nScanning last 50 blocks for import...");
        BigInteger currentBlock = web3j.ethBlockNumber().send().getBlockNumber();
        Long foundBlock = scanForImport(web3j, cEvm, blockBeforeSubmit, currentBlock);
        
        if (foundBlock != null) {
            System.out.println("Import found in block: " + foundBlock);
        } else {
            System.out.println("Import not found in scanned blocks (may be in a later block)");
        }
        
        // Step 10: Report balance changes
        BigInteger balanceAfter = newBalance;
        System.out.println("\nBalance After:  " + formatAvax(balanceAfter) + " (" + balanceAfter + " wei)");
        
        BigInteger delta = balanceAfter.subtract(balanceBefore);
        System.out.println("Delta:          " + formatAvax(delta));
        
        System.out.println("\n═══════════════════════════════════════════════════════");
        System.out.println("Import complete!");
        System.out.println("═══════════════════════════════════════════════════════");
    }
    
    /**
     * Scan blocks for an ImportTx crediting the given address.
     */
    private static Long scanForImport(Web3j web3j, String evmAddress, BigInteger fromBlock, BigInteger toBlock) {
        ExtDataDecoder decoder = new ExtDataDecoder();
        byte[] targetAddress = Numeric.hexStringToByteArray(evmAddress);
        
        // Scan from most recent block backward
        for (BigInteger i = toBlock; i.compareTo(fromBlock) >= 0 && i.compareTo(toBlock.subtract(BigInteger.valueOf(50))) >= 0; i = i.subtract(BigInteger.ONE)) {
            try {
                EthBlock ethBlock = web3j.ethGetBlockByNumber(DefaultBlockParameter.valueOf(i), false).send();
                if (ethBlock.getBlock() == null) continue;
                
                String extraData = ethBlock.getBlock().getExtraData();
                if (extraData == null || extraData.equals("0x") || extraData.length() < 10) continue;
                
                // C-Chain stores atomic txs in extraData after a certain format
                // We need to check blockExtraData field which isn't in standard EthBlock
                // Use raw JSON parsing instead
                byte[] extData = fetchBlockExtraData(web3j, i);
                if (extData == null || extData.length == 0) continue;
                
                List<AtomicTx> txs = decoder.parseAtomicTransactions(extData);
                for (AtomicTx tx : txs) {
                    if (!tx.isImportTx()) continue;
                    
                    // Check if any output goes to our address
                    boolean matches = tx.getImportTx().getOuts().stream()
                        .anyMatch(out -> java.util.Arrays.equals(out.getAddress(), targetAddress));
                    
                    if (matches) {
                        return i.longValue();
                    }
                }
            } catch (Exception e) {
                // Skip blocks we can't parse
            }
        }
        return null;
    }
    
    /**
     * Fetch blockExtraData from a block using raw RPC.
     */
    private static byte[] fetchBlockExtraData(Web3j web3j, BigInteger blockNumber) throws IOException {
        java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
        String blockHex = "0x" + blockNumber.toString(16);
        String body = String.format(
            "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"%s\",false],\"id\":1}",
            blockHex
        );
        
        java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder()
            .uri(java.net.URI.create(FUJI_RPC_URL))
            .header("Content-Type", "application/json")
            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body))
            .build();
        
        try {
            java.net.http.HttpResponse<String> response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
            java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("\"blockExtraData\"\\s*:\\s*\"(0x[0-9a-fA-F]*)\"");
            java.util.regex.Matcher matcher = pattern.matcher(response.body());
            
            if (matcher.find()) {
                String hex = matcher.group(1);
                if (hex.equals("0x") || hex.isEmpty()) return null;
                return Numeric.hexStringToByteArray(hex);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return null;
    }
    
    /**
     * Load .env file into a map.
     */
    private static Map<String, String> loadEnv() throws IOException {
        Path envPath = Path.of(".env");
        if (!Files.exists(envPath)) {
            throw new IllegalStateException(".env file not found. Run go_test_setup/bin/go_generate_keys first.");
        }
        
        Map<String, String> env = new HashMap<>();
        for (String line : Files.readAllLines(envPath)) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            
            int eq = line.indexOf('=');
            if (eq > 0) {
                String key = line.substring(0, eq).trim();
                String value = line.substring(eq + 1).trim();
                env.put(key, value);
            }
        }
        return env;
    }
    
    /**
     * CB58 decode (Base58Check with 4-byte checksum).
     */
    private static byte[] decodeCb58(String encoded) {
        byte[] decoded = decodeBase58(encoded);
        // Last 4 bytes are checksum
        byte[] data = new byte[decoded.length - 4];
        System.arraycopy(decoded, 0, data, 0, data.length);
        return data;
    }
    
    private static final String ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    
    private static byte[] decodeBase58(String input) {
        if (input.isEmpty()) return new byte[0];
        
        BigInteger bi = BigInteger.ZERO;
        for (char c : input.toCharArray()) {
            int digit = ALPHABET.indexOf(c);
            if (digit < 0) throw new IllegalArgumentException("Invalid Base58 character: " + c);
            bi = bi.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(digit));
        }
        
        byte[] bytes = bi.toByteArray();
        
        // Count leading zeros in input
        int leadingZeros = 0;
        for (char c : input.toCharArray()) {
            if (c == '1') leadingZeros++;
            else break;
        }
        
        // Remove sign byte if present
        int offset = (bytes.length > 1 && bytes[0] == 0) ? 1 : 0;
        byte[] result = new byte[leadingZeros + bytes.length - offset];
        System.arraycopy(bytes, offset, result, leadingZeros, bytes.length - offset);
        
        return result;
    }
    
    private static String formatAvax(BigInteger wei) {
        // 18 decimals for EVM balance
        double avax = wei.doubleValue() / 1e18;
        return String.format("%.9f AVAX", avax);
    }
    
    private static String formatNAvax(long nAvax) {
        // 9 decimals for nAVAX
        double avax = nAvax / 1e9;
        return String.format("%.9f AVAX (%d nAVAX)", avax, nAvax);
    }
}

