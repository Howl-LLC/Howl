// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_PHONE_DOWN } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface CallState {
  active?: boolean;
  startedAt?: number; // epoch ms
}

@action({ UUID: 'com.howlpro.streamdeck.call.end' })
export class CallEndAction extends SingletonAction<Settings> {
  /** Per-action timer that updates the duration label. */
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.call', async () => {
      await this.render(ev);
      this.manageDurationTimer(ev);
    });

    // Start the timer if call is already active.
    this.manageDurationTimer(ev);

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    this.clearTimer(id);
    cleanupAction(id);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      await executeAction('call.end');
    } catch {
      await flashError(ev.action);
    }
  }

  private manageDurationTimer(ev: { action: WillAppearEvent<Settings>['action'] }): void {
    const id = actionId(ev.action);
    const call = getState('state.call') as CallState | undefined;

    if (call?.active && call.startedAt) {
      // Start a 1s timer to update the duration label if not already running.
      if (!this.timers.has(id)) {
        const timer = setInterval(async () => {
          const current = getState('state.call') as CallState | undefined;
          if (!current?.active) {
            this.clearTimer(id);
            await this.render(ev);
            return;
          }
          await this.render(ev);
        }, 1_000);
        this.timers.set(id, timer);
      }
    } else {
      this.clearTimer(id);
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const call = getState('state.call') as CallState | undefined;
    const active = call?.active ?? false;

    let label = 'End Call';
    if (active && call?.startedAt) {
      const elapsed = Math.floor((Date.now() - call.startedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      label = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    const image = await renderKey({
      icon: ICON_PHONE_DOWN,
      bgColor: active ? COLORS.RED : COLORS.BG_INACTIVE,
      label,
      stateColor: !active ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
