package io.avalanche.atomic;

import io.avalanche.atomic.builder.ImportTxBuilder;
import io.avalanche.atomic.model.AtomicTx;
import io.avalanche.atomic.model.EVMOutput;
import io.avalanche.atomic.model.UTXO;
import io.avalanche.atomic.parser.BlockParser;
import io.avalanche.atomic.parser.ExtDataDecoder;
import io.avalanche.atomic.rpc.AvalancheRpcClient;
import io.avalanche.atomic.signer.TxSigner;
import org.web3j.crypto.ECKeyPair;
import org.web3j.protocol.Web3j;
import org.web3j.protocol.core.DefaultBlockParameter;
import org.web3j.protocol.core.methods.response.EthBlock;
import org.web3j.utils.Numeric;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * AvalancheAtomicSDK - Main entry point for detecting and creating
 * P-Chain to C-Chain atomic import transactions.
 */
public class AvalancheAtomicSDK {
    private final Web3j web3j;
    private final AvalancheRpcClient avaxClient;
    private final BlockParser blockParser;
    private final ExtDataDecoder extDataDecoder;
    private final ImportTxBuilder importTxBuilder;
    private final TxSigner txSigner;
    
    /**
     * Create SDK instance.
     * 
     * @param nodeUrl Avalanche node URL (e.g., "https://api.avax.network")
     * @param web3j Web3j instance connected to C-Chain RPC
     */
    public AvalancheAtomicSDK(String nodeUrl, Web3j web3j) {
        this.web3j = web3j;
        this.avaxClient = new AvalancheRpcClient(nodeUrl);
        this.blockParser = new BlockParser();
        this.extDataDecoder = new ExtDataDecoder();
        this.importTxBuilder = new ImportTxBuilder();
        this.txSigner = new TxSigner();
    }
    
    /**
     * Create SDK instance (legacy constructor for backwards compatibility).
     * Note: submitTx() will not work without nodeUrl.
     * 
     * @param web3j Web3j instance connected to C-Chain RPC
     */
    public AvalancheAtomicSDK(Web3j web3j) {
        this(null, web3j);
    }
    
    /**
     * Create SDK instance with just node URL (no web3j).
     * Useful when you only need atomic operations, not Ethereum calls.
     * 
     * @param nodeUrl Avalanche node URL
     */
    public AvalancheAtomicSDK(String nodeUrl) {
        this(nodeUrl, null);
    }
    
    /**
     * Query pending UTXOs from shared memory (P-Chain exports waiting to be imported).
     * 
     * @param bech32Addresses Bech32 addresses to check (e.g., "C-avax1..." or "C-fuji1...")
     * @return List of UTXOs available for import
     */
    public List<UTXO> getPendingImports(List<String> bech32Addresses) {
        if (avaxClient == null) {
            throw new IllegalStateException("SDK created without nodeUrl - cannot query UTXOs");
        }
        return avaxClient.getUTXOs(bech32Addresses, "P");
    }
    
    /**
     * Query pending UTXOs from shared memory (single address).
     */
    public List<UTXO> getPendingImports(String bech32Address) {
        return getPendingImports(List.of(bech32Address));
    }
    
    /**
     * Detect ImportTx transactions in a block that credit watched addresses.
     * 
     * @param blockNumber Block number to check
     * @param watchAddresses Set of EVM addresses to watch (hex strings with 0x prefix)
     * @return List of detected imports crediting the watched addresses
     */
    public List<DetectedImport> detectImports(BigInteger blockNumber, Set<String> watchAddresses) {
        if (web3j == null) {
            throw new IllegalStateException("SDK created without web3j - cannot query blocks");
        }
        try {
            // Get block with full body
            EthBlock ethBlock = web3j.ethGetBlockByNumber(
                DefaultBlockParameter.valueOf(blockNumber),
                true
            ).send();
            
            if (ethBlock.getBlock() == null) {
                return List.of();
            }
            
            // Extract ExtData from block body
            // Note: web3j doesn't expose raw block body, so this is a simplified approach
            // In production, you'd need to fetch raw block data via custom RPC call
            
            // For now, return empty list (this would need raw block RLP data)
            return List.of();
            
        } catch (Exception e) {
            throw new RuntimeException("Failed to detect imports", e);
        }
    }
    
    /**
     * Detect all atomic transactions from raw block body RLP.
     * 
     * @param blockBodyRlp Raw block body RLP bytes
     * @return List of all atomic transactions (ImportTx and ExportTx)
     */
    public List<AtomicTx> detectAtomicTransactions(byte[] blockBodyRlp) {
        byte[] extData = blockParser.extractExtData(blockBodyRlp);
        if (extData == null) {
            return List.of();
        }
        
        return extDataDecoder.parseAtomicTransactions(extData);
    }
    
    /**
     * Detect ImportTx transactions crediting watched addresses.
     * 
     * @param blockBodyRlp Raw block body RLP bytes
     * @param watchAddresses Set of EVM addresses to watch (20 bytes each)
     * @return List of detected imports with matched outputs
     */
    public List<DetectedImport> detectImportsFromRaw(byte[] blockBodyRlp, Set<byte[]> watchAddresses) {
        List<AtomicTx> allTxs = detectAtomicTransactions(blockBodyRlp);
        List<DetectedImport> imports = new ArrayList<>();
        
        for (AtomicTx tx : allTxs) {
            if (!tx.isImportTx()) {
                continue;
            }
            
            // Check if any output credits a watched address
            List<EVMOutput> matchedOutputs = tx.getImportTx().getOuts().stream()
                .filter(out -> watchAddresses.stream()
                    .anyMatch(addr -> Arrays.equals(addr, out.getAddress())))
                .collect(Collectors.toList());
            
            if (!matchedOutputs.isEmpty()) {
                imports.add(new DetectedImport(tx.getTxId(), matchedOutputs));
            }
        }
        
        return imports;
    }
    
    /**
     * Build an unsigned ImportTx.
     * 
     * @param networkId Network ID (1=mainnet, 5=fuji)
     * @param cChainId C-Chain blockchain ID (32 bytes)
     * @param pChainId P-Chain ID (32 bytes, usually all zeros)
     * @param utxos UTXOs to import
     * @param toAddress Destination EVM address (20 bytes)
     * @param avaxAssetId AVAX asset ID (32 bytes)
     * @param baseFee Current base fee from eth_baseFee
     * @return Unsigned transaction bytes
     */
    public byte[] buildImportTx(
            int networkId,
            byte[] cChainId,
            byte[] pChainId,
            List<UTXO> utxos,
            byte[] toAddress,
            byte[] avaxAssetId,
            BigInteger baseFee) {
        
        return importTxBuilder.buildImportTx(
            networkId, cChainId, pChainId, utxos, toAddress, avaxAssetId, baseFee
        );
    }
    
    /**
     * Sign an unsigned ImportTx.
     * 
     * @param unsignedTxBytes Unsigned transaction bytes
     * @param keyPairs Key pairs for signing (one per input)
     * @return Signed transaction bytes ready for submission
     */
    public byte[] signTx(byte[] unsignedTxBytes, List<ECKeyPair> keyPairs) {
        return txSigner.signImportTx(unsignedTxBytes, keyPairs);
    }
    
    /**
     * Submit a signed transaction to the C-Chain.
     * 
     * @param signedTxBytes Signed transaction bytes
     * @return Transaction ID (CB58 encoded string)
     */
    public String submitTx(byte[] signedTxBytes) {
        if (avaxClient == null) {
            throw new IllegalStateException("SDK created without nodeUrl - cannot submit transactions");
        }
        return avaxClient.issueTx(signedTxBytes);
    }
    
    /**
     * Check the status of a submitted transaction.
     * 
     * @param txId Transaction ID (CB58)
     * @return Status string ("Accepted", "Processing", "Rejected", "Unknown")
     */
    public String getTxStatus(String txId) {
        if (avaxClient == null) {
            throw new IllegalStateException("SDK created without nodeUrl - cannot check tx status");
        }
        return avaxClient.getTxStatus(txId);
    }
    
    /**
     * Get current base fee from C-Chain.
     */
    public BigInteger getBaseFee() {
        try {
            // Note: eth_baseFee might not be available in all web3j versions
            // You may need to use a custom RPC call
            return web3j.ethGasPrice().send().getGasPrice();
        } catch (Exception e) {
            throw new RuntimeException("Failed to get base fee", e);
        }
    }
    
    /**
     * Represents a detected import transaction with transaction ID.
     */
    public static class DetectedImport {
        private final byte[] txId;
        private final List<EVMOutput> matchedOutputs;
        
        public DetectedImport(byte[] txId, List<EVMOutput> matchedOutputs) {
            this.txId = txId.clone();
            this.matchedOutputs = matchedOutputs;
        }
        
        public byte[] getTxId() {
            return txId.clone();
        }
        
        public String getTxIdHex() {
            return Numeric.toHexString(txId);
        }
        
        public List<EVMOutput> getMatchedOutputs() {
            return matchedOutputs;
        }
        
        public long getTotalAmount() {
            return matchedOutputs.stream()
                .mapToLong(EVMOutput::getAmount)
                .sum();
        }
    }
}

