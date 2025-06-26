import { Buffer } from 'node:buffer';
import { StoredBlock } from "./BatchRpc";

export const serializeFixedLenHex = (hex: string, expectedLengthBytes: number): Buffer => {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (cleanHex.length !== expectedLengthBytes * 2) {
        throw new Error(`Hex string ${hex} has ${cleanHex.length / 2} bytes but expected exactly ${expectedLengthBytes} bytes`);
    }
    return Buffer.from(cleanHex, 'hex');
}

export const serializeHex = (hex: string): Buffer => {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex;
    return Buffer.from(paddedHex, 'hex');
}

export const serializeNumber = (number: number): Buffer => {
    return serializeHex(number.toString(16))
}

export const deserializeNumber = (bytes: Uint8Array): number => {
    if (bytes.length === 0) return 0;
    if (bytes.length > 6) {
        // Fallback to BigInt for numbers larger than MAX_SAFE_INTEGER
        return Number(deserializeBigInt(bytes));
    }
    return Buffer.from(bytes).readUIntBE(0, bytes.length);
}

export const deserializeBigInt = (bytes: Uint8Array): bigint => {
    if (bytes.length === 0) return 0n;
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
        result = (result << 8n) | BigInt(bytes[i]);
    }
    return result;
}

export const deserializeFixedLenHex = (bytes: Uint8Array): string => {
    return '0x' + Buffer.from(bytes).toString('hex')
}

export const deserializeHex = (bytes: Uint8Array): string => {
    if (bytes.length === 0) {
        return '0x0';
    }
    const hex = Buffer.from(bytes).toString('hex');

    // Remove leading zeros but keep at least one zero
    const trimmed = hex.replace(/^0+/, '') || '0';
    return '0x' + trimmed;
}
