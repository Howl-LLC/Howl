// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { NavigationTarget } from '../types';
import type { MlsTier } from '../services/mls/roomKey';

interface NavigationState {
  activeServerId: NavigationTarget;
  activeChannelId: string;
  activeDmChannelId: string | null;
  activeDmTier: MlsTier;
  templateUrlCode: string | null;
  accountDeepLink: { page?: string; subTab?: string; profileServerId?: string } | null;
  calendarActive: boolean;
  keybindPageOpen: boolean;
  mobileServerDrawerOpen: boolean;
  selectedQuickTextChannelId: string | null;
  isQuickTextOpen: boolean;
  /** Target message ChatArea should scroll to once mounted with the matching channelId.
   *  Set by jump-to-message handlers (search results, pinned, replies). Cleared by ChatArea
   *  after scrolling, or after exhausting back-pagination retries. */
  pendingScrollTarget: { channelId: string; messageId: string } | null;
  /** ID of the forum post currently open in ForumView (null when browsing post list).
   *  Used by useNotificationSocketEvents to suppress the per-post unread bump for
   *  the post the user is actively viewing. */
  activeForumPostId: string | null;

  setActiveServerId(id: NavigationTarget): void;
  setActiveChannelId(id: string): void;
  setActiveDmChannelId(id: string | null): void;
  setActiveDmTier(t: MlsTier): void;
  setTemplateUrlCode(code: string | null): void;
  setAccountDeepLink(link: NavigationState['accountDeepLink']): void;
  setCalendarActive(v: boolean): void;
  setKeybindPageOpen(v: boolean): void;
  setMobileServerDrawerOpen(v: boolean): void;
  setSelectedQuickTextChannelId(id: string | null): void;
  setIsQuickTextOpen(v: boolean): void;
  setPendingScrollTarget(t: { channelId: string; messageId: string } | null): void;
  setActiveForumPostId(id: string | null): void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  activeServerId: 'home',
  activeChannelId: '',
  activeDmChannelId: null,
  activeDmTier: 'saved' as MlsTier,
  templateUrlCode: null,
  accountDeepLink: null,
  calendarActive: false,
  keybindPageOpen: false,
  mobileServerDrawerOpen: false,
  selectedQuickTextChannelId: null,
  isQuickTextOpen: false,
  pendingScrollTarget: null,
  activeForumPostId: null,

  setActiveServerId(id) { set({ activeServerId: id }); },
  setActiveChannelId(id) { set({ activeChannelId: id }); },
  setActiveDmChannelId(id) { set({ activeDmChannelId: id, activeDmTier: 'saved' }); },
  setActiveDmTier(t) { set({ activeDmTier: t }); },
  setTemplateUrlCode(code) { set({ templateUrlCode: code }); },
  setAccountDeepLink(link) { set({ accountDeepLink: link }); },
  setCalendarActive(v) { set({ calendarActive: v }); },
  setKeybindPageOpen(v) { set({ keybindPageOpen: v }); },
  setMobileServerDrawerOpen(v) { set({ mobileServerDrawerOpen: v }); },
  setSelectedQuickTextChannelId(id) { set({ selectedQuickTextChannelId: id }); },
  setIsQuickTextOpen(v) { set({ isQuickTextOpen: v }); },
  setPendingScrollTarget(t) { set({ pendingScrollTarget: t }); },
  setActiveForumPostId(id) { set({ activeForumPostId: id }); },
}));
