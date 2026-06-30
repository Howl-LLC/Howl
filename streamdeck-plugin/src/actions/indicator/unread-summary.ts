// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_BELL } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface UnreadState {
  [channelId: string]: number;
}

@action({ UUID: 'com.howlpro.streamdeck.indicator.unread-summary' })
export class IndicatorUnreadSummaryAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.unread', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      await executeAction('indicator.unread-summary');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const unread = getState('state.unread') as UnreadState | undefined;

    let totalCount = 0;
    if (unread && typeof unread === 'object') {
      for (const count of Object.values(unread)) {
        if (typeof count === 'number') {
          totalCount += count;
        }
      }
    }

    const hasUnread = totalCount > 0;
    const badgeText = totalCount > 99 ? '99+' : String(totalCount);

    const image = await renderKey({
      icon: ICON_BELL,
      bgColor: COLORS.BG_DEFAULT,
      label: hasUnread ? 'Unread' : 'All Read',
      badge: hasUnread ? { text: badgeText, color: COLORS.RED } : undefined,
      stateColor: !hasUnread ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
