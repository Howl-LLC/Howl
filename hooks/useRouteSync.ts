// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NavigationTarget } from '../types';
import { useNavigationStore } from '../stores/navigationStore';
import { useServerStore } from '../stores/serverStore';

interface RouteSyncParams {
  /** Non-null when user is authenticated — sync is disabled when logged out. */
  currentUser: unknown | null;
}

// URL ↔ state mapping

/**
 * Derive navigation state from a URL pathname. Returns null for paths the
 * main-app navigation doesn't own — auth helper pages (/auth/passkey-*,
 * /auth/callback), legal pages, /invite/:code, /template/:code, /about,
 * /credits, /login, etc. Returning null tells both sync effects to leave
 * the URL alone; otherwise we'd fall through to `home` and force a redirect
 * to `/`, which broke the Electron passkey flow (the system browser opened
 * /auth/passkey-login?nonce=xxx, useRouteSync navigated it to / before the
 * WebAuthn ceremony could fire, the deep link never fired, Electron never
 * signed in).
 */
function stateFromPath(pathname: string): {
  serverId: NavigationTarget;
  channelId?: string;
  dmChannelId?: string | null;
} | null {
  if (pathname === '/home') {
    return { serverId: 'home' };
  }
  if (pathname === '/friends') {
    return { serverId: 'friends' };
  }
  if (pathname.startsWith('/settings')) {
    return { serverId: 'account' };
  }
  if (pathname === '/notifications') {
    return { serverId: 'notifications' };
  }
  if (pathname === '/discover' || pathname.startsWith('/discover/')) {
    return { serverId: 'discover' };
  }
  if (pathname.startsWith('/channels/@me')) {
    const dmChannelId = pathname.split('/')[3] || null;
    return { serverId: 'dm', dmChannelId };
  }
  if (pathname.startsWith('/channels/')) {
    const parts = pathname.split('/');
    const serverId = parts[2];
    const channelId = parts[3];
    if (serverId) {
      return channelId
        ? { serverId, channelId }
        : { serverId };
    }
  }
  return null;
}

/** Compute URL pathname from navigation state. */
function pathFromState(
  activeServerId: NavigationTarget,
  activeChannelId: string,
  activeDmChannelId: string | null,
): string {
  switch (activeServerId) {
    case 'home':
      return '/home';
    case 'friends':
      return '/friends';
    case 'account':
      return '/settings';
    case 'notifications':
      return '/notifications';
    case 'discover':
      return '/discover';
    case 'dm':
      return activeDmChannelId
        ? `/channels/@me/${activeDmChannelId}`
        : '/channels/@me';
    default:
      // Server UUID
      return activeChannelId
        ? `/channels/${activeServerId}/${activeChannelId}`
        : `/channels/${activeServerId}`;
  }
}

/**
 * Bidirectional sync between react-router URL and the legacy navigation
 * state variables (activeServerId, activeChannelId, activeDmChannelId).
 *
 * **URL → state**: when the URL changes externally (back/forward button,
 * direct URL entry), derive the navigation state and call the existing
 * useState setters so all downstream effects (Socket.IO rooms, etc.) fire.
 *
 * **State → URL**: when an existing setter is called (from the 54+ call
 * sites not yet migrated), update the URL bar to match via `navigate()`.
 * Uses `replace: true` so each state-driven change doesn't push a new
 * history entry — proper push-based history comes in Pass 2 when setters
 * are replaced with navigate() calls.
 *
 * A `skipNextStateSync` ref prevents the state→URL effect from reverting
 * a URL→state sync on the subsequent render cycle.
 */
export function useRouteSync({
  currentUser,
}: RouteSyncParams) {
  const location = useLocation();
  const navigate = useNavigate();
  const skipNextStateSync = useRef(false);
  const isLoggedIn = !!currentUser;

  const activeServerId = useNavigationStore(s => s.activeServerId);
  const activeChannelId = useNavigationStore(s => s.activeChannelId);
  const activeDmChannelId = useNavigationStore(s => s.activeDmChannelId);

  const SPECIAL_IDS = new Set(['home', 'dm', 'friends', 'account', 'notifications', 'discover']);

  // URL → state
  useEffect(() => {
    if (!isLoggedIn) return;

    const derived = stateFromPath(location.pathname);
    if (!derived) return; // Path isn't owned by the main-app nav — leave state alone

    // Validate server UUID deep links — redirect to home if server doesn't exist
    if (derived.serverId && !SPECIAL_IDS.has(derived.serverId)) {
      const currentServers = useServerStore.getState().servers;
      if (currentServers.length > 0 && !currentServers.find(s => s.id === derived.serverId)) {
        navigate('/channels/@me', { replace: true });
        return;
      }
    }

    const nav = useNavigationStore.getState();
    let changed = false;

    if (derived.serverId !== nav.activeServerId) {
      nav.setActiveServerId(derived.serverId);
      changed = true;
    }
    if ('channelId' in derived && derived.channelId !== nav.activeChannelId) {
      nav.setActiveChannelId(derived.channelId as string);
      changed = true;
    }
    if ('dmChannelId' in derived && derived.dmChannelId !== nav.activeDmChannelId) {
      nav.setActiveDmChannelId(derived.dmChannelId as string | null);
      changed = true;
    }

    if (changed) {
      skipNextStateSync.current = true;
    }
    // Only re-run when the URL path, login status, or servers list changes.
    // Intentionally excludes navigation state from deps to avoid loops.
  }, [location.pathname, isLoggedIn]);

  // State → URL
  useEffect(() => {
    if (!isLoggedIn) return;

    if (skipNextStateSync.current) {
      skipNextStateSync.current = false;
      return;
    }

    // Don't force the URL back onto a main-app path when the user is on an
    // auth helper, legal page, invite link, etc.
    if (!stateFromPath(location.pathname)) return;

    const expectedPath = pathFromState(activeServerId, activeChannelId, activeDmChannelId);
    if (location.pathname !== expectedPath) {
      navigate(expectedPath, { replace: true });
    }
    // Only re-run when navigation state or login status changes.
    // Intentionally excludes location/navigate from deps.
  }, [activeServerId, activeChannelId, activeDmChannelId, isLoggedIn]);
}
