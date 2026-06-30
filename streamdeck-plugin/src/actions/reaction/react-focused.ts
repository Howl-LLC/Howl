// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderEmojiKey, renderOverlayIcon, COLORS } from '../shared/render.js';
import { ICON_PADLOCK_SMALL } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

interface ReactionSettings extends JsonObject {
  emoji?: string;
}

interface FocusedChannelState {
  channelId?: string | null;
  latestMessageId?: string | null;
}

interface E2eeState {
  lockedChannels?: string[];
}

@action({ UUID: 'com.howlpro.streamdeck.reaction.react-focused' })
export class ReactionReactFocusedAction extends SingletonAction<ReactionSettings> {
  private settingsCache = new Map<string, ReactionSettings>();
  /** Per-action error flash timer. */
  private errorTimers = new Map<string, ReturnType<typeof setTimeout>>();

  override async onWillAppear(ev: WillAppearEvent<ReactionSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.focused-channel', async () => {
      await this.render(ev);
    });
    subscribeTopic(id, 'state.e2ee', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReactionSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    const timer = this.errorTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.errorTimers.delete(id);
    }
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReactionSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ReactionSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<ReactionSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;
    const emoji = settings.emoji;

    if (!emoji) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('reaction.react-focused', { emoji });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'e2ee-locked') {
        // Flash padlock overlay with "Unlock Howl" for 1.5s.
        await this.flashE2eeError(ev);
      } else {
        await flashError(ev.action);
      }
    }
  }

  private async flashE2eeError(ev: { action: WillAppearEvent<ReactionSettings>['action'] }): Promise<void> {
    const id = actionId(ev.action);

    // Render padlock + "Unlock Howl" label
    const image = await renderEmojiKey({
      emoji: '🔒', // lock emoji
      bgColor: COLORS.RED,
      label: 'Unlock Howl',
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }

    // Clear any existing error timer.
    const existing = this.errorTimers.get(id);
    if (existing) clearTimeout(existing);

    // Re-render after 1.5s.
    this.errorTimers.set(id, setTimeout(async () => {
      this.errorTimers.delete(id);
      await this.render(ev);
    }, 1500));
  }

  private async render(ev: { action: WillAppearEvent<ReactionSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const emoji = settings?.emoji ?? '❤️';

    const focused = getState('state.focused-channel') as FocusedChannelState | undefined;
    const e2ee = getState('state.e2ee') as E2eeState | undefined;

    const hasFocused = !!focused?.channelId;
    const isLocked = hasFocused && Array.isArray(e2ee?.lockedChannels) &&
      e2ee!.lockedChannels.includes(focused!.channelId!);

    let image = await renderEmojiKey({
      emoji,
      bgColor: COLORS.BG_DEFAULT,
      label: settings?.emoji ? undefined : 'React',
      greyed: !hasFocused,
    });

    // Padlock overlay when E2EE-locked.
    if (isLocked && hasFocused) {
      image = await renderOverlayIcon({
        baseImage: image,
        overlayIcon: ICON_PADLOCK_SMALL,
      });
    }

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
