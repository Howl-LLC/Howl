// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderKey, COLORS, PRESENCE_COLORS } from '../shared/render.js';
import { ICON_DOT_ONLINE, ICON_DOT_IDLE, ICON_DOT_DND, ICON_DOT_INVISIBLE } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';

interface PresenceSetSettings extends JsonObject {
  status?: PresenceStatus;
}

interface PresenceState {
  status?: string;
}

const STATUS_ICONS: Record<PresenceStatus, string> = {
  online: ICON_DOT_ONLINE,
  idle: ICON_DOT_IDLE,
  dnd: ICON_DOT_DND,
  invisible: ICON_DOT_INVISIBLE,
};

const STATUS_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'DND',
  invisible: 'Invisible',
};

@action({ UUID: 'com.howlpro.streamdeck.presence.set' })
export class PresenceSetAction extends SingletonAction<PresenceSetSettings> {
  private settingsCache = new Map<string, PresenceSetSettings>();

  override async onWillAppear(ev: WillAppearEvent<PresenceSetSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.presence', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<PresenceSetSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PresenceSetSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PresenceSetSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<PresenceSetSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;
    const status = settings.status ?? 'online';

    try {
      await executeAction('presence.set', { status });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<PresenceSetSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const targetStatus: PresenceStatus = settings?.status ?? 'online';

    const presence = getState('state.presence') as PresenceState | undefined;
    const currentStatus = presence?.status;
    const isActive = currentStatus === targetStatus;

    // When active, use a brighter background to highlight the match.
    const statusColor = PRESENCE_COLORS[targetStatus] ?? COLORS.GREY;
    const bgColor = isActive ? statusColor : COLORS.BG_DEFAULT;

    const image = await renderKey({
      icon: STATUS_ICONS[targetStatus],
      bgColor,
      label: STATUS_LABELS[targetStatus],
      badge: isActive ? { text: '✓', color: COLORS.GREEN } : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
