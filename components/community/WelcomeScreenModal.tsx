// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback } from 'react';
import { Hash, Sparkles, Volume2, AlertTriangle, Megaphone, MessageSquarePlus } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/modal';
import { apiClient } from '../../services/api';
import { useCommunityStore, type WelcomeScreenData } from '../../stores/communityStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useServerStore } from '../../stores/serverStore';

interface WelcomeScreenModalProps {
  /** Server to show the welcome screen for. Pass null to render nothing. */
  serverId: string | null;
  /** Called when user closes the modal (or clicks a welcome channel). */
  onClose: () => void;
}

/**
 * Discord-parity welcome screen. Shown on a user's first channel-message-send
 * after joining a community-enabled server with `welcomeScreenEnabled=true`.
 *
 * Trigger logic lives outside this component (in `AppLayout.tsx` /
 * message-send hook). This component just renders the modal when
 * `serverId` is set, fetches the welcome screen data once, and offers
 * channel-jump shortcuts.
 *
 * Tracking-which-servers-already-shown is managed by `useCommunityStore`
 * (backed by `localStorage`) so it survives reloads.
 */
export const WelcomeScreenModal: React.FC<WelcomeScreenModalProps> = ({ serverId, onClose }) => {
  const cached = useCommunityStore((s) => (serverId ? s.welcomeScreens.get(serverId) : undefined));
  const cacheWelcomeScreen = useCommunityStore((s) => s.cacheWelcomeScreen);
  const markWelcomeSeen = useCommunityStore((s) => s.markWelcomeSeen);

  const setActiveServerId = useNavigationStore((s) => s.setActiveServerId);
  const setActiveChannelId = useNavigationStore((s) => s.setActiveChannelId);
  const servers = useServerStore((s) => s.servers);

  const [data, setData] = useState<WelcomeScreenData | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  // Fetch the welcome screen payload (cache for the session)
  useEffect(() => {
    if (!serverId) return;
    if (cached) {
      setData(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiClient.welcomeScreenGet(serverId)
      .then((resp) => {
        if (cancelled) return;
        const next: WelcomeScreenData = {
          serverId: resp.serverId,
          serverName: resp.serverName,
          serverIcon: resp.serverIcon,
          description: resp.description ?? '',
          channels: resp.channels.map((c) => ({
            channelId: c.channelId,
            emoji: c.emoji,
            description: c.description,
          })),
          enabled: resp.enabled,
        };
        cacheWelcomeScreen(next);
        setData(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Endpoint may not exist yet — degrade gracefully.
        const msg = err instanceof Error ? err.message : 'Failed to load welcome screen';
        setError(msg);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [serverId, cached, cacheWelcomeScreen]);

  const handleClose = useCallback(() => {
    if (serverId) markWelcomeSeen(serverId);
    onClose();
  }, [serverId, markWelcomeSeen, onClose]);

  const handleChannelJump = useCallback((channelId: string) => {
    if (!serverId) return;
    markWelcomeSeen(serverId);
    setActiveServerId(serverId);
    setActiveChannelId(channelId);
    onClose();
  }, [serverId, markWelcomeSeen, setActiveServerId, setActiveChannelId, onClose]);

  if (!serverId) return null;

  // Resolve the channel name from the loaded server (so we can show "# general").
  const server = servers.find((s) => s.id === serverId);
  const channelLabel = (channelId: string): string => {
    const ch = server?.channels?.find((c) => c.id === channelId);
    return ch?.name ?? 'channel';
  };
  const channelType = (channelId: string): 'text' | 'voice' | 'stage' | 'forum' | 'role_picker' | 'unknown' => {
    const ch = server?.channels?.find((c) => c.id === channelId);
    return ch?.type ?? 'unknown';
  };

  return (
    <Modal open onClose={handleClose} size="md">
      <ModalHeader>
        <div className="flex items-center gap-3">
          {data?.serverIcon ? (
            <img src={data.serverIcon} alt="" className="w-12 h-12 rounded-2xl object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-fill-hover text-t-primary font-bold text-lg">
              {(data?.serverName ?? server?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[var(--cyan-accent)] shrink-0" />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--cyan-accent)]">Welcome</span>
            </div>
            <h2 className="text-lg font-bold text-t-primary truncate">
              {data?.serverName ?? server?.name ?? 'this server'}
            </h2>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {loading && (
          <p className="text-sm text-t-secondary py-4 text-center">Loading welcome screen...</p>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-300 flex items-start gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>This server doesn't have a welcome screen configured yet.</span>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {data.description && (
              <p className="text-sm text-t-secondary leading-relaxed mb-5 whitespace-pre-line">
                {data.description}
              </p>
            )}

            {data.channels.length === 0 ? (
              <p className="text-xs text-t-secondary italic py-4 text-center">
                No welcome channels are highlighted yet. Explore the channel list to get started.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.channels.map((c) => {
                  const type = channelType(c.channelId);
                  const Icon = type === 'voice' ? Volume2
                    : type === 'stage' ? Megaphone
                    : type === 'forum' ? MessageSquarePlus
                    : Hash;
                  return (
                    <li key={c.channelId}>
                      <button
                        type="button"
                        onClick={() => handleChannelJump(c.channelId)}
                        className="w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border border-default bg-input-surface hover:bg-fill-hover transition-colors group"
                      >
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--cyan-accent)]/[0.1] flex items-center justify-center text-lg">
                          {c.emoji ?? <Icon size={16} className="text-[var(--cyan-accent)]" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Icon size={12} className="text-t-secondary shrink-0" />
                            <span className="text-xs font-semibold text-t-primary truncate">
                              {channelLabel(c.channelId)}
                            </span>
                          </div>
                          <p className="text-[11px] text-t-secondary mt-0.5 line-clamp-2">
                            {c.description}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          onClick={handleClose}
          className="btn-cta px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
        >
          Got it
        </button>
      </ModalFooter>
    </Modal>
  );
};

export default WelcomeScreenModal;
