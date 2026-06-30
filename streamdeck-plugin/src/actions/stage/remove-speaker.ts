// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderAvatarKey, COLORS } from '../shared/render.js';
import { ICON_USER_MINUS, ICON_X } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

interface RemoveSpeakerSettings extends JsonObject {
  userId?: string;
  displayName?: string;
  avatarUrl?: string;
}

interface ThreadStageState {
  stageIsLive?: boolean;
  inStageChannel?: boolean;
  isStageModerator?: boolean;
}

@action({ UUID: 'com.howlpro.streamdeck.stage.remove-speaker' })
export class StageRemoveSpeakerAction extends SingletonAction<RemoveSpeakerSettings> {
  private settingsCache = new Map<string, RemoveSpeakerSettings>();

  override async onWillAppear(ev: WillAppearEvent<RemoveSpeakerSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.thread-stage', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<RemoveSpeakerSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RemoveSpeakerSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, RemoveSpeakerSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<RemoveSpeakerSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;

    if (!settings.userId) {
      await flashError(ev.action);
      return;
    }

    try {
      await executeAction('stage.remove-speaker', { userId: settings.userId });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<RemoveSpeakerSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const configured = !!settings?.userId;

    const state = getState('state.thread-stage') as ThreadStageState | undefined;
    const isLive = state?.stageIsLive ?? false;
    const isMod = state?.isStageModerator ?? false;

    const greyed = !configured || !isLive || !isMod;
    const displayName = settings?.displayName ?? settings?.userId?.slice(0, 8) ?? 'Not Set';

    const image = await renderAvatarKey({
      avatarUrl: configured ? (settings?.avatarUrl ?? undefined) : undefined,
      fallbackIcon: ICON_USER_MINUS,
      bgColor: COLORS.BG_DEFAULT,
      label: configured ? displayName : 'Not Set',
      overlayIcon: configured ? ICON_X : undefined,
      stateColor: greyed ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
