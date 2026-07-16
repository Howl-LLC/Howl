---
slug: howl-vs-stoat
title: "Howl vs Stoat (formerly Revolt): Encryption Compared"
description: Stoat is an established open-source Discord alternative with no E2EE. How Howl compares on encryption, voice, self-hosting, and funding.
lastVerified: 2026-07-10
---

# Howl vs Stoat (formerly Revolt)

Stoat, the project that used to be called Revolt, is one of the more established open-source, self-hostable Discord alternatives. It runs on donations, and as of 2026-07-10 it doesn't end-to-end encrypt anything, so whoever operates the server can read message content. Howl is newer, funded by subscriptions and donations, and E2E-encrypts DMs, group DMs, and every voice and video call. Self-hosting unlocks every paid feature.

Stoat is ahead on a few things: track record, native mobile apps, a Rust stack.

## The rename: Revolt is now Stoat

If you searched for Revolt and landed on "Stoat," it's the same software. The rebrand was announced for 1 October 2025, forced by a cease-and-desist over the "Revolt" trademark. Servers, user data, features, and core values carried over unchanged. The repositories moved to the stoatchat GitHub org, and a new voice system plus new web and desktop clients arrived alongside the name.

## Encryption

Stoat doesn't end-to-end encrypt messages. E2EE is on the upstream roadmap but hasn't been released, which means the operator (the official host, or whoever runs your instance) can read message content. It's the same posture Discord takes for text.

We encrypt the private half of the app. DMs, group DMs, and all voice, video, and stage calls are end-to-end encrypted. DM content uses MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in; calls use SFrame over a LiveKit SFU. (The full crypto detail is on our [security page](/security).)

Server text channels are not end-to-end encrypted on Howl (they're encrypted in transit and at rest), same boundary as Discord and Stoat: server messages are readable server-side so they can be moderated, searched, and backed up.

By default you hold your own keys (Self recovery), and if you lose them, we can't help. Opt into Server recovery and we can recover a lost account, but that uploads a server-readable copy of your vault key, and for that account the server can then decrypt your DMs.

## Where Stoat is ahead

Stoat has been around longer and built a bigger base; roughly 600,000 registered users were cited before the rebrand (reported). It has native iOS and Android apps today, where ours are still on the way (Howl is mobile-friendly in the browser meanwhile). Its backend is Rust; ours is Node.js and TypeScript.

## Where Howl is ahead

Encryption, as above. It's the reason Howl exists. Past that, there's more built in: threads, forums with tags, polls, events and calendar, stages with screen-share and viewer counts, picture-in-picture calls, DeepFilterNet noise suppression, and a Stream Deck plugin. And the Docker self-host turns on every Pro feature for free, with no phone-home.

## Funding

Stoat is donation-funded through Open Collective, historically with an optional cosmetic supporter tier. Howl runs on subscriptions and donations. No genuine features sit behind a paywall: the paid tiers (Essential and Pro) add extras like higher-resolution screen sharing and more customization, and self-hosting unlocks all of it free. We don't run ads. It's a standard subscription model; current prices are on the [pricing page](/pricing).

## Self-hosting both

Both projects are self-hostable and open source, both with Docker. Stoat runs as a multi-service Rust deployment. Our setup documentation is in the repo: a quick local test first, then a public deploy with automatic HTTPS. The first account registered becomes the owner. Voice and video are optional and need your own LiveKit server; text, DMs, and full E2EE work without one. Email is optional too, and accounts auto-verify if you configure none.

## FAQ

**Is Stoat the same as Revolt?**
Yes. Revolt rebranded to Stoat on 1 October 2025 after a trademark cease-and-desist, same project and data, new name and repos under the stoatchat org.

**Does Stoat have end-to-end encryption?**
Not for messages, so the operator can read content; E2EE is on the roadmap but hasn't been released. Howl E2E-encrypts DMs, group DMs, and calls, though (like Stoat and Discord) not server text channels.

**Does Howl have a mobile app?**
Not yet; Howl is mobile-friendly in the browser (installable to your home screen), with native apps on the way. Stoat has native iOS and Android apps.

**Is Howl more private than Discord too?**
For DMs and calls, yes: Discord's DAVE protocol covers voice and video but not text DMs. Server channels on all three are server-readable.

**Which is easier to self-host?**
Both use Docker. Stoat is a multi-service Rust stack; Howl is a single Compose setup (voice needs a separate LiveKit server), and self-hosting unlocks all paid features free.

**Can I migrate my Discord server to Howl?**
Partially. Howl imports messages from per-channel JSON exports (text only, not roles, members, permissions, or reactions), needs Manage Server permission, and runs as a background job.

---

*Last verified: 2026-07-10*
