// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_PHONE_DOWN } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface VoiceState {
  connected?: boolean;
}

@action({ UUID: 'com.howlpro.streamdeck.voice.hangup' })
export class VoiceHangupAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.voice', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      await executeAction('voice.hangup');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const voice = getState('state.voice') as VoiceState | undefined;
    const connected = voice?.connected ?? false;

    const image = await renderKey({
      icon: ICON_PHONE_DOWN,
      bgColor: connected ? COLORS.RED : COLORS.BG_INACTIVE,
      label: 'Hang Up',
      stateColor: !connected ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
