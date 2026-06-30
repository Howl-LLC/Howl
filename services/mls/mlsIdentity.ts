// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import nacl from 'tweetnacl';
import {
  generateKeyPackageWithKey,
  type Credential,
  type Lifetime,
  type PrivateKeyPackage,
  type KeyPackage,
} from 'ts-mls';
import { encodeKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl, supportedCapabilities } from './ciphersuite';
import type { MlsIdentity, GeneratedKeyPackage } from './mlsEngine';

/** Single-use KeyPackages minted per replenish batch. */
export const KEYPACKAGE_BATCH_SIZE = 20;
/** Replenish when remaining single-use packages drop below this. */
export const KEYPACKAGE_LOW_WATER = 5;
/** Requested KeyPackage lifetime; the server clamps to 30 days. */
export const KEYPACKAGE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Requested last-resort KeyPackage lifetime: ~100 years (finite, NOT int64-max).
 * The server clamps to a 100-year FINITE ceiling; new Date(this) must stay a valid
 * Date. A last-resort never expires in practice but is rotated by the
 * boot provisioner each run, superseded server-side (one live last-resort per device).
 */
export const KEYPACKAGE_LASTRESORT_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// Versioned (v2) Basic-credential identity (byte-identical to backend)
// Layout (169 bytes): version@0 | userId@1(36) | deviceId@37(36) | AIK_pub@73(32)
//                     | crossSig@105(64). The AIK (Ed25519) cross-signs the
// device leaf signing key over DEVICE_XSIG_LABEL ‖ userId ‖ deviceId ‖ leafPub.
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

/** Versioned Basic-credential identity carrying the AIK cross-signature (matches backend). */
export function encodeMlsCredentialIdentity(
  userId: string, deviceId: string, aikPub: Uint8Array, crossSig: Uint8Array,
): Uint8Array {
  if (!UUID_RE.test(userId)) throw new Error('encodeMlsCredentialIdentity: userId is not a UUID');
  if (!UUID_RE.test(deviceId)) throw new Error('encodeMlsCredentialIdentity: deviceId is not a UUID');
  if (aikPub.length !== AIK_PUB_LEN) throw new Error('encodeMlsCredentialIdentity: aikPub must be 32 bytes');
  if (crossSig.length !== CROSS_SIG_LEN) throw new Error('encodeMlsCredentialIdentity: crossSig must be 64 bytes');
  const out = new Uint8Array(ID_LEN);
  out[0] = MLS_CREDENTIAL_VERSION;
  const enc = new TextEncoder();
  out.set(enc.encode(userId), OFF_USER);
  out.set(enc.encode(deviceId), OFF_DEVICE);
  out.set(aikPub, OFF_AIK);
  out.set(crossSig, OFF_SIG);
  return out;
}

/** Inverse of encodeMlsCredentialIdentity. Throws (fail closed) on bad length/version/UUID. */
export function decodeMlsCredentialIdentity(bytes: Uint8Array): {
  version: number; userId: string; deviceId: string; aikPub: Uint8Array; crossSig: Uint8Array;
} {
  if (bytes.length !== ID_LEN) throw new Error('decodeMlsCredentialIdentity: unexpected length');
  if (bytes[0] !== MLS_CREDENTIAL_VERSION) throw new Error('decodeMlsCredentialIdentity: unsupported version');
  const dec = new TextDecoder();
  const userId = dec.decode(bytes.subarray(OFF_USER, OFF_DEVICE));
  const deviceId = dec.decode(bytes.subarray(OFF_DEVICE, OFF_AIK));
  if (!UUID_RE.test(userId)) throw new Error('decodeMlsCredentialIdentity: userId is not a UUID');
  if (!UUID_RE.test(deviceId)) throw new Error('decodeMlsCredentialIdentity: deviceId is not a UUID');
  return {
    version: bytes[0],
    userId,
    deviceId,
    aikPub: bytes.slice(OFF_AIK, OFF_SIG),
    crossSig: bytes.slice(OFF_SIG, ID_LEN),
  };
}

/** The raw Ed25519 message the AIK signs to bind a device leaf (matches backend). */
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

/**
 * Cross-sign a device leaf signing key with the account identity key (AIK,
 * Ed25519, via nacl) and pack the v2 credential identity. Raw Ed25519 over
 * DEVICE_XSIG_LABEL ‖ userId ‖ deviceId ‖ leafSigningPublicKey — NOT signWithLabel.
 */
export function buildCrossSignedCredentialIdentity(
  userId: string, deviceId: string, leafSigningPublicKey: Uint8Array,
  aikPub: Uint8Array, aikPriv: Uint8Array,
): Uint8Array {
  const msg = buildDeviceXsigMessage(userId, deviceId, leafSigningPublicKey);
  const crossSig = nacl.sign.detached(msg, aikPriv); // 64-byte Ed25519 detached sig
  return encodeMlsCredentialIdentity(userId, deviceId, aikPub, crossSig);
}

/** Mint a fresh leaf signing keypair (boot phase 1; not yet cross-signed). */
export async function mintLeafKeypair(): Promise<{ signKey: Uint8Array; publicKey: Uint8Array }> {
  return freshSigningKeyPair(); // existing private helper (impl.signature.keygen)
}

export interface MlsIdentityBundle {
  identity: MlsIdentity;
  userId: string;
  deviceId: string;
}

/**
 * Generate a fresh stable signing keypair + credential for (userId, deviceId).
 * Called at setup. The signing key is the long-lived identity; every KeyPackage
 * reuses it via generateKeyPackageWithKey.
 *
 * `deviceId` is minted by dmKeyManager (crypto.randomUUID) and persisted in the
 * blob; it is passed in here, so this module has no store dependency.
 */
export async function createIdentity(
  userId: string, deviceId: string, aikPub: Uint8Array, aikPriv: Uint8Array,
): Promise<MlsIdentityBundle> {
  const { signKey, publicKey } = await freshSigningKeyPair();
  const credentialIdentity = buildCrossSignedCredentialIdentity(userId, deviceId, publicKey, aikPub, aikPriv);
  return {
    identity: {
      signaturePublicKey: publicKey,
      signaturePrivateKey: signKey,
      credentialIdentity,
    },
    userId,
    deviceId,
  };
}

/**
 * Generate `count` single-use KeyPackages plus (optionally) one last-resort,
 * all reusing the identity's stable signing key. last-resort is an app-layer
 * marker (ts-mls has no native last_resort extension); it is tracked on the
 * result, not embedded in the wire bytes.
 */
export async function generateKeyPackages(
  identity: MlsIdentity,
  count: number,
  includeLastResort: boolean,
): Promise<GeneratedKeyPackage[]> {
  const impl = await getImpl();
  const credential: Credential = { credentialType: 'basic', identity: identity.credentialIdentity };
  const signatureKeyPair = {
    signKey: identity.signaturePrivateKey,
    publicKey: identity.signaturePublicKey,
  };

  const out: GeneratedKeyPackage[] = [];
  const total = count + (includeLastResort ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const isLastResort = includeLastResort && i === total - 1;
    const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
      credential,
      supportedCapabilities(),
      requestLifetime(isLastResort),
      [],
      signatureKeyPair,
      impl,
    );
    const keyPackage = encodeKeyPackage(publicPackage);
    const keyPackageRef = await makeKeyPackageRef(publicPackage, impl.hash);
    out.push({
      keyPackage,
      keyPackageRef,
      privateKeyPackage: serializePrivateKeyPackage(privatePackage, publicPackage),
      isLastResort,
    });
  }
  return out;
}

/**
 * Request a real (non-max-int64) lifetime. Single-use packages request +30d (server
 * clamps to 30d); a last-resort requests ~100 years (server clamps to a 100-year
 * FINITE ceiling). Never int64-max - the AS Math.min over a finite ceiling must
 * yield a valid Date.
 */
function requestLifetime(isLastResort: boolean): Lifetime {
  const ms = isLastResort ? KEYPACKAGE_LASTRESORT_LIFETIME_MS : KEYPACKAGE_LIFETIME_MS;
  return {
    notBefore: 0n,
    notAfter: BigInt(Math.floor((Date.now() + ms) / 1000)),
  };
}

/** Generate a fresh Ed25519 signing keypair via the ciphersuite signature impl. */
async function freshSigningKeyPair(): Promise<{ signKey: Uint8Array; publicKey: Uint8Array }> {
  const impl = await getImpl();
  // ts-mls 1.6.2: signature.keygen() resolves { publicKey, signKey }.
  const { signKey, publicKey } = await impl.signature.keygen();
  return { signKey, publicKey };
}

/**
 * Serialize a PrivateKeyPackage to the JSON-triple shape mlsEngine.joinFromWelcome
 * reads. ts-mls exports no PrivateKeyPackage codec, so we encode the three private
 * keys (base64) plus the public KeyPackage bytes needed to reconstruct the pair.
 */
function serializePrivateKeyPackage(priv: PrivateKeyPackage, pub: KeyPackage): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      initPrivateKey: bytesToB64(priv.initPrivateKey),
      hpkePrivateKey: bytesToB64(priv.hpkePrivateKey),
      signaturePrivateKey: bytesToB64(priv.signaturePrivateKey),
      keyPackage: bytesToB64(encodeKeyPackage(pub)),
    }),
  );
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
