// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Web Worker for Argon2id key derivation.
 * Runs the CPU-intensive hash-wasm argon2id off the main thread.
 */
import { argon2id } from 'hash-wasm';

export interface Argon2Request {
  requestId?: number;
  password: string;
  salt: Uint8Array;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
}

export interface Argon2Response {
  requestId?: number;
  hash?: Uint8Array;
  error?: string;
}

self.onmessage = async (e: MessageEvent<Argon2Request>) => {
  const { requestId, password, salt, parallelism, iterations, memorySize, hashLength } = e.data;
  try {
    const hash = await argon2id({
      password,
      salt,
      parallelism,
      iterations,
      memorySize,
      hashLength,
      outputType: 'binary',
    });
    (self as unknown as Worker).postMessage({ requestId, hash } satisfies Argon2Response, [hash.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ requestId, error: String(err) } satisfies Argon2Response);
  }
};
