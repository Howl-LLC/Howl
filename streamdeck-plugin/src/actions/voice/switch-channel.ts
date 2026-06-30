// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_SWITCH } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

interface SwitchChannelSettings extends JsonObject {
  serverId?: string;
  channelId?: string;
  channelName?: string;
}

interface VoiceState {
  connected?: boolean;
  channelId?: string;
  serverId?: string;
}

@action({ UUID: 'com.howlpro.streamdeck.voice.switch-channel' })
export class VoiceSwitchChannelAction extends SingletonAction<SwitchChannelSettings> {
  /** Cached settings per action id. */
  private settingsCache = new Map<string, SwitchChannelSettings>();

  override async onWillAppear(ev: WillAppearEvent<SwitchChannelSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.voice', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<SwitchChannelSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SwitchChannelSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SwitchChannelSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<SwitchChannelSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;

    if (!settings.serverId || !settings.channelId) {
      // Not configured — show alert.
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('voice.switch-channel', {
        serverId: settings.serverId,
        channelId: settings.channelId,
      });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<SwitchChannelSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const voice = getState('state.voice') as VoiceState | undefined;

    const configured = !!(settings?.serverId && settings?.channelId);
    const isCurrentChannel = configured &&
      voice?.connected &&
      voice?.channelId === settings?.channelId &&
      voice?.serverId === settings?.serverId;

    const image = await renderKey({
      icon: ICON_SWITCH,
      bgColor: isCurrentChannel ? COLORS.GREEN : COLORS.BG_DEFAULT,
      label: configured ? (settings?.channelName ?? 'Channel') : 'Not Set',
      badge: isCurrentChannel ? { text: '•', color: COLORS.GREEN } : undefined,
      stateColor: !configured ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
