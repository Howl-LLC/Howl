// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Side-effect imports — each augments APIClient.prototype via declaration merging
import './auth';
import './users';
import './channels';
import './servers';
import './dms';
import './friends';
import './billing';
import './account';
import './assets';
import './uploads';
import './settings';
import './events';
import './dmKeys';
import './polls';
import './threads';
import './stages';
import './notifications';
import './linkPreview';
import './permissions';
import './forum';
import './gameAccounts';
import './serverFolders';
import './discovery';
import './community';
import './verification';
import './bootstrap';
import './rolePickers';
import './instanceConfig';

// MUST come AFTER all prototype augmentations
import { APIClient } from './core';
export { APIClient };
export const apiClient = new APIClient();

// Re-export all public types (preserves import surface for consumers)
export type { UserPreferences, SessionInfo, FamilyLinkInfo, FamilyRestrictions, FamilyActivity, RegisterResult, LoginResult, MfaStatus, PowerUpStatus, PowerUpableServer } from './types';
export type { ArchiveItem, ArchiveRow } from './dmKeys';
export type { InvitePreview } from './servers';
export type { ServerCardSummary, DiscoverFilters, DiscoverListResponse, DiscoverCategory, PublicServerProfile } from './discovery';
export type { BootstrapPayload } from './bootstrap';
