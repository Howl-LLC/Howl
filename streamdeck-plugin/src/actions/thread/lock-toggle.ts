// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_LOCK, ICON_LOCK_OPEN } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface ThreadStageState {
  focusedThreadId?: string | null;
  threadIsLocked?: boolean;
  isThreadModerator?: boolean;
}

@action({ UUID: 'com.howlpro.streamdeck.thread.lock-toggle' })
export class ThreadLockToggleAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    const id = actionId(ev.action);
    await this.render(ev);

    subscribeTopic(id, 'state.thread-stage', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
    cleanupAction(actionId(ev.action));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const state = getState('state.thread-stage') as ThreadStageState | undefined;
    if (!state?.focusedThreadId || !state?.isThreadModerator) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('thread.lock-toggle');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const state = getState('state.thread-stage') as ThreadStageState | undefined;
    const hasThread = !!state?.focusedThreadId;
    const isLocked = state?.threadIsLocked ?? false;
    const isMod = state?.isThreadModerator ?? false;

    // Determine grey state: no thread, or not a moderator.
    const greyed = !hasThread || !isMod;

    const image = await renderKey({
      icon: isLocked ? ICON_LOCK : ICON_LOCK_OPEN,
      bgColor: isLocked ? COLORS.RED : COLORS.BG_DEFAULT,
      label: greyed && !isMod && hasThread ? 'Mod Only' : (isLocked ? 'Locked' : 'Unlocked'),
      stateColor: greyed ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
