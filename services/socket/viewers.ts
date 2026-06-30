// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { StreamContext } from '../../stores/types';

export interface ViewerChangedPayload {
  context: StreamContext;
  streamOwnerId: string;
  streamType: 'screen';
  add?: string[];
  remove?: string[];
}

export interface ViewerClearedPayload {
  context: StreamContext;
  streamOwnerId: string;
  streamType: 'screen';
}

declare module './core' {
  interface SocketService {
    _viewerChangedHandler: ((p: ViewerChangedPayload) => void) | null;
    _viewerClearedHandler: ((p: ViewerClearedPayload) => void) | null;

    emitViewerSubscribe(p: { context: StreamContext; streamOwnerId: string; streamType: 'screen' }): Promise<{ ok: boolean; error?: string }>;
    emitViewerUnsubscribe(p: { context: StreamContext; streamOwnerId: string; streamType: 'screen' }): Promise<{ ok: boolean; error?: string }>;
    requestViewerList(p: { context: StreamContext; streamOwnerId: string; streamType: 'screen'; page?: number }): Promise<{ ok: boolean; viewers?: string[]; nextPage?: number; error?: string }>;
    onViewerChanged(cb: (p: ViewerChangedPayload) => void): void;
    offViewerChanged(): void;
    onViewerCleared(cb: (p: ViewerClearedPayload) => void): void;
    offViewerCleared(): void;
  }
}

function ackPromise<T>(sock: any, event: string, payload: any): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'ack timeout' } as T);
    }, 5000);
    sock.emit(event, payload, (r: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(r);
    });
  });
}

SocketService.prototype.emitViewerSubscribe = function(this: SocketService, p) {
  if (!this.socket) return Promise.resolve({ ok: false, error: 'no socket' });
  return ackPromise(this.socket, 'viewer:subscribe', p);
};

SocketService.prototype.emitViewerUnsubscribe = function(this: SocketService, p) {
  if (!this.socket) return Promise.resolve({ ok: false, error: 'no socket' });
  return ackPromise(this.socket, 'viewer:unsubscribe', p);
};

SocketService.prototype.requestViewerList = function(this: SocketService, p) {
  if (!this.socket) return Promise.resolve({ ok: false, error: 'no socket' });
  return ackPromise(this.socket, 'viewer:list', p);
};

SocketService.prototype.onViewerChanged = function(this: SocketService, cb) {
  if (!this.socket) return;
  if (this._viewerChangedHandler) this.socket.off('viewer:changed', this._viewerChangedHandler);
  this._viewerChangedHandler = cb;
  this.socket.on('viewer:changed', cb);
};

SocketService.prototype.offViewerChanged = function(this: SocketService) {
  if (this._viewerChangedHandler && this.socket) {
    this.socket.off('viewer:changed', this._viewerChangedHandler);
    this._viewerChangedHandler = null;
  }
};

SocketService.prototype.onViewerCleared = function(this: SocketService, cb) {
  if (!this.socket) return;
  if (this._viewerClearedHandler) this.socket.off('viewer:cleared', this._viewerClearedHandler);
  this._viewerClearedHandler = cb;
  this.socket.on('viewer:cleared', cb);
};

SocketService.prototype.offViewerCleared = function(this: SocketService) {
  if (this._viewerClearedHandler && this.socket) {
    this.socket.off('viewer:cleared', this._viewerClearedHandler);
    this._viewerClearedHandler = null;
  }
};
