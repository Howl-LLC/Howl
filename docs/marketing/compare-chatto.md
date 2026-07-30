---
slug: howl-vs-chatto
title: "Howl vs Chatto: Self-Hosted Chat With and Without E2EE DMs"
description: "Howl and Chatto both self-host with E2EE calls. The split: Howl end-to-end encrypts DMs and is Discord-shaped; Chatto is single-community team chat."
lastVerified: 2026-07-30
---

# Howl vs Chatto

Chatto is an open-source, self-hostable team chat platform that went open source in July 2026, from German developer Hendrik Mans. It runs one community per instance, closer to Slack or Teams than to Discord, and as of 2026-07-30 it encrypts messages at rest but not end-to-end, so whoever operates the server can read message content; its author has said end-to-end encrypting text is out of scope by design. Howl is Discord-shaped, one account across many servers, and it end-to-end encrypts DMs, group DMs, and every voice and video call by default. Both are AGPL and self-host for free.

Chatto is ahead on a few things: an unusually small single-binary deploy, SSO in the open-source build, and the client polish that led its launch.

## Team chat versus community servers

The first difference is shape, before encryption even comes up. Chatto is one community per instance, with rooms that range from free-form chat to forums and social feeds, plus a roles and permissions system. It's built for a single team or group space, the way Slack or Teams is.

Howl is Discord-shaped: one account joins many servers, each with text and voice channels, stages, roles, and moderation, plus public community discovery and vanity URLs. If you want a single space for one team, that difference counts for Chatto. If you want people to join many communities under one identity, that's Howl.

## Encryption

We encrypt the private half of the app. DMs, group DMs, and all voice, video, and stage calls are end-to-end encrypted, and the server sees ciphertext only. DM content uses MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in; calls use SFrame over a LiveKit SFU, and if a call can't be encrypted, it doesn't connect at all: you see a red shield instead of a call that gave up its privacy. (The full crypto detail is on our [security page](/security).)

Server text channels are not end-to-end encrypted on Howl (they're encrypted in transit and at rest): they stay readable server-side so they can be moderated, searched, and backed up.

Chatto's announcement describes its voice and video calls as end-to-end encrypted. Text takes a different path: messages are encrypted at rest with per-user keys, and deleting an account destroys its keys (they call it crypto shredding), but the operator can read them, and the author has said text E2EE isn't planned (as of 2026-07-30). At-rest encryption protects the stored copy, not the conversation from whoever runs the server.

By default you hold your own keys (Self recovery), and if you lose them, we can't help. Opt into Server recovery and we can recover a lost account, but that uploads a server-readable copy of your vault key, and for that account the server can then decrypt your DMs.

## Where Chatto is ahead

The deployment is unusually compact: a single 50 MB binary with no dependencies that serves its own frontend, so a basic instance runs without a separate database. SSO is included in the open-source build rather than held back for an enterprise tier. Integrations get first-class GraphQL and NATS APIs plus pluggable extensions. Chatto Cloud offers managed hosting on European-owned infrastructure, in beta as of 2026-07-30, which counts if EU domicile matters to your procurement or users. And the client's speed and design were the most-praised parts of its open-source debut; the developer has been building polished software for decades.

## Where Howl is ahead

Encryption, as above. It's the reason Howl exists. Past that, there's the multi-community model itself, and more built in: stages with host, speaker, and audience roles, screen share with viewer indicators, picture-in-picture calls, DeepFilterNet 3 noise suppression (no GPU required), forums with tags, polls in channels and DMs, events and calendar, themes and custom chat backgrounds, an Electron desktop app (Windows x64/arm64, macOS, Linux) with a game and voice overlay, and a Stream Deck plugin. Moderation tooling (roles, permission overrides, member screening, an auto-filter) is available today; Chatto has roles and permissions, with content reporting and moderation planned for its v0.5 (as of 2026-07-30).

## Funding

Chatto is free to self-host, with Chatto Cloud as paid managed hosting in beta. Howl runs on subscriptions and donations. No genuine features sit behind a paywall: the paid tiers (Essential and Pro) add extras like higher-resolution screen sharing and more customization, and self-hosting unlocks all of it free. We don't run ads. It's a standard subscription model; current prices are on the [pricing page](/pricing).

## Self-hosting both

Both projects are self-hostable and open source. Chatto runs as a single executable that serves its own frontend, with no separate database needed for a basic install, and Docker Compose for more involved deployments. Ours is Docker-first, with setup documentation in the repo: a quick local test first, then a public deploy with automatic HTTPS. The first account registered becomes the owner. Voice and video are optional and need your own LiveKit server; text, DMs, and full E2EE work without one. Email is optional too, and accounts auto-verify if you configure none.

## FAQ

**Is Chatto end-to-end encrypted?**
Its calls are, per its announcement; text messages aren't, they're encrypted at rest and readable by the operator, and the author has said text E2EE is out of scope (as of 2026-07-30). Howl's DMs, group DMs, and all calls are end-to-end encrypted by default.

**Which one is more like Discord?**
Howl: one account joins many servers, with voice channels, stages, and community discovery. Chatto runs one community per instance and sits closer to Slack or Teams.

**Are both open source?**
Yes. Chatto is AGPL-3.0-or-later with Apache-2.0 exceptions for some components; Howl is AGPL-3.0. Confirm license terms in each repo before relying on them.

**Which is easier to self-host?**
Chatto runs as a single binary with no separate database for a basic install; Howl is a single Docker Compose stack (voice needs a separate LiveKit server), and self-hosting unlocks all paid features free.

**Can I migrate my Discord server to Howl?**
Partially. Howl imports messages from per-channel JSON exports (text only, not roles, members, permissions, or reactions), needs Manage Server permission, and runs as a background job.

**Which should I pick?**
If end-to-end encrypted DMs and a Discord-style multi-server model matter most, pick Howl. If a single team or community space from the smallest possible deployment matters more, that's Chatto's focus. Both are open and self-hostable, so trying each is cheap.

---

*Last verified: 2026-07-30. Competitor details reflect publicly available information on that date and may have changed since.*
