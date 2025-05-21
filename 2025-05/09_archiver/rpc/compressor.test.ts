import { expect, test } from "bun:test";
import { compress, decompress } from "./compressor";
import { Buffer } from "node:buffer";
import { encode as cborEncode } from 'cbor2';

test("should compress and decompress a simple object", async () => {
    const originalData = { message: "hello world", count: 42 };
    const compressed = await compress(originalData);
    const decompressed = await decompress<typeof originalData>(compressed);
    expect(decompressed).toEqual(originalData);
});

test("should compress and decompress with different compression levels", async () => {
    const originalData = {
        a: "a".repeat(1000),
        b: "b".repeat(1000)
    };

    // Use level 0 (uncompressed) vs default level
    const compressedWithLevel0 = await compress(originalData, 0);
    const compressedDefault = await compress(originalData);

    // Level 0 should definitely be different from default compression
    expect(compressedWithLevel0.length).not.toBe(compressedDefault.length);

    // Both should correctly decompress
    const decompressedLevel0 = await decompress<typeof originalData>(compressedWithLevel0);
    const decompressedDefault = await decompress<typeof originalData>(compressedDefault);

    expect(decompressedLevel0).toEqual(originalData);
    expect(decompressedDefault).toEqual(originalData);
});

test("should decompress uncompressed data", async () => {
    const originalData = { note: "this data is not compressed" };
    // Manually create "compressed" data with FLAG_UNCOMPRESSED
    const cborEncoded = Buffer.from(cborEncode(originalData));

    // To properly test FLAG_UNCOMPRESSED, we need the CBOR encoded version of originalData.
    // Since 'encode' from 'cbor2' is not directly exported or accessible from compressor.ts,
    // and to avoid modifying compressor.ts just for this test, we'll prepare it externally if possible,
    // or accept a less direct test.
    // Given the constraints, the most straightforward way to test this path is to assume
    // we have a CBOR encoded payload and prepend the uncompressed flag.

    // Let's use a known simple CBOR payload for "hello" which is 0x6568656c6c6f
    const knownCborPayload = Buffer.from([0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const uncompressedFlag = 0x00;
    const dataWithUncompressedFlag = Buffer.concat([Buffer.from([uncompressedFlag]), knownCborPayload]);

    const decompressed = await decompress<string>(dataWithUncompressedFlag);
    expect(decompressed).toEqual("hello");
});

test("should throw an error for an unknown compression flag", async () => {
    const fakeData = Buffer.from([0x99, 0x01, 0x02, 0x03]); // Unknown flag 0x99
    await expect(decompress(fakeData)).rejects.toThrow("Unknown compression flag: 153");
});

test("compress should produce a buffer starting with the ZSTD flag", async () => {
    const originalData = { test: "flag check" };
    const compressed = await compress(originalData);
    const FLAG_NODE22_ZSTD = 0x01;
    expect(compressed[0]).toBe(FLAG_NODE22_ZSTD);
});

test("decompression of empty or minimal data", async () => {
    // Test with an empty object
    const emptyObj = {};
    const compressedEmptyObj = await compress(emptyObj);
    const decompressedEmptyObj = await decompress<typeof emptyObj>(compressedEmptyObj);
    expect(decompressedEmptyObj).toEqual(emptyObj);

    // Test with null
    const nullData = null;
    const compressedNull = await compress(nullData);
    const decompressedNull = await decompress<typeof nullData>(compressedNull);
    expect(decompressedNull).toEqual(nullData);
});

test("should correctly decompress data marked as uncompressed", async () => {
    const originalData = { type: "uncompressed_test", value: 12345 };
    const cborEncoded = Buffer.from(cborEncode(originalData));
    const FLAG_UNCOMPRESSED = 0x00;

    const dataWithUncompressedFlag = Buffer.alloc(cborEncoded.length + 1);
    dataWithUncompressedFlag[0] = FLAG_UNCOMPRESSED;
    cborEncoded.copy(dataWithUncompressedFlag, 1);

    const decompressed = await decompress<typeof originalData>(dataWithUncompressedFlag);
    expect(decompressed).toEqual(originalData);
});

