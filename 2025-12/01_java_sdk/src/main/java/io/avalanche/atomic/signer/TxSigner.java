package io.avalanche.atomic.signer;

import io.avalanche.atomic.codec.LinearCodec;
import io.avalanche.atomic.model.Credential;
import io.avalanche.atomic.model.UnsignedImportTx;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Hash;
import org.web3j.crypto.Sign;

import java.util.ArrayList;
import java.util.List;

/**
 * TxSigner signs atomic transactions using secp256k1.
 * Uses web3j for signing with critical v-27 fix for Avalanche.
 */
public class TxSigner {
    private final LinearCodec codec;
    
    public TxSigner() {
        this.codec = new LinearCodec();
    }
    
    /**
     * Sign an unsigned ImportTx.
     * 
     * @param unsignedTxBytes Unsigned transaction bytes
     * @param keyPairs Key pairs for signing (one per input)
     * @return Signed transaction bytes ready for submission
     */
    public byte[] signImportTx(byte[] unsignedTxBytes, List<ECKeyPair> keyPairs) {
        // Hash the unsigned bytes with SHA256
        byte[] hash = Hash.sha256(unsignedTxBytes);
        
        // Create credentials
        List<Credential> credentials = new ArrayList<>();
        for (ECKeyPair keyPair : keyPairs) {
            byte[] signature = signForAvalanche(hash, keyPair);
            credentials.add(new Credential(List.of(signature)));
        }
        
        // Deserialize to get the tx object
        UnsignedImportTx tx = codec.deserializeUnsignedImportTx(unsignedTxBytes);
        
        // Serialize with credentials
        return codec.serializeSignedTx(tx, credentials);
    }
    
    /**
     * Sign a hash for Avalanche.
     * CRITICAL: Web3j returns v as 27 or 28, but Avalanche expects 0 or 1.
     * 
     * @param hash Hash to sign (32 bytes)
     * @param keyPair Key pair for signing
     * @return Signature in Avalanche format [r(32) || s(32) || v(1)] where v ∈ [0,3]
     */
    public byte[] signForAvalanche(byte[] hash, ECKeyPair keyPair) {
        // Sign using web3j
        Sign.SignatureData sig = Sign.signMessage(hash, keyPair, false);
        
        // Assemble signature: [r(32) || s(32) || v(1)]
        byte[] result = new byte[65];
        
        // Copy r (32 bytes)
        byte[] r = sig.getR();
        if (r.length == 32) {
            System.arraycopy(r, 0, result, 0, 32);
        } else if (r.length > 32) {
            // Remove leading zeros
            System.arraycopy(r, r.length - 32, result, 0, 32);
        } else {
            // Pad with leading zeros
            System.arraycopy(r, 0, result, 32 - r.length, r.length);
        }
        
        // Copy s (32 bytes)
        byte[] s = sig.getS();
        if (s.length == 32) {
            System.arraycopy(s, 0, result, 32, 32);
        } else if (s.length > 32) {
            // Remove leading zeros
            System.arraycopy(s, s.length - 32, result, 32, 32);
        } else {
            // Pad with leading zeros
            System.arraycopy(s, 0, result, 32 + (32 - s.length), s.length);
        }
        
        // CRITICAL FIX: Convert v from 27/28 to 0/1
        byte v = sig.getV()[0];
        if (v >= 27) {
            v -= 27;
        }
        result[64] = v;
        
        // Verify v is in valid range [0,3]
        if (result[64] < 0 || result[64] > 3) {
            throw new IllegalStateException("Invalid recovery ID: " + result[64]);
        }
        
        return result;
    }
    
    /**
     * Verify a signature is in correct Avalanche format.
     */
    public boolean verifySignatureFormat(byte[] signature) {
        if (signature == null || signature.length != 65) {
            return false;
        }
        
        byte v = signature[64];
        return v >= 0 && v <= 3;
    }
}

