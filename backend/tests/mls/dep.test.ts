// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  generateKeyPackage,
  defaultCapabilities,
  defaultLifetime,
  type Credential,
} from 'ts-mls';

describe('ts-mls is a usable backend dependency', () => {
  it('instantiates ciphersuite id 83 and generates a KeyPackage', async () => {
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName('MLS_256_XWING_AES256GCM_SHA512_Ed25519'),
    );
    expect(impl.name).toBe('MLS_256_XWING_AES256GCM_SHA512_Ed25519');

    const credential: Credential = {
      credentialType: 'basic',
      identity: new TextEncoder().encode('dep-test'),
    };
    const { publicPackage, privatePackage } = await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl,
    );
    expect(publicPackage.version).toBe('mls10');
    expect(privatePackage.initPrivateKey.length).toBeGreaterThan(0);
  });
});
