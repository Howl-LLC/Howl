# Howl DM Encryption Spec

## Overview

Every DM and group DM on Howl is end-to-end encrypted with MLS (Messaging Layer Security, RFC 9420). The server stores and relays ciphertext it cannot read on its own. The one exception is users who opt into **Server recovery** (server-assisted key escrow): for those users the server holds a usable copy of their key material and *can* decrypt their DM and group-DM content out of band. Under the default mode, **Self recovery** (user-held keys), the server cannot decrypt. See "The vault and recovery models" below for the exact trust boundary.

There is no opt-in toggle, no "secure" tab, and no tier distinction in the live product: MLS is the only DM content crypto, the only DM key distribution, and the only DM-call keying. The pre-MLS scheme (per-channel AES-256-GCM keys exchanged via X25519 `tweetnacl.box` dead drops) has been removed; this spec describes the end state.

A small set of pre-2026-03-28 legacy DMs created before universal E2E shipped remain server-encrypted-at-rest only (see "At-rest invariants" below). Everything created after the universal-E2E cutover is MLS end-to-end encrypted.

This is an engineering reference.

## Protocol stack

- **Group messaging protocol:** MLS (RFC 9420) via the [`ts-mls`](https://www.npmjs.com/package/ts-mls) library. One MLS group backs each `DMChannel` (1:1 and group DMs alike).
- **Ciphersuite:** codepoint **83**, `MLS_256_XWING_AES256GCM_SHA512_Ed25519`: a post-quantum **hybrid** suite (X-Wing KEM = X25519 + ML-KEM-768, AES-256-GCM, SHA-512, **Ed25519** signatures). Locked in `services/mls/ciphersuite.ts`, mirrored in `backend/src/mls/ciphersuite.ts`, and pinned by name at the AS (`backend/src/mls/as.ts`). **Interim codepoint:** 83 is a draft value (draft-mahy-mls-xwing / draft-ietf-mls-pq-ciphersuites, codepoints 77–88), **pending IANA** assignment. Re-verify the ts-mls mapping and re-pin if IANA assigns X-Wing a final codepoint (`healSuiteMismatchedGroups` bounds breakage by re-establishing mismatched groups). **Confidentiality is PQ-hybrid, but authentication is classical Ed25519:** harvest-now-decrypt-later protects message *content*, not *identity*. A future quantum adversary could forge Ed25519 signatures. Migration to ML-DSA-87 (codepoint 87) is tracked.
- **Group state location:** client-side IndexedDB database `howl_mls` (`services/mls/mlsGroupStore.ts`). Group ratchet state is encrypted at rest under a per-account at-rest key (see "The vault"); the server never holds MLS group state for a Self-recovery user.
- **Single-writer discipline:** MLS group state is mutated by exactly one tab. A tab acquires a `navigator.locks` lease named `howl-mls-writer` (`services/mls/mlsTabLock.ts`); the elected writer runs MLS in a SharedWorker (`services/mls/mlsWorker.ts` / `mlsWorkerHost.ts`), and non-writer tabs read through it. This prevents two tabs from advancing the same single-use message ratchet and corrupting group state. When `navigator.locks` is unavailable (older WebView, some test environments) the code falls back to single-tab leadership.
- **Coordinator:** `services/mls/mlsCoordinator.ts` + `mlsCoordinatorCore.ts` own group lifecycle (create, join, commit, message encrypt/decrypt) and bridge the worker boundary; `mlsEngine.ts` wraps the raw `ts-mls` primitives; `mlsReconcile.ts` reconciles local group state against the server delivery service after a reconnect.

## Identity model

Howl carries **two** distinct identities per account. Keeping them straight is load-bearing.

### Per-device MLS identity

Each device has its own MLS leaf identity: an Ed25519 signing keypair plus the basic-credential identity bytes `utf8("${userId}:${deviceId}")` (`services/mls/mlsEngine.ts` `MlsIdentity`, minted in `dmKeyManager.mintMlsIdentity`). This identity is **device-local**: it is persisted only in the device's `howl_mls` store via `mlsGroupStore.putIdentity` and is **never** written into the roaming recovery blob. A new device (or a re-installed device) mints a fresh `deviceId` + signing keypair and publishes its own KeyPackages.

Per-device identity is what lets one account participate from multiple devices: each device is a separate MLS leaf in the group, so a second device does not collide with the first device's leaf or share its signing key.

### Roaming X25519 / Ed25519 vault identity

A separate, long-lived X25519 box keypair plus an Ed25519 signing keypair lives in the recovery blob and roams across devices. This identity **does not encrypt any DM content**. It survives because it is still load-bearing for:

- **Voice/stage SFrame keying** (see "Voice and stage calls"). `dmKeyManager.encryptKeyForRecipient` / `decryptKeyFromSender` wrap voice/stage session keys to the X25519 public key; `signVoiceJoinBlob` / `verifyVoiceJoinBlob` sign leader-election join blobs with the Ed25519 key.
- **Recovery blob AAD.** The blob is sealed with its X25519 public key bound as additional authenticated data (`getBlobAAD` in `dmKeyManager.ts`). Keeping the identity keeps the blob format and AAD intact across all recovery paths.

The public half of this identity is published in the user's `DmKeyBundle` (`publicKey`, `signingPublicKey`); the server cross-validates voice join-blob signatures against `DmKeyBundle.signingPublicKey`, and clients independently TOFU-pin that key as the voice/stage trust anchor (see *Voice and stage calls*).

## Group membership and key distribution

A 1:1 DM is created keyless: `POST /api/dms` creates the channel (self-DM, family-restriction, block, dedup, and `MAX_DM_CHANNELS` guards intact) with no key material on the wire. The client then classifies the channel `mls` and calls `mlsCoordinator.establishChannel`, which is idempotent (it self-resolves a deduped or concurrently-created channel). Group DMs create the same way.

Members are distributed group state via MLS, not a dead drop:

- **Welcome.** When a member is added, the committer produces an MLS `Welcome` for the new member's published KeyPackage; the new member joins from the Welcome.
- **External Commit.** A member can self-join an existing group by publishing an external commit against the group's public `GroupInfo` (used for cold-start 1:1 and concurrent-create reconciliation).

KeyPackages are published to the directory service (`backend/src/routes/mls.ts`); a freshly-minted identity publishes an initial batch, and the elected writer replenishes them.

### Membership authority (owner-only Remove, two-phase kick)

Group membership changes are server-authorized:

- The group **owner** (`DMChannel.ownerId`) is the only principal allowed to remove a member. The REST kick route marks the target `DMParticipant.pendingRemoval` (phase one) and the resulting MLS `Remove` commit is framed as an `mls_public_message` so the delivery service can read the inline `Remove` proposal, map removed leaf indices to userIds against the stored pre-commit ratchet tree, and reject any commit that removes a member the owner did not first mark `pendingRemoval` (`403 unauthorized_remove`). This is the two-phase kick: owner marks, then the group commits the cryptographic removal (phase two).
- A self-leave elects the oldest non-`pendingRemoval` remaining member to author the Remove commit that evicts the leaver's leaf; a stale-`pendingRemoval` sweep (`cleanup.worker.ts`) re-fires `dm-key-rotation-needed` until the Remove lands if the elected author was offline.
- `dm-key-rotation-needed` is **not** legacy: it is the MLS leave/kick leader-election signal and always carries `leaverId`.

A removed member is cryptographically evicted: the post-Remove epoch re-keys the group, so the ex-member cannot decrypt subsequent messages even if the server were to relay them.

## Message protection

- Messages are MLS application messages: each is sealed under the current epoch's message keys (per-message single-use ratchet), giving forward secrecy and post-compromise security within the conversation.
- The server persists the opaque MLS ciphertext to `DMMessage.content` (with the per-message IV in `DMMessage.contentIv`) and relays it over Socket.IO. It cannot decrypt (Self-recovery users) or only out of band via escrow (Server-recovery users).
- **Fail-closed, no rung below MLS.** A channel classified `mls` but not yet ready (group state still draining) blocks sends and calls; it never falls back to plaintext or a weaker scheme. There is no legacy decrypt path to downgrade to.
- **The placeholder is healable.** When a message arrives on a channel that is not yet classified `mls` (a real socket-ordering race: `new-dm-message` can beat `mls-welcome` on a brand-new 1:1), decrypt renders the standard lock placeholder *and stamps* `undecryptable: true` + `_encryptedEnvelope` (and `_encryptedContent` for reply quotes). `useMlsRedecrypt` watches those flags and re-decrypts the rows the moment the Welcome drain classifies the channel `mls`, with no reload. "Wait" means self-healing wait, never stuck-until-reload.
- **Own-sent history archive.** A sender's MLS application message is decryptable by the recipient's ratchet, not the sender's own; to let a sender re-read its own sent messages after reload, the plaintext is also written to the local history archive (see "Cross-device history").
- **Downgrade resistance.** The channel classification is a one-way ratchet (`encryptionFlags.setChannelProtocol`, persisted in localStorage and mirrored across tabs merge-only), alongside the `encrypted` flag ratchet and the server-side `DMChannel.encrypted` no-downgrade Prisma guard. A compromised server cannot move a live MLS channel back to plaintext.

## Attachments

File attachments on DM messages are encrypted client-side with a per-file random AES-256-GCM key before upload. The ciphertext is uploaded to R2; the per-file key is sealed into the MLS message payload (so it is protected by the same epoch keys as the message). See `services/fileCrypto.ts`.

## The vault and recovery models

The user's secrets live in a client-sealed **recovery blob**, stored server-side as `DmKeyBundle.encryptedBlob` (mapped to the `SecureKeyBundle` table). Unlocking is a single Argon2id pass:

- `deriveUnlockMaterial(password, salt)` (`services/dmCrypto.ts`) runs Argon2id (`hash-wasm`, in a Web Worker) **once** and derives three independent keys from the one hash:
  - `blobKey` (AES-256-GCM) seals/opens the recovery blob.
  - `atRestKey` (HKDF-SHA256, info `howl-mls-at-rest`) encrypts the local `howl_mls` MLS group state and per-device identity at rest.
  - `historyKey` (HKDF-SHA256, info `howl-mls-history`) encrypts the local Saved-history archive.
- The blob carries the roaming X25519/Ed25519 identity (`privateKey`, `privateSigningKey`) and the `archiveKey` (see below). It does **not** carry the per-device MLS identity (device-local only) or any per-channel DM key (MLS keys never leave the device).
- `blobVersion` is optimistic-locking metadata: stale writes are rejected; clients re-fetch, merge, and retry.

The unlock path (`dmKeyManager.unlock` / `recover` / `serverRecover`) is the single MLS entry point: it decrypts the blob, loads or mints the per-device MLS identity, sets the at-rest and history keys on the group store, and activates the coordinator. A failure *after* the blob decrypts (e.g. an MLS activation error) does not surface as "wrong password," because the password was already proven correct by the decrypt.

The user chooses one of two recovery models at setup. Both produce MLS-encrypted DMs on the wire; they differ only in the recovery story and in whether the server holds a readable copy.

### Self recovery (default; `passwordDerived = false`)

The user takes custody of their own key material. The server stores only the public keys plus the client-sealed `encryptedBlob` and a user-held `recoveryBlob` (sealed under a 256-bit recovery key shown once at setup). No `serverEscrowBlob` exists, so the server has **no** key that can read this user's DM content and nothing it could target with an offline guessing attack. Lost password *and* lost recovery key means the identity is unrecoverable, and the user is told so explicitly at setup.

### Server recovery (`passwordDerived = true`)

The user opts in and sets a separate DM password. In addition to the client-sealed blob, the client uploads the raw blob contents so the server stores a `serverEscrowBlob`: the *same* secrets re-encrypted under a server-held key, `AES-256-GCM(HKDF(SERVER_E2E_MASTER_KEY, userId), rawBlobContents)` (`backend/src/services/e2eEscrow.ts`). The server can decrypt this blob at will (it does exactly that in `POST /api/v1/dms/keys/server-recover`). **For these users the server holds a usable copy of their keys and can read their DM and group-DM content** (including, via the carried `archiveKey`, their history archive rows). This is the honest cost of server-assisted recovery and is stated plainly wherever the trust model is described.

`passwordDerived` defaults to `false`. Switching from Server recovery back to Self recovery (`DELETE /api/v1/dms/keys/password-derived`) deletes the `serverEscrowBlob` going forward but does not retroactively rotate anything the server may already have read.

Escrow-bearing blob writes fail closed: when `SERVER_E2E_MASTER_KEY` is unavailable, the escrow-writing routes return `503` and commit nothing rather than silently committing a blob with a null escrow.

## Vault-independent provisioning

Establishing an MLS group for a DM requires consuming the peer's published KeyPackages. Originally KeyPackages were published only from vault operations (`bootstrapMlsIdentity` fires from `unlock`/`setup`/`recover`/`serverRecover`), so a peer who never unlocked on a post-MLS build, or whose packages lapsed (every row, last-resort included, was clamped to a 30-day `notAfter`), returned 404 and the DM could not be established. Vault-independent provisioning decouples a device's *addressability* (its MLS identity + a live KeyPackage pool) from *unlocking the vault*.

### Device-local wrap key

The per-device MLS signing key and the KeyPackage private packages are encrypted at rest under a dedicated **device-local wrap key**, not the vault-derived `atRestKey`. The wrap key is a single non-extractable AES-256-GCM `CryptoKey` generated per (origin, browser profile) and stored directly (structured-clone) in the `howl_mls` IndexedDB (`STORE_DEVICEKEY`, id `mls-device-wrap`, `mlsGroupStore.getOrCreateDeviceWrapKey`). It is reachable from both the main thread and the MLS SharedWorker (IndexedDB is origin-global; the worker fetches the key itself at init - it is never passed across the worker `postMessage` boundary). It never leaves the device, is never escrowed, and is never roamed. It is destroyed only by `reset()` / `clearAll()`, which fire on BOTH logout and an in-app encryption reset (`reset()` calls `mlsGroupStore.clearAll()` on the full sign-out / reset path) - never by lock, idle-lock, or `forgetDevice`, because the device identity must remain usable whenever the device is logged in. A logout-time clear is safe: the boot provisioner re-mints the device identity on the next login. (Note: the server route `DELETE /api/v1/dms/keys/bundle` deletes the server-side bundle/KeyPackage rows; it does NOT clear the client IndexedDB stores, so it is not what destroys this device-local key.)

Identity and KeyPackage rows carry a cleartext `wrapVersion` discriminator: `1` = legacy (privates wrapped under the vault `atRestKey`), `2` = device-wrap (under the device-local key). On read, the store branches on `wrapVersion`; a legacy v1 row is read with the `atRestKey` for read-compat and opportunistically re-wrapped to v2 the next time the `atRestKey` is available. Group ratchet state (`STORE_GROUPS`) and the history archive (`STORE_HISTORY`) stay **vault-keyed** under the `atRestKey` / `historyKey`: this preserves the Self-mode guarantee that existing group state and history cannot be read without the vault password. Identity/KeyPackage operations succeed with only the device key set; group/history operations still fail closed ("mls store locked") until the vault unlocks. A Server-mode password change re-keys only `STORE_GROUPS`/`STORE_HISTORY` - the identity rides the device wrap and does not rotate with the password (so a password change cannot orphan the identity and trigger a re-mint).

### Boot provisioner

`provisionMlsDevice()` runs on every authenticated session start, **before and independent of** vault unlock, single-flighted across tabs by an exclusive `navigator.locks` lease (`howl-mls-provision`, held only for the provisioner's duration; distinct from the lifetime-held `howl-mls-writer` single-writer lease). Its branch on the pre-unlock identity probe (`mlsGroupStore.getIdentityMeta`, which reads the identity row's existence + `wrapVersion` without decrypting):

- **No row:** mint a fresh device identity under the device wrap (`wrapVersion 2`) and publish the initial batch (`KEYPACKAGE_BATCH_SIZE` single-use + one last-resort).
- **`wrapVersion 1` (legacy row):** **defer** - never mint a second identity (the per-device-identity collision lesson). The next unlock re-wraps the existing identity to v2.
- **`wrapVersion 2`:** load the identity, top up single-use KeyPackages to the batch size, and unconditionally mint+publish a **fresh last-resort** each run (deleting the prior local last-resort private).

The probe is the load-bearing fix: a plain `getIdentity` returns `null` for both a missing row *and* an undecryptable legacy row, which would let a legacy device mint a second identity (a leaf collision). `getIdentityMeta` distinguishes the two without the vault. `bootstrapMlsIdentity` (unlock/recover/serverRecover) keeps its activation role and shares the same provision lock; recovery still mints a **fresh** identity (revocation semantics) and forces it by deleting the prior identity + KeyPackage privates before load-or-mint.

### No-expiry last-resort

Single-use KeyPackages keep a 30-day `notAfter`; the last-resort KeyPackage is rotate-only with a finite far-future `notAfter` (`now + 100 years`, not `max-int64`, so the non-nullable `notAfter` column never receives an `Invalid Date`). The server clamp is conditional: 30-day ceiling for single-use, `now + 100 years` for last-resort (`backend/src/mls/as.ts` `validateAndBindKeyPackage(..., isLastResort)`). The read-side `notAfter > now` filters then admit a live last-resort indefinitely, so a peer who provisioned once and went idle stays DM-able. The server trusts the client-asserted `isLastResort` for the no-30-day-clamp branch, bounded by the one-live-last-resort supersede (the publish transaction deletes prior last-resort rows) and consume-prefers-single-use ordering. The join-boundary secrecy of a group formed from a stale last-resort is bounded by rotation cadence (every boot), not by expiry - the accepted Signal-equivalent tradeoff.

### Content-key posture by recovery mode

Where the device identity always provisions vault-independently, the **content keys** (`blobKey`, `atRestKey`, `historyKey`) follow the recovery mode:

- **Self recovery (`passwordDerived = false`):** content stays password-gated. Remember-on-device is an opt-in 30-day sliding-TTL persistence of the content keys, wrapped under the device-local key in IndexedDB (replacing the previous wrapped-password localStorage stash). Idle-lock and the lock prompt are unchanged.
- **Server recovery (`passwordDerived = true`):** content-key persistence is always-on with no TTL. At login the flow derives the unlock material from the account password and unlocks silently; on a fresh device it calls `POST /api/v1/dms/keys/server-recover` with the same password (the route enforces exactly that credential). After unlock the content keys are wrapped under the device-local key and persisted, so subsequent boots install them with no password (a passwordless install path that skips Argon2id and runs the shared post-derive install tail), no lock screen, and idle-lock skipped. If escrow is unavailable (`503`) or recovery fails, the flow degrades to the lock prompt (fail closed; never a silent-plaintext path).

#### Silent-unlock matrix

| Login credential | Silent unlock? |
| --- | --- |
| Password present (no MFA) | Yes - unlock derives from the account password (already shipped). |
| Passkey / MFA / device-verify / SSO (`passwordHash = null`) | Only if the device already holds a device-wrapped content key; otherwise fail-closed degrade to the lock prompt (never silent plaintext). |
| Pure-SSO (`passwordHash = null`) on a fresh device | Cannot server-recover (the route 400s with no password credential), so it degrades to the lock prompt. Giving SSO accounts a server-recovery credential is a tracked follow-up. |

The silent-unlock mechanism for non-password logins is the device-wrapped content-key persistence, **not** re-derivation from an absent password. "No lock screen for Server users" is therefore not a universal property - it holds for password-present logins and for devices that already hold a wrapped content key.

#### Mode switches and migration

- Server -> Self: purge the device's content-key persistence and remove escrow (the existing `escrowStale` machinery); other devices heal lazily on their next boot/bundle-fetch, same-device tabs converge via the existing `howl_e2e_password_derived` storage event.
- Self -> Server: enable always-on content-key persistence and send escrow.
- The legacy localStorage remember-device stash is honored once on first unlock post-deploy, re-persisted under the device mechanism (write-new and verify-readback before delete-old), then the localStorage entries are deleted. On Electron the OS-keychain (`safeStorage`) persistence tier is preserved.

## Cross-device history archive

MLS application messages are decryptable only by the device that processed the relevant ratchet step. A second device, or the same device after re-unlock, cannot self-decrypt prior MLS history from the ciphertext alone. The cross-device archive converges a user's own readable history across their devices without exposing plaintext to the server:

- Each archive row is `base64(AES-256-GCM(archiveKey, utf8(plaintext)))` with a 16-byte GCM tag, sealed client-side (`services/dmCrypto.ts` `sealArchiveRow` / `openArchiveRow`). The 96-bit GCM IV is **derived deterministically** via HKDF-SHA256 over the raw `archiveKey` and the row tuple (info `howl-archive-iv:v1:userId:dmChannelId:messageId:envelopeHash`) rather than randomly generated, so within a key generation IVs are unique by construction: no random-nonce birthday bound and no SP800-38D invocation ceiling. The IV is recomputed on open, so it is **not** stored in the row.
- The seal uses a **distinct** key from the live message keys: a stable per-account `archiveKey`, a 32-byte AES-256-GCM key generated by `crypto.getRandomValues` (`dmKeyManager`), carried in the blob, **not** HKDF-derived from the Argon2id hash and independent of `blobKey`/`atRestKey`/`historyKey`. It is intentionally long-lived (does not rotate on password change) so old rows stay readable. **Carve-out (honest statement): a single static `archiveKey` decrypts the user's entire conversation-history archive. The server stores only ciphertext, but any device (or the escrow path below) that holds this one key reads all archived plaintext for the account.** See *Archive key cryptoperiod and rotation* below.
- Each row binds AAD `howl:archive:v2:userId:dmChannelId:messageId:envelopeHash:keyVersion`, so a compromised server cannot splice a valid ciphertext under a different (channel, message, envelope) tuple, nor relabel a row's generation: `keyVersion` is the archiveKey generation (`DmHistoryArchive.keyVersion`, currently `1`), and a downgraded label breaks the tag → the row is rejected and falls back to live decrypt (anti-downgrade). An *active* min-version floor on restore composes with the move-to-Private rotation work when it lands.
- **Deleted messages are not resurrected.** A delete-for-everyone records a write-once tombstone: client-side (the `howl_mls` `tombstones` store, consulted by the restore and re-archive paths) and server-side (`DmHistoryArchiveTombstone`, written in the same transaction as the row deletion; the upload route filters tombstoned items). A re-served or re-uploaded copy of a deleted row is suppressed. *Residual:* a participant who is permanently offline during a delete and never reconnects before provisioning a fresh device could still surface their own surviving server copy, a fundamental limit without a server-trusted deletion broadcast.
- Rows are stored and served **opaque** via `/api/v1/dms/history-archive` (`backend/src/routes/dmHistoryArchive.ts`): batch upsert, per-channel restore, delete-for-everyone write-through, and bulk wipe, each gated on active `DMParticipant` membership. The server never reads the plaintext. The local archive is bounded by a synced-aware oldest-eviction cap (`MAX_HISTORY`): already-uploaded (`synced`) rows are evicted oldest-first, and a not-yet-uploaded row is dropped only as a last resort when synced rows cannot cover the overflow (logged as `droppedUnsynced`). The server enforces a per-user row cap oldest-first.
- The `archiveKey` is **not** stripped by `stripMlsForEscrow`, so Server-recovery users carry it into `serverEscrowBlob` and the server can decrypt their archive rows out of band, exactly as it can their live content. Self-recovery users' `archiveKey` never reaches the server, so their rows stay opaque to it.

### Archive key cryptoperiod and rotation

- **Provenance.** `archiveKey` is 32 bytes from `crypto.getRandomValues` (CSPRNG); it is never derived from a password and never HKDF-stretched.
- **IV uniqueness.** Because the per-row IV is HKDF-derived from the (key, row-tuple) rather than randomly sampled, IV collision within a key generation is structurally impossible, so the random-IV birthday bound (~2³² rows under SP800-38D) does **not** apply, and rotation is driven by compromise response and calendar, not an invocation count. No persisted per-key counter is required.
- **Cryptoperiod.** One static key seals every row, so its default cryptoperiod is the account lifetime. Each row records the sealing generation via `keyVersion`, so rotation is supported without a destructive read break.
- **Rotation triggers (deferred plumbing).** A new generation is minted (and `keyVersion` incremented) on: move-to-Private key rotation, suspected key compromise, and a move from Server recovery back to Self recovery. On rotation the client re-seals prior rows under the new key and the server raises a min-acceptable-`keyVersion` floor that the restore path enforces. That rotation/floor machinery (the move-to-Private work) is tracked separately; `keyVersion` is already bound into the AAD now so it composes cleanly when that lands.

## Voice and stage calls

Voice/stage and DM calls all use LiveKit SFrame end-to-end encryption (`ExternalE2EEKeyProvider`) over the DTLS-SRTP transport. They derive their SFrame keys differently:

### DM calls (keyed from the MLS exporter)

A DM call's SFrame base key is derived from the channel's MLS group via the RFC 9420 exporter (`mlsEngine.exportSecret`, label `SFrame 1.0 Base Key`, 32 bytes). Because the key comes from the live MLS epoch, the call inherits MLS forward secrecy and post-compromise security, and a removed member's eviction rekeys the call key too.

The call scheme (`useDMCall.ts` `DmCallKeyScheme`) is `mls | blocked | none`:

- **`mls`** - the MLS exporter yielded a key; the call is end-to-end encrypted. Green shield, gated by the bilateral `dm-call-e2ee-ack` round-trip (each side confirms its own SFrame leg keyed). Mid-call epoch lag or decrypt failure surfaces via `RoomEvent.EncryptionError` → `mlsDegraded`.
- **`blocked`** - E2EE was expected but no MLS key was available (e.g. a call placed on a brand-new channel before MLS is ready). The call carries **no media** and shows a red/blocked shield. It is never silently downgraded to a transport-only or plaintext call. This is the honest failure.
- **`none`** - E2EE was not expected for this channel (the legacy non-encrypted case).

There is no legacy call-key scheme and no peer-dependent downgrade/upgrade ladder.

**SFU-eject backstop.** When a member is removed from a group during a call, the MLS Remove rekeys the group so the kicked member goes deaf, and the server additionally hard-disconnects them at the LiveKit SFU (`backend/src/routes/dms.ts` member-removal), the same belt-and-suspenders eject used for voice-channel kicks and GDPR removal.

### Server voice channels and stages (X25519 box wrap)

Server voice channels and stages are **not** on MLS (they have no MLS group). They keep the proven SFrame key-holder scheme: the oldest verified participant is the leader and generates the SFrame session key, which it wraps to each participant's X25519 public key (`dmKeyManager.encryptKeyForRecipient` / `decryptKeyFromSender`, the surviving box primitives) and distributes over the `voice-e2ee-key` / `stage-e2ee-key` socket events. The key rotates on participant departure for forward secrecy.

**Identity trust is client-pinned, not server-supplied.** The Ed25519 key that signs join blobs and host attestations is the account identity key (AIK) — the same key MLS cross-signs into device credentials and TOFU-pins per peer in the shared `howl_mls` trust store. Voice leader election (`services/voiceE2ee.ts` `selectSignedLeader`) verifies each peer's signed join blob (`signVoiceJoinBlob` / `verifyVoiceJoinBlob`) against that **client-pinned AIK** — resolved from the trust store, TOFU-pinned on first sight — not the key the server hands over on the wire; a peer whose key fails the pin is dropped from election. Stages have no leader election, so the host distributes a **signed host attestation** (`signStageHostBlob` / `verifyStageHostBlob`): it signs `{channelId, wrapKey, AIK}`, and each audience member verifies it against the host's pinned AIK and decrypts the session key with the wrap key bound *inside the attestation*, never a server-supplied host key. Both paths fail closed on a pin mismatch, so a malicious or compromised server cannot substitute a signing/wrap key and MITM the SFrame session key. The server still cross-validates voice join blobs against `DmKeyBundle.signingPublicKey` as defense in depth, but it is no longer the trust anchor.

Note: this is the X25519 *box wrap over its own socket events*, **not** a `PendingKeyDelivery` dead drop. The dead drop was DM-only and has been removed.

Server text channels are not E2E encrypted (server admins need moderation visibility). This spec covers DM and call media; server-channel media inherits the room's SFrame E2EE for voice.

## At-rest invariants

- DM channels created after the universal-E2E cutover have `DMChannel.encrypted = true`; the send path rejects plaintext writes to them and a Prisma guard blocks `encrypted = false` (no-downgrade).
- Pre-2026-03-28 legacy DMs (`DMChannel.encrypted = false`, `DMMessage.encryptionVersion = 1`, `DMMessage.contentIv = null`) are **server-encrypted at rest** under `DM_ENCRYPTION_KEY` (`backend/src/services/dmCrypto.ts`, the server-side AES service - distinct from the frontend `services/dmCrypto.ts`) but are not end-to-end encrypted. They are the only category of DM where the server can see plaintext, retained to preserve user history. A small set of server-generated system messages (group add/remove, DM-call notices) are also written under this key.
- **`DM_ENCRYPTION_KEY` validation & cryptoperiod.** The key must be a strict 32-byte hex value (`isValidHexKey32`, the same gate as `MFA_ENCRYPTION_KEY`/`SERVER_E2E_MASTER_KEY`); a missing/invalid key is fatal in production and falls back to a deterministic test key only under `NODE_ENV=test`. The key has no automatic rotation. Its cryptoperiod is operational: rotate on suspected compromise or staff offboarding. Because the legacy server-at-rest set is a closed, pre-cutover population, re-encryption on rotation is a one-shot batch, not an ongoing migration.
- **Rotation runbook (`DM_ENCRYPTION_KEY`).** (1) Provision a new key. (2) Decrypt the closed set of server-encrypted rows (`contentIv != null`, `encryptionVersion = 1`) under the old key and re-encrypt under the new one in a single maintenance pass. (3) Swap the env var and redeploy. *Deferred enhancement:* a key-id-prefixed keyring + deterministic per-record IV + row-binding AAD (HKDF over the message id) would let new and old generations coexist and bind each blob to its `(dmChannelId, messageId)` row; tracked as a residual (the at-rest splice/IV hardening), out of scope for the current pass.

## Reporting

When a user reports a DM message, the plaintext is decrypted client-side and submitted directly to the admin panel (it is not stored as plaintext in the main database). This works on MLS DMs because the reporter's own client can already read the message; the report carries the client-decrypted plaintext. The legacy server-side report-verification subsystem (which re-decrypted a reporter-supplied channel key) has been removed.

## What this design does and does not provide

- **Forward secrecy and post-compromise security within a conversation:** provided by MLS epoch ratcheting. Member changes rekey the group.
- **Per-device identity:** each device is its own MLS leaf; no roamed signing key.
- **Cross-device readable history:** provided by the cross-device archive (opaque to the server for Self-recovery users).
- **Server blindness for DMs:** the message path sees only ciphertext. The sole exception is Server-recovery users, whose `serverEscrowBlob` gives the server an out-of-band read path by design.
- **Not provided:** an MLS-credential safety number / mutual-verification UI (the legacy X25519 safety number was removed because it attested an identity that no longer protects DM content; an MLS-credential safety number is a tracked follow-up). No deniable messaging or disappearing-message primitives.

## The v3 wire break

The legacy-teardown change bumped `CURRENT_PROTOCOL_VERSION` 2 → 3 (`shared/protocol.ts` + `backend/src/protocol.ts`, byte-synced) and physically removed the legacy DM wire surface (the `/dms/keys/start|pending|claim|rotate-key` and DM-verification routes, the key-exchange body fields on DM create, the `join-dm-call` `e2eeKey` field, the `dm-key-delivery` / `dm-key-rotated` socket events, and the `PendingKeyDelivery` / `DmVerification` models and `MessageReport.channelKey` / `.verificationState` columns). The 60-day deprecation window was waived because this is a replace-not-migrate clean break; deployments apply it as a strict cutover. Full break record: `docs/PROTOCOL_CHANGES.md` (entry 2026-06-10).

## Relevant code paths

- `services/mls/` - MLS engine (`mlsEngine.ts`), coordinator (`mlsCoordinator.ts` / `mlsCoordinatorCore.ts`), worker single-writer (`mlsWorker.ts` / `mlsWorkerHost.ts` / `mlsTabLock.ts`), group store (`mlsGroupStore.ts`, IndexedDB `howl_mls`), reconcile (`mlsReconcile.ts`), per-device identity (`mlsIdentity.ts`), ciphersuite (`ciphersuite.ts`), history archive sync/restore (`mlsHistoryArchiveSync.ts` / `mlsHistoryRestore.ts`).
- `services/dmKeyManager.ts` - the vault: Argon2id unlock, Self/Server recovery, escrow, blob persistence, the roaming X25519/Ed25519 identity, the per-device MLS identity bootstrap, voice/stage key wrap primitives, and the drive into the MLS coordinator.
- `services/dmCrypto.ts` - surviving pure crypto helpers: `deriveUnlockMaterial` (blob/at-rest/history keys), recovery-blob seal, the archive seal (`sealArchiveRow` / `openArchiveRow`), and the voice/stage box/keygen primitives. (The legacy DM message codec has been removed.)
- `services/dmEncryption.ts` - the MLS encrypt/decrypt entry points wiring into the DM send/receive path.
- `services/encryptionFlags.ts` - per-channel `mls` classification ratchet + `encrypted` flag ratchet (downgrade resistance).
- `services/fileCrypto.ts` - per-file AES-256-GCM attachment encryption.
- `services/voiceE2ee.ts` / `services/stageE2ee.ts` / `services/call/CallEngine.ts` - voice/stage/DM-call SFrame E2EE.
- `hooks/useDMCall.ts` - DM-call key scheme (`mls | blocked | none`) and shield derivation.
- `backend/src/routes/dmKeys.ts` - identity-key-bundle lifecycle (setup, blob update, password change, recovery, public-key/signing-key, password-derived toggle, server-recover, bundle reset). Mounted under `/api/v1/dms/keys/*`.
- `backend/src/routes/dmHistoryArchive.ts` - the opaque cross-device history archive.
- `backend/src/routes/mls.ts` - the MLS delivery/directory service (KeyPackages, commits, welcomes).
- `backend/src/services/e2eEscrow.ts` - server-side escrow encrypt/decrypt for Server recovery.
- `backend/prisma/schema.prisma` - `DmKeyBundle` (mapped to `SecureKeyBundle`), `DMChannel`, `DMMessage`, `DmHistoryArchive`.
