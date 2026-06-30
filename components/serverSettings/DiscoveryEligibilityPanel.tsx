// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Loader2, Globe, Info } from 'lucide-react';
import { apiClient } from '../../services/api';
import type { DiscoveryEligibility, DiscoveryEligibilityCheck } from '../../services/api/community';
import { Card } from '../settings/SettingsWidgets';

export interface DiscoveryEligibilityPanelProps {
  serverId: string;
  /**
   * Bumped by parent when something changed that could affect eligibility
   * (settings save, community-mode toggle). Re-fetches on increment.
   */
  refreshKey?: number;
  /**
   * Optional callback invoked once the eligibility result is loaded so the
   * parent can disable the discovery toggle if the server isn't eligible.
   */
  onEligibilityLoaded?: (eligible: boolean) => void;
}

/**
 * Owner-facing checklist showing whether the server meets the size/age/
 * activity bars to be listed on /discover. Reuses the same row layout as
 * the community-mode eligibility checklist for visual consistency.
 *
 * Renders a green "Listed since YYYY-MM-DD" header when eligible, or a red
 * "Not eligible yet" header with per-check deltas when not.
 */
export const DiscoveryEligibilityPanel: React.FC<DiscoveryEligibilityPanelProps> = ({
  serverId,
  refreshKey,
  onEligibilityLoaded,
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<DiscoveryEligibility | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiClient.serverDiscoveryEligibility(serverId);
      setData(next);
      onEligibilityLoaded?.(next.eligible);
    } catch {
      // Silently fall back to no data — community section already surfaces
      // a network error toast on its own loads.
    } finally {
      setLoading(false);
    }
  }, [serverId, onEligibilityLoaded]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-t-secondary" />
          <p className="text-sm font-semibold text-t-primary">
            {t('discoveryEligibility.title', { defaultValue: 'Discovery listing requirements' })}
          </p>
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-t-secondary" />}
      </div>

      {data && data.eligible && !data.overrideActive && (
        <div className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <p className="text-[12px] text-emerald-300">
            {t('discoveryEligibility.eligible', {
              defaultValue: 'Your server meets the requirements and can be listed on Discover.',
            })}
          </p>
        </div>
      )}

      {data && data.eligible && data.overrideActive && (
        <div className="mb-3 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2">
          <p className="text-[12px] text-cyan-300">
            {t('discoveryEligibility.overrideActive', {
              defaultValue:
                'Listed on Discover via admin override. Per-row checks below show the real values for transparency.',
            })}
          </p>
        </div>
      )}

      {data && !data.eligible && !loading && (
        <div className="mb-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <p className="text-[12px] text-yellow-300">
            {t('discoveryEligibility.notEligible', {
              defaultValue: "Your server isn't eligible to appear on Discover yet.",
            })}
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {(data?.checks ?? []).map((c) => (
          <EligibilityRow key={c.key} check={c} />
        ))}
      </ul>

      <div className="mt-3 pt-3 border-t border-default flex items-start gap-2">
        <Info size={11} className="mt-0.5 text-t-secondary shrink-0" />
        <p className="text-[11px] text-t-secondary">
          {t('discoveryEligibility.thresholdsNotice', {
            defaultValue: 'These requirements may change as Howl grows.',
          })}
        </p>
      </div>
    </Card>
  );
};

interface EligibilityRowProps {
  check: DiscoveryEligibilityCheck;
}

const EligibilityRow: React.FC<EligibilityRowProps> = ({ check }) => {
  const { t } = useTranslation();

  // Shorten the blocker text into a compact "needs N more X" format when
  // numeric remaining data is present. Falls back to the full blocker string.
  const compactBlocker = (() => {
    if (check.met) return null;
    const r = check.remaining;
    if (!r) return check.blocker || check.explanation || null;
    const parts: string[] = [];
    if (r.daysShort && r.daysShort > 0) {
      parts.push(
        t('discoveryEligibility.daysShort', {
          count: r.daysShort,
          defaultValue: '{{count}} more day(s)',
        }),
      );
    }
    if (r.membersShort && r.membersShort > 0) {
      parts.push(
        t('discoveryEligibility.membersShort', {
          count: r.membersShort,
          defaultValue: '{{count}} more member(s)',
        }),
      );
    }
    if (r.weeksShort && r.weeksShort > 0) {
      parts.push(
        t('discoveryEligibility.weeksShort', {
          count: r.weeksShort,
          defaultValue: '{{count}} week(s) fall short',
        }),
      );
    }
    if (r.retentionRatePct != null) {
      parts.push(
        t('discoveryEligibility.retentionRatePct', {
          pct: r.retentionRatePct,
          defaultValue: '{{pct}}% retained',
        }),
      );
    }
    return parts.length > 0 ? parts.join(' · ') : check.blocker || check.explanation || null;
  })();

  return (
    <li className="flex items-start gap-3 py-1.5">
      <div
        className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
          check.met ? 'bg-emerald-500/20' : 'bg-red-500/15'
        }`}
      >
        {check.met ? (
          <Check size={11} className="text-emerald-400" />
        ) : (
          <X size={11} className="text-red-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-t-primary">{check.label}</p>
        {!check.met && compactBlocker && (
          <p className="text-[11px] mt-0.5 text-yellow-300/80">{compactBlocker}</p>
        )}
        {check.met && check.explanation && (
          <p className="text-[11px] mt-0.5 text-t-secondary">{check.explanation}</p>
        )}
      </div>
    </li>
  );
};
