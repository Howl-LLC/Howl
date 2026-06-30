// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for SSRF blocklist coverage.
 *
 * The blocklist must cover 100.64.0.0/10, 198.18.0.0/15, 203.0.113.0/24, and
 * 192.0.0.0/24, each of which can be reachable from a hosted backend's private
 * network.
 *
 * Canonicalisation matters: IPv4-mapped IPv6 addresses spelled in decimal-dotted
 * form (`[::ffff:169.254.169.254]`) are normalised by Node's `new URL()` parser
 * and `dns.lookup` to hex form (`[::ffff:a9fe:a9fe]`). If the check only matches
 * the decimal spelling, an authenticated user could smuggle an AWS/GCP metadata
 * or 100.64/10 destination past the blocklist. The tests below round-trip every
 * mapped address through `new URL()` to lock in canonical-bit checking; add
 * hex-form cases directly; and cover NAT64 and malformed IPv6.
 *
 * DNS-pinning behavior is not covered by a unit test because it requires either
 * a live attacker DNS server or a network-layer harness. The pinning code path
 * is exercised by integration.
 */

import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIP } from '../src/utils/safeFetch.js';

describe('isPrivateOrReservedIP — SSRF blocklist coverage', () => {
  describe('CIDRs present in the original blocklist', () => {
    it.each([
      ['10.0.0.1', '10.0.0.0/8 private'],
      ['172.16.5.5', '172.16.0.0/12 private'],
      ['172.31.255.255', '172.16.0.0/12 private (upper bound)'],
      ['192.168.1.1', '192.168.0.0/16 private'],
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'AWS/GCP link-local metadata'],
      ['0.0.0.0', 'this-network'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'broadcast'],
      ['localhost', 'named loopback'],
      ['metadata.google.internal', 'GCP metadata hostname'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('CIDRs that must be in the blocklist', () => {
    it.each([
      ['100.64.0.1', '100.64.0.0/10 CGNAT — hosted internal network'],
      ['100.127.255.255', '100.64.0.0/10 upper bound'],
      ['198.18.0.1', '198.18.0.0/15 RFC2544 benchmark'],
      ['198.19.255.255', '198.18.0.0/15 upper bound'],
      ['203.0.113.5', '203.0.113.0/24 TEST-NET-3'],
      ['192.0.0.5', '192.0.0.0/24 IETF protocol assignments'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('IPv4-mapped IPv6 (smuggling vector)', () => {
    it.each([
      ['[::ffff:127.0.0.1]', 'mapped loopback'],
      ['[::ffff:100.64.0.1]', 'mapped CGNAT'],
      ['[::ffff:169.254.169.254]', 'mapped GCP metadata'],
      ['[::127.0.0.1]', 'IPv4-compatible loopback'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('regression: mapped/compat addresses after `new URL()` normalisation', () => {
    // Node's `new URL()` rewrites every decimal-dotted IPv4-mapped IPv6 into hex
    // form. The prior implementation only matched the decimal spelling, so the
    // rewritten hostname slipped through. Every URL below is checked after going
    // through `new URL()` so future regressions in the canonicalisation path get
    // caught at CI.
    it.each([
      ['http://[::ffff:169.254.169.254]/', 'mapped AWS/GCP metadata via hex normalisation'],
      ['http://[::ffff:10.0.0.1]/', 'mapped 10.0.0.1 via hex'],
      ['http://[::ffff:127.0.0.1]/', 'mapped loopback via hex'],
      ['http://[::ffff:100.64.0.1]/', 'mapped CGNAT via hex'],
      ['http://[::ffff:192.168.1.1]/', 'mapped 192.168.1.1 via hex'],
      ['http://[::127.0.0.1]/', 'IPv4-compat loopback via hex'],
    ])('rejects %s (%s)', (url) => {
      const parsed = new URL(url);
      expect(isPrivateOrReservedIP(parsed.hostname)).toBe(true);
    });
  });

  describe('direct hex-form inputs (what `dns.lookup` returns)', () => {
    // `dns.lookup` returns addresses without brackets and in hex form. These
    // mirror what the resolved-IP blocklist check sees on the second call.
    it.each([
      ['::ffff:a9fe:a9fe', 'hex 169.254.169.254 — AWS/GCP metadata'],
      ['::ffff:a00:1', 'hex 10.0.0.1'],
      ['::ffff:7f00:1', 'hex 127.0.0.1'],
      ['::ffff:6440:1', 'hex 100.64.0.1 — CGNAT'],
      ['::ffff:c0a8:101', 'hex 192.168.1.1'],
      ['::ffff:a9fe:1', 'hex 169.254.0.1 — link-local'],
      ['::7f00:1', 'IPv4-compat hex 127.0.0.1'],
      ['::a9fe:a9fe', 'IPv4-compat hex 169.254.169.254'],
      ['0:0:0:0:0:ffff:a9fe:a9fe', 'fully expanded hex 169.254.169.254'],
      ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe', 'leading-zero fully expanded hex'],
      ['::FFFF:A9FE:A9FE', 'uppercase hex mapped — case insensitive'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('NAT64 well-known prefix 64:ff9b::/96', () => {
    it.each([
      ['64:ff9b::a9fe:a9fe', 'NAT64 → 169.254.169.254'],
      ['64:ff9b::a00:1', 'NAT64 → 10.0.0.1'],
      ['64:ff9b::6440:1', 'NAT64 → CGNAT'],
      ['64:ff9b::7f00:1', 'NAT64 → loopback'],
      ['64:ff9b::169.254.169.254', 'NAT64 mixed dotted-quad tail'],
      ['0064:ff9b:0000:0000:0000:0000:a9fe:a9fe', 'NAT64 fully expanded'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });

    // NAT64 pointed at a public IPv4 is still rejected because we unwrap before
    // checking — but if the target v4 is public, the unwrap returns false and
    // the base address itself is not in a reserved v6 range, so we pass it.
    // Documented to pin behaviour.
    it('passes NAT64 pointing at public IPv4 (e.g. 64:ff9b::8.8.8.8)', () => {
      expect(isPrivateOrReservedIP('64:ff9b::8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIP('64:ff9b::808:808')).toBe(false);
    });
  });

  describe('malformed IPv6 fails closed', () => {
    it.each([
      'foo:',
      '::foo:',
      'gggg::',
      '1:2:3:4:5:6:7:8:9',          // too many hextets
      '1:2:3:4:5:6:7',              // too few hextets, no `::`
      ':::',                          // triple colon
      '::ffff:1.2.3',               // incomplete dotted-quad
      '::ffff:1.2.3.256',           // octet > 255
      '::ffff:1.2.3.4.5',           // too many octets
      'a:b',                         // too few hextets
      'a:b:c:d:e:f:g:h',            // non-hex hextet
      '::12345',                     // hextet too long
    ])('rejects malformed %s', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('public IPv6 still passes', () => {
    it.each([
      ['2001:4860:4860::8888', 'Google DNS'],
      ['2606:4700:4700::1111', 'Cloudflare DNS'],
      ['2001:db8::1', 'documentation range — treated as public in this check'],
    ])('allows %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(false);
    });
  });

  describe('IPv6 private/reserved', () => {
    it.each([
      ['[::1]', 'loopback'],
      ['[fe80::1]', 'link-local'],
      ['[fc00::1]', 'unique-local'],
      ['[fd00::1]', 'unique-local'],
      ['[ff02::1]', 'multicast'],
    ])('rejects %s (%s)', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });

  describe('public addresses pass through', () => {
    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '151.101.1.195',
      'example.com',
      'www.google.com',
      '93.184.216.34',
    ])('allows %s', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(false);
    });
  });

  describe('malformed dotted-quad inputs reject', () => {
    it.each([
      '999.1.1.1',
      '256.0.0.1',
    ])('rejects malformed %s', (host) => {
      expect(isPrivateOrReservedIP(host)).toBe(true);
    });
  });
});
