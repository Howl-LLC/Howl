// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_HASH } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

interface ChannelSwitchSettings extends JsonObject {
  serverId?: string;
  channelId?: string;
  channelName?: string;
}

interface UnreadState {
  [channelId: string]: number;
}

interface FocusedChannelState {
  channelId?: string | null;
}

@action({ UUID: 'com.howlpro.streamdeck.channel.switch' })
export class ChannelSwitchAction extends SingletonAction<ChannelSwitchSettings> {
  private settingsCache = new Map<string, ChannelSwitchSettings>();

  override async onWillAppear(ev: WillAppearEvent<ChannelSwitchSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.unread', async () => {
      await this.render(ev);
    });
    subscribeTopic(id, 'state.focused-channel', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ChannelSwitchSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ChannelSwitchSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ChannelSwitchSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<ChannelSwitchSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;

    if (!settings.serverId || !settings.channelId) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('channel.switch', {
        serverId: settings.serverId,
        channelId: settings.channelId,
      });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<ChannelSwitchSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const configured = !!(settings?.serverId && settings?.channelId);

    const unread = getState('state.unread') as UnreadState | undefined;
    const focused = getState('state.focused-channel') as FocusedChannelState | undefined;

    const channelId = settings?.channelId;
    const unreadCount = channelId && unread ? (unread[channelId] ?? 0) : 0;
    const isFocused = configured && focused?.channelId === channelId;

    const displayName = settings?.channelName ?? channelId?.slice(0, 6) ?? 'Not Set';

    const image = await renderKey({
      icon: ICON_HASH,
      bgColor: isFocused ? COLORS.BLUE : COLORS.BG_DEFAULT,
      label: configured ? displayName : 'Not Set',
      badge: unreadCount > 0 ? { text: unreadCount > 99 ? '99+' : String(unreadCount), color: COLORS.RED } : undefined,
      stateColor: !configured ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
