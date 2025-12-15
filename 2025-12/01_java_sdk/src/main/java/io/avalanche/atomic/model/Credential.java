package io.avalanche.atomic.model;

import java.util.ArrayList;
import java.util.List;

/**
 * Credential holds signatures for an input.
 * Maps to secp256k1fx.Credential in Go.
 */
public class Credential {
    private final List<byte[]> signatures;  // Each signature is 65 bytes [r||s||v]
    
    public Credential(List<byte[]> signatures) {
        this.signatures = new ArrayList<>();
        for (byte[] sig : signatures) {
            if (sig.length != 65) {
                throw new IllegalArgumentException("Signature must be 65 bytes");
            }
            this.signatures.add(sig.clone());
        }
    }
    
    public List<byte[]> getSignatures() {
        List<byte[]> copy = new ArrayList<>();
        for (byte[] sig : signatures) {
            copy.add(sig.clone());
        }
        return copy;
    }
    
    public int size() {
        return signatures.size();
    }
}

