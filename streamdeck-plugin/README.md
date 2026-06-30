# Howl Stream Deck Plugin

Elgato Stream Deck plugin for Howl. Controls voice, calls, presence, reactions, threads, and stages from a Stream Deck device.

## Install

```bash
cd streamdeck-plugin
npm install
```

## Build

```bash
npm run build        # Bundle to com.howlpro.streamdeck.sdPlugin/bin/plugin.js
npm run typecheck    # TypeScript check (no emit)
npm run dev          # Watch mode (rebuilds on change)
```

## Validate

```bash
npm run validate     # Check manifest, PI paths, action UUIDs, icons
```

Validates that:
- manifest.json parses and has all required fields
- All 20 action UUIDs use the `com.howlpro.streamdeck.*` prefix
- PropertyInspectorPath files exist on disk for actions that declare them
- Icon files exist (warning only since icons are TODO)
- Built `bin/plugin.js` exists

## Package

```bash
npm run package
```

Produces `com.howlpro.streamdeck.streamDeckPlugin` in the `streamdeck-plugin/` directory. This file is a renamed `.zip` archive that can be distributed and installed by double-clicking.

The package script runs validation automatically before creating the archive.

## Sideload for Local Testing

Link the `com.howlpro.streamdeck.sdPlugin` directory into the Stream Deck plugins folder:

- **Windows:** `%APPDATA%\Elgato\StreamDeck\Plugins\`
- **macOS:** `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`

On Windows (PowerShell, run as Administrator):
```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:APPDATA\Elgato\StreamDeck\Plugins\com.howlpro.streamdeck.sdPlugin" `
  -Target "C:\path\to\Howl\streamdeck-plugin\com.howlpro.streamdeck.sdPlugin"
```

On macOS:
```bash
ln -s /path/to/Howl/streamdeck-plugin/com.howlpro.streamdeck.sdPlugin \
  ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/com.howlpro.streamdeck.sdPlugin
```

Then restart the Stream Deck software, or run:
```bash
streamdeck restart com.howlpro.streamdeck
```

## Prerequisites

The plugin connects to the Howl desktop app via a local WebSocket bridge. To use it:

1. Install and run the Howl Electron desktop app.
2. In Howl, go to **Settings > Stream Deck** and enable the integration.
3. The first time the plugin runs, it will prompt you to pair from the Howl app.

## Icons

Icons ship with the plugin under `com.howlpro.streamdeck.sdPlugin/imgs/`. The plugin- and action-level icons are stored at the following paths:

**Plugin-level icons:**
- `com.howlpro.streamdeck.sdPlugin/imgs/plugin.png` (256x256) + `plugin@2x.png` (512x512)
- `com.howlpro.streamdeck.sdPlugin/imgs/category.png` (28x28) + `category@2x.png` (56x56)

**Per-action icons** (288x288 recommended for retina):

| Action | Icon path | Key path |
|--------|-----------|----------|
| Mute | `imgs/actions/voice-mute/icon.png` | `imgs/actions/voice-mute/key.png` |
| Deafen | `imgs/actions/voice-deafen/icon.png` | `imgs/actions/voice-deafen/key.png` |
| Push to Talk | `imgs/actions/voice-ptt/icon.png` | `imgs/actions/voice-ptt/key.png` |
| Camera | `imgs/actions/voice-camera/icon.png` | `imgs/actions/voice-camera/key.png` |
| Hang Up | `imgs/actions/voice-hangup/icon.png` | `imgs/actions/voice-hangup/key.png` |
| Switch Voice Channel | `imgs/actions/voice-switch-channel/icon.png` | `imgs/actions/voice-switch-channel/key.png` |
| Cycle Audio Device | `imgs/actions/voice-device-switcher/icon.png` | `imgs/actions/voice-device-switcher/key.png` |
| Answer Call | `imgs/actions/call-answer/icon.png` | `imgs/actions/call-answer/key.png` |
| Decline Call | `imgs/actions/call-decline/icon.png` | `imgs/actions/call-decline/key.png` |
| End Call | `imgs/actions/call-end/icon.png` | `imgs/actions/call-end/key.png` |
| Cycle Status | `imgs/actions/presence-rotate/icon.png` | `imgs/actions/presence-rotate/key.png` |
| Set Status | `imgs/actions/presence-set/icon.png` | `imgs/actions/presence-set/key.png` |
| React to Latest | `imgs/actions/reaction-react-focused/icon.png` | `imgs/actions/reaction-react-focused/key.png` |
| Switch Channel | `imgs/actions/channel-switch/icon.png` | `imgs/actions/channel-switch/key.png` |
| Open DM | `imgs/actions/dm-open-pinned/icon.png` | `imgs/actions/dm-open-pinned/key.png` |
| Start Thread | `imgs/actions/thread-start-from-focused/icon.png` | `imgs/actions/thread-start-from-focused/key.png` |
| Toggle Thread Lock | `imgs/actions/thread-lock-toggle/icon.png` | `imgs/actions/thread-lock-toggle/key.png` |
| Start/End Stage | `imgs/actions/stage-start-end/icon.png` | `imgs/actions/stage-start-end/key.png` |
| Remove Speaker | `imgs/actions/stage-remove-speaker/icon.png` | `imgs/actions/stage-remove-speaker/key.png` |
| Unread Summary | `imgs/actions/indicator-unread-summary/icon.png` | `imgs/actions/indicator-unread-summary/key.png` |

Provide `icon.png` (20x20) + `icon@2x.png` (40x40) for the action list, and `key.png` (72x72) + `key@2x.png` (144x144) for the key face.

## Architecture

The plugin runs as a separate Node.js process launched by the Elgato Stream Deck software. It connects to the Howl Electron app via a loopback WebSocket bridge.

- `src/plugin.ts` -- Entry point; connects to Stream Deck and initializes the bridge.
- `src/bridge/client.ts` -- WebSocket client that discovers and connects to the Howl bridge.
- `src/bridge/token-store.ts` -- Persists pairing tokens via Elgato's global settings API.
- `src/state/connection.ts` -- Connection lifecycle, auth, subscription, and state cache.
- `src/protocol/types.ts` -- Protocol type definitions (mirrored from `/shared/streamdeck/types.ts`).
- `src/actions/shared/action-base.ts` -- Shared helpers: topic subscriptions, action cleanup, list-forwarding for PIs.
- `src/actions/shared/render.ts` -- Canvas-based key image renderer (144x144 PNG).
- `src/actions/shared/icons.ts` -- Bundled SVG icons as data URLs.

### Property Inspector UIs

7 of the 20 actions have configurable per-key settings, each with a self-contained HTML Property Inspector page in `com.howlpro.streamdeck.sdPlugin/ui/`:

| PI file | Action | UI |
|---------|--------|----|
| `voice-switch-channel.html` | Switch Voice Channel | Server + Channel dropdowns |
| `voice-device-switcher.html` | Cycle Audio Device | Input / Output / Both radio group |
| `presence-set.html` | Set Status | Online / Idle / DND / Invisible radio group |
| `reaction-react-focused.html` | React to Latest | Emoji text input + quick-pick grid |
| `channel-switch.html` | Switch Channel | Server + Channel dropdowns (text channels) |
| `dm-open-pinned.html` | Open DM | User dropdown (from DM list) |
| `stage-remove-speaker.html` | Remove Speaker | User ID text input (v1 limitation) |

PIs that need dynamic data (servers, channels, DMs) send `{ type: 'list', resource }` messages to the plugin via `sendToPlugin`. The plugin forwards these to the Howl bridge via `Connection.listResources()` and replies with `{ type: 'list-response', resource, data }`.

The remaining 13 actions have no per-key settings and no Property Inspector.
