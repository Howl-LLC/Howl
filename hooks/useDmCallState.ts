// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';

export interface IncomingDmCallPayload {
  dmChannelId: string;
  fromUserId: string;
  username: string;
  avatar?: string;
  banner?: string | null;
  bannerPositionY?: number;
  bannerZoom?: number;
  withVideo?: boolean;
  /** The ringer's advertised MLS-call readiness. The recipient's initial
   *  key decision ANDs this with its own readiness; the post-join roster is
   *  the authoritative reconcile (group calls may have mixed members). */
  mlsCallReady?: boolean;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  avatarEffect?: string | null;
  effectivePlan?: string | null;
}

/**
 * Manages DM call lifecycle state: active call, incoming call modal,
 * declined tracking, and participant IDs. Also registers socket
 * listeners for ring / decline / end events.
 */
export function useDmCallState(
  currentUser: User | null,
  showMissedCallToast?: (message: string) => void,
) {
  // Auto-rejoin on hard refresh: if we persisted a pending rejoin in
  // sessionStorage (same tab only) within the last 60s, restore it here so
  // the call flow resumes without the user having to click "Join call"
  // manually. The backend's isDmCallRateLimited bypass for "recently in this
  // DM" (markRecentDmCallPresence) keeps the rejoin from being throttled.
  // Stale entries (>60s) are dropped — by then the other party has likely
  // hung up and an automatic rejoin would just ring them.
  const PENDING_REJOIN_KEY = 'howl:pendingDmCallRejoin';
  const PENDING_REJOIN_MAX_AGE_MS = 60_000;
  const readPendingRejoin = (): { dmChannelId: string; withVideo: boolean } | null => {
    try {
      const raw = sessionStorage.getItem(PENDING_REJOIN_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { dmChannelId?: unknown; withVideo?: unknown; timestamp?: unknown };
      if (typeof parsed?.dmChannelId !== 'string' || typeof parsed?.timestamp !== 'number') return null;
      if (Date.now() - parsed.timestamp > PENDING_REJOIN_MAX_AGE_MS) {
        sessionStorage.removeItem(PENDING_REJOIN_KEY);
        return null;
      }
      return { dmChannelId: parsed.dmChannelId, withVideo: !!parsed.withVideo };
    } catch { return null; }
  };
  const [activeDmCallChannelId, setActiveDmCallChannelId] = useState<string | null>(() => readPendingRejoin()?.dmChannelId ?? null);
  const [dmCallWithVideo, setDmCallWithVideo] = useState(() => readPendingRejoin()?.withVideo ?? false);
  const [dmCallDeclinedUserIds, setDmCallDeclinedUserIds] = useState<string[]>([]);
  /** Incoming DM call queue (show Accept/Decline modal for front entry). */
  const [incomingDmCallQueue, setIncomingDmCallQueue] = useState<IncomingDmCallPayload[]>([]);
  const incomingDmCall = incomingDmCallQueue[0] ?? null;
  // Backward-compatible setter
  const setIncomingDmCall = useCallback((updater: IncomingDmCallPayload | null | ((prev: IncomingDmCallPayload | null) => IncomingDmCallPayload | null)) => {
    if (updater === null) {
      setIncomingDmCallQueue(prev => prev.slice(1));
    } else if (typeof updater === 'function') {
      setIncomingDmCallQueue(prev => {
        const current = prev[0] ?? null;
        const result = updater(current);
        if (result === null) return prev.slice(1);
        if (result === current) return prev;
        return [result, ...prev.slice(1)];
      });
    } else {
      setIncomingDmCallQueue(prev => {
        if (prev.some(c => c.dmChannelId === updater.dmChannelId)) return prev;
        return [...prev, updater];
      });
    }
  }, []);
  /** User IDs of remote participants in the active DM/group call. */
  const [dmCallParticipantIds, setDmCallParticipantIds] = useState<string[]>([]);

  /** Epoch ms when the DM call became active (activeDmCallChannelId went non-null).
   *  Used by Stream Deck state.call to populate the startedAt field for duration display. */
  const [dmCallStartedAt, setDmCallStartedAt] = useState<number | null>(
    () => readPendingRejoin()?.dmChannelId ? Date.now() : null,
  );

  // Track activeDmCallChannelId transitions: null → non-null sets startedAt,
  // non-null → null clears it.
  const prevActiveDmCallRef = useRef(activeDmCallChannelId);
  useEffect(() => {
    const prev = prevActiveDmCallRef.current;
    prevActiveDmCallRef.current = activeDmCallChannelId;
    if (!prev && activeDmCallChannelId) {
      setDmCallStartedAt(Date.now());
    } else if (prev && !activeDmCallChannelId) {
      setDmCallStartedAt(null);
    }
  }, [activeDmCallChannelId]);

  // Persist active DM call state to sessionStorage so a hard refresh
  // automatically resumes the call (see readPendingRejoin above).
  // Cleared on explicit leave (activeDmCallChannelId → null). The
  // timestamp is refreshed on every change so a call in progress keeps
  // its "recent" window sliding forward.
  useEffect(() => {
    try {
      if (activeDmCallChannelId) {
        sessionStorage.setItem(PENDING_REJOIN_KEY, JSON.stringify({
          dmChannelId: activeDmCallChannelId,
          withVideo: dmCallWithVideo,
          timestamp: Date.now(),
        }));
      } else {
        sessionStorage.removeItem(PENDING_REJOIN_KEY);
      }
    } catch { /* storage disabled / quota */ }
  }, [activeDmCallChannelId, dmCallWithVideo]);

  // Auto-dismiss incoming call after 60 seconds of ringing
  useEffect(() => {
    if (!incomingDmCall) return;
    const currentId = incomingDmCall.dmChannelId;
    const timeout = setTimeout(() => {
      setIncomingDmCallQueue(prev => prev.filter(c => c.dmChannelId !== currentId));
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [incomingDmCall?.dmChannelId]);

  // Auto-cancel outgoing call after 60 seconds if no one joins
  useEffect(() => {
    if (!activeDmCallChannelId || dmCallParticipantIds.length > 0) return;
    const channelId = activeDmCallChannelId;
    const timeout = setTimeout(() => {
      socketService.leaveDmCall(channelId);
      setActiveDmCallChannelId(null);
      setDmCallWithVideo(false);
      setDmCallDeclinedUserIds([]);
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [activeDmCallChannelId, dmCallParticipantIds.length]);

  // Ref mirrors for stable closure access in socket callbacks
  const activeDmCallChannelIdRef = useRef(activeDmCallChannelId);
  useEffect(() => { activeDmCallChannelIdRef.current = activeDmCallChannelId; }, [activeDmCallChannelId]);

  const showMissedCallToastRef = useRef(showMissedCallToast);
  showMissedCallToastRef.current = showMissedCallToast;

  // Value = Date.now() at decline time; entries older than 60s are ignored
  const declinedDmCallChannelIds = useRef<Map<string, number>>(new Map());

  // Socket: incoming DM call ring / decline / end listeners.
  // Uses onSocketCreated to handle the race where this effect runs
  // before the socket connect effect in App.tsx.
  useEffect(() => {
    if (!currentUser) return;
    let cleanedUp = false;
    // onDmCallEnded is additive (DMView also subscribes); track our own
    // unsubscribe so re-registration on reconnect doesn't stomp DMView.
    let unsubCallEnded: (() => void) | null = null;

    const registerListeners = () => {
      if (cleanedUp) return;
      socketService.offIncomingDMCall();
      socketService.offDmCallDeclined();
      socketService.offDmCallNoAnswer();
      unsubCallEnded?.();
      socketService.onDmCallDeclined((data) => {
        if (activeDmCallChannelIdRef.current === data.dmChannelId) {
          setDmCallDeclinedUserIds((prev) => prev.includes(data.userId) ? prev : [...prev, data.userId]);
        }
      });
      // Server-authoritative end for outgoing calls when no callee answered
      // (60s ring timeout, all callees declined, or all callees disconnected
      // without accepting). Clearing activeDmCallChannelId unmounts
      // DMCallView, which runs useRingTone's cleanup branch and stops the
      // ringback. Without this listener the caller would keep ringing until
      // the 60s client-side safety net at line 131-141 fires.
      socketService.onDmCallNoAnswer((data) => {
        if (activeDmCallChannelIdRef.current !== data.dmChannelId) return;
        setActiveDmCallChannelId(null);
        setDmCallWithVideo(false);
        setDmCallDeclinedUserIds([]);
      });
      socketService.onIncomingDMCall((data) => {
        if (activeDmCallChannelIdRef.current === data.dmChannelId) return;
        const declinedAt = declinedDmCallChannelIds.current.get(data.dmChannelId);
        if (declinedAt !== undefined && Date.now() - declinedAt < 60_000) return;
        let isNewCall = false;
        setIncomingDmCallQueue(prev => {
          if (prev.some(c => c.dmChannelId === data.dmChannelId)) return prev;
          isNewCall = true;
          if (prev.length >= 5) {
            // Notify user about the dropped (oldest) call before capping
            const dropped = prev[0];
            if (dropped) {
              const callerName = dropped.username || 'Unknown';
              showMissedCallToastRef.current?.(`Missed call from ${callerName}`);
            }
          }
          const queue = prev.length >= 5 ? prev.slice(1) : prev;
          // Avatar and banner arrive as raw `/api/uploads/...` paths from the
          // server; in prod the frontend and backend live on different origins
          // so the relative path would hit Cloudflare Pages instead of the
          // signed CDN proxy. resolveAssetUrl prepends the backend origin so
          // the 302-to-signed-CDN redirect works.
          const resolvedAvatar = apiClient.resolveAssetUrl(data.avatar) ?? data.avatar;
          const resolvedBanner = apiClient.resolveAssetUrl(data.banner ?? undefined) ?? data.banner;
          return [...queue, { dmChannelId: data.dmChannelId, fromUserId: data.fromUserId, username: data.username, avatar: resolvedAvatar, banner: resolvedBanner, bannerPositionY: data.bannerPositionY, bannerZoom: data.bannerZoom, nameColor: data.nameColor, nameFont: data.nameFont, nameEffect: data.nameEffect, avatarEffect: data.avatarEffect, effectivePlan: data.effectivePlan, withVideo: data.withVideo, mlsCallReady: data.mlsCallReady }];
        });
        // When the Howl window is not focused, fire a native OS notification
        // so the recipient gets a visible + audible alert even if the
        // in-app ringtone is blocked by the browser autoplay policy or the
        // user is on another desktop/monitor. Only fires for NEW calls
        // (not repeat ring emissions every 5s) and skips if we're already
        // in/declined the call.
        if (isNewCall && typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
          const title = data.withVideo ? 'Incoming video call' : 'Incoming call';
          const body = `${data.username || 'Someone'} is calling you`;
          const electronApi = (window as unknown as { electron?: { showNotification?: (t: string, b: string) => void } }).electron;
          if (electronApi?.showNotification) {
            try { electronApi.showNotification(title, body); } catch { /* ignore */ }
          } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try { new Notification(title, { body, silent: false }); } catch { /* ignore */ }
          }
        }
      });
      unsubCallEnded = socketService.onDmCallEnded((data) => {
        setIncomingDmCallQueue(prev => prev.filter(c => c.dmChannelId !== data.dmChannelId));
        declinedDmCallChannelIds.current.delete(data.dmChannelId);
      });
    };

    // Try immediately if socket already exists
    let registeredSocket: ReturnType<typeof socketService.getSocket> = null;
    const sock = socketService.getSocket();
    if (sock) {
      registerListeners();
      sock.on('connect', registerListeners);
      registeredSocket = sock;
    }

    // Also queue for when socket is created (handles the race where this
    // effect runs before the socket connect effect in App.tsx)
    const unsubSocketCreated = socketService.onSocketCreated(() => {
      if (cleanedUp) return;
      const s = socketService.getSocket();
      if (s && s !== registeredSocket) {
        registerListeners();
        s.on('connect', registerListeners);
        registeredSocket = s;
      }
    });

    return () => {
      cleanedUp = true;
      unsubSocketCreated();
      unsubCallEnded?.();
      socketService.offIncomingDMCall();
      socketService.offDmCallDeclined();
      socketService.offDmCallNoAnswer();
      if (registeredSocket) registeredSocket.off('connect', registerListeners);
    };
  }, [currentUser?.id]);

  return {
    activeDmCallChannelId, setActiveDmCallChannelId,
    dmCallWithVideo, setDmCallWithVideo,
    dmCallDeclinedUserIds, setDmCallDeclinedUserIds,
    incomingDmCall, setIncomingDmCall,
    dmCallParticipantIds, setDmCallParticipantIds,
    declinedDmCallChannelIds,
    dmCallStartedAt,
  };
}
