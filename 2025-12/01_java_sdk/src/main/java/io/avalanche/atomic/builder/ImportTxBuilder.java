package io.avalanche.atomic.builder;

import io.avalanche.atomic.codec.LinearCodec;
import io.avalanche.atomic.constants.AvalancheConstants;
import io.avalanche.atomic.model.EVMOutput;
import io.avalanche.atomic.model.TransferableInput;
import io.avalanche.atomic.model.UTXO;
import io.avalanche.atomic.model.UnsignedImportTx;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * ImportTxBuilder constructs C-Chain ImportTx transactions.
 * Implements fee calculation based on gas usage and base fee.
 */
public class ImportTxBuilder {
    private final LinearCodec codec;
    
    public ImportTxBuilder() {
        this.codec = new LinearCodec();
    }
    
    /**
     * Build an ImportTx from UTXOs.
     * 
     * @param networkId Network ID (1=mainnet, 5=fuji)
     * @param cChainId C-Chain blockchain ID
     * @param pChainId P-Chain ID (source chain)
     * @param utxos UTXOs to import
     * @param toAddress Destination EVM address (20 bytes)
     * @param avaxAssetId AVAX asset ID (32 bytes)
     * @param baseFee Current base fee in wei
     * @return Unsigned ImportTx bytes ready for signing
     */
    public byte[] buildImportTx(
            int networkId,
            byte[] cChainId,
            byte[] pChainId,
            List<UTXO> utxos,
            byte[] toAddress,
            byte[] avaxAssetId,
            BigInteger baseFee) {
        
        if (utxos.isEmpty()) {
            throw new IllegalArgumentException("No UTXOs to import");
        }
        
        // Calculate total amount available
        long totalAmount = 0;
        for (UTXO utxo : utxos) {
            totalAmount += utxo.getAmount();
        }
        
        // Build inputs from UTXOs (sorted)
        List<TransferableInput> inputs = new ArrayList<>();
        for (UTXO utxo : utxos) {
            // Assume single signature (index 0)
            int[] sigIndices = {0};
            inputs.add(new TransferableInput(
                utxo.getTxId(),
                utxo.getOutputIndex(),
                utxo.getAssetId(),
                utxo.getAmount(),
                sigIndices
            ));
        }
        
        // Sort inputs (required by protocol)
        Collections.sort(inputs);
        
        // Build temporary tx to calculate fee
        List<EVMOutput> tempOuts = List.of(
            new EVMOutput(toAddress, totalAmount, avaxAssetId)
        );
        
        UnsignedImportTx tempTx = new UnsignedImportTx(
            networkId, cChainId, pChainId, inputs, tempOuts
        );
        
        // Serialize to get actual size
        byte[] tempBytes = codec.serializeUnsignedImportTx(tempTx);
        
        // Calculate gas (post-AP5 with intrinsic gas)
        long gas = calculateGas(tempBytes.length, inputs.size(), true);
        
        // Calculate fee
        long fee = calculateDynamicFee(gas, baseFee);
        
        if (totalAmount <= fee) {
            throw new IllegalArgumentException(
                String.format("Insufficient funds: have %d, need %d for fee", totalAmount, fee)
            );
        }
        
        // Build final outputs with fee deducted
        List<EVMOutput> finalOuts = List.of(
            new EVMOutput(toAddress, totalAmount - fee, avaxAssetId)
        );
        
        UnsignedImportTx finalTx = new UnsignedImportTx(
            networkId, cChainId, pChainId, inputs, finalOuts
        );
        
        return codec.serializeUnsignedImportTx(finalTx);
    }
    
    /**
     * Calculate gas for an ImportTx.
     * Formula from atomic/import_tx.go:
     * gas = txBytes * 1 + numInputs * 1000 + 10000 (intrinsic)
     */
    private long calculateGas(int txBytes, int numInputs, boolean includeIntrinsic) {
        long gas = txBytes * AvalancheConstants.TX_BYTES_GAS;
        gas += numInputs * AvalancheConstants.SECP256K1_FX_COST_PER_SIG;
        
        if (includeIntrinsic) {
            gas += AvalancheConstants.ATOMIC_TX_INTRINSIC_GAS;
        }
        
        return gas;
    }
    
    /**
     * Calculate dynamic fee.
     * Formula from atomic/tx.go:
     * fee = ceil((gas * baseFee) / 1e9)
     * 
     * @param gas Gas units
     * @param baseFee Base fee in wei
     * @return Fee in nAVAX
     */
    private long calculateDynamicFee(long gas, BigInteger baseFee) {
        BigInteger gasBig = BigInteger.valueOf(gas);
        BigInteger feeWei = gasBig.multiply(baseFee);
        
        // Convert from wei to nAVAX (divide by 1e9, rounding up)
        BigInteger x2cRate = BigInteger.valueOf(AvalancheConstants.X2C_RATE);
        BigInteger feeNAvax = feeWei.add(x2cRate.subtract(BigInteger.ONE)).divide(x2cRate);
        
        return feeNAvax.longValue();
    }
}

