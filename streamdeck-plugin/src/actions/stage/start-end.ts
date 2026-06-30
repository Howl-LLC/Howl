// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_STAGE } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type Settings = JsonObject;

interface ThreadStageState {
  stageIsLive?: boolean;
  inStageChannel?: boolean;
  isStageModerator?: boolean;
}

@action({ UUID: 'com.howlpro.streamdeck.stage.start-end' })
export class StageStartEndAction extends SingletonAction<Settings> {
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
    if (!state?.inStageChannel || !state?.isStageModerator) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('stage.start-end');
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<Settings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const state = getState('state.thread-stage') as ThreadStageState | undefined;
    const isLive = state?.stageIsLive ?? false;
    const inStage = state?.inStageChannel ?? false;
    const isMod = state?.isStageModerator ?? false;

    const greyed = !inStage || !isMod;

    let bgColor: string;
    let label: string;

    if (greyed) {
      bgColor = COLORS.BG_INACTIVE;
      label = !inStage ? 'No Stage' : 'Mod Only';
    } else if (isLive) {
      bgColor = COLORS.RED;
      label = 'End Stage';
    } else {
      bgColor = COLORS.GREEN;
      label = 'Start Stage';
    }

    const image = await renderKey({
      icon: ICON_STAGE,
      bgColor,
      label,
      stateColor: greyed ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
