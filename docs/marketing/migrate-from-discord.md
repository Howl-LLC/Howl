---
slug: move-discord-server-to-howl
title: Move Your Discord Server to Howl (Migration Guide)
description: Import your Discord channel history into Howl. Step-by-step guide, plan-tier file-size caps, and what does and doesn't transfer.
lastVerified: 2026-07-10
---

# How to Move Your Discord Server to Howl

Moving a Discord server to Howl works like this: you export each channel's history to a .json file with a third-party channel-export tool, then upload it to a Howl server where you hold the Manage Server permission. Howl re-creates the channel and its category and backfills the messages in the background. It's a message-history importer, not a full server clone: text content and reply threading come across, everything else stays behind.

## Why migrate (and why you might not)

Discord wins on ecosystem: bots, native iOS/Android apps, Go Live, a huge third-party integration surface (as of 2026-07-10). Howl is mobile-friendly in the browser, with a native app on the way; server bot support is planned too. Neither is here today, so if your community lives on bots and phones, a full switch will hurt.

Migrate when the things Discord can't give you matter more. We end-to-end encrypt DMs and group DMs with MLS (RFC 9420), a modern open encryption standard, with post-quantum protection layered in, and every voice, video, and stage call. Discord E2E-encrypts calls only (DAVE, as of 2026-07-10); its text stays server-readable. Neither platform end-to-end encrypts server text channels. You can also self-host: your own Docker instance, every Pro feature unlocked, no phone-home, which Discord doesn't offer. And it's open source under AGPL, with no ads and no rewards economy.

### The encryption boundary before you import

Migration lands your Discord history in the server-readable half. DMs, group DMs, DM file attachments, and all voice/video/stage calls are E2E-encrypted, so the server sees ciphertext only. Server text channels are not, and that's where imported Discord messages go. A server that moderates, searches, and backs up channels has to read them.

By default you hold your own keys (**Self recovery**). Opt into **Server recovery** and we store a server-readable copy of your vault key so we can help you recover, at the cost of the server being able to read that account's DM content.

## What the importer brings over

| Item | Imported? |
|---|---|
| Message content (text) | Yes |
| Reply threading (message references) | Yes |
| Original send/edit timestamps | Yes. Discord send and edit times are preserved from the export |
| Attachments | As links to the original files on Discord (not copied to Howl) |
| Channel creation | Yes. Creates the target text channel if missing |
| Category creation | Yes. Matches or creates the Discord category name |
| Original author identity | Stored as metadata (name/avatar/id) on each imported message; posts are attributed to the importing user |
| Roles / permissions | **No** |
| Members / user accounts | **No** |
| Reactions | **No** |
| Voice / stage channels | **No.** These exports are rejected |

Only text-type channels import: regular text, announcement, and forum channels, plus DM and group-DM text exports. Per file you get up to **100,000 messages**, message content capped at 4,000 chars, and up to 20 attachments per message.

## Prerequisites

1. A Howl server where you have the Manage Server permission (create one at app.howlpro.com or on your self-hosted instance).
2. A third-party channel-export tool that produces per-channel JSON files in the accepted format. This isn't Discord's own "Data Package" download, and we don't accept a zip. One .json file per channel.
3. A Howl plan that fits your export size (caps below). Imports run on background processing that's automatic on hosted Howl and included in the default self-host stack.

### Plan-tier file-size caps

Each uploaded JSON file must fit under your plan's cap:

| Plan | Max import file size |
|---|---|
| Free | 50 MB |
| Essential | 200 MB |
| Pro | 500 MB |

Chatty channels blow past 50 MB fast, so either upgrade (see the [pricing page](/pricing)) or export the channel in smaller date ranges and import each slice into the same channel. Rate limit: 2 imports per 15 minutes per user.

## Steps

**1. Export a channel.** In your export tool, select the channel, choose JSON as the format, and export. You'll get one .json file for that channel.

**2. In Howl, open the target server's settings → Import.** You need to be on a server where you hold Manage Server.

**3. Upload the .json file.** We check the format and your plan cap right away, re-create the channel and category if they don't exist, and start the import in the background.

**4. Watch progress.** The import runs in the background, and the app notifies you when it finishes or fails. Large imports take roughly **10 to 30 minutes**.

**5. Repeat per channel.** One JSON file per channel means exporting every text channel to migrate a whole server. Multi-select them all in one go and we work through them in sequence — two imports per 15 minutes, so a big server takes some patience. Matching Discord category names are reused, so the sidebar rebuilds as you go.

## What does NOT transfer

The importer handles messages only, so a lot stays behind.

Roles, permissions, and role assignments don't come over; rebuild those by hand. Members and accounts don't either, so your people join Howl themselves, and imported messages carry the original author's name and avatar as metadata but post under your account. Reactions sit in the export file but never get written, and voice and stage exports are rejected outright.

Attachments don't get copied to Howl. Imported messages link back to the original files on Discord, so if those originals are ever deleted, the links stop working. Custom emoji, stickers, pinned messages, and server settings don't come over either, and Discord threads arrive as regular messages (replies still point to the right message). Plan to set the rest up again by hand.

## Running both during the switch

You don't have to move everyone overnight. The smoothest path is to run both for a while:

1. **Bring the history in first**, channel by channel, so Howl already has everything before anyone relies on it.
2. **Keep Discord open** while people get set up on Howl (desktop app for Windows/macOS/Linux, or the mobile browser). The two don't sync, so during the overlap treat them as separate places.
3. **Pick a switch date.** After it, make the old Discord channels read-only and point new conversation to Howl. Imported attachments still link back to Discord, so keep the old server around (read-only is fine) and old files keep loading.

## FAQ

**What file format does Howl's Discord importer accept?**
A single .json file per channel, in the format produced by common third-party channel exporters. Not Discord's built-in "Data Package" export, and not a zip.

**Does importing bring my Discord members and their messages under their names?**
No; members aren't imported, so everyone joins Howl fresh. Imported messages are attributed to the importing user, with the original author's name, avatar, and ID stored as metadata.

**Are my imported Discord messages end-to-end encrypted in Howl?**
No; imported messages live in server text channels, which are server-readable on Howl just as they are on Discord. Our end-to-end encryption covers DMs, group DMs, and calls, not server channels.

**My server export is bigger than 50 MB. What can I do?**
Each file has to fit your plan cap (Free 50 MB / Essential 200 MB / Pro 500 MB). Either upgrade, or export the channel in smaller date ranges and import each slice into the same channel.

**How long does an import take, and how will I know it finished?**
It processes in the background, roughly 10 to 30 minutes for large channels, and the app notifies you when it's done. Limit: 2 imports per 15 minutes.

**Should I keep my Discord server running after migrating?**
Yes, at least read-only. There's no live bridge, and attachments import as links to the original Discord URLs, so taking the source server fully offline can break those links.

---

*Competitor details (Discord DAVE calls-only E2EE, ecosystem, pricing) reflect public information as of 2026-07-10 and may change.*

**Last verified: 2026-07-10**
