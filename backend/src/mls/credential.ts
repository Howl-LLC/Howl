// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MLS_CREDENTIAL_VERSION = 2;
export const DEVICE_XSIG_LABEL = 'howl:mls:device-xsig:v1';

const UUID_LEN = 36;
const AIK_PUB_LEN = 32;
const CROSS_SIG_LEN = 64;
const ID_LEN = 1 + UUID_LEN * 2 + AIK_PUB_LEN + CROSS_SIG_LEN; // 169
const OFF_USER = 1;
const OFF_DEVICE = OFF_USER + UUID_LEN;     // 37
const OFF_AIK = OFF_DEVICE + UUID_LEN;      // 73
const OFF_SIG = OFF_AIK + AIK_PUB_LEN;      // 105

export interface MlsIdentity {
  version: number;
  userId: string;
  deviceId: string;
  aikPub: Uint8Array;
  crossSig: Uint8Array;
}

/** Versioned Basic-credential identity carrying the AIK cross-signature. */
export function encodeMlsIdentity(
  userId: string, deviceId: string, aikPub: Uint8Array, crossSig: Uint8Array,
): Uint8Array {
  if (!UUID_RE.test(userId)) throw new Error('encodeMlsIdentity: userId is not a UUID');
  if (!UUID_RE.test(deviceId)) throw new Error('encodeMlsIdentity: deviceId is not a UUID');
  if (aikPub.length !== AIK_PUB_LEN) throw new Error('encodeMlsIdentity: aikPub must be 32 bytes');
  if (crossSig.length !== CROSS_SIG_LEN) throw new Error('encodeMlsIdentity: crossSig must be 64 bytes');
  const out = new Uint8Array(ID_LEN);
  out[0] = MLS_CREDENTIAL_VERSION;
  const enc = new TextEncoder();
  out.set(enc.encode(userId), OFF_USER);
  out.set(enc.encode(deviceId), OFF_DEVICE);
  out.set(aikPub, OFF_AIK);
  out.set(crossSig, OFF_SIG);
  return out;
}

/** Inverse of encodeMlsIdentity. Throws (fail closed) on bad length/version/UUID. */
export function decodeMlsIdentity(bytes: Uint8Array): MlsIdentity {
  if (bytes.length !== ID_LEN) throw new Error('decodeMlsIdentity: unexpected length');
  if (bytes[0] !== MLS_CREDENTIAL_VERSION) throw new Error('decodeMlsIdentity: unsupported version');
  const dec = new TextDecoder();
  const userId = dec.decode(bytes.subarray(OFF_USER, OFF_DEVICE));
  const deviceId = dec.decode(bytes.subarray(OFF_DEVICE, OFF_AIK));
  if (!UUID_RE.test(userId)) throw new Error('decodeMlsIdentity: userId is not a UUID');
  if (!UUID_RE.test(deviceId)) throw new Error('decodeMlsIdentity: deviceId is not a UUID');
  return {
    version: bytes[0],
    userId,
    deviceId,
    aikPub: bytes.slice(OFF_AIK, OFF_SIG),
    crossSig: bytes.slice(OFF_SIG, ID_LEN),
  };
}

/** The raw Ed25519 message the AIK signs to bind a device leaf. */
export function buildDeviceXsigMessage(
  userId: string, deviceId: string, leafSigningPublicKey: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(DEVICE_XSIG_LABEL), enc.encode(userId), enc.encode(deviceId), leafSigningPublicKey];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
