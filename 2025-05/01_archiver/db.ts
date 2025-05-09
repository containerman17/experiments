import { ClassicLevel } from "classic-level"

// Database configuration with optimized settings
export const db = new ClassicLevel<string, Uint8Array>('data/archive', {
  valueEncoding: 'buffer',
  // Optimal block size - 16KB is recommended for general workloads
  // Larger block size (16KB) improves space efficiency and reduces index size
  blockSize: 256 * 1024,
  // Enable compression for better space efficiency
  compression: true,
  // Set maximum open files to -1 to keep all files open and avoid table cache lookups
  maxOpenFiles: -1,
  // Increase write buffer size for better write performance
  writeBufferSize: 64 * 1024 * 1024,  // 64MB
})

import { decode, encode } from 'cbor2';

export async function saveToDb(key: string, value: unknown) {
  // Convert string to Buffer for storage
  if (!value) throw new Error(`Value is empty: ${key}`)
  const buffer = Buffer.from(encode(value))
  await db.put(key, buffer)
}

export async function loadFromDb<Type = unknown>(key: string): Promise<Type> {
  const buffer = await db.get(key)
  if (!buffer) throw new Error(`Key not found: ${key}`)
  return decode(buffer) as Type
}
