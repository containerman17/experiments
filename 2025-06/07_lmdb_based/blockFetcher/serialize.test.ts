import { expect, test, describe } from 'vitest'
import {
    serializeFixedLenHex,
    serializeHex,
    deserializeNumber,
    deserializeBigInt,
    deserializeFixedLenHex,
    deserializeVariableLenHex
} from './serialize'

describe('serialize-deserialize functions', () => {
    test('serializeFixedLenHex handles block hashes (32 bytes)', () => {
        const blockHash = "0xb0eac1b80624d28eecac008f0a2780ce66d757a71541a44a912be680f1ad0a07"
        const bytes = serializeFixedLenHex(blockHash, 32)

        expect(bytes.length).toBe(32)
        expect(bytes[0]).toBe(0xb0)
        expect(bytes[1]).toBe(0xea)
        expect(bytes[31]).toBe(0x07)
    })

    test('serializeFixedLenHex handles addresses (20 bytes)', () => {
        const address = "0xa552b00a6f79e7e40eff56dc6b8c79be1a333e60"
        const bytes = serializeFixedLenHex(address, 20)

        expect(bytes.length).toBe(20)
        expect(bytes[0]).toBe(0xa5)
        expect(bytes[19]).toBe(0x60)
    })

    test('serializeFixedLenHex handles nonces (8 bytes)', () => {
        const nonce = "0x0000000000000000"
        const bytes = serializeFixedLenHex(nonce, 8)

        expect(bytes.length).toBe(8)
        expect(Array.from(bytes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    })

    test('serializeFixedLenHex throws on short hex values', () => {
        const shortHex = "0x123"
        expect(() => serializeFixedLenHex(shortHex, 20)).toThrow('has 1.5 bytes but expected exactly 20 bytes')
    })

    test('serializeFixedLenHex throws on long hex values', () => {
        const tooLongHex = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234"
        expect(() => serializeFixedLenHex(tooLongHex, 32)).toThrow('has 34 bytes but expected exactly 32 bytes')
    })

    test('serializeHex handles variable length hex', () => {
        const baseFee = "0x5d21dba00"
        const bytes = serializeHex(baseFee)

        expect(bytes.length).toBe(5)
        expect(Array.from(bytes)).toEqual([0x05, 0xd2, 0x1d, 0xba, 0x00])
    })

    test('serializeHex handles odd length hex by padding', () => {
        const oddHex = "0x123"
        const bytes = serializeHex(oddHex)

        expect(bytes.length).toBe(2)
        expect(Array.from(bytes)).toEqual([0x01, 0x23])
    })

    test('deserializeNumber handles block numbers', () => {
        const blockNumberHex = "0x8888"
        const bytes = serializeHex(blockNumberHex)
        const number = deserializeNumber(bytes)

        expect(number).toBe(34952) // 0x8888 in decimal
    })

    test('deserializeNumber handles gas limits', () => {
        const gasLimitHex = "0xb71b00"
        const bytes = serializeHex(gasLimitHex)
        const gasLimit = deserializeNumber(bytes)

        expect(gasLimit).toBe(12000000) // 0xb71b00 in decimal
    })

    test('deserializeBigInt handles large values', () => {
        const largeValue = "0x38d7ea4c68000"
        const bytes = serializeHex(largeValue)
        const bigint = deserializeBigInt(bytes)

        expect(bigint).toBe(1000000000000000n)
    })

    test('deserializeFixedLenHex recreates original hash', () => {
        const originalHash = "0xb0eac1b80624d28eecac008f0a2780ce66d757a71541a44a912be680f1ad0a07"
        const bytes = serializeFixedLenHex(originalHash, 32)
        const recreatedHash = deserializeFixedLenHex(bytes)

        expect(recreatedHash).toBe(originalHash)
    })

    test('deserializeVariableLenHex recreates original values', () => {
        const originalValue = "0x5d21dba00"
        const bytes = serializeHex(originalValue)
        const recreatedValue = deserializeVariableLenHex(bytes)

        expect(recreatedValue).toBe(originalValue)
    })

    test('deserializeVariableLenHex removes leading zeros', () => {
        const paddedHex = "0x00000123"
        const bytes = serializeHex(paddedHex)
        const result = deserializeVariableLenHex(bytes)

        expect(result).toBe("0x123")
    })

    test('deserializeVariableLenHex handles zero value', () => {
        const zeroHex = "0x00000000"
        const bytes = serializeHex(zeroHex)
        const result = deserializeVariableLenHex(bytes)

        expect(result).toBe("0x0")
    })

    test('round-trip serialization maintains data integrity', () => {
        const testValues = [
            "0x0",
            "0x123",
            "0x8888",
            "0x5d21dba00",
            "0xb0eac1b80624d28eecac008f0a2780ce66d757a71541a44a912be680f1ad0a07"
        ]

        testValues.forEach(value => {
            const bytes = serializeHex(value)
            const reconstructed = deserializeVariableLenHex(bytes)
            expect(reconstructed).toBe(value)
        })
    })

    test('number round-trip maintains precision', () => {
        const testNumbers = [0, 1, 255, 256, 65535, 65536, 34952, 12000000]

        testNumbers.forEach(num => {
            const hex = '0x' + num.toString(16)
            const bytes = serializeHex(hex)
            const reconstructed = deserializeNumber(bytes)
            expect(reconstructed).toBe(num)
        })
    })

    test('bigint round-trip maintains precision', () => {
        const testBigInts = [0n, 1n, 255n, 256n, 1000000000000000n]

        testBigInts.forEach(bigint => {
            const hex = '0x' + bigint.toString(16)
            const bytes = serializeHex(hex)
            const reconstructed = deserializeBigInt(bytes)
            expect(reconstructed).toBe(bigint)
        })
    })
})
