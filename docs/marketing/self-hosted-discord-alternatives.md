---
slug: self-hosted-discord-alternatives
title: "Self-Hosted Discord Alternatives (2026 Comparison)"
description: "Self-hosted, open-source Discord alternatives in 2026 compared on encryption, mobile, and hosting: Howl, Fluxer, Stoat, Matrix/Element, Spacebar."
lastVerified: 2026-07-10
---

# Self-hosted Discord alternatives in 2026

Five self-hosted, open-source Discord alternatives are worth a look in 2026: Matrix/Element, Fluxer, Stoat (formerly Revolt), Spacebar, and Howl (that's us). Each runs on your own server, each is open source, and the biggest difference between them is encryption: which parts are end-to-end encrypted varies from project to project.

We build Howl, so read our entry with that in mind.

In the table, the E2EE column means DMs and calls, not community channels. On Howl, Fluxer, Stoat, and Spacebar, server text channels stay readable by the server so moderation, search, and backups work (Discord works the same way). Matrix is the partial exception: private rooms there are end-to-end encrypted by default, though public community rooms generally aren't.

## Comparison table

The competitor rows reflect each project's publicly documented state as of 2026-07-10.

| | License | E2EE (DMs / calls) | Voice channels | Native mobile | Self-host shape | Business model |
|---|---|---|---|---|---|---|
| **Howl** | AGPL-3.0 | DMs yes (MLS, post-quantum) / calls yes (SFrame); server text no | Yes (LiveKit SFU) | Mobile-friendly browser; native on the way | Docker Compose, single stack | Subscriptions + donations; self-host unlocks all Pro free |
| **Fluxer** | AGPLv3 | DMs no (TLS only) / calls rolling out (canary) | Yes | In the works (Flutter) | Node + Postgres | Freemium (Plutonium €5/mo) |
| **Stoat** | AGPLv3 | DMs no (roadmap) / calls no | Yes (new system, Oct 2025) | Yes (inherited from Revolt) | Rust, multi-service | Donation-funded |
| **Matrix/Element** | Open protocol; Synapse + Element OSS | DMs yes (default) / calls yes (Element Call) | Yes (Element Call/MatrixRTC) | Yes (Element / Element X) | Synapse + MatrixRTC, multi-service | Open protocol; Element hosted plans paid |
| **Spacebar** | Open source | No E2EE | Yes (WIP) | No (web) | Alpha stage | Community project |

## Howl: DM- and call-encrypted, no native mobile yet

There's no native iOS or Android app yet; Howl is mobile-friendly in the browser, with native apps on the way. Our security reviews so far are internal, not a third-party audit, but the code is open source, so anyone can read it and check what we claim. Need a signed external audit today? Pick Matrix.

The encryption is the part we've put the most work into. DMs and group DMs are end-to-end encrypted with MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in (the full crypto detail is on our [security page](/security)). Every call is end-to-end encrypted too, and we mean all of them: DM and group-DM voice and video calls, plus the voice channels and stages inside a server. Joining a voice channel on a public Howl server is an encrypted call, which isn't something most people expect. If a call can't be encrypted, it doesn't connect at all: you see a red shield instead of a call that gave up its privacy. Server text channels are the one part that isn't end-to-end encrypted (they're encrypted in transit and at rest): they stay readable by the server so moderation and search work.

By default you hold your keys (Self recovery). Optional Server recovery uploads a server-readable copy of your vault key so we can help you get back in, with the tradeoff that we can then reach that account's DM content out of band.

Self-hosting is a Docker Compose deploy with automatic HTTPS via Caddy. The first account becomes admin. No phone-home by default (error reporting is opt-in), and every Pro feature is unlocked free on your instance. Voice and video are off until you point the instance at your own LiveKit server. Hosted plans are Free, Essential, and Pro; see the [pricing page](/pricing).

Choose Howl if you want encrypted DMs and calls out of the box on a Discord-style server, you can run Docker, and mobile-in-the-browser is fine for now.

## Fluxer: the closest to Discord's look, call E2EE arriving, no text E2EE

Fluxer (AGPLv3, from a solo developer in Sweden) is the one that most tries to feel like Discord: parity UI, a familiar feature set, and a native mobile client in the works (Flutter, iOS + Android; source out mid-2026, store releases planned). Voice and video E2EE is rolling out in canary to opted-in communities as of 2026-07-10. Text and DMs are a different story. They're not end-to-end encrypted, TLS in transit only, and the roadmap treats text E2EE as too complex to prioritize. Premium is "Plutonium" at €5/mo (competitor figure, as of 2026-07-10).

Choose Fluxer if the closest match to Discord's UI and native mobile apps on the way matter more than encrypted text DMs.

## Stoat (formerly Revolt): mature feature set, no message E2EE

Stoat rebranded from Revolt on 1 October 2025 after a trademark cease-and-desist. Servers, data, and features carried over, and a new voice system arrived alongside the rename. Rust backend, AGPLv3 upstream, self-hostable, with native iOS and Android apps inherited from Revolt. The catch, as of 2026-07-10: messages are not end-to-end encrypted. E2EE sits on the upstream roadmap and hasn't been released. Donation-funded and free.

Choose Stoat if you want a polished, community-run Discord-style app with native mobile and don't need message E2EE.

## Matrix / Element: the maturity and federation benchmark

Matrix is an open federated protocol, and Element is its flagship client. It's the only option here with E2EE on by default across DMs, group chats, and 1:1 and group calls (Element Call / MatrixRTC), backed by mature native iOS and Android apps and years of ecosystem. Nothing here matches its maturity or its federation model. The cost is operational: it's a multi-service deployment, and E2EE calls mean also standing up MatrixRTC/Element Call infrastructure unless you rent Element's hosted suite. The Community self-host tier is free; hosted plans run roughly Business ~$5 and Enterprise ~$10 per user/month (competitor figures, as of 2026-07-10).

Choose Matrix/Element if you want the widest encryption coverage, federation, native mobile, and a track record, and you can handle the setup.

## Spacebar: Discord-API-compatible, but alpha and no E2EE

Spacebar (formerly Fosscord) reimplements Discord's API, so existing Discord clients and bots can point straight at a Spacebar instance. That compatibility is unique on this list. The caveats, as of 2026-07-10: no E2EE, and the project is still WIP/alpha.

Choose Spacebar if API and client compatibility with the existing Discord bot ecosystem is the whole point and you accept alpha-stage software without E2EE.

## Adjacent tools (not Discord clones, but often the right answer)

- **Rocket.Chat / Mattermost / Zulip**: open-source, self-hostable team platforms. Rocket.Chat offers optional E2EE, off by default. Mattermost is strong on compliance, SSO, and admin, but not E2EE by default. Zulip's topic-threaded model tames channel sprawl and isn't E2EE either. Reach for one of these when you're outfitting a workplace rather than a community. (All as of 2026-07-10.)
- **Mumble**: open-source, self-hosted, lowest-latency voice only, with positional audio. Transport-encrypted, not user-verified E2EE. Pick it for a dedicated voice server and nothing else.

Discord itself isn't self-hostable and is proprietary. It does E2EE calls by default through the DAVE protocol (open source, independently audited by Trail of Bits), but not text. Its native mobile apps, bot ecosystem, and polish stay the bar every project here gets measured against.

## FAQ

**Which self-hosted Discord alternative has the most complete encryption?**
Matrix/Element: it's the only one here with E2EE by default across text DMs, group chats, and calls (as of 2026-07-10). Howl covers DMs, group DMs, and all calls but not server text channels; Fluxer covers calls (canary) but not text; Stoat and Spacebar have no message E2EE yet.

**Are any of these fully end-to-end encrypted, including server channels?**
Matrix/Element comes closest: private rooms and DMs are encrypted by default, though public community rooms generally aren't. On Howl, Fluxer, Stoat, and Spacebar, server text channels are readable by the server so they can be moderated, searched, and backed up; Howl's E2EE covers DMs, group DMs, and every call.

**Which one has real native mobile apps?**
Stoat and Matrix/Element have native iOS and Android apps as of 2026-07-10; Fluxer's Flutter apps are in the works. Howl is mobile-friendly in the browser with native apps on the way; Spacebar is web-first.

**Which is easiest to self-host?**
Howl runs from a single Docker Compose stack and Fluxer from a standard Node and Postgres stack. Matrix/Element involves the most services, since E2EE calls mean running MatrixRTC infrastructure alongside Synapse.

**Can I migrate my Discord server?**
Howl imports messages from per-channel JSON exports (Manage Server required); it doesn't import roles, members, permissions, or reactions. Spacebar takes a different route via Discord-API compatibility; check each project's own migration docs for current support.

**Is Howl really free to self-host?**
Yes. Self-hosted instances unlock all Pro features free, no phone-home by default. Hosted plans (Free / Essential / Pro) are on the [pricing page](/pricing).

---

Last verified: 2026-07-10
