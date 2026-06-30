// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent, type DidReceiveSettingsEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonObject, JsonValue } from '@elgato/utils';
import { renderKey, COLORS } from '../shared/render.js';
import { ICON_HEADSET, ICON_MIC, ICON_HEADPHONES } from '../shared/icons.js';
import { subscribeTopic, cleanupAction, actionId, flashError, getState, executeAction, handleListFromPI, subscribePairPending, maybeRenderPairPrompt } from '../shared/action-base.js';

type DeviceKind = 'input' | 'output' | 'both';

interface DeviceSwitcherSettings extends JsonObject {
  kind?: DeviceKind;
}

interface VoiceState {
  connected?: boolean;
}

@action({ UUID: 'com.howlpro.streamdeck.voice.device-switcher' })
export class VoiceDeviceSwitcherAction extends SingletonAction<DeviceSwitcherSettings> {
  private settingsCache = new Map<string, DeviceSwitcherSettings>();

  override async onWillAppear(ev: WillAppearEvent<DeviceSwitcherSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);

    subscribeTopic(id, 'state.voice', async () => {
      await this.render(ev);
    });

    subscribePairPending(id, () => { void this.render(ev); });
  }

  override async onWillDisappear(ev: WillDisappearEvent<DeviceSwitcherSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.delete(id);
    cleanupAction(id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DeviceSwitcherSettings>): Promise<void> {
    const id = actionId(ev.action);
    this.settingsCache.set(id, ev.payload.settings);
    await this.render(ev);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, DeviceSwitcherSettings>): Promise<void> {
    await handleListFromPI(ev);
  }

  override async onKeyDown(ev: KeyDownEvent<DeviceSwitcherSettings>): Promise<void> {
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id) ?? ev.payload.settings;
    const kind = settings.kind ?? 'both';

    try {
      await executeAction('voice.device-switcher', { kind });
    } catch {
      await flashError(ev.action);
    }
  }

  private async render(ev: { action: WillAppearEvent<DeviceSwitcherSettings>['action'] }): Promise<void> {
    if (await maybeRenderPairPrompt(ev.action)) return;
    const id = actionId(ev.action);
    const settings = this.settingsCache.get(id);
    const voice = getState('state.voice') as VoiceState | undefined;
    const kind = settings?.kind ?? 'both';

    const iconMap: Record<DeviceKind, string> = {
      input: ICON_MIC,
      output: ICON_HEADPHONES,
      both: ICON_HEADSET,
    };
    const labelMap: Record<DeviceKind, string> = {
      input: 'Input',
      output: 'Output',
      both: 'Devices',
    };

    const image = await renderKey({
      icon: iconMap[kind],
      bgColor: COLORS.BG_DEFAULT,
      label: labelMap[kind],
      stateColor: !(voice?.connected) ? COLORS.GREY : undefined,
    });

    if (ev.action.isKey()) {
      await ev.action.setImage(image);
    }
  }
}
