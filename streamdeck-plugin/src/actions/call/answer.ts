// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_PHONE_PICKUP, ICON_USER } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface CallState {
  incoming?: boolean;
  active?: boolean;
  callerName?: string;
  callerAvatar?: string;
}

@action({ UUID: 'com.howlpro.streamdeck.call.answer' })
export class CallAnswerAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.call', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      await executeAction('call.answer');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const call = getState('state.call') as CallState | undefined;
    const incoming = call?.incoming ?? false;

    const image = await renderKey({
      icon: incoming ? ICON_USER : ICON_PHONE_PICKUP,
      bgColor: incoming ? COLORS.GREEN : COLORS.BG_INACTIVE,
      label: incoming ? (call?.callerName?.slice(0, 14) ?? 'Incoming') : 'Answer',
      stateColor: !incoming ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
