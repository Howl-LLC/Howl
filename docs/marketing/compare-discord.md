---
slug: howl-vs-discord
title: "Howl vs Discord: A Private Discord Alternative"
description: "How Howl compares to Discord on encryption, self-hosting, price, and features, and what to check before you switch."
lastVerified: 2026-07-10
---

# Howl vs Discord: a private, open-source alternative

Howl is an open-source Discord alternative with end-to-end encrypted DMs and calls. You can run it yourself with Docker, and a self-hosted instance unlocks every paid feature. That's the pitch.

Whether it fits your community mostly comes down to two things: how much your server depends on Discord's bots, and how much of your community lives on their phones. Server bot support is on the way, and we plan to build native mobile apps if the project gets traction, but today those are Discord's advantages.

## What's actually encrypted

Howl end-to-end encrypts DMs, group DMs, and every voice, video, and stage call. DMs use MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in. Calls use SFrame media encryption over a LiveKit SFU. If a call can't be encrypted, it doesn't connect at all: you see a red shield instead of a call that gave up its privacy. (The full crypto detail is on our [security page](/security).)

Server text channels are not end-to-end encrypted on Howl. Channels need moderation, search, and history for the person who joined last week, and plain text is also how server bots will work once they land. The encryption is for the private half of the app: your DMs, your group chats, your calls.

By default you hold your own keys (Self recovery), and if you lose them, we can't help you. If you'd rather be able to recover your account, you can opt into Server recovery, which stores a server-readable copy of your vault key, so the server could then read that account's DMs.

## What Discord still does better

Bots. If your server leans on a moderation bot, a music bot, and a handful of webhooks, none of that comes with you yet. Server bot support is in the works, but there's no ecosystem today.

Mobile. Discord has native iOS and Android apps. Howl is mobile-friendly in the browser (installable to your home screen, push notifications included), and native apps are planned once there's traction.

Encryption-wise, Discord covers calls (DAVE, on by default, as of 2026-07-10). Text and DMs stay server-readable. On Howl, calls and DMs are both encrypted.

## What you get on Howl

The whole platform is AGPL-3.0, so you can read the crypto code instead of taking this page's word for it.

Self-hosting is a Docker Compose file that brings up the full stack with automatic HTTPS, no license key, no phone-home, and every Pro feature enabled out of the box. Voice needs your own LiveKit server; text and encrypted DMs work without it.

There's no advertising and no rewards economy. Revenue is subscriptions and donations.

Feature-wise, it's the shape you'd expect from a Discord-style platform. Servers with channels and roles, threads, forums, polls, events, stages, screen share, and activity status for Spotify, Steam, Twitch, YouTube, Riot, and Epic. Desktop apps via Electron, and a Stream Deck plugin.

## Importing from Discord

Howl can import your channel history. Export each channel to a JSON file with a third-party channel-export tool, one file per channel. (Discord's own "Request my data" download is a different thing and won't work here.) Upload those files to a Howl server where you have the Manage Server permission and the import runs in the background; big ones take 10 to 30 minutes.

Messages come over with reply threading, attachment links, and the original author's name and avatar. The importer creates the channel and category if they don't exist yet. Roles, members, permissions, and reactions don't transfer. Caps: 100,000 messages per file, file sizes of 50 MB on Free, 200 MB on Essential, 500 MB on Pro, and 2 imports per 15 minutes.

## Who shouldn't switch yet

- Your server runs on bots. Bot support is coming, but we can't replace your setup today.
- Your members are mobile-first. The browser experience may not be enough for them until native apps arrive.
- You need E2EE in large public channels. Howl's encryption covers DMs, group DMs, and calls, not server channels.
- You need a vendor your compliance team already knows. Read our Privacy Policy, Law Enforcement guidelines, and Breach Notification policy first, or just self-host so the question goes away.

If your community mostly lives on desktop and cares that DMs and calls are unreadable by the platform, Howl is a strong fit.

## FAQ

**Is Howl actually end-to-end encrypted?**
DMs, group DMs, and all voice/video/stage calls, yes: MLS (RFC 9420) with post-quantum protection for messages, SFrame for calls. Server text channels aren't E2EE.

**Is Discord end-to-end encrypted?**
Calls yes, text no. As of 2026-07-10 Discord encrypts voice and video by default via DAVE. Messages and DMs remain server-readable.

**Can I self-host Howl for free?**
Yes: Docker Compose, every Pro feature enabled, no phone-home. Voice needs your own LiveKit server; everything else works without it.

**Does Howl have a mobile app?**
Not a native one yet. Howl is mobile-friendly in the browser, installable to your home screen with push notifications, and native apps are planned as the platform grows.

**Can I move my Discord server to Howl?**
Message history, yes: export each channel to a JSON file with a third-party export tool and upload the files. Roles, members, permissions, and reactions don't transfer, and you need Manage Server permission on the destination.

**What does Howl cost?**
Free tier, plus Essential and Pro subscriptions (prices on the [pricing page](/pricing)); self-hosted gets everything free. Discord's Nitro Basic was $2.99/mo and Nitro $9.99/mo as of 2026-07-10.
