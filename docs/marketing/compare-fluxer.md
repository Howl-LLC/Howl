---
slug: howl-vs-fluxer
title: Howl vs Fluxer, Open-Source Discord Alternatives
description: "Howl and Fluxer are both AGPL, self-hostable Discord alternatives. The split: Howl's E2EE is on by default today, Fluxer's is mostly roadmap."
lastVerified: 2026-07-10
---

# Howl vs Fluxer: two open-source Discord alternatives, compared

Howl and Fluxer are both open-source, AGPLv3-licensed, self-hostable Discord alternatives. The one place they split is encryption. Our end-to-end encryption for DMs, group DMs, and all voice/video/stage calls is on by default today; Fluxer's text and DM messages are TLS-in-transit only, with E2EE still mostly on the roadmap as of 2026-07-10.

## The tech stack

Both are open source under AGPLv3 and self-hostable. Fluxer runs Node.js + PostgreSQL; Howl runs Node.js/Express + Socket.IO + PostgreSQL. Fluxer's official clients can point at a custom instance; a self-hosted Howl serves its own web app (the official desktop client targets the hosted service).

## End-to-end encryption

We end-to-end encrypt three things, and the server sees ciphertext only. Direct messages and group DMs run on MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in. DM file attachments are encrypted per file before upload. Voice, video, and stage calls use SFrame over a LiveKit SFU, and if a call can't be encrypted, it doesn't connect at all: you see a red shield instead of a call that gave up its privacy. (The full crypto detail is on our [security page](/security).)

Server text channels are the exception: encrypted in transit and at rest, but not end-to-end, so we can offer moderation, search, and backups.

By default you hold your own keys, and Self recovery keeps the only copy with you. Opt into Server recovery and it uploads a server-readable copy of your vault key so we can recover a lost account, which means the server can then read that account's DMs.

Per Fluxer's own 2026 roadmap, text and DMs are not end-to-end encrypted (TLS in transit only), and the project has said text E2EE would add too much complexity and is deprioritized. Voice and video E2EE has moved past roadmap: it runs in canary for opted-in communities and rolls out as clients update. Optional E2EE for personal notes, calendar, DMs, and small groups is planned, not released.

## Where Fluxer is ahead

Fluxer aims to track Discord's UI as closely as possible. Howl is Discord-style too, so neither asks a switching community to relearn much; Fluxer just leans furthest into the exact layout. On mobile, Fluxer is further along: a native Flutter client for iOS and Android is in the works, with source published in mid-June 2026 and store releases planned. Howl is mobile-friendly in the browser today, with native apps planned as the project grows.

## What else you get on Howl

Beyond encryption: stages with host, speaker, and audience roles, screen share with viewer indicators, picture-in-picture calls, DeepFilterNet 3 noise suppression (no GPU required), forums with tags, polls in channels and DMs, events and calendar, community discovery with vanity URLs, themes and custom chat backgrounds, an Electron desktop app (Windows x64/arm64, macOS, Linux) with a game/voice overlay, and a Stream Deck plugin. Voice and video run on a LiveKit SFU rather than a P2P mesh, which holds up better on larger calls.

## Self-hosting

Both self-host. Ours is Docker-first, with setup documentation in the repo. Every Pro feature is unlocked free by default, nothing phones home, HTTPS is automatic, and the first account registered becomes admin. Voice/video is optional (bring your own LiveKit), and so is email (with none, accounts auto-verify); text, DMs, and full E2EE work without either. Fluxer self-hosts on its Node and Postgres stack.

## Ownership and jurisdiction

Fluxer is an independent, self-funded project from a solo developer in Sweden, reportedly operating as Fluxer Platform AB (exact legal entity unverified as of 2026-07-10). If EU domicile matters to your procurement or users, that counts in Fluxer's favor. Our answer to jurisdiction is self-hosting: run your own instance and your data sits wherever you put it, keys held by your users.

## Pricing

Both are freemium. Fluxer's premium tier, Plutonium, is €5/month (an early one-time "Visionary" tier sold about 1,000 seats at $299 before it closed), as of 2026-07-10. We run on subscriptions and donations, with Free, Essential, and Pro tiers plus power-ups (server boosts), gifting, and a one-per-user free trial; current prices are on the [pricing page](/pricing). Self-hosting unlocks every Pro feature at no cost.

## Migrating from Discord

We have a built-in Discord import: export your channels to JSON files with a third-party export tool, then upload them to a Howl server where you have Manage Server. It brings messages only (content, reply threading, attachment links) and creates channels and categories as needed. Roles, members, permissions, and reactions don't transfer, and only text and forum channels are supported. Limits are 100,000 messages per file with plan-tiered size caps.

## FAQ

**Is Fluxer end-to-end encrypted?**
Not for text or DMs as of 2026-07-10; those are TLS-in-transit only, with text E2EE deprioritized on the roadmap, while voice/video E2EE rolls out via canary. Our E2EE for DMs, group DMs, and all calls is on by default today.

**Does Howl encrypt server channels?**
Yes, in transit and at rest, but not end-to-end: the server can read them, which is what makes moderation, search, and backups work (and how server bots will work once they land). DMs, group DMs, DM attachments, and calls are the end-to-end encrypted half.

**Which one has a mobile app?**
Fluxer has a native Flutter app for iOS and Android in the works (source out mid-2026, store releases planned). Howl is mobile-friendly in the browser today, with native apps on the way.

**Are both really open source?**
Yes, both AGPLv3 and self-hostable. Confirm license terms in each repo before relying on them.

**Can I move my Discord server over?**
To Howl, yes: upload a JSON export of each channel and it brings messages, channels, and categories, but not roles, members, or reactions.

**Which should I pick?**
If E2EE for DMs and calls that's on by default matters most, pick Howl. If tracking Discord's exact UI matters more, that's Fluxer's focus, and both are open and self-hostable, so trying each is cheap.

---

*Last verified: 2026-07-10. Competitor details reflect publicly available information on that date and may have changed since.*
