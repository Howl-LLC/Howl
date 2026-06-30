// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const schemas = require('./schemas.js');
const rl = require('./rate-limiter.js');
const tokenStore = require('./token-store.js');
const fingerprint = require('./fingerprint.js');
const log = require('./log.js');

const HOST_ALLOWLIST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const MAX_SCHEMA_FAILS_PER_CONN = 3;
const SCHEMA_FAIL_CLOSE_CODE = 4400;
const MAX_CONCURRENT_AUTHED = 4;
const MAX_CONCURRENT_UNAUTHED = 2;

const PAIR_LIMIT = { max: 3, windowMs: 5 * 60 * 1000 };
const EXECUTE_LIMITS = {
  'presence.set':             { max: 1, windowMs: 1000 },
  'reaction.react-focused':   { max: 2, windowMs: 1000 },
  'channel.switch':           { max: 5, windowMs: 1000 },
  'thread.lock-toggle':       { max: 2, windowMs: 1000 },
  'stage.remove-speaker':     { max: 2, windowMs: 1000 },
  _default:                   { max: 10, windowMs: 1000 },
};

async function start(opts) {
  const { userDataDir, installId, onPairRequest, onExecute, onListResource, onSubscribe } = opts;

  const pairLimiter = rl.create(PAIR_LIMIT);
  const execLimiters = new Map();
  function execLimiterFor(action) {
    const cfg = EXECUTE_LIMITS[action] || EXECUTE_LIMITS._default;
    let l = execLimiters.get(action);
    if (!l) { l = rl.create(cfg); execLimiters.set(action, l); }
    return l;
  }

  const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  // Transport-level cap slightly above our soft limit so oversized frames
  // reach our handler (which replies with a structured error) rather than
  // being closed by the ws library before we can tell the plugin why.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * schemas.MAX_FRAME_BYTES });

  const connections = new Set();

  httpServer.on('upgrade', (req, socket, head) => {
    // Loopback check
    const remote = socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      socket.destroy(); return;
    }
    // Origin rejection
    if (req.headers.origin) { socket.destroy(); return; }
    // Host allowlist (DNS-rebinding defense)
    const host = req.headers.host || '';
    if (!HOST_ALLOWLIST_RE.test(host)) { socket.destroy(); return; }
    // Path
    if (req.url !== '/bridge') { socket.destroy(); return; }

    // Connection caps (unauthed at upgrade time; authed counted after auth)
    const unauthed = [...connections].filter((c) => !c.authed).length;
    if (unauthed >= MAX_CONCURRENT_UNAUTHED) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const conn = {
      ws,
      authed: false,
      pluginId: null,
      schemaFails: 0,
    };
    connections.add(conn);

    ws.on('message', async (raw) => {
      // size check
      if (raw.length > schemas.MAX_FRAME_BYTES) {
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), kind: 'error', code: 'frame-too-large' }));
        return;
      }

      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); }
      catch {
        conn.schemaFails++;
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), kind: 'error', code: 'schema' }));
        if (conn.schemaFails >= MAX_SCHEMA_FAILS_PER_CONN) ws.close(SCHEMA_FAIL_CLOSE_CODE, 'schema');
        return;
      }

      // Version gate BEFORE strict parsing so we can return a useful error
      if (parsed && typeof parsed === 'object' && !schemas.SUPPORTED_PROTOCOL_VERSIONS.includes(parsed.v)) {
        ws.send(JSON.stringify({ v: 1, id: parsed.id || crypto.randomUUID(), kind: 'error', code: 'unsupported-version', detail: JSON.stringify(schemas.SUPPORTED_PROTOCOL_VERSIONS) }));
        return;
      }

      const parsedCmd = schemas.anyCommandSchema.safeParse(parsed);
      if (!parsedCmd.success) {
        conn.schemaFails++;
        ws.send(JSON.stringify({ v: 1, id: (parsed && parsed.id) || crypto.randomUUID(), kind: 'error', code: 'schema' }));
        if (conn.schemaFails >= MAX_SCHEMA_FAILS_PER_CONN) ws.close(SCHEMA_FAIL_CLOSE_CODE, 'schema');
        return;
      }

      const cmd = parsedCmd.data;

      if (cmd.type === 'pair') {
        // per-install rate limit — key is intentionally constant across sources
        const rlRes = pairLimiter.tryHitWithRetryAfter('install');
        if (!rlRes.ok) {
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'pair-rate-limited', detail: String(rlRes.retryAfterMs) }));
          return;
        }

        const fp = fingerprint.derive({ pluginId: cmd.pluginId, challenge: cmd.challenge, installId });
        // Fingerprint is logged for support diagnostics; not surfaced in UI.
        log.info('pair-request', { pluginId: cmd.pluginId, fp: fp.display });

        let decision;
        try {
          decision = await onPairRequest({
            pluginId: cmd.pluginId,
            displayName: cmd.displayName,
            version: cmd.version,
            fingerprint: fp,
            isOfficialId: cmd.pluginId === schemas.OFFICIAL_PLUGIN_ID,
          });
        } catch (err) {
          log.error('pair-callback-failed', { error: String(err && err.message || err) });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'internal' }));
          return;
        }

        if (decision.decision !== 'allow') {
          log.info('pair-denied', { pluginId: cmd.pluginId });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'pair-denied' }));
          return;
        }

        const token = tokenStore.generateToken();
        try {
          tokenStore.storePairing(userDataDir, installId, {
            pluginId: cmd.pluginId, displayName: cmd.displayName, version: cmd.version, token,
          });
        } catch (err) {
          log.error('pair-store-failed', { error: String(err && err.message || err) });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'pair-storage', detail: String(err && err.message || '') }));
          return;
        }

        conn.authed = true;
        conn.pluginId = cmd.pluginId;
        log.info('pair-accepted', { pluginId: cmd.pluginId, tp: log.tokenPrefix(token) });
        ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'response', type: 'pair-accepted', data: { token } }));
        return;
      }

      if (cmd.type === 'auth') {
        const authed = [...connections].filter((c) => c.authed).length;
        if (authed >= MAX_CONCURRENT_AUTHED) {
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'too-many-connections' }));
          return;
        }
        // Scan all pairings for this install to find matching token
        const pairings = tokenStore.listPairings(userDataDir, installId);
        let match = null;
        for (const p of pairings) {
          if (tokenStore.verifyToken(userDataDir, installId, p.pluginId, cmd.token)) {
            match = p; break;
          }
        }
        if (!match) {
          log.warn('auth-fail', { tp: log.tokenPrefix(cmd.token) });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'not-paired' }));
          return;
        }
        conn.authed = true;
        conn.pluginId = match.pluginId;
        ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'response', type: 'auth-ok', data: { pluginId: match.pluginId } }));
        return;
      }

      if (!conn.authed) {
        ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'not-paired' }));
        return;
      }

      if (cmd.type === 'subscribe') {
        try {
          const snapshots = onSubscribe ? await onSubscribe({ pluginId: conn.pluginId, topics: cmd.topics }) : [];
          for (const snap of snapshots) {
            ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), kind: 'event', topic: snap.topic, snapshot: true, data: snap.data }));
          }
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'response', type: 'subscribed' }));
        } catch (err) {
          log.error('subscribe-failed', { error: String(err && err.message || err) });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'internal' }));
        }
        return;
      }

      if (cmd.type === 'execute') {
        const limRes = execLimiterFor(cmd.action).tryHitWithRetryAfter(conn.pluginId);
        if (!limRes.ok) {
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'rate-limited', detail: String(limRes.retryAfterMs) }));
          return;
        }
        try {
          const result = await onExecute({ pluginId: conn.pluginId, action: cmd.action, params: cmd.params || {} });
          if (result && result.code) {
            ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: result.code, detail: result.detail }));
          } else {
            ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'response', type: 'execute-ok', data: result?.data }));
          }
        } catch (err) {
          log.error('execute-failed', { error: String(err && err.message || err), action: cmd.action });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'internal' }));
        }
        return;
      }

      if (cmd.type === 'list') {
        try {
          const data = await onListResource({ pluginId: conn.pluginId, resource: cmd.resource, params: cmd.params || {} });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'response', type: 'list-ok', data }));
        } catch (err) {
          log.error('list-failed', { error: String(err && err.message || err), resource: cmd.resource });
          ws.send(JSON.stringify({ v: 1, id: cmd.id, kind: 'error', code: 'internal' }));
        }
        return;
      }
    });

    ws.on('close', () => { connections.delete(conn); });
    ws.on('error', () => { /* swallow; socket will close */ });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve(undefined));
  });

  const addr = httpServer.address();
  log.info('bridge-started', { port: addr.port });

  function broadcastEvent(topic, data) {
    const frame = JSON.stringify({ v: 1, id: crypto.randomUUID(), kind: 'event', topic, snapshot: false, data });
    for (const c of connections) {
      if (c.authed && c.ws.readyState === 1) c.ws.send(frame);
    }
  }

  async function stop() {
    for (const c of connections) { try { c.ws.close(); } catch { /* ignored */ } }
    connections.clear();
    await new Promise((r) => wss.close(() => r()));
    await new Promise((r) => httpServer.close(() => r()));
    log.info('bridge-stopped');
  }

  return {
    port: addr.port,
    address: addr.address,
    broadcastEvent,
    stop,
  };
}

module.exports = { start };
