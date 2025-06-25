import { StoredBlock } from "./BatchRpc";

export const serializeFixedLenHex = (hex: string, expectedLengthBytes: number): Uint8Array => {
    // Remove 0x prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

    // Check if hex is the exact expected length
    if (cleanHex.length !== expectedLengthBytes * 2) {
        throw new Error(`Hex string ${hex} has ${cleanHex.length / 2} bytes but expected exactly ${expectedLengthBytes} bytes`);
    }

    const bytes = new Uint8Array(expectedLengthBytes);
    for (let i = 0; i < expectedLengthBytes; i++) {
        bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export const serializeHex = (hex: string): Uint8Array => {
    // Remove 0x prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

    // Ensure even length by padding with leading zero if needed
    const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex;

    const bytes = new Uint8Array(paddedHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(paddedHex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export const serializeNumber = (number: number): Uint8Array => {
    return serializeHex(number.toString(16))
}

export const deserializeNumber = (bytes: Uint8Array): number => {
    let result = 0;
    for (let i = 0; i < bytes.length; i++) {
        result = result * 256 + bytes[i];
    }
    return result;
}

export const deserializeBigInt = (bytes: Uint8Array): bigint => {
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
        result = result * 256n + BigInt(bytes[i]);
    }
    return result;
}

export const deserializeFixedLenHex = (bytes: Uint8Array): string => {
    return '0x' + Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export const deserializeHex = (bytes: Uint8Array): string => {
    const hex = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');

    // Remove leading zeros but keep at least one zero
    const trimmed = hex.replace(/^0+/, '') || '0';
    return '0x' + trimmed;
}
