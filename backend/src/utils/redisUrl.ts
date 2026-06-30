// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Robust REDIS_URL parser.
 *
 * Node's WHATWG URL parser (`new URL`) — and ioredis's URL handling — both
 * choke on passwords that contain unescaped special characters like `@`,
 * `%`, `#`, `!`, `$`. That's a real failure mode after a manual password
 * rotation: backend booted, `await import('./queues/connection.js')` ran
 * `new URL(REDIS_URL)`, and every cluster worker crashed at startup with
 * `TypeError: Invalid URL`.
 *
 * This parser splits the URL by hand so any literal characters in the
 * password are passed through to ioredis verbatim. The password is treated
 * as a literal string — we don't apply percent-decoding, because doing so
 * would corrupt passwords that happen to contain `%XX` sequences.
 *
 * Returns ioredis ConnectionOptions ready to pass to `new Redis(opts)`.
 */

export type RedisConnectionOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: { rejectUnauthorized: boolean };
};

export function parseRedisUrl(url: string): RedisConnectionOptions {
  const tls = url.startsWith('rediss://');
  const scheme = tls ? 'rediss://' : 'redis://';
  if (!url.startsWith(scheme)) {
    throw new Error(`parseRedisUrl: expected redis:// or rediss:// scheme, got "${url.slice(0, 12)}..."`);
  }
  let rest = url.slice(scheme.length);

  // Split credentials from authority at the LAST '@'.
  // The password may itself contain '@' — many managed providers' auto-generated
  // passwords don't, but rotated passwords might.
  let username: string | undefined;
  let password: string | undefined;
  const lastAt = rest.lastIndexOf('@');
  if (lastAt >= 0) {
    const creds = rest.slice(0, lastAt);
    rest = rest.slice(lastAt + 1);
    const firstColon = creds.indexOf(':');
    if (firstColon >= 0) {
      username = creds.slice(0, firstColon) || undefined;
      password = creds.slice(firstColon + 1) || undefined;
    } else {
      username = creds || undefined;
    }
  }

  // Parse host[:port][/db]. Handle IPv6 in brackets: [::1]:6379
  let host: string;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) throw new Error('parseRedisUrl: unterminated IPv6 bracket');
    host = rest.slice(1, close);
    rest = rest.slice(close + 1);
  } else {
    const m = rest.match(/^([^:/?#]+)/);
    if (!m) throw new Error('parseRedisUrl: missing host');
    host = m[1];
    rest = rest.slice(host.length);
  }

  let port = 6379;
  if (rest.startsWith(':')) {
    const m = rest.slice(1).match(/^(\d+)/);
    if (m) {
      port = parseInt(m[1], 10);
      rest = rest.slice(1 + m[1].length);
    }
  }

  let db: number | undefined;
  if (rest.startsWith('/')) {
    const m = rest.slice(1).match(/^(\d+)/);
    if (m) db = parseInt(m[1], 10);
  }

  const opts: RedisConnectionOptions = { host, port };
  if (username) opts.username = username;
  if (password) opts.password = password;
  if (db !== undefined) opts.db = db;
  if (tls) opts.tls = { rejectUnauthorized: true };
  return opts;
}
