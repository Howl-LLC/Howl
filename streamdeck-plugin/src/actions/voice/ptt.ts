// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type KeyUpEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_MIC } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface VoiceState {
  connected?: boolean;
}

/**
 * Push-to-Talk action. Sends phase:'down' on keyDown and phase:'up' on keyUp.
 * While held, the key renders green.
 */
@action({ UUID: 'com.howlpro.streamdeck.voice.ptt' })
export class VoicePttAction extends SingletonAction<Settings> {
  /** Track per-action pressed state for rendering. keyed by action id. */
  private pressed = new Map<string, boolean>();

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    this.pressed.set(id, false);
    await this.render(ev, false);

    subscribeTopic(id, 'state.voice', async () => {
      await this.render(ev, this.pressed.get(id) ?? false);
    });

    subscribePairPending(id, () => { void this.render(ev, this.pressed.get(id) ?? false); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    this.pressed.delete(id);
    cleanupAction(id);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    this.pressed.set(id, true);
    await this.render(ev, true);

    try {
      await executeAction('voice.ptt', { phase: 'down' });
    } catch {
      await flashError(ev.action);
    }
  }

  override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    this.pressed.set(id, false);
    await this.render(ev, false);

    try {
      await executeAction('voice.ptt', { phase: 'up' });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(
    ev: { action: WillAppearEvent<Settings>['action'] | KeyDownEvent<Settings>['action'] },
    isPressed: boolean,
  ): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const voice = getState('state.voice') as VoiceState | undefined;
    const connected = voice?.connected ?? false;

    const image = await renderKey({
      icon: ICON_MIC,
      bgColor: isPressed ? COLORS.GREEN : COLORS.BG_DEFAULT,
      label: 'PTT',
      stateColor: !connected ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
