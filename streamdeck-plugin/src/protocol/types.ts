// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Copy of /shared/streamdeck/types.ts — keep in sync.
// __tests__/streamdeck/types-parity.test.ts in the main repo asserts the
// runtime shape matches these TS types; drift fails CI.

export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export const OFFICIAL_PLUGIN_ID = 'com.howlpro.streamdeck';
export const MAX_FRAME_BYTES = 128 * 1024;

export type Topic =
  | 'state.voice' | 'state.call' | 'state.presence' | 'state.dm-presence'
  | 'state.unread' | 'state.focused-channel' | 'state.thread-stage'
  | 'state.e2ee' | 'state.bridge';

export interface FrameBase { v: 1; id: string; }

export interface PairRequest extends FrameBase {
  kind: 'command';
  type: 'pair';
  pluginId: string;
  displayName: string;
  version: string;
  challenge: string;
}

export interface AuthCommand extends FrameBase {
  kind: 'command';
  type: 'auth';
  token: string;
}

export interface SubscribeCommand extends FrameBase {
  kind: 'command';
  type: 'subscribe';
  topics: Topic[];
}

export interface ExecuteCommand extends FrameBase {
  kind: 'command';
  type: 'execute';
  action: string;
  params?: Record<string, unknown>;
}

export interface ListCommand extends FrameBase {
  kind: 'command';
  type: 'list';
  resource: 'servers' | 'channels' | 'dms' | 'custom-emoji' | 'pinned-dms';
  params?: Record<string, unknown>;
}

export type AnyCommand = PairRequest | AuthCommand | SubscribeCommand | ExecuteCommand | ListCommand;

export interface ResponseFrame extends FrameBase {
  kind: 'response';
  type: string;
  data?: unknown;
}

export interface ErrorFrame extends FrameBase {
  kind: 'error';
  code: string;
  detail?: string;
}

export interface EventFrame extends FrameBase {
  kind: 'event';
  topic: Topic;
  snapshot: boolean;
  data: unknown;
}

export type AnyFrame = AnyCommand | ResponseFrame | ErrorFrame | EventFrame;
