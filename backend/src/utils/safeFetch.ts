// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * SSRF-safe fetch helper.
 *
 * Two guarantees on top of the built-in `fetch`:
 *   1. Every hop (initial URL + every redirect) is checked against a comprehensive
 *      private/reserved IP blocklist, including CIDRs that are reachable from a
 *      cloud provider's internal network (CGNAT 100.64.0.0/10, plus RFC2544 198.18/15,
 *      TEST-NET-3 203.0.113/24, and RFC6890 192.0.0/24).
 *   2. DNS is pinned: the hostname is resolved exactly once per hop, and the TCP
 *      connection is forced to that pinned IP. This closes the DNS-rebinding window
 *      that existed between `resolveAndCheckIP` and `fetch()` in the original code.
 *
 * IPv6 addresses that encode an IPv4 in their low 32 bits (IPv4-mapped `::ffff:A.B.C.D`,
 * deprecated IPv4-compatible `::A.B.C.D`, and NAT64 well-known `64:ff9b::/96`) are
 * canonicalised to bytes and re-checked against the v4 blocklist — this catches the
 * hex-form smuggling vector (`::ffff:a9fe:a9fe`) that Node's URL parser and
 * `dns.lookup` produce, which a decimal-only string regex misses.
 */

import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';

const MAX_REDIRECTS = 5;

/**
 * Check whether a hostname (or literal IP) is in a private/reserved range that
 * MUST NOT be reachable from user-controlled fetches.
 */
export function isPrivateOrReservedIP(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  const blocked = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'metadata.google.internal']);
  if (blocked.has(lowered)) return true;

  // IPv4 literal (dotted quad).
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isPrivateOrReservedIPv4(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));

  // Bracketed IPv6 literal. Also handle IPv4-mapped IPv6 (`::ffff:A.B.C.D`) and
  // IPv4-compatible IPv6 (`::A.B.C.D`) — these are known smuggling vectors.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return isPrivateOrReservedIPv6(hostname.slice(1, -1));
  }

  // Bare IPv6 literal (no brackets, but contains colon).
  if (hostname.includes(':')) {
    return isPrivateOrReservedIPv6(hostname);
  }

  return false;
}

function isPrivateOrReservedIPv4(a: number, b: number, _c: number, _d: number): boolean {
  if ([a, b, _c, _d].some((n) => n < 0 || n > 255 || Number.isNaN(n))) return true; // malformed → reject

  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (AWS/GCP metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 224.0.0.0/4 — multicast; 240.0.0.0/4 — reserved; 255.255.255.255 — broadcast
  if (a >= 224) return true;

  // 100.64.0.0/10 — Carrier-Grade NAT (cloud-provider internal networks)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 — RFC2544 benchmark
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 203.0.113.0/24 — TEST-NET-3 (RFC5737)
  if (a === 203 && b === 0 && _c === 113) return true;
  // 192.0.0.0/24 — IETF protocol assignments (RFC6890)
  if (a === 192 && b === 0 && _c === 0) return true;
  // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 0 && _c === 2) return true;
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && _c === 100) return true;

  return false;
}

/**
 * Parse an IPv6 literal into its 16 network-order bytes. Returns null on any
 * malformed input. Accepts `::` compression, dotted-quad tail (`::ffff:1.2.3.4`),
 * and RFC 4007 zone identifiers (stripped). This exists so the blocklist below
 * can match on canonical bits rather than string patterns — Node's URL parser
 * and `dns.lookup` normalise mapped addresses to hex form (`::ffff:a9fe:a9fe`),
 * so any regex keyed on decimal-dotted form will silently miss the hex form.
 */
function parseIPv6ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 45) return null;

  // Strip RFC 4007 zone identifier (e.g. `%eth0`).
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  // Expand optional trailing IPv4 dotted-quad into two hex hextets so the rest
  // of the parser can treat the address as hex-only.
  const quadMatch = s.match(/^(.*?:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (quadMatch) {
    const head = quadMatch[1]!;
    const octets = [quadMatch[2]!, quadMatch[3]!, quadMatch[4]!, quadMatch[5]!].map(Number);
    if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    const h1 = ((octets[0]! << 8) | octets[1]!).toString(16);
    const h2 = ((octets[2]! << 8) | octets[3]!).toString(16);
    s = head + h1 + ':' + h2;
  } else if (s.includes('.')) {
    // A dot anywhere other than a valid trailing quad → malformed.
    return null;
  }

  const dcParts = s.split('::');
  if (dcParts.length > 2) return null;

  let hextets: string[];
  if (dcParts.length === 2) {
    const left = dcParts[0] === '' ? [] : dcParts[0]!.split(':');
    const right = dcParts[1] === '' ? [] : dcParts[1]!.split(':');
    if (left.length + right.length > 7) return null;
    const zeros: string[] = new Array(8 - left.length - right.length).fill('0');
    hextets = [...left, ...zeros, ...right];
  } else {
    hextets = s.split(':');
    if (hextets.length !== 8) return null;
  }
  if (hextets.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const h = hextets[i]!;
    if (h.length === 0 || h.length > 4 || !/^[0-9a-fA-F]+$/.test(h)) return null;
    const n = parseInt(h, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    bytes[i * 2] = (n >>> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isPrivateOrReservedIPv6(inner: string): boolean {
  const b = parseIPv6ToBytes(inner);
  // Malformed → fail closed.
  if (b === null) return true;

  // :: (unspecified) and ::1 (loopback).
  let allZero = true;
  for (let i = 0; i < 16; i++) { if (b[i] !== 0) { allZero = false; break; } }
  if (allZero) return true;
  let loopbackHigh = true;
  for (let i = 0; i < 15; i++) { if (b[i] !== 0) { loopbackHigh = false; break; } }
  if (loopbackHigh && b[15] === 1) return true;

  // Regardless of literal form (decimal or hex), these encode an IPv4 in the low
  // 32 bits and MUST be re-checked against the v4 blocklist. Node normalises the
  // decimal-tail form (`::ffff:169.254.169.254`) into the hex form
  // (`::ffff:a9fe:a9fe`) during URL parsing and DNS resolution — the decimal-only
  // regex the prior implementation used never saw the normalised input.

  // IPv4-mapped `::ffff:A.B.C.D` — bytes 0-9 zero, bytes 10-11 = 0xFF.
  const isMapped =
    b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) return isPrivateOrReservedIPv4(b[12]!, b[13]!, b[14]!, b[15]!);

  // NAT64 well-known prefix `64:ff9b::/96` (RFC 6052).
  const isNat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0;
  if (isNat64) return isPrivateOrReservedIPv4(b[12]!, b[13]!, b[14]!, b[15]!);

  // Deprecated IPv4-compatible `::A.B.C.D` — bytes 0-11 zero. We've already
  // returned for `::` and `::1`, so any remaining all-zero-high address encodes
  // an IPv4 in the low 32 bits.
  let compatHigh = true;
  for (let i = 0; i < 12; i++) { if (b[i] !== 0) { compatHigh = false; break; } }
  if (compatHigh) return isPrivateOrReservedIPv4(b[12]!, b[13]!, b[14]!, b[15]!);

  // Link-local fe80::/10.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;

  // Unique-local fc00::/7 (fc00-fdff).
  if ((b[0]! & 0xfe) === 0xfc) return true;

  // Multicast ff00::/8.
  if (b[0] === 0xff) return true;

  return false;
}

/**
 * SSRF-safe, DNS-pinned fetch with manual redirect handling.
 *
 * Every hop:
 *   1. URL hostname is checked (literal IP form).
 *   2. Hostname is resolved exactly once; resolved IP is checked.
 *   3. undici Agent is bound to that pinned IP for the connection, so the TCP
 *      layer never re-resolves behind our back.
 */
export async function safeFetch(
  url: string,
  accept = 'text/html,application/xhtml+xml',
  externalSignal?: AbortSignal,
): Promise<globalThis.Response> {
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(currentUrl);
    if (isPrivateOrReservedIP(parsed.hostname)) {
      throw new Error('SSRF: hostname resolves or is private/reserved');
    }

    let resolved: { address: string; family: number };
    try {
      resolved = await lookup(parsed.hostname);
    } catch {
      throw new Error('SSRF: DNS resolution failed');
    }
    if (isPrivateOrReservedIP(resolved.address)) {
      throw new Error(`SSRF: resolved IP ${resolved.address} is private/reserved`);
    }

    const pinnedIP = resolved.address;
    const pinnedFamily = resolved.family as 4 | 6;

    const pinnedAgent = new Agent({
      connect: {
        // Node ≥18's net stack passes `{ all: true }` to the connector's lookup hook
        // and expects `cb(null, [{address, family}])`; older callers still use the
        // legacy `cb(null, address, family)` form. Handle both — calling the legacy
        // signature when `all: true` is set yields `Invalid IP address: undefined`
        // because Node tries to read addresses[0].address from a bare string.
        lookup: ((_host: string, opts: { all?: boolean } | undefined, cb: (err: NodeJS.ErrnoException | null, addressOrList: string | { address: string; family: number }[], family?: number) => void) => {
          if (opts && opts.all) {
            cb(null, [{ address: pinnedIP, family: pinnedFamily }]);
          } else {
            cb(null, pinnedIP, pinnedFamily);
          }
        }) as unknown as Agent.Options['connect'] extends { lookup?: infer L } ? L : never,
      },
    });

    const timeoutSignal = AbortSignal.timeout(5000);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    let response: globalThis.Response;
    try {
      response = await fetch(currentUrl, {
        signal,
        redirect: 'manual',
        // `dispatcher` is an undici-specific RequestInit extension; Node's global
        // fetch is undici under the hood.
        // @ts-expect-error — `dispatcher` is not in the standard RequestInit type.
        dispatcher: pinnedAgent,
        headers: {
          'User-Agent': 'HowlBot/1.0 (+https://howlpro.com)',
          Accept: accept,
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
    } finally {
      // Close the per-request Agent so its sockets/pools don't linger.
      pinnedAgent.close().catch(() => { /* ignore */ });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without Location header');
      currentUrl = new URL(location, currentUrl).href;
      const rp = new URL(currentUrl);
      if (rp.protocol !== 'http:' && rp.protocol !== 'https:') {
        throw new Error('Redirect to non-HTTP protocol blocked');
      }
      continue;
    }

    return response;
  }

  throw new Error('Too many redirects');
}
