# Protocol Change Checklist

Any change to a Socket.IO event, REST payload, or E2EE crypto must follow
these rules.

## Decision tree

Before changing anything, answer in order:

1. **New event or endpoint?** Free: add it. Old clients ignore what they don't subscribe to.
2. **New field on an existing payload?** Mark it `.optional()`. Default to the pre-existing behavior when missing. No further action.
3. **Removing a field?** Stop. Ship code that stops reading/writing the field, wait 60 days, bump `protocolVersion`, then remove.
4. **Renaming or repurposing a field or event?** Stop. Add a new name; dual-emit and dual-accept for ≥60 days; bump `protocolVersion`; remove the old form.
5. **Changing E2EE crypto (cipher, KDF, key exchange format)?** Stop. Add as a new capability (`sframe.v2`), keep `sframe.v1` as the eternal baseline. Ship client-side before any leader uses it.
6. **Bumping `protocolVersion`?** Last resort: it resets the 60-day compat window for anyone below the new floor. Justify in the PR description. Requires `compat-break-approved` label.
7. **Changing a Prisma migration?** Additive only (nullable columns, defaults). Destructive changes (`DROP COLUMN`, `RENAME COLUMN`, type changes) require `compat-break-approved` + a two-phase deploy plan in the PR description.

## CI gate

Every PR touching `backend/src/socketSchemas.ts`, `backend/src/routes/**`,
`services/voiceE2ee.ts`, `services/stageE2ee.ts`, `shared/protocol.ts`,
`backend/src/protocol.ts`, or `backend/prisma/migrations/` runs
`scripts/check-schema-compat.ts`. Failures block merge; override requires
the `compat-break-approved` label plus a matching `protocolVersion` bump
or a documented two-phase deploy.

## When in doubt

Read the spec. If still unsure, the safe default is always "add a new field
or event, don't touch existing ones."

## Stream Deck plugin protocol

The plugin protocol (`shared/streamdeck/types.ts`, `electron/streamdeck/schemas.js`)
follows the same additive rules.

- Inbound (plugin → bridge) command schemas are `.strict()`. Adding a new
  command type is fine; new fields on an existing command are not.
- Outbound (bridge → plugin) frames are NOT strict (`responseSchema`,
  `errorSchema`, `eventSchema`). Adding a new `kind` is additive; the
  plugin's `handleMessage` ignores frames it does not recognize.

## 2026-04-21 - viewer tracking events

Additive. No client-side enforcement needed.

Client → server:
- `viewer:subscribe { context: { kind, scopeId }, streamOwnerId, streamType: 'screen' }`, ack: `{ ok: boolean; error?: string }`.
- `viewer:unsubscribe { context, streamOwnerId, streamType }`, ack: same.
- `viewer:list { context, streamOwnerId, streamType, page? }`, ack: `{ ok: boolean; viewers?: string[]; nextPage?: number; error?: string }`.

Server → client (broadcast to room):
- `viewer:changed { context, streamOwnerId, streamType, add?: string[], remove?: string[] }`, coalesced on 100 ms window per stream key.
- `viewer:cleared { context, streamOwnerId, streamType }`, emitted when the stream ends.

Schemas use `.passthrough()` (additive). Room determined by existing voice/dm/stage membership.

## 2026-04-24 - server-driven room auto-subscribe on connect

Additive behavior change. No payload schema changes. No `protocolVersion` bump.

**Before:** On connect, the client emitted one `join-server`, `join-channel`, and `join-dm` event per resource it was a member of, so the server could call `socket.join` for each. For users in ~3+ populated servers this routinely exceeded the 30-events-per-10-seconds `checkSocketRateLimit` counter and silently throttled their first in-session action (e.g. `join-dm-call` → "Rate limited").

**After:** On every (re)connect, `backend/src/socketHandlers/connection.ts` batch-loads the user's `ServerMember` (with roles + @everyone), text-`Channel` rows, override tables, `ServerBan`, and `DMParticipant` rows in parallel, applies the same permission gate the `join-*` handlers apply, and calls `socket.join(...)` for each visible `server:*`, `channel:*`, and `dm:*` room. The initial voice/stage state (`server-voice-participants-initial`, `server-stage-participants-initial`) is emitted once per server from the same pass via the shared `emitServersInitialState` helper in `channels.ts`. Private channels are only joined when the user has an explicit override granting `viewChannels`; banned servers are skipped.

Mid-session membership changes are handled by the REST routes that create/add the resource. They now call `io.in('user:${id}').socketsJoin(...)` (or `io.in('server:${id}').socketsJoin(...)` for public channels) before emitting their broadcast:
- `POST /api/servers/:serverId/channels` (servers.ts): `socketsJoin('channel:${newId}')` for non-private channels.
- `POST /api/dms` + `POST /api/dms/group` + `PATCH /api/dms/:id` (dms.ts): `socketsJoin('dm:${id}')` for creator + recipients / new members.
- `POST /api/dms/secure` (secureDm.ts): same as above for secure 1:1 DMs.
- `POST /api/invites/join` (invites.ts): `socketsJoin` the server room + all non-private text channels for the new member's live sockets.

**Backward compatibility:** The `join-server` / `join-channel` / `join-dm` socket handlers remain registered unchanged. Older clients that still emit them continue to work (the `socket.join` call becomes idempotent because the backend already put the socket in the room). During the deploy skew window, new backend + old client can emit `server-voice-participants-initial` twice (once from auto-subscribe, once from the old client's explicit `join-server`); the client's `onInitial` handler is idempotent.

**Client-side removal:** `App.tsx` no longer emits bulk `socketService.joinServer / joinChannel / joinDM` on bootstrap or reconnect. The per-tracked-set refs (`joinedServerRoomsRef`, `joinedDmIdsRef`, `joinedAllChannelsRef`) are retained for cleanup-on-removal (the `leave-*` emits still fire when the user leaves a server / closes a DM / loses visibility to a channel) and for downstream consumers (`useServerMemberSocketEvents`, `leaveServer` / `transferOwnershipAndLeave` / `deleteServer` helpers). Single-resource emits on active-channel/active-DM selection remain as defensive backstops. They never contribute to a bootstrap flood.

**Rate limiter:** `checkSocketRateLimit` stays at 30 events / 10 seconds. The flood that motivated the change is gone; the counter now applies only to the spammy event classes it was designed for (typing, soundboard, signaling, etc.).

## 2026-04-26 - DM encryption upgrade (legacy unencrypted 1:1 DMs)

Additive. New endpoint + new socket event. No `protocolVersion` bump.

**Why:** DM channels created during the pre-2026-04-12 plaintext-fallback
window were persisted with `DMChannel.encrypted = false`. After the
"no plaintext fallback" fix (`355c1ee2`), the client send path requires a
per-channel key in the user's blob, so these channels are write-locked
in both directions. This change adds an upgrade path so the client can
generate a fresh per-channel key, deliver it to the counterpart via the
existing `PendingKeyDelivery` mechanism, and flip the channel to
`encrypted = true`.

**REST:**
- `POST /api/v1/dms/:dmChannelId/upgrade-encryption`
  - Auth: required. Limiter: `dmMutateLimiter`.
  - Body: `{ encryptedKey, nonce, senderPublicKey, signature?, signedPayloadV? }` (same key-exchange shape used by `POST /api/v1/dms`).
  - Response: `{ id, encrypted: true }` (200) or one of the 400/403/404/409 error shapes documented in the route.
  - Restrictions: 1:1 channels only; rejects already-encrypted channels (409); both participants must have a `dmKeyBundle`.
  - Side effects: `DMChannel.encrypted` flipped to `true`; one `PendingKeyDelivery` row created for the recipient (any prior stale row from this sender is deleted first).

**Server → client socket events:**
- `dm-encryption-upgraded { dmChannelId: string }`, emitted to both participants' `user:<id>` rooms after a successful upgrade. Recipient flips `setChannelEncryptionStatus(dmChannelId, true)` and updates the local `dmStore` so the shield icon appears immediately. Old clients that don't subscribe ignore it.
- `dm-key-delivery { dmChannelId: string }`, additionally emitted to the recipient as part of the upgrade so existing `claimPendingDeliveries` logic loads the new channel key without any new wiring.

Payload shapes are stable. Schemas use the same `dmBase64` validator + `.strict()` body wrapper as the create-DM route.

## 2026-04-24 - `secure-dm-*` rename (hard cutover)

Strict-cutover rename: no dual-emit, no compat alias (clean-break replace-not-migrate). Part of the broader retirement of the "Secure DM" tier terminology (all DMs are E2E encrypted by default; `secureDm*` was naming debt).

**Socket event rename (server → client):**
- `secure-dm-key-delivery` → `dm-key-delivery`

Payload shape (`{ dmChannelId: string }`) and room (`user:<id>`) are unchanged. Emitters updated: `backend/src/routes/dmKeys.ts` (3 sites) and `backend/src/routes/dms.ts` (3 sites). Frontend listener in `services/socket/dmMessages.ts` updated to match.

**REST path rename:**
- `/api/v1/dms/secure/*` → `/api/v1/dms/keys/*`

Route file renamed from `backend/src/routes/secureDm.ts` to `backend/src/routes/dmKeys.ts`; mounted at `/api/v1/dms/keys` in `backend/src/server.ts`. Onboarding-exempt paths updated to `/dms/keys/bundle` and `/dms/keys/setup`. Per-endpoint schemas renamed in `backend/src/schemas.ts` (`secureDmSetupSchema` → `dmKeysSetupSchema`, etc.). Payload shapes are unchanged.

No `protocolVersion` bump: there are no deployed clients to keep compatible.

## 2026-04-28 - mutual DM verification attestations

Additive. No `protocolVersion` bump. Old clients keep working with one-sided
("I trust this peer") shields; new clients require mutual confirmation before
the shield turns full green.

**REST (mounted at `/api/v1/dms/keys/`):**
- `POST /api/v1/dms/keys/verify`
  - Auth: required. Limiter: `dmVerifyMutationLimiter` (30/min/user).
  - Body: `{ peerId: uuid, safetyNumber: string }` where `safetyNumber` matches
    `^[0-9a-f]{4}( [0-9a-f]{4}){4}$`.
  - Response: `{ self: { safetyNumber, verifiedAt } | null, peer: { safetyNumber, verifiedAt } | null }`.
  - Side effect: upsert one `DmVerification` row keyed on `(ownerId, peerId)`.
  - Errors: 400 self-verify; 403 no encrypted DM; 403 blocked.
- `DELETE /api/v1/dms/keys/verify/:peerId`
  - Idempotent. Removes only my row (peer's row preserved).
  - Response shape identical to POST.
- `GET /api/v1/dms/keys/verify/:peerId`
  - Auth: required. Limiter: `dmVerifyReadLimiter` (60/min/user).
  - Response: full pair `{ self, peer }`. Header: `Cache-Control: no-store`.

**Server → client socket event (additive):**
- `dm-verification-changed { peerId, self, peer }`, emitted to both
  `user:<ownerId>` and `user:<peerId>` rooms after each POST/DELETE. The
  server flips perspective per emit so each recipient's `self` is their
  own attestation about `peerId`. Old clients that don't subscribe ignore
  it; new clients update IndexedDB + the in-memory peer cache and bump
  `useDmStore.dmVerificationVersion` so dependent memos re-derive.

**Schema:**
- New Prisma model `DmVerification` (`backend/prisma/schema.prisma`):
  `id, ownerId, peerId, safetyNumber, verifiedAt`. `@@unique([ownerId, peerId])`,
  `@@index([peerId])`. Both FKs `onDelete: Cascade` to `User`.
- Migration: `20260428015216_add_dm_verification`.

**Why server-tracked:** mismatched `safetyNumber` across the two rows for the
same pair is direct cryptographic evidence of an active man-in-the-middle on
the key bundle fetch (the only way the two endpoints can compute different
fingerprints for the same conversation). Local-only verification masks this
signal entirely. The server learns no new metadata: `(ownerId, peerId)` is
already exposed via `DMParticipant`, and `safetyNumber` is derived from
public keys both users already display in `VerifyPeerModal`.

## 2026-05-01 - `attachmentIsExplicit` per-attachment NSFW marker

Additive. No `protocolVersion` bump. Old clients keep working. They neither
send the field (server defaults to `false`) nor read it (recipients still
render attachments unmodified, matching today's behavior).

**Why:** the user's "Explicit media: show / blur / hide" preference currently
filters Discover only. Per-attachment gating in channels and DMs requires a
machine-readable marker on each message. The flag is volunteered by the
sending client; the server never inspects content to set it (DMs are E2EE
and the server only sees ciphertext).

**Schema (additive, defaults preserve prior behavior):**
- `Message.attachmentIsExplicit Boolean @default(false)`
- `DMMessage.attachmentIsExplicit Boolean @default(false)`
- Migration: `20260501120000_add_attachment_is_explicit`, two `ALTER TABLE …
  ADD COLUMN … BOOLEAN NOT NULL DEFAULT false` statements. Backfill is
  unnecessary because the default handles existing rows.

**REST (additive):**
- `POST /api/v1/messages/channels/:channelId`: body now accepts
  `attachmentIsExplicit?: boolean`. Persisted as-is; server does not infer.
- `POST /api/v1/dms/:dmChannelId/messages`: body now accepts
  `attachmentIsExplicit?: boolean`. Same semantics. DMs remain E2EE; the
  server stores and forwards this metadata flag without inspecting
  ciphertext.
- `GET /api/v1/messages/channels/:channelId` and
  `GET /api/v1/dms/:dmChannelId/messages` responses now include
  `attachmentIsExplicit: boolean` on each message.
- `GET /api/v1/search/messages` and `GET /api/v1/search/dm-messages` results
  also include `attachmentIsExplicit: boolean`.
- DM pins endpoint includes the field in the pinned message shape.

**Socket payloads (additive):**
- `new-message` and `new-dm-message` payloads gain `attachmentIsExplicit:
  boolean` alongside the existing `attachmentUrl/Name/ContentType/Width/
  Height` fields. No `.strict()` violation: the REST `sendMessageSchema`
  and `sendDmMessageSchema` Zod schemas already wrapped with `.strict()`
  remain `.strict()`; the new field is `.optional()` on both.

**Backward compatibility:**
- Old clients omit the field on send → schema default + server `!!undefined`
  produces `false`; identical to existing behavior.
- Old clients receive the field on read → unknown property; ignored.
- The new field is metadata-only. The server never reads it for routing,
  filtering, or moderation. No content inspection is introduced.

## 2026-05-26 - group DM owner kick

Additive. No `protocolVersion` bump. New REST route + new server→client
events; old clients ignore events they don't subscribe to.

**Schema (additive, nullable):**
- `DMChannel.ownerId String?`: group-DM owner (creator). Backfilled to the
  earliest-joined participant for existing groups. Migration
  `20260526165426_add_dmchannel_owner`. (Note: that migration was hand-trimmed
  to exclude the `search_vector` FTS drift Prisma wanted to add. FTS columns
  are managed outside the schema; use `--create-only` + strip for future migrations.)

**REST:**
- `DELETE /api/v1/dms/:dmChannelId/members/:targetUserId`: owner-only kick.
  Auth required; `dmMutateLimiter`. 400 non-group, 403 non-owner / self-kick,
  404 missing channel / non-member. Side effects: deletes the target's
  `DMParticipant`, rotates the channel key (see below), writes a
  `member_removed` system message. Response `{ id, members: [...] }`.

**Server → client events (additive):**
- `dm-removed-from-group { dmChannelId }`, to the kicked user's `user:<id>`
  room; their sockets are also removed from `dm:<id>`.
- `dm-participant-removed { dmChannelId, userId }`, to the `dm:<id>` room and
  each remaining `user:<id>` (same dual-emit shape as `dm-participant-left`).
- `dm-group-owner-changed { dmChannelId, ownerId }`, emitted when the owner
  leaves and ownership auto-transfers to the oldest remaining member (leave path).
- `dm-key-rotation-needed`, **reused unchanged** from the leave path; emitted to
  remaining members (only when `encrypted && remaining >= 2`) so the removed
  member cannot decrypt post-kick messages. The kicked user is excluded from the
  rotation recipients.

`new-dm-channel` and the `GET /dms` list entries gain an additive `ownerId`
field on group DMs. The `member_removed` system payload is
`{ kind: 'member_removed', userId }`.

## 2026-05-28 - voice/stage E2EE forward-secrecy on abrupt departure

Additive. No `protocolVersion` bump. One new client→server event; the existing
`voice-e2ee-rotate` / `stage-e2ee-rotate` events are now emitted from additional
server paths (no shape change).

**Why:** the graceful `leave-voice-channel` / `stage-leave` / moderator-remove
paths rotated the SFrame key (and, for stages, advanced the `setStageLeader`
pointer), but the abrupt-disconnect cleanup in
`backend/src/socketHandlers/connection.ts` (browser close, crash, sleep,
network drop: the common departure) did neither. That left forward secrecy
unenforced for the common case and, for stages, left the leader-gated
`stage-e2ee-distribute` rejecting every remaining speaker for the rest of the
session so post-disconnect joiners got no key.

**Server behavior change (no payload change):**
- A shared helper `backend/src/services/voiceE2eeRotation.ts`
  (`scheduleVoiceE2eeRotate`, `rotateStageLeaderAndKey`) now backs the graceful
  leave, moderator-remove, AND abrupt-disconnect paths so they cannot drift.
- The abrupt-disconnect voice cleanup now schedules the same debounced
  `voice-e2ee-rotate { channelId, newLeaderUserId }` as graceful leave.
- The abrupt-disconnect stage cleanup now calls `setStageLeader(...)` and emits
  `stage-e2ee-rotate { channelId, newHostUserId }` when a departing speaker
  leaves speakers behind, identical to graceful `stage-leave`.

**New event (additive, client → server):**
- `stage-e2ee-request-key { channelId: uuid, publicKey: string, capabilities?: string[] }`
  : an audience member or speaker that never received the SFrame session key
  (host push lost, host mid-reconnect, host abruptly departed) asks the server
  to re-trigger distribution. The server resolves the authoritative leader
  (Redis `leader` pointer, DB `StageSession.startedById` fallback) and forwards
  `stage-e2ee-request-key { channelId, userId, publicKey, capabilities? }` to
  that leader's `user:<id>` room (mirrors the existing `voice-e2ee-request-key`
  round-trip). The leader's client re-distributes via the existing
  `stage-e2ee-distribute` → `stage-e2ee-key` path. Requester's public key is
  re-looked-up server-side from `DmKeyBundle`, never trusted from the client.
  Schema `stageE2eeRequestKeyPayload` uses `.passthrough()` (additive). Old
  clients neither emit nor subscribe.

**Client behavior change (additive):**
- `useVoiceE2ee` gates the optimistic 500 ms self-key on roster size > 1
  and adds a `voice-user-left`-driven liveness backstop that re-elects
  locally if the verified leader departs and no `voice-e2ee-rotate` arrives.
- `useStageE2ee` adds the audience-side `stage-e2ee-request-key` request with
  bounded backoff and a host-side responder; `useStageRoom` now shows an amber
  shield for both speakers and audience until the verified host key arrives.

## 2026-05-28 - `dm-call-e2ee-ack` bilateral DM-call shield

Additive. New socket event only (decision-tree rule 1: free). No
`protocolVersion` bump. Old clients neither emit nor subscribe to it; they fall
back to the prior per-side shield behavior.

**Why:** the DM-call initiator
showed a green "end-to-end encrypted" shield as soon as its OWN SFrame key
installed, before the peer had keyed, over-claiming bilateral E2EE while the
peer leg could be transport-only (amber) or still establishing. There was no
signal channel for one side to learn the other's E2EE state.

**Client → server:**
- `dm-call-e2ee-ack { dmChannelId: uuid, ok: boolean }`: the local user reports
  whether E2EE is established on their own SFrame leg (`ok:true` = keyed,
  `ok:false` = E2EE expected but the key never installed). Schema
  `dmCallE2eeAckPayload` is `.passthrough()` (additive). Handler
  (`backend/src/socketHandlers/dmCalls.ts`) rate-limits via `checkSocketRateLimit`,
  validates the payload, gates on `isInDmCall(dmChannelId, userId)`, and relays
  to the rest of the `dm-call:<id>` room. The server never sees keys: `ok` is a
  plain boolean about the sender's own state.

**Server → client (relay to the dm-call room, sender excluded):**
- `dm-call-e2ee-ack { userId: string, ok: boolean }`: each peer adds/removes
  the sender from its acked/failed sets and recomputes the shield. Green is shown
  only once EVERY current remote peer has acked `ok:true`; amber "establishing"
  while a peer is unconfirmed; amber "failed" if a peer reports `ok:false` or the
  local leg never keyed. Clients re-emit their standing ack whenever a new peer
  appears so late joiners converge (room broadcasts only reach current members;
  no per-call server state is persisted).

## 2026-05-28 - Secure-DM create routes through `/dms/keys/start`; escrow writes fail closed

Additive. No request/response schema changes. No `protocolVersion` bump.
**Client adoption of an existing endpoint.** `createEncryptedDm` / `createGroupDm` now create a Secure DM via the already-defined atomic `POST /api/v1/dms/keys/start` (channel create + recipient `PendingKeyDelivery` + sender `blobVersion` bump in one transaction) instead of the prior two-request saga (`POST /dms` then `PUT /dms/keys/blob`). The endpoint, its request body, and its `{ id, encrypted, otherUser, blobVersion? }` response are unchanged. Only the client call site changed. A `409 { error: 'Version conflict', currentVersion }` from `/start` now self-heals client-side (re-fetch → merge → retry), same as every other blob writer.

**Escrow-bearing blob writes fail closed (new failure mode, additive).** When `SERVER_E2E_MASTER_KEY` is unavailable, the five escrow-writing routes (`PUT /dms/keys/blob`, `PUT /dms/keys/password`, `POST /dms/keys/recover`, `POST /dms/keys/start`, `POST /dms/keys/claim`) now return **`503 { error: '…temporarily unavailable…' }`** and commit nothing, instead of silently committing the blob while nulling `serverEscrowBlob` and returning 200. Request/response success shapes are unchanged; this only adds a 503 path on an existing error condition, which clients treat as a transient failure and retry. No field added or removed.

**Cross-tab convergence (client-only, no wire impact).** Password-derived mode changes broadcast to sibling tabs via a `howl_e2e_password_derived` `localStorage` event so each tab's escrow gate (`rawBlobForEscrow`, already an optional field) stays consistent with the server-authoritative row-level `passwordDerived`. No socket/REST payload involved.

## 2026-05-29 - `POST /dms/group` response: additive `created` flag

Additive. New optional response field; old clients ignore it. No request-schema change, no `protocolVersion` bump.
`POST /api/v1/dms/group` now returns `created: boolean` on both outcomes: `true` on a genuine create (201), `false` on a dedup-to-existing member set (200). Unlike `POST /dms/keys/start`, the group response carried no `blobVersion` to distinguish create from dedup, so a stale device that lacked the channel key could not tell the two apart and would mint a fresh channel key over the members' original (permanent E2EE divergence). The client now keys on `created`: on `created: false` without the local key it recovers the original key (claim the creator's `PendingKeyDelivery`, else reconcile its own server blob) and never persists a fresh one, surfacing a retryable error if the key has not yet synced. Behavior for clients that ignore the field is unchanged.

## 2026-05-29 - `escrowStale` response flag on `/dms/keys/blob` and `/dms/keys/claim`

Additive. New optional response field; old clients ignore it. No request-schema change, no `protocolVersion` bump.
`PUT /api/v1/dms/keys/blob` and `POST /api/v1/dms/keys/claim` now return `escrowStale: true` when the row is `passwordDerived` but the committed write omitted `rawBlobForEscrow`, i.e. a backgrounded tab's per-tab escrow gate was stale and, because `blobVersion` was current, no `409` fired to trigger reconcile, so `serverEscrowBlob` silently lagged the live blob. On `escrowStale`, the client adopts the authoritative password-derived mode (broadcasting to sibling tabs) and re-sends escrow once through `PUT /dms/keys/blob`. The flag is computed solely from the row's `passwordDerived` boolean and the presence/absence of `rawBlobForEscrow`, never from key or message plaintext, and is never emitted to non-password-derived users (who must never transmit raw keys).

## 2026-06-04 - group MLS member commits serialize as `mls_public_message` (removal authority)

Additive. No `protocolVersion` bump. No new Socket.IO event or schema, and no REST body-shape change (so no `fixtures.test.ts` protocol-v1 impact). Only the internal MLS wireformat of the commit bytes changed; commits still travel as the existing base64 `commit` field on `POST /api/v1/mls/groups/:groupId/commits` (validated by the unchanged `mlsSubmitCommitSchema`).

**Why:** the backend Delivery Service is the authority on member removal. A `Remove` proposal is only readable by the server if the commit is framed as `mls_public_message` (a `mls_private_message` commit is opaque to anyone outside the group). Group member commits are therefore re-framed as public so the server can read their inline `Remove` proposals and authorize them against `DMParticipant.pendingRemoval`. A member can no longer evict a peer the owner has not first marked for removal.

**Wireformat change (client send path):**
- Group-tier member commits (add and remove) now serialize as `mls_public_message`. The coordinator passes `wireAsPublicMessage=true` for the group paths (`createGroupDmGroup`, `commitAddMembersWithRebase`, `commitRemoveMembersWithRebase`) in `services/mls/mlsCoordinatorCore.ts`.
- 1:1 member commits stay `mls_private_message` (unchanged).
- External commits stay `mls_public_message` (unchanged).
- `selfUpdate` (key rotation / PCS heal) stays `mls_private_message` (unchanged).

**Receive path (already additive):** `processHandshake` in `services/mls/mlsEngine.ts` already accepts both `mls_private_message` and `mls_public_message` commits, and external joins already published public, so accepting public group commits requires no receiver change. Old and new clients both apply either framing.

**Delivery Service (accept-both during the transition):** `POST /api/v1/mls/groups/:groupId/commits` in `backend/src/routes/mls.ts` accepts BOTH wireformats for group members. A public group member commit is authorized: the server parses its inline `Remove` proposals, maps the removed leaf indices to userIds against the stored pre-commit (epoch-N) ratchet tree, and requires every removed user to already be marked `DMParticipant.pendingRemoval` (owner-authorized at the REST kick route, or a self-leave). A commit that removes a non-`pendingRemoval` member is rejected with `403 { error: 'unauthorized_remove' }`. A private group member commit from an old client falls back to the legacy advisory path. A later release will tighten group members to require-public (1:1 and external wireformat checks are already enforced).

**Backward compatibility:** Additive both ways. New clients send public group commits that old clients still apply (receivers accept both) and the server authorizes. Old clients send private group commits that the server still admits via the legacy advisory path. No field is added or removed on any socket or REST payload.

## 2026-06-08 - MLS commit fan-out reaches the submitter's own devices

Additive behavior change. No payload schema changes. No `protocolVersion` bump.

**Before:** On an accepted MLS commit, `POST /api/v1/mls/groups/:groupId/commits` fanned the `mls-commit` push to every participant's user room EXCEPT the submitter's (`if (userId === req.userId) continue`). With per-account roaming identity that was fine (one device per account); with per-device identity the submitter's OTHER devices never got the live commit and only caught up on the next reconnect/poll.

**After:** The submitter's user room is no longer suppressed, so all of the submitter's devices receive `mls-commit`. The submitting device itself drops its own echo via the existing client-side epoch guard (`epoch <= lastAppliedEpoch`). The `mls-commit` / `mls-welcome` payloads are unchanged; only delivery scope changed. Added (Welcome) recipients still take the separate `mls-welcome` path, and `pendingRemoval` members are still excluded (forward secrecy).

**Backward compatibility:** Emit-only server->client change; no inbound schema touched. The `scripts/check-schema-compat.ts` gate scans `socketSchemas.ts` / `schemas.ts` / migrations / socket `.on()` handlers, none of which this change touches, so it passes with no waiver.

## 2026-06-08: cross-device DM history archive

Additive. No `protocolVersion` bump. **REST-only**: no new Socket.IO event, no change to any existing socket/REST payload, no change to the E2EE message envelope. Because no socket schema is added or modified, **no new socket fixture is required** and `fixtures.test.ts` is untouched (the protocol-v1 fixtures are unchanged).

**Why:** MLS messages are decryptable only by the device that processed the commit/application key. A second device (or the same device after re-unlock) cannot self-decrypt prior MLS DM history. The archive is an opt-in-by-virtue-of-being-unlocked, client-sealed per-account archive so a user's own readable history converges across their devices without the server ever seeing plaintext.

**Schema (additive, new model, no change to existing tables):**
- New Prisma model `DmHistoryArchive` (`backend/prisma/schema.prisma`): `id, userId, dmChannelId, envelopeHash, ciphertext, keyVersion (default 1), messageId, msgCreatedAt, createdAt`. Both FKs (`userId` -> `User`, `dmChannelId` -> `DMChannel`) `onDelete: Cascade`. `@@unique([userId, dmChannelId, envelopeHash])` (idempotent multi-device upsert), plus three covering indexes (preview/restore, delete-for-everyone, bulk-delete).
- Migration: `20260608_add_dm_history_archive` (hand-trimmed to exclude the `search_vector` FTS drift). Purely a `CREATE TABLE` + indexes; no backfill, no existing-column change.

**REST (five routes, mounted at `/api/v1/dms/history-archive`, auto-aliased at `/api/dms/history-archive`; route file `backend/src/routes/dmHistoryArchive.ts`):**
- `POST /`: batch upsert (append-only, idempotent via `createMany({ skipDuplicates })`). Body `{ items: [{ dmChannelId, envelopeHash, ciphertext, keyVersion, messageId, msgCreatedAt }] }` (≤50 rows; the JSON body limit for this prefix is bumped to 2 MB in `server.ts`). Authz: every distinct `dmChannelId` must have the caller as an **active** `DMParticipant` (`pendingRemoval === null`), else 403. Response `{ stored }`.
- `GET /previews`: latest sealed row per active-participant channel (`DISTINCT ON (dmChannelId)`, newest-first), cursor-paginated by `dmChannelId`. `Cache-Control: no-store`. Declared **before** `/:dmChannelId` so Express does not capture `previews` as a UUID param.
- `GET /:dmChannelId`: paginated full restore for one channel, newest-first, cursor by row id. Active-participant gate; `Cache-Control: no-store`.
- `DELETE /:dmChannelId/:messageId`: delete-for-everyone write-through (removes every archived revision sharing `messageId`; idempotent). Active-participant gate.
- `DELETE /`: bulk wipe of the caller's entire archive (scoped to `req.userId`; reserved for the move-to-Private flow).

All routes use `authenticateToken` + dedicated read/write rate limiters (`createRateLimitStore`, 120/min/user) and `validate(...)` Zod middleware. The archive rows are also deleted on encryption reset (`backend/src/routes/dmKeys.ts`) and GDPR account deletion (`backend/src/routes/gdpr.ts`).

**E2EE envelope is unchanged.** The archive ciphertext is a **separate** seal that wraps the already-decrypted plaintext for at-rest cross-device convergence; it does not alter how a live MLS/DM message is encrypted or framed:
- Each row is `base64(iv[12] || AES-256-GCM(archiveKey, utf8(plaintext)))` with a 16-byte GCM tag, sealed client-side under a stable per-account `archiveKey` (`services/dmCrypto.ts` `sealArchiveRow`/`openArchiveRow`).
- Row-binding AAD `howl:archive:v1:userId:dmChannelId:messageId:envelopeHash` prevents a compromised server from splicing a valid ciphertext under a different (channel, message, envelope) tuple. The server stores and serves these rows **opaque**: it never reads the plaintext.

**`BlobContents.archiveKey` (additive, optional, `services/dmCrypto.ts`):** the key vault blob gains an optional `archiveKey?: string` (base64 of the 32-byte AES key). Backward compatible: an older blob lacks the field; on the next unlock `dmKeyManager` lazily mints and back-fills a fresh `archiveKey` and re-persists, so old blobs upgrade in place with no migration. The key is **not** stripped by `stripMlsForEscrow`, so Server-recovery users (`passwordDerived = true`) carry `archiveKey` into `serverEscrowBlob`; for those users (and only those) the server can decrypt the archive rows out of band via the existing escrow path, exactly as it already can decrypt their live content. Self-recovery users' `archiveKey` never reaches the server, so their rows stay opaque to it.

**IndexedDB `howl_mls` bump v3→v4 (additive, client-only, `services/mls/mlsGroupStore.ts`):** adds a `synced` index on the existing `history` object store (numeric `0 | 1` key, since a boolean key path would be invalid in IndexedDB) and reopen handlers. The v3→v4 upgrade stamps every pre-existing history row `synced = 0` (a plain index excludes rows whose key path is `undefined`) so the upload syncer enumerates them. No store is dropped or renamed; only the additive index is created.

**Backward compatibility:** Old clients neither call the new routes nor read `BlobContents.archiveKey` / the `synced` index, so they are wholly unaffected. New clients on an older blob back-fill `archiveKey` lazily and migrate the local DB on first open. No socket schema, no existing payload, and no E2EE envelope is touched, so `scripts/check-schema-compat.ts` passes with no waiver and `fixtures.test.ts` needs no new protocol-v1 fixture.

## 2026-06-10 - legacy E2EE teardown (protocolVersion 2 -> 3)

Compat-breaking removal, `compat-break-approved`. The 60-day deprecation
window is explicitly waived: this is a clean-break replace-not-migrate
teardown (the pre-MLS E2EE layer is deleted, not migrated), so deployments
apply it as a strict cutover.

Removed wire surface:
- REST: `POST /api/dms/keys/start`, `GET /api/dms/keys/pending`,
  `POST /api/dms/keys/claim`, `POST /api/dms/keys/rotate-key`,
  `POST /api/dms/keys/verify`, `GET|DELETE /api/dms/keys/verify/:peerId`.
- REST body fields: `POST /api/dms` lost
  `encryptedKey`/`nonce`/`senderPublicKey`/`signature`/`signedPayloadV`
  (keyless 1:1 create); `POST /api/dms/group` and
  `POST /api/dms/:id/members` lost `encryptedKeys`/`senderPublicKey`;
  `POST /api/reports` lost `channelKey`.
- Socket: `join-dm-call` lost `e2eeKey`; `incoming-dm-call` no longer carries
  `e2eeKey`/`keyFormat`; the `dm-key-delivery` and `dm-key-rotated` events no
  longer exist. (`dm-key-rotation-needed` SURVIVES: it is the MLS leave/kick
  leader election, emitted with `leaverId`.)
- DB: `PendingKeyDelivery` and `DmVerification` tables dropped;
  `MessageReport.channelKey`/`verificationState` columns dropped
  (destructive migration, single-phase deploy, strict-cutover waiver).

MLS (RFC 9420) is now the only DM content crypto, key distribution, and
DM-call keying. Voice channels and stages are unchanged (X25519 box wrap over
`voice-e2ee-key`/`stage-e2ee-key`; not the removed dead drop).

Fixtures and compat tooling: `fixtures.test.ts` is unaffected. The only socket
schema touched, `joinDmCallPayload`, drops an optional field the protocol-v1
fixture never carried, and non-strict schemas ignore unknown fields.
`scripts/check-schema-compat.ts` fails by design with exactly six waivable
violations (the destructive migration, `joinDmCallPayload.e2eeKey`, and the
removed `dmStartSchema`/`dmClaimKeysSchema`/`dmKeyRotationSchema`/
`dmVerifyPeerSchema`); the PR carries the `compat-break-approved` label.

## 2026-06-11 - MLS group create self-heals abandoned epoch-0 rows

Additive behavior change. No payload schema changes. No `protocolVersion` bump.

**Before:** `POST /api/v1/mls/groups` was strictly create-once: a unique-constraint
conflict (`@@unique([dmChannelId, tier])`) always returned `409`. An epoch-0 group row
orphaned by a failed establish (the peer's KeyPackage consume 404'd after the row was
minted) stranded the channel permanently: re-create hit the 409, and External Commit
refuses an epoch-0 group, so no client could recover it.

**After:** On the same `409` path, the route loads the existing row inside a
`Serializable` transaction. If it is at `currentEpoch === 0` AND older than a 10-minute
grace window, the row is deleted and replaced with the caller's fresh epoch-0 GroupInfo,
returning `201` as a normal create. Live groups (`currentEpoch >= 1`) and recently
created groups (within the window) still return `409` exactly as before. An epoch-0 row
has no committed members and no Welcomes (Welcomes are written only by `submitCommit`,
which advances the epoch), so the replacement orphans nothing. Concurrent heals resolve
to exactly one winner via Serializable isolation; the loser gets `409`.

**Backward compatibility:** No request or response shape changed (still
`{ dmChannelId, tier?, groupInfo }` in, `{ groupId, currentEpoch }` out). Because no
socket schema is added or modified, no new socket fixture is required and
`fixtures.test.ts` is untouched (the protocol-v1 fixtures are unchanged). The
`scripts/check-schema-compat.ts` gate scans `socketSchemas.ts` / `schemas.ts` /
migrations / socket `.on()` handlers (none of which this change touches), so it passes
with no waiver despite the `backend/src/routes/**` trigger path.

## 2026-06-13 - MLS KeyPackage conditional last-resort lifetime clamp (vault-independent provisioning)

Additive **behavioral** change. No payload schema change, no new socket event,
no `protocolVersion` bump. (Decision-tree rule 5: this touches E2EE key-distribution
metadata - the KeyPackage `Lifetime.notAfter` ceiling - but adds NO new wire field
and keeps the existing `notAfter` DateTime column and its semantics, so it lands as a
rule-2-style additive value change rather than a new `sframe.v2`-class capability.)
Because no socket schema, REST body, or Prisma migration is touched,
`scripts/check-schema-compat.ts` passes with no waiver and `fixtures.test.ts` is
untouched (the protocol-v1 fixtures are unchanged).

**Why:** vault-independent provisioning moves the MLS device identity + KeyPackage privates off the
vault-derived `atRestKey` onto a device-local wrap so a boot-time provisioner keeps
every account addressable without a vault unlock. Single-use KeyPackages keep their
30-day expiry, but the **last-resort** KeyPackage is now rotate-only (Signal-style):
it must not silently expire out from under a peer who is trying to establish a DM, or
the "every DM needs an MLS group" path bricks again. The read-side `notAfter > now` filters then admit a live last-resort
indefinitely; rotation happens on every boot, not by expiry.

**Server behavior change (`backend/src/mls/as.ts` `validateAndBindKeyPackage`):**
- Adds an `isLastResort: boolean` parameter, threaded from the publish route
  (`backend/src/routes/mls.ts`) per published item.
- The notAfter ceiling becomes **conditional**:
  - single-use -> `min(declared, now + 30 days)` (`MLS_KEYPACKAGE_MAX_LIFETIME_MS`, unchanged ceiling).
  - last-resort -> `min(declared, now + 100 years)`. The `Math.min` is retained even
    for last-resort: it stays **finite** so the non-nullable `mlsKeyPackage.notAfter`
    DateTime never receives an `Invalid Date` (`new Date(maxint64)`), which would fail
    the INSERT.
- Client requests `notAfter = now + 100 years` for the last-resort package and keeps
  `now + 30 days` for single-use (`services/mls/mlsIdentity.ts`).

**Trust note (recorded in `docs/howl-dm-encryption-spec.md` §"vault-independent
provisioning"):** for the no-30-day-clamp branch the server trusts the client-asserted
`isLastResort` flag. This is bounded by (a) the already-shipped one-live-last-resort
supersede (the publish transaction deletes the device's prior last-resort row(s)) and
(b) consume-prefers-single-use ordering, so a mislabeled package cannot expand the
attack surface beyond one long-lived HPKE init key per device - the same posture the
threat model already concedes.

**Backward compatibility:** No field is added or removed on any payload. Old clients
that publish without asserting `isLastResort` are treated as `isLastResort = false`
(single-use 30-day clamp), preserving today's behavior exactly. The far-future
`notAfter` is just a value; ts-mls validates lifetimes against `now`, not against a
ceiling, so Add/Welcome processing accepts it unchanged.

## 2026-06-15 - MLS default ciphersuite flip to X-Wing+Ed25519 (codepoint 1 -> 83)

Crypto-identity change (decision-tree rule 5), shipped as a clean-break
replace-not-migrate flip rather than a dual-capability rollout. The single active
MLS ciphersuite changes from MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 (1) to
MLS_256_XWING_AES256GCM_SHA512_Ed25519 (83), giving every DM/group-DM post-quantum
confidentiality via the X-Wing hybrid KEM. No protocolVersion bump.

**Why:** Harvest-now-decrypt-later is a retroactive threat, so PQC confidentiality
must be in place from the start. The minimal flip is safe because it is a
clean-break replace-not-migrate cutover (old suite state is purged, not migrated),
so a re-flip stays cheap and no coexistence machinery is warranted.

**Wire surface:** The ciphersuite codepoint lives inside the opaque base64
KeyPackage / commit / GroupInfo / Welcome bytes. No Socket.IO event shape, no REST
body field, and no socketSchemas.ts schema changes. The MlsGroup.cipherSuite audit
column default changes 1 -> 83 via a default-only ALTER migration (additive, no
backfill, no destructive DDL). Transport caps were raised to hold the larger X-Wing
payloads at the 15-member worst case: the Socket.IO maxHttpBufferSize 50_000 ->
131_072 for the full-commit mls-commit relay, and a route-scoped 2mb JSON parser
for /mls/groups (mirroring the history-archive pattern); the global 256kb JSON cap
is unchanged. The cap raises are loosening (more permissive) and backward-compatible.

**Backward compatibility:** None required. Existing suite-1 server state is purged
at cutover by the operator-gated backend/scripts/purge-mls.ts (purged, not migrated), and
clients re-establish groups on X-Wing on next open. Suite-1 KeyPackages auto-reject
at the AS publish gate (it compares against the active suite name). fixtures.test.ts
(protocol-v1) is untouched: the MLS socket payload schemas validate the base64
envelope, not the ciphersuite inside the bytes.

## 2026-06-19 - MLS identity-trust: howl_mls IDB v5 -> v6 (additive STORE_TRUST)

**IndexedDB `howl_mls` bump v5→v6 (additive, client-only, `services/mls/mlsGroupStore.ts`):** adds a new `trust` object store (keyPath `userId`) holding the per-user TOFU-pinned account identity key (AIK) and seen device leaf keys (`TrustRecord`). The store is created by an UNCONDITIONAL `createObjectStore` guard in the upgrade callback, so both fresh installs and v5→v6 upgrades get it. No store is dropped or renamed; nothing else in the schema changes.

**At-rest wrap:** trust rows ride the always-available device-wrap key (`getOrCreateDeviceWrapKey`, wrapVersion-2 style), NOT the vault at-rest key, so reads/writes succeed pre-unlock, exactly when `validateCredential` runs at a Welcome that can arrive before the first vault unlock. The trust data (AIKs, leaf keys) is public; the wrap provides tamper-resistance at rest, not confidentiality, and an undecryptable/tampered row is treated as absent (callers fail closed). `clearAll` (logout) wipes the store with the others.

**Backward compatibility:** Client-local IDB only: no socket schema, no REST body, no E2EE envelope, and no `protocolVersion` impact. Old clients neither read nor write the `trust` store, so they are wholly unaffected; new clients create it on first DB open. `scripts/check-schema-compat.ts` and `fixtures.test.ts` (protocol-v1) are untouched.

## 2026-06-19 - MLS credential format v2 (AIK cross-signed, in-envelope, no protocolVersion bump)

Crypto-identity change (decision-tree rule 5), shipped as a clean-break
replace-not-migrate cutover rather than a dual-read rollout. The MLS basic-
credential identity changes from the v1 `utf8("userId:deviceId")` string to a
versioned 169-byte binary struct `{ version=0x02, userId(36), deviceId(36),
AIK_pub(32), crossSig(64) }` (offsets: version@0, userId@1, deviceId@37,
AIK_pub@73, crossSig@105). The device leaf signing key is cross-signed by the
account identity key (AIK, Ed25519) via raw `nacl.sign.detached` over
`"howl:mls:device-xsig:v1" ‖ userId ‖ deviceId ‖ leafSigningPublicKey` (NOT
ts-mls `signWithLabel`). The client `encodeMlsCredentialIdentity` and backend
`encodeMlsIdentity` produce byte-identical output. No protocolVersion bump.

**Why:** The cross-signature binds each device leaf to the account's TOFU-pinned
AIK, the foundation for the identity-trust validator that detects a
malicious-server leaf injection. Provisioning becomes two-phase: boot mints a
leaf-only identity and WITHHOLDS publishing; the first unlock/setup cross-signs
with the in-memory AIK and publishes the KeyPackages.

**Wire surface:** The credential bytes live INSIDE the opaque base64 KeyPackage /
commit / GroupInfo / Welcome envelope. No Socket.IO event shape, no REST body
field, and no socketSchemas.ts / schemas.ts schema changes. This change adds only a
v2-aware STRUCTURAL validator (decode succeeds ⇒ accept); the cryptographic
cross-sig ENFORCEMENT lands separately. The 96-byte-per-leaf size increase
(AIK_pub + crossSig vs the short colon string) stays well under the transport
caps measured by the X-Wing payload-size regression test.

**Backward compatibility:** None required, and NO v1↔v2 dual-read path exists by
design (clean break). As a replace-not-migrate cutover, existing groups
re-establish on next open and any v1 credential fails the v2 decode (fail closed).
fixtures.test.ts (protocol-v1) is untouched: the MLS socket payload schemas
validate the base64 envelope, not the credential struct inside the bytes.

## 2026-06-21 - MLS KeyPackage low-water victim signal

Additive. New server → client event only. No `protocolVersion` bump, no inbound
schema change (nothing added to `socketSchemas.ts` / `schemas.ts`).

Server → client:
- `mls-keypackage-low-water { reason: 'last-resort-served' }`, emitted to
  `user:<targetUserId>` when `GET /mls/keypackages/:userId` serves a reusable
  last-resort package (the victim's single-use pool is drained → forward secrecy
  degrading). Carries no `callerId` (don't reveal who). **Debounced** server-side
  (`shouldSignalKpLowWater`, ≤1 / 5 min / victim) so it cannot be weaponised as a
  notification bomb. Old clients ignore the event.

**Why:** make single-use pool drain / last-resort reuse
visible to the victim instead of silent. The client handler (replenish
KeyPackages / surface a nudge) is deferred to the client/UI terminal; emitting
the signal now is forward-compatible (old clients ignore it).

## 2026-06-22 - MLS application-message PADME plaintext frame

E2EE plaintext-format change (clean break). **No** Socket.IO / REST / Prisma
schema change, **no** `protocolVersion` bump, **no** new capability: the frame
lives entirely INSIDE the MLS application plaintext, which the server relays as
opaque ciphertext, and both the encrypt and decrypt sides are the same
client-side engine (`services/mls/mlsEngine.ts`).

What changed: `encryptApp` now frames every application plaintext as
`VERSION(0x01) || u32LE(realLen) || plaintext` and zero-pads it up to a Padmé
bucket (`padmeSize(5 + realLen)`) before `createApplicationMessage`; `decryptApp`
strips the frame (reads `realLen`, slices), failing closed on a truncated /
unknown-version / out-of-range frame (→ "🔒 Unable to decrypt"). The ts-mls
`defaultPaddingConfig` 256-floor is kept for the small-message regime; the two
compose as `max(256-floor, padmeSize(5+len))`.

Compat: an old (unframed) application ciphertext would be mis-parsed and fail
closed. This is a **strict cutover**, applied as a clean-break replace-not-migrate
teardown (the old framing is deleted, not migrated), the same basis as the other
strict cutovers. The cross-device readable-history archive
stores plaintext separately, so it is unaffected. Decision rationale: ts-mls's
`PaddingConfig` is a closed union (`padUntilLength | alwaysPad`) and cannot
express PADME, so the bucketing must live at the application layer.

**Why:** MLS text >256 B leaked its exact length at byte
granularity over the wire and at rest (the text analog of the attachment length leak).
PADME bounds the residual length leak to a coarse bucket (≤ ~12% granularity).

## 2026-06-18 - require public wireformat for group member commits (close accept-both seam)

Hard tightening of an existing acceptance rule, not an additive change, but safe
without a `protocolVersion` bump because there are no deployed old clients and the
current client already complies.

**Why:** `POST /api/v1/mls/groups` (the commit relay) ran the server-side Remove
authorization (`parseRemovedLeaves` + the in-transaction `pendingRemoval` check) ONLY
for a `mls_public_message` group member commit. During the prior "accept-both" window it
also admitted a `mls_private_message` group member commit, which `parseRemovedLeaves`
cannot read, so `removeTargets` stayed empty and the `forbidden_remove` gate could be
skipped for those commits. This change forces every group membership-changing commit
through the authorization gate.

**Change:** for `mode === 'member' && isGroup`, the route now rejects any commit whose
wireformat is not `mls_public_message` with `400 { error: 'invalid_commit', reason:
'wrong_wireformat' }`, mirroring the existing external (public-only) and 1:1
(private-only) assertions. Every group membership-changing commit is now forced
through the authorization gate.

**Backward compatibility:** The current client always wires group member commits as
public (`commitAddMembersWithRebase` / `commitRemoveMembersWithRebase` pass
`wireAsPublicMessage = true`; only 1:1 `createDmGroup` uses private). No deployed old
clients send private group member commits, so no dual-accept window is needed. 1:1
member commits and external commits are unchanged. No payload schema change (the
runtime wireformat check is unchanged in shape), so `protocolVersion` is not bumped.

## 2026-06-20 - run the Remove-authz gate for external commits (close the external-commit eviction bypass)

Hard tightening of an existing acceptance rule, not an additive change, safe without
a `protocolVersion` bump because the current client's external commits only ever remove
the committer's OWN leaf, which the carve-out below preserves.

**Why:** the 2026-06-18 change forced *group member* commits
through the server-side Remove-authz gate (`parseRemovedLeaves` + the in-transaction
`pendingRemoval` check), but that gate still ran ONLY for `mode === 'member'`. External
commits (`mode === 'external'`) are also `mls_public_message` and can legitimately carry
an inline Remove (RFC 9420 §12.4.3.2: the resync path drops the joiner's own stale
leaf), yet `removeTargets` was never computed for them, so the `forbidden_remove` gate
could be skipped for external commits. This change extends the authorization gate to
cover them, with a self-resync carve-out below.

**Change:** `POST /api/v1/mls/groups/:groupId/commits` now runs the Remove-authz gate
for a public commit when `mode === 'external'` as well as `mode === 'member' && isGroup`.
For an external commit the resolved targets are filtered by a **self-resync carve-out**:
a removed leaf whose credential `userId === req.userId` (the committer dropping its own
prior leaf) is allowed without a `pendingRemoval` marker; every OTHER removed target
must be owner-marked `pendingRemoval`, else `403 { error: 'unauthorized_remove' }`.

**Backward compatibility:** The legitimate external resync (the only external commit the
real client emits with an inline Remove) removes the committer's own leaf and so passes
the carve-out unchanged. A plain external join carries no Remove and is unaffected. No
socket/REST payload field is added or removed and no migration is touched, so
`scripts/check-schema-compat.ts` passes with no waiver and `fixtures.test.ts` is
untouched.

## 2026-06-20 - bind `POST /upload?encrypted=true` to a DM context + refuse encrypted blobs on server channels

Tightening of an existing REST acceptance rule plus an additive DB column. No
socket payload schema changes, so `protocolVersion` is not bumped, but this DOES
change `POST /upload` acceptance and adds a migration, so it needs a deploy order
(below).

**Why:** `POST /upload?encrypted=true` skips ALL server-side
content safety (MIME magic-byte, EXIF strip, decompression-bomb, SHA-256/NCMEC,
PDQ/CSAM) because the bytes are E2E ciphertext. The flag was self-asserted and
unbound to any DM (the independent `source` param defaulted to `channel` and was
never cross-checked), and encrypted uploads recorded no provenance, so any
authenticated user could POST arbitrary unscanned bytes, receive a normal
`/api/uploads/<uuid>` URL, and attach it to a plaintext, multi-recipient server
channel (`messages.ts` only checked the URL was a local upload path).

**Change (three layers, comprehensive multi-surface closure):**
1. **Request-time binding (`routes/upload.ts`):** when `encrypted=true`, the upload
   must declare `source=dm` and a `sourceId` for a DM channel the caller is an
   ACTIVE participant of (`DMParticipant` with `pendingRemoval: null`); otherwise
   `400` (non-DM source / missing id) or `403` (not a participant). The client
   (`services/api/uploads.ts` `uploadEncryptedFile`) now sends
   `?encrypted=true&source=dm&sourceId=<dmChannelId>`.
2. **Forced `.enc` extension (`routes/upload.ts`):** encrypted uploads are stored
   as `<uuid>.enc` regardless of the client-supplied originalname. This kills the
   `evil.png` masquerade and means an encrypted blob can never satisfy the
   extension-only allowlists on the asset surfaces (user avatar/banner, server
   icon/banner, per-server member avatar, custom emoji, sticker, soundboard), so
   those surfaces reject it without any per-route change. (The real DM client
   already names encrypted blobs `*.enc`, so this is a no-op for legit uploads.)
3. **Send-time provenance check on every any-file surface:** every encrypted upload
   writes one `ImageHash` provenance row (`encrypted: true`, hash + sha256 null),
   written before the URL is returned and fail-closed. A shared helper
   (`services/uploadProvenance.ts`, `checkUploadAttachment`) extracts the stored
   filename from any URL form the serve route accepts (relative `/api/uploads`,
   `/api/v1/uploads`, absolute backend-origin, trailing slash, `?query`,
   `%`-encoding) and refuses (`400`) any URL whose provenance is `encrypted`,
   failing closed (`503`) on a lookup error. It is called from the channel-message
   send (`routes/messages.ts`), forum post + forum message (`routes/forum.ts`),
   thread message (`routes/threads.ts`), and role icon create/update
   (`routes/serverRoles.ts`): the surfaces that accept arbitrary or
   non-extension-checked upload URLs. Schema: additive
   `ImageHash.encrypted Boolean @default(false)` + `@@index([filename])`
   (migration `20260620000000_imagehash_encrypted_provenance`).

The original fix shipped only the channel-message check, which had two bypasses
(trailing-slash → empty filename; absolute / `/api/v1/` URL forms skipping the
`isLocalUpload` gate) and several uncovered surfaces (forum, threads,
avatar/icon/emoji/sticker via the `.png` masquerade). This entry documents the
comprehensive closure: robust shared extractor + `.enc` forcing + guard on every
reachable surface.

**DEPLOY ORDER (two-phase, per rule 7):** the request-time binding rejects an
encrypted upload that lacks `source=dm`, which OLD clients (sending bare
`?encrypted=true`) do not send. Ship the FRONTEND first (clients start sending
`source=dm&sourceId`), THEN the backend enforcement. The reverse order
(new-backend + old-frontend) only causes encrypted DM file uploads to fail CLOSED
(the user sees an upload error and retries) for the rollover window: no security
gap and no plaintext exposure. Run the migration before/with the backend deploy.
The rollover-window impact is limited to those transient retries.

**Backward compatibility:** non-encrypted uploads are unaffected (new column
defaults `false`; existing `ImageHash` rows read as not-encrypted, so no existing
channel attachment is newly rejected). Pre-fix encrypted blobs (which never got a
provenance row) are not retroactively blockable at send time, an accepted
forward-only limitation; the request-time binding prevents minting NEW
unscanned-then-channel-attachable blobs. No socket payload field changes, so
`scripts/check-schema-compat.ts` passes with no waiver and `fixtures.test.ts` is
untouched.

## 2026-06-20 - voice SFrame key rotation on involuntary / channel-switch departures

Additive, backend-only. No `protocolVersion` bump, no new event, no payload shape
change, no migration, no client change. The existing
`voice-e2ee-rotate { channelId, newLeaderUserId }` event is now emitted from more
server paths, exactly the same continuation as the 2026-05-28 work, which
first wired this event into the abrupt-disconnect path.

**Why:** the graceful `leave-voice-channel` (voice.ts) and
abrupt-disconnect (connection.ts) paths call `scheduleVoiceE2eeRotate` so a
departed member's retained SFrame key no longer protects the remaining members'
media (forward secrecy). The four INVOLUNTARY voice-departure REST paths did NOT:
moderator kick (`servers.ts`), ban/GDPR removal (`serverSettings.ts`), timeout
voice-kick (`servers.ts`), and self leave-server (`servers.ts`, which also lacked
the LiveKit SFU eject the other three already had). A removed member, already
holding the live session key, kept it for every remaining member after removal:
FS unenforced at the kick/ban/timeout/leave security boundary. The same gap
existed at the moderator `move-voice-user` socket path (an involuntary removal
from the source channel) and at the self-initiated channel-switch paths
(voice→voice on join, voice→DM-call, voice→stage) and account self-deletion
mid-call, all of which leave the source channel without rotating while the
departing member retains its key.

**Server behavior change (no payload change):** `scheduleVoiceE2eeRotate(io,
channelId, participantsRemain)` is now called after the participant is removed in
every involuntary / switch / deletion path that leaves members behind:
- `routes/servers.ts`: kick, timeout voice-kick, and leave-server (the
  leave-server path also gains the `removeLiveKitParticipant` SFU eject it lacked).
- `routes/serverSettings.ts`: ban / GDPR removal.
- `socketHandlers/voice.ts`: `move-voice-user` rotates the SOURCE channel; the
  auto-leave-previous-channel on a new join rotates the old channel.
- `socketHandlers/dmCalls.ts` / `socketHandlers/stages.ts`: leaving a voice
  channel to join a DM call / stage rotates the old channel.
- `routes/gdpr.ts`: account self-deletion mid-call emits `voice-user-left`
  (so the remaining clients' leader-election backstop prunes the departed user)
  and rotates.
- `queues/workers/cleanup.worker.ts`: the scheduled expired-temporary-member
  purge is an involuntary removal of a live member; if that member is still in a
  server voice channel it now drops them from the SFU and rotates (mirrors kick).
The inactivity reaper (only fires when one user is left, emptying the channel) and
the ghost reapers (clean up already-disconnected users) are intentionally NOT
rotated: no remaining member is exposed to a live departed key.

**Client behavior:** none. `voice-e2ee-rotate` is already handled by every
deployed client (`hooks/useVoiceE2ee.ts onVoiceE2eeRotate`): the verified leader
mints a fresh session key and redistributes to the remaining members, excluding
the departed one. No deploy ordering concern (backend-only, backward compatible).
`scripts/check-schema-compat.ts` passes with no waiver; `fixtures.test.ts`
untouched.

## 2026-06-20 - server elects the voice key-holder by signed joinTimestamp

Additive, backend-only. No `protocolVersion` bump, no new/changed event or
payload field, no migration, no client change. No wire format is touched: only
*which* participant the server treats as the SFrame key-holder.

**Why:** clients elect the voice leader by the signed
`joinTimestamp` in each join-blob (`services/voiceE2ee.ts#selectSignedLeader`,
gated at `hooks/useVoiceE2ee.ts`), but the server authorized the key-holder
strictly by `participants[0]` ordered on the server-stamped `joinedAt` (Redis
arrival order). Those two orderings can flip relative order under ordinary
client clock drift (the ±30s join clamp bounds each blob's absolute skew but
never the *relative* order of two joiners). When they diverge the
server-allowed leader's key is rejected by every client AND the client-elected
leader's `voice-e2ee-distribute` is dropped by the server, so no SFrame key is
ever accepted and the call wedges with no recovery (the existing liveness
backstop fires only on leader *departure*, and rotation re-derived the same
`joinedAt` order). Fail-closed (no confidentiality break) but a real
availability/DoS gap.

**Server behavior change (no payload change):** a new pure helper
`backend/src/services/voiceLeaderElection.ts#electVoiceLeader` re-derives the
leader server-side using the SAME rule the client uses: among participants
whose stored join-blob VERIFIES (re-checked with the identical join-blob gate:
Ed25519 signature valid under the DB-authoritative `signingPublicKey`,
`blob.sigPub` matching it, `blob.channelId` matching), the earliest
`joinTimestamp` wins, ties broken by lex-smaller X25519 `pub`; if no participant
carries a verifying blob it falls back to the server-attested oldest by
`joinedAt` (exactly what the client falls back to when its election returns
null). Wired into the three server leader-authz seams: the `voice-e2ee-distribute`
gate and the `voice-e2ee-request-key` fallback (`socketHandlers/voice.ts`) and
the `voice-e2ee-rotate` `newLeaderUserId` (`services/voiceE2eeRotation.ts`). The
server already verifies + stores each blob at join, so no new trust in
client-asserted data is introduced; the verified `joinTimestamp` is merely
reused for ordering.

**Security:** the client key-accept gate (`useVoiceE2ee.ts`:
"accept a key only from the locally cryptographically-elected leader") is
DELIBERATELY UNCHANGED, so the anti-injection property is fully
preserved: a lying/compromised server still cannot get an attacker-controlled
key accepted. The server's election only decides which member it authorizes to
distribute; it can never make a client accept a non-elected key.

**Rejected alternative:** a purely client-side reconciliation (relax the gate to
the server-attested `participants[0]` after a grace window) was considered. It
was rejected because it requires every deployed client to update before any wedge
clears (web caches / Electron update on their own cadence) and adds recovery
latency, whereas this server-side fix corrects every already-deployed client the
moment the backend ships (clients already elect correctly: only the server was
wrong). It also avoids relaxing the client crypto gate.

**Rollout:** backward compatible, no two-phase deploy. During a rolling restart
old/new replicas only differ for skew calls, which are *currently wedged*, so
a mixed rollout can only fix them, never break a call that works today (when the
orderings agree, `electVoiceLeader` returns the same member as the old
`participants[0]`). `scripts/check-schema-compat.ts` is not triggered (no watched
schema path changed) and passes; `fixtures.test.ts` untouched.

## 2026-07-01 — key-change acknowledge: `dm-encryption-reset` push + reset hygiene

Additive. One NEW server → client event, a client listener for the EXISTING
`mls-group-reset` push, and additional server-side deletes inside the existing
`DELETE /api/dms/keys/bundle` transaction. No inbound schema change, no
`protocolVersion` bump. Following the `mls-group-reset` / `otr-ended` precedent, the
new event gets no `socketSchemas.ts` entry, so `fixtures.test.ts` (protocol-v1) is
untouched and `scripts/check-schema-compat.ts` passes with no waiver.

**Server → client (new, additive):**
- `dm-encryption-reset { userId }` — emitted (best-effort, post-transaction) by
  `DELETE /api/dms/keys/bundle` to the resetter's own `user:<id>` room and to every
  distinct DM partner's room (`pendingRemoval: null`, capped at 1000). Receivers
  NEVER clear a TOFU pin on it (a server-triggerable event must not weaken TOFU);
  they only re-attempt establish on shared MLS channels so the key change surfaces
  the warn+acknowledge prompt through the normal credential-validation path. Old
  clients ignore the event.

**Client adoption of an existing event:** `mls-group-reset { dmChannelId, mlsGroupId }`
(emitted since the 1:1 reset route shipped, previously with NO listener) is now
subscribed via `services/mls/mlsClient.ts` and relayed through the coordinator seams
(worker `socket-event: 'group-reset'`); the core drops the matching LOCAL group row
(groupId-guarded so a newer re-established group is never dropped) so re-establish
isn't wedged by stale state.

**`DELETE /api/dms/keys/bundle` (behavior extension, same response shape):** the
wipe transaction now ALSO deletes the user's pending `MlsWelcome` rows (sealed to
init keys the reset just destroyed — permanently unjoinable) and the user's
`AikRotation`/`AikHead` chain (the lineage ends at a reset; re-setup mints an
unlinked genesis AIK — mirrors the discontinuity clears on `/recover` and
`/signing-key`).

**Client-internal (no wire impact):** the MLS worker RPC error marshal gains
optional `blockedUserId` and the `reason` union widens to include
`'key-change-blocked'` (the typed pre-consume negative-cache refusal); the
net-result marshal gains optional `nonApiResponse` (apiClient stamps it on a
404 whose body is not the API's JSON `{ error }` shape, so the stale-group
teardown never treats an infra 404 as an authoritative delete); the
`MlsNetwork` seam gains `getPeerAik` (reads the existing
`GET /dms/keys/public-key/:userId`) and `resetGroup` (calls the existing
`POST /mls/groups/:groupId/reset`).

## 2026-06-20 - MLS persistence retention sweeps

Additive, backend-only. No `protocolVersion` bump, no new/changed socket event or
REST payload, no E2EE crypto change, and **no schema migration** (reaper-only).

**Why:** nothing pruned MLS persistence. `MlsKeyPackage`
consume only tombstones `consumedAt` (the pool cap counts AVAILABLE rows only) and
`MlsWelcome` has no consume/delete route and no FK on `groupId` (the
`DMChannel -> MlsGroup` delete cascade never reaches it), so consumed/expired
KeyPackages and stale/orphaned Welcomes grew without bound.

**Change:** a new daily BullMQ cleanup task `mlsRetentionSweep`
(`producers.ts` `0 5 * * *`) runs `sweepExpiredKeyPackages()` (prune
consumed/expired non-last-resort packages past a 7-day grace) and
`sweepStaleWelcomes()` (prune Welcomes older than a 14-day delivery TTL, and drop
Welcomes whose `groupId` no longer resolves to a live `MlsGroup`). The task name
is added to the `CleanupJobData` union and the `workerSchemas.ts` Zod enum.

**Deploy:** single-phase, additive, order-independent. A new BullMQ job name is
free (decision-tree rule 1); during a rolling deploy an old worker never receives
`cleanup-mlsRetentionSweep`, and one that somehow dequeued it would `safeParse`-
reject it harmlessly. `scripts/check-schema-compat.ts` is not triggered (no
watched path changed). A DB-enforced FK `MlsWelcome.groupId -> MlsGroup(id) ON
DELETE CASCADE` is a clean, provably-insert-safe future follow-up (the orphan
reaper handles the same case in code today, migration-free).
