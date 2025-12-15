package io.avalanche.atomic.parser;

import org.web3j.rlp.RlpDecoder;
import org.web3j.rlp.RlpList;
import org.web3j.rlp.RlpString;
import org.web3j.rlp.RlpType;

/**
 * BlockParser extracts ExtData from C-Chain block bodies.
 * C-Chain blocks have 4 RLP elements: [Transactions, Uncles, Version, ExtData]
 * Standard Ethereum blocks have only 2: [Transactions, Uncles]
 */
public class BlockParser {
    
    /**
     * Extract ExtData from a C-Chain block body.
     * 
     * @param blockBodyRlp RLP-encoded block body
     * @return ExtData bytes, or null if no atomic transactions
     */
    public byte[] extractExtData(byte[] blockBodyRlp) {
        if (blockBodyRlp == null || blockBodyRlp.length == 0) {
            return null;
        }
        
        try {
            RlpList decoded = RlpDecoder.decode(blockBodyRlp);
            RlpList body = (RlpList) decoded.getValues().get(0);
            
            // Check if this is a C-Chain block (4 elements)
            if (body.getValues().size() < 4) {
                // Standard Ethereum block or pre-atomic block
                return null;
            }
            
            // Index 0: Transactions (standard)
            // Index 1: Uncles (standard)
            // Index 2: Version (Avalanche-specific)
            // Index 3: ExtData (Avalanche-specific)
            
            RlpType extDataRlp = body.getValues().get(3);
            
            if (extDataRlp instanceof RlpString) {
                byte[] extData = ((RlpString) extDataRlp).getBytes();
                // Return null if ExtData is empty
                return (extData != null && extData.length > 0) ? extData : null;
            }
            
            return null;
        } catch (Exception e) {
            throw new IllegalArgumentException("Failed to parse block body RLP", e);
        }
    }
}

