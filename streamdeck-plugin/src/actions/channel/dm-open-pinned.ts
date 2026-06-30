// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderAvatarKey, COLORS, PRESENCE_COLORS } from '../shared/render.js';
import { ICON_USER } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

interface DmOpenPinnedSettings extends JsonObject {
  userId?: string;
  displayName?: string;
  avatarUrl?: string;
}

interface DmPresenceState {
  [userId: string]: string; // 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
}

@action({ UUID: 'com.howlpro.streamdeck.dm.open-pinned' })
export class DmOpenPinnedAction extends SingletonAction<DmOpenPinnedSettings> {
  private settingsCache = new Map<string, DmOpenPinnedSettings>();

  override async onWillAppear(ev: WillAppearEvent<DmOpenPinnedSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.dm-presence', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<DmOpenPinnedSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DmOpenPinnedSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, DmOpenPinnedSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<DmOpenPinnedSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;

    if (!settings.userId) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('dm.open-pinned', { userId: settings.userId });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<DmOpenPinnedSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const configured = !!settings?.userId;

    const dmPresence = getState('state.dm-presence') as DmPresenceState | undefined;
    const userStatus = configured && settings?.userId && dmPresence
      ? (dmPresence[settings.userId] ?? 'offline')
      : 'offline';

    const statusColor = PRESENCE_COLORS[userStatus] ?? COLORS.GREY;
    const displayName = settings?.displayName ?? settings?.userId?.slice(0, 8) ?? 'Not Set';

    const image = await renderAvatarKey({
      avatarUrl: settings?.avatarUrl ?? undefined,
      fallbackIcon: ICON_USER,
      statusColor: configured ? statusColor : undefined,
      bgColor: COLORS.BG_DEFAULT,
      label: displayName,
      stateColor: !configured ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
