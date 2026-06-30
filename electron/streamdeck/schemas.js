// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';
const { z } = require('zod');

// Keep these values in lockstep with shared/streamdeck/types.ts.
// __tests__/streamdeck/types-parity.test.ts enforces parity.
const SUPPORTED_PROTOCOL_VERSIONS = [1];
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9.-]{1,127}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const uuidField = z.string().uuid();
const vField = z.number().int().refine((v) => SUPPORTED_PROTOCOL_VERSIONS.includes(v), {
  message: 'unsupported-version',
});

const base = {
  v: vField,
  id: uuidField,
};

const pairRequestSchema = z.object({
  ...base,
  kind: z.literal('command'),
  type: z.literal('pair'),
  pluginId: z.string().regex(PLUGIN_ID_RE),
  displayName: z.string().min(1).max(64),
  version: z.string().regex(SEMVER_RE).max(32),
  challenge: z.string().length(64).regex(/^[0-9a-f]+$/),
}).strict();

const authSchema = z.object({
  ...base,
  kind: z.literal('command'),
  type: z.literal('auth'),
  token: z.string().min(1).max(256),
}).strict();

const subscribeSchema = z.object({
  ...base,
  kind: z.literal('command'),
  type: z.literal('subscribe'),
  topics: z.array(z.enum([
    'state.voice', 'state.call', 'state.presence', 'state.dm-presence',
    'state.unread', 'state.focused-channel', 'state.thread-stage',
    'state.e2ee', 'state.bridge',
  ])).min(1).max(20),
}).strict();

const executeSchema = z.object({
  ...base,
  kind: z.literal('command'),
  type: z.literal('execute'),
  action: z.string().min(1).max(64),
  params: z.record(z.unknown()).optional(),
}).strict();

const listSchema = z.object({
  ...base,
  kind: z.literal('command'),
  type: z.literal('list'),
  resource: z.enum(['servers', 'channels', 'dms', 'custom-emoji', 'pinned-dms']),
  params: z.record(z.unknown()).optional(),
}).strict();

const anyCommandSchema = z.discriminatedUnion('type', [
  pairRequestSchema, authSchema, subscribeSchema, executeSchema, listSchema,
]);

// Outbound (bridge → plugin) frames are NOT strict — additive evolution allowed.
const responseSchema = z.object({
  ...base,
  kind: z.literal('response'),
  type: z.string(),
  data: z.unknown().optional(),
});

const errorSchema = z.object({
  ...base,
  kind: z.literal('error'),
  code: z.string(),
  detail: z.string().optional(),
});

const eventSchema = z.object({
  ...base,
  kind: z.literal('event'),
  topic: z.string(),
  snapshot: z.boolean(),
  data: z.unknown(),
});

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  PLUGIN_ID_RE,
  OFFICIAL_PLUGIN_ID: 'com.howlpro.streamdeck',
  pairRequestSchema,
  authSchema,
  subscribeSchema,
  executeSchema,
  listSchema,
  anyCommandSchema,
  responseSchema,
  errorSchema,
  eventSchema,
  MAX_FRAME_BYTES: 128 * 1024,
};
