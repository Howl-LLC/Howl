// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_MESSAGE_CIRCLE } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface FocusedChannelState {
  channelId?: string | null;
  latestMessageId?: string | null;
}

@action({ UUID: 'com.howlpro.streamdeck.thread.start-from-focused' })
export class ThreadStartAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.focused-channel', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const focused = getState('state.focused-channel') as FocusedChannelState | undefined;
    if (!focused?.latestMessageId) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('thread.start-from-focused');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const focused = getState('state.focused-channel') as FocusedChannelState | undefined;
    const hasMessage = !!focused?.latestMessageId;

    const image = await renderKey({
      icon: ICON_MESSAGE_CIRCLE,
      bgColor: COLORS.BG_DEFAULT,
      label: 'New Thread',
      stateColor: !hasMessage ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
