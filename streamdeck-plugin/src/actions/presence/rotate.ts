// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS, PRESENCE_COLORS } from '../shared/render.js';
import { ICON_DOT_ONLINE, ICON_DOT_IDLE, ICON_DOT_DND, ICON_DOT_INVISIBLE, ICON_REFRESH } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface PresenceState {
  status?: string; // 'online' | 'idle' | 'dnd' | 'invisible'
}

const STATUS_ICONS: Record<string, string> = {
  online: ICON_DOT_ONLINE,
  idle: ICON_DOT_IDLE,
  dnd: ICON_DOT_DND,
  invisible: ICON_DOT_INVISIBLE,
};

const STATUS_LABELS: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'DND',
  invisible: 'Invisible',
};

@action({ UUID: 'com.howlpro.streamdeck.presence.rotate' })
export class PresenceRotateAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.presence', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      await executeAction('presence.rotate');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const presence = getState('state.presence') as PresenceState | undefined;
    const status = presence?.status ?? 'offline';

    const image = await renderKey({
      icon: STATUS_ICONS[status] ?? ICON_REFRESH,
      bgColor: COLORS.BG_DEFAULT,
      label: STATUS_LABELS[status] ?? 'Status',
      stateColor: status === 'offline' ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
