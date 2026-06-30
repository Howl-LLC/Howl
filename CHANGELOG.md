# Howl — Patch Notes

## v1.0.4 — April 25, 2026

A big update covering the past week: Stream Deck integration, Community Servers, a noise-suppression overhaul, Picture-in-Picture for calls, and a long list of polish fixes.

### New

- **Community Servers.** Server owners can now make their server publicly discoverable. Pick a category, claim a vanity URL, write a short pitch and rules, and people can find you on the new Discover page or land on a public profile at `howlpro.com/s/<your-vanity>`. New owner tools include join applications (with a simple Q&A flow), a moderator-facing report queue, daily activity insights, and welcome-screen channels for new members.
- **Discover.** A new `/discover` destination — both as a public marketing surface and as a section inside the app (left-nav compass icon for signed-in users). Browse by category, filter by language, and jump straight into a server's public profile. The hero uses the same animated chromatic-arc shader as the landing page.
- **Stream Deck integration.** Pair your Elgato Stream Deck with Howl using a 4-word fingerprint code. Buttons can mute/deafen, push-to-talk, accept or decline calls, switch audio devices, react to messages, jump between servers and channels, control threads and stages, set your presence, and more. End-to-end encryption stays on the desktop side — keys never cross the bridge. Settings → Stream Deck to opt in.
- **Picture-in-Picture for calls.** Pop a screenshare or camera feed out into a small floating window so you can keep watching while you scroll chat or work in another channel. Hover to reveal controls; click outside or press Escape to close. Available across server voice, stages, and DM calls.
- **Viewer indicators on screenshares.** See a live count and avatar list of who's actually watching your screenshare or stage stream. Click to expand the full viewer list (bottom-sheet on mobile).
- **NVIDIA Broadcast acceleration (RTX).** Hardware-accelerated voice and video effects on supported NVIDIA RTX cards. The effects pipeline is wired up and dormant pending broader testing.
- **Noise suppression upgraded to DeepFilterNet 3.** Replaces the older NVIDIA Broadcast AFX path with a higher-quality, lower-latency model that runs on every machine (no GPU required).
- **Better camera + background segmentation.** Upgraded MediaPipe models — FaceLandmarker plus a multiclass body segmenter — for cleaner virtual backgrounds and effects.
- **Live voice tweaks.** Advanced Noise Suppression and Opus bitrate now apply instantly when you change them mid-call — no more reconnecting to hear the new setting.
- **Community-server toggle in Create Server.** When you create a new server, there's now an opt-in toggle to make it a community server right away. You can still flip it on later in Server Settings → Community Hub.

### Improved

- **DM call UX overhaul.** The call surface now blends naturally with the chat instead of hovering as a distinct block, the resize handle is bigger and easier to grab, the incoming-call popup uses the same card-grid layout as an active call, and presence + leave events stay in sync across both sides of the call.
- **Landing page.** A new cyan animated "Discover" link in the top nav (with a slow-spinning compass and shimmering text). The legal links moved to the footer where you'd expect them. The site now stays available at the root URL even when you're signed in — clicking "Open in Browser" takes you into the app.
- **Sidebar.** The Discover and Notifications half-pills sit closer together with a tighter divider line, and the "selected" highlight for DMs / Friends / Account uses the accent color instead of a hardcoded violet.
- **Chat composer.** The space above the input bar is now reserved for the typing indicator, so the chat doesn't jump when someone starts typing.
- **Server profile.** Added a clear "Remove banner" button in the Overview tab so you can clear the banner without re-uploading.
- **Settings dropdowns.** Settings rows with a long label no longer collapse the dropdown — labels wrap cleanly.
- **Mobile call views.** The viewer list opens as a bottom-sheet modal, and the viewer popover is tap-to-toggle so you can read it without holding.
- **Username protections.** Slurs, homoglyph spoofs, and barcode/zero-width spam are now blocked at signup and rename. (Existing usernames are unaffected.)

### Fixed

- Clicking the home button (Howl logo) in the sidebar no longer kicks you out of the app to the marketing site.
- Window-focus flash on the Discover page is gone — switching to another app and back keeps the existing servers on screen instead of flipping to skeleton placeholders.
- Discover page now scrolls properly when there are enough server cards to overflow the viewport.
- Discover page no longer renders in only half the app shell — fills the full content area as expected.
- Server cards on Discover no longer show "NaNM online" — the online count is correct now.
- Background GIFs (custom chat backgrounds) actually stop decoding when the window blurs, instead of quietly burning CPU/GPU in the background.
- DM calls no longer enter a reconnect loop after a transient drop.
- The "X is in a call" banner clears properly once both sides hang up.
- DM message edits and forwards on the newer encryption envelope no longer fail.
- Image attachments now reload automatically when their signed URL expires, instead of showing a broken-image icon.
- Stale assets after a deploy: the app now correctly fetches the new version instead of getting trapped on a cached HTML shell.
- SSO + MFA: signing in via Google when you have MFA enabled now lands you on the verification step instead of bouncing to a blank page.
- Voice settings: the input sensitivity bar now reflects what the system actually hears (and the toggle was renamed to "ML Noise Suppression" for clarity).
- Email-based account flows now use a dedicated `accounts@` sender for better deliverability.
- Server settings → Community Hub: the sidebar group label no longer shows the raw translation key, and the channel pickers use the same dropdown style as the rest of the app.
- "Community Guidelines" link in the create-server modal is now a real link (opens the policy page).

### Security

- Tightened private-channel auto-subscribe so members no longer get joined to private channels via the server's @everyone baseline alone — explicit channel- or category-level grants are required, matching the Discord model.
- A batch of security hardening landed across the week: stricter session revalidation, atomic Stripe webhook idempotency, role-hierarchy gates on moderation actions, OAuth query-param scrubbing in logs, encryption-downgrade guards on DM channels, MFA step-up on SSO sign-ins, and more. None of these are user-visible on the happy path, but the floor is higher.

### Under the hood

- Backend, frontend, and tests all green on a fresh checkout. Build pipeline now produces both x64 and arm64 Windows binaries from one `npm run dist`.
