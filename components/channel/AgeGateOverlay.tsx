// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useCallback, useMemo } from 'react';
import { Shield, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { apiClient } from '../../services/api';

interface AgeGateOverlayProps {
  channelId: string;
  onGoBack: () => void;
}

/**
 * Age-gate overlay for age-restricted channels.
 *
 * Three rendered states:
 *   1. Adult, first visit  — DOB >= 18, channel not yet accepted -> confirm prompt
 *   2. Adult, already accepted — returns null (no overlay)
 *   3. Under 18 / no DOB — hard block, go-back only
 *
 * Acceptance is stored on the active server's `acceptedAgeRestrictedChannelIds`
 * (populated from the caller's ServerMember row server-side). The Continue
 * button POSTs to /api/v1/channels/:id/age-gate/accept and optimistically
 * updates the local server record so the overlay disappears live.
 */
export function AgeGateOverlay({ channelId, onGoBack }: AgeGateOverlayProps) {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.currentUser);
  const activeServerId = useNavigationStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull acceptance array from the active server record. The backend exposes
  // it on Server.acceptedAgeRestrictedChannelIds (sourced from the caller's
  // own ServerMember row), so we don't need a separate membership lookup.
  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId),
    [servers, activeServerId],
  );
  const acceptedIds: string[] = activeServer?.acceptedAgeRestrictedChannelIds ?? [];

  // `isMinor` is server-derived from DOB and ships on /auth/me. `needsDateOfBirth`
  // is true only for legacy users without a DOB row. Adult = explicit false on
  // both. Anything else (undefined, true) → not adult, surface the hard-block
  // state. Backend enforces the gate independently, so the UI treating the
  // unknown case as "not adult" is fail-safe.
  const isAdult = !!(currentUser && currentUser.isMinor === false && currentUser.needsDateOfBirth !== true);

  // All hooks above the early return — React rules of hooks.
  const handleContinue = useCallback(async () => {
    if (!activeServerId) return;
    setAccepting(true);
    setError(null);
    try {
      const result = await apiClient.acceptChannelAgeGate(channelId);
      // Optimistically update the active server's acceptance list so the
      // overlay re-renders and dismisses without waiting for a refresh.
      useServerStore.getState().updateServer(activeServerId, (srv) => ({
        ...srv,
        acceptedAgeRestrictedChannelIds:
          result.acceptedAgeRestrictedChannelIds
          ?? Array.from(new Set([...(srv.acceptedAgeRestrictedChannelIds ?? []), channelId])),
      }));
    } catch {
      setError(t('ageGate.error', 'Something went wrong. Please try again.'));
    } finally {
      setAccepting(false);
    }
  }, [channelId, activeServerId, t]);

  // State 2: adult, already accepted -> no overlay
  if (isAdult && acceptedIds.includes(channelId)) {
    return null;
  }

  // Heavy blur shared by both rendered states. `saturate(0.7)` flattens
  // colors so the chat behind reads as a smear, not just out-of-focus
  // content. Without it, even at blur(60px) the silhouettes of message
  // bubbles + avatar colors are still recognizable.
  const overlayBackdropStyle: React.CSSProperties = {
    background: 'rgba(8, 11, 12, 0.85)',
    backdropFilter: 'blur(60px) saturate(0.7)',
    WebkitBackdropFilter: 'blur(60px) saturate(0.7)',
  };

  // State 3: under 18 / no DOB
  if (!isAdult) {
    return (
      <div
        className="absolute inset-0 z-50 flex items-center justify-center"
        style={overlayBackdropStyle}
      >
        <div
          className="text-center"
          style={{
            maxWidth: '320px',
            width: '100%',
            background: 'linear-gradient(180deg, #161c1e 0%, #11181a 100%)',
            border: '1px solid rgba(220, 110, 110, 0.30)',
            borderRadius: '12px',
            padding: '24px 22px 20px',
            boxShadow: '0 22px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.3)',
          }}
        >
          {/* Red shield */}
          <div
            className="mx-auto flex items-center justify-center"
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: 'rgba(220, 110, 110, 0.10)',
              border: '1px solid rgba(220, 110, 110, 0.30)',
              marginBottom: '16px',
            }}
          >
            <ShieldAlert size={24} style={{ color: '#ef9999' }} />
          </div>
          <h2
            style={{
              fontSize: '16px',
              fontWeight: 700,
              color: '#fff',
              marginBottom: '8px',
            }}
          >
            {t('ageGate.under18.title', 'This channel is 18+')}
          </h2>
          <p
            style={{
              fontSize: '12.5px',
              lineHeight: 1.5,
              color: 'rgba(255,255,255,0.65)',
              marginBottom: '20px',
            }}
          >
            {t(
              'ageGate.under18.body',
              "You don't meet the age requirement to view this channel.",
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGoBack}
              className="flex-1 transition-colors hover:brightness-110"
              style={{
                padding: '9px 18px',
                borderRadius: '12px',
                fontSize: '13px',
                fontWeight: 600,
                background: 'rgba(220, 110, 110, 0.14)',
                color: '#ef9999',
                border: '1px solid rgba(220, 110, 110, 0.25)',
              }}
            >
              {t('ageGate.under18.goBack', 'Go back')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 1: adult, first visit -> confirm prompt
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={overlayBackdropStyle}
    >
      <div
        className="text-center"
        style={{
          maxWidth: '320px',
          width: '100%',
          background: 'linear-gradient(180deg, #161c1e 0%, #11181a 100%)',
          border: '1px solid var(--accent-muted)',
          borderRadius: '12px',
          padding: '24px 22px 20px',
          boxShadow: '0 22px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.3)',
        }}
      >
        {/* Accent shield */}
        <div
          className="mx-auto flex items-center justify-center"
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'var(--accent-subtle)',
            border: '1px solid var(--accent-emphasis)',
            marginBottom: '16px',
          }}
        >
          <Shield size={24} style={{ color: 'var(--cyan-accent)' }} />
        </div>
        <h2
          style={{
            fontSize: '16px',
            fontWeight: 700,
            color: '#fff',
            marginBottom: '8px',
          }}
        >
          {t('ageGate.title', 'Age-Restricted Channel')}
        </h2>
        <p
          style={{
            fontSize: '12.5px',
            lineHeight: 1.5,
            color: 'rgba(255,255,255,0.65)',
            marginBottom: '20px',
          }}
        >
          {t(
            'ageGate.body',
            'This channel is marked 18+. By entering, you confirm you are 18 or older.',
          )}
        </p>
        {error && (
          <p className="text-xs mb-3" style={{ color: '#ef9999' }}>
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {/* Nevermind */}
          <button
            type="button"
            onClick={onGoBack}
            className="flex-1 transition-colors hover:brightness-110"
            style={{
              padding: '9px 18px',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 600,
              background: 'transparent',
              color: 'rgba(255,255,255,0.55)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {t('ageGate.nevermind', 'Nevermind')}
          </button>
          {/* Continue */}
          <button
            type="button"
            onClick={handleContinue}
            disabled={accepting}
            className="btn-cta flex-1 disabled:opacity-50"
            style={{
              padding: '9px 18px',
              fontSize: '13px',
            }}
          >
            {accepting
              ? t('common.loading', 'Loading...')
              : t('ageGate.continue', 'Continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
