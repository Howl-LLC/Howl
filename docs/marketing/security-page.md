---
slug: security
title: "Howl Encryption and Security: What's End-to-End Encrypted"
description: How Howl encrypts your data with MLS post-quantum E2EE for DMs, group DMs, and every call. What's encrypted, what isn't, and why.
lastVerified: 2026-07-10
---

# Howl encryption and security: what's end-to-end encrypted, and what isn't

Howl end-to-end encrypts your direct messages, group DMs, and every voice, video, and stage call. For those, the server sees ciphertext, nothing else. Server text channels are **not** end-to-end encrypted, for reasons below.

Howl is open source, so you can check any of this against the code. Competitor claims carry an "as of" date and get re-checked when the date at the bottom moves.

## What's end-to-end encrypted

For the following, the server stores and relays **opaque ciphertext only**. It can't read the plaintext.

- Direct messages and group DMs. Content encryption and key distribution run on **MLS (RFC 9420)** via [ts-mls](https://www.npmjs.com/package/ts-mls), ciphersuite codepoint 83, `MLS_256_XWING_AES256GCM_SHA512_Ed25519`: a **post-quantum hybrid** suite pairing the X-Wing KEM (X25519 plus ML-KEM-768) with Ed25519 signatures and AES-256-GCM. Group state is single-writer, encrypted at rest in the browser, per-device leaf identities.
- DM file attachments, encrypted per file with AES-256-GCM before upload. The server holds the ciphertext; the key rides inside the encrypted MLS channel.
- DM and group-DM voice/video calls. SFrame E2EE over a LiveKit SFU, not peer-to-peer mesh. The SFrame base key derives from the channel's **MLS exporter**, binding the call to the same end-to-end channel as your messages.
- Server voice channels and stages. SFrame E2EE, keyed by an oldest-verified-participant-as-key-holder scheme: the holder wraps the session key to each peer's X25519 public key and distributes it over the signaling channel. This keying sits outside MLS, on signature-verified join blobs pinned trust-on-first-use.
- The DM history archive. Rows sealed client-side with AES-256-GCM; the server stores the ciphertext.

Fail-closed by design. A DM call that can't obtain a valid E2EE key doesn't fall back to plaintext: you see a red blocked shield and no media. The failure mode is "no call," never "unencrypted call."

## What's NOT end-to-end encrypted

Server text channels, their messages, and uploads posted to them use ordinary server-side storage: encrypted in transit and at rest, but readable by the server by design.

Why? The same reason Discord and Slack keep them readable: a public community needs moderation, full-text search, spam and abuse handling, backups, and history for the member who joined last week. You can't moderate or search content you can't read. When you need a conversation the server can't read, use a DM, a group DM, or an Off the Record chat (a DM mode where messages live only on your devices and are never backed up to our servers). The DM path only ever sees ciphertext, and we won't add content inspection to it.

## The recovery-escrow tradeoff

End-to-end encryption creates a problem. If only you hold the keys and lose them, your history is gone.

**Self recovery** is the default. Your key material stays with you, and the server holds nothing that can decrypt your DMs. Lose your recovery method and the content is unrecoverable, by us or anyone.

**Server recovery** is opt-in. You upload a server-readable copy of your vault key material so the server can help you recover. The cost: for those accounts, the server can then decrypt that user's DM content out of band.

You can switch between the two whenever you want. Turning Server recovery on uploads that escrow copy; turning it back off deletes our copy, and you're back to holding your keys alone. One side effect to know about: Off the Record chats require Self recovery on both sides, so turning Server recovery on ends any Off the Record chats you have open. You get a warning first, and the other person sees the chat close. Switch back to Self recovery and you can go Off the Record again.

You can't have both "the server can restore your keys" and "the server can never read your content."

## Audits

Our security reviews so far are internal, not a third-party penetration test or formal certification. The strongest external assurance in this category today is Discord's DAVE protocol, independently audited by Trail of Bits (as of 2026-07-10); we haven't commissioned an equivalent yet.

## Open source and self-hosting

Howl is open source under AGPL-3.0 and self-hostable under the same terms.

Run your own instance with Docker. Every Pro feature is unlocked free, there's no phone-home, and DMs stay E2E encrypted. Voice/video is off by default on self-host, since it needs your own LiveKit; text and encrypted DMs run without it. Setup documentation is in the repo.

## Responsible disclosure

Found a vulnerability? Tell us before anyone else. Email support@howlpro.com with "SECURITY" in the subject line (or use private vulnerability reporting on the GitHub repository) rather than opening a public issue, give us a reasonable window to remediate, and we'll credit you if you'd like. Our Law Enforcement guidelines, Breach Notification policy, and DMCA policy are published in advance, not improvised after an incident.

## FAQ

**Is Howl end-to-end encrypted?**
Your DMs, group DMs, and all voice/video/stage calls, yes: MLS (RFC 9420) with a post-quantum hybrid ciphersuite for messages, SFrame for calls. Server text channels aren't, so communities can moderate and search.

**What encryption does Howl use for DMs?**
MLS (RFC 9420) via [ts-mls](https://www.npmjs.com/package/ts-mls), ciphersuite `MLS_256_XWING_AES256GCM_SHA512_Ed25519`: X-Wing (X25519 plus ML-KEM-768) key exchange, Ed25519 signatures, AES-256-GCM content encryption. That's the post-quantum hybrid part. The key exchange protects your message keys against a future quantum attacker; the Ed25519 signatures authenticating participants stay classical.

**Can Howl read my messages?**
Not your DMs or calls under default Self recovery; those keys stay with you. It can read server text channels (by design), and it *can* read the DMs of users who opt into Server recovery, since that uploads a server-readable copy of their key material.

**What happens to a call if encryption fails?**
It's blocked, not downgraded: the client shows a red shield and sends no audio or video. There's no silent plaintext fallback.

**Has Howl been independently audited?**
Not yet; our security reviews so far are internal. Discord's DAVE call protocol has a Trail of Bits audit; we don't have an equivalent.

**Is Howl really open source?**
Yes: AGPL-3.0 and self-hostable, with all Pro features unlocked and no phone-home. Hosted-service pricing is on the [pricing page](/pricing).

---

*Last verified: 2026-07-10. Competitor details are framed "as of 2026-07-10" and re-checked on that date; Howl claims are checkable against the open-source code.*
