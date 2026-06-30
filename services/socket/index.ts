// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Side-effect imports — each augments SocketService.prototype via declaration merging
import './channels';
import './voice';
import './dmMessages';
import './dmCalls';
import './social';
import './activity';
import './events';
import './polls';
import './threads';
import './stages';
import './notifications';
import './dmKeys';
import './billing';
import './settings';
import './viewers';
import './community';

// MUST come AFTER all prototype augmentations
import { SocketService } from './core';
export { SocketService };
export const socketService = new SocketService();

// Re-export all public types (preserves import surface for consumers)
export type { SocketServerRole, SocketNewMessagePayload } from './types';
