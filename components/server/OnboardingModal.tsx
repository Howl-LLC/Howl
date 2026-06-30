// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Check, Lock, Loader2 } from 'lucide-react';
import { apiClient } from '../../services/api';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import type { RolePickerTree, RolePickerCategory, RolePickerEntry, ConditionFailure } from '../../services/api/rolePickers';
import { useCommunityStore } from '../../stores/communityStore';
import { useGlobalToast } from '../../hooks/useGlobalToast';

export interface OnboardingModalProps {
  /** Server whose mandatory onboarding picker is being shown. */
  serverId: string;
}

/**
 * Mandatory onboarding modal shown once per member on entering a server that
 * has `onboardingEnabled` + a role picker + a null `onboardingCompletedAt`.
 *
 * No Skip / close button — the only exit is "Continue", which is gated on
 * every `required` category having at least one held role. When
 * `tree.selfRolesBlocked` is true (e.g. an auto-assigned `blocksSelfRoles`
 * role makes every claim 403), Continue is enabled regardless so the member
 * is never trapped.
 *
 * The durable show-once gate is the server-side `onboardingCompletedAt`
 * (roams across devices); the gating effect lives in AppLayout.
 */
export const OnboardingModal: React.FC<OnboardingModalProps> = ({ serverId }) => {
  const { t } = useTranslation();
  const { showGlobalToast } = useGlobalToast();
  const [tree, setTree] = useState<RolePickerTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  // Mirror RolePickerChannel.loadTree — list → get into a tree state.
  const loadTree = useCallback(async () => {
    try {
      const list = await apiClient.rolePickersList(serverId);
      if (!list.picker) {
        // No picker (shouldn't happen given the gating effect) — complete and
        // close so the member isn't trapped behind an empty modal.
        setTree(null);
        try { await apiClient.onboardingComplete(serverId); } catch { /* best effort */ }
        useCommunityStore.getState().markOnboardingShownThisSession(serverId);
        useCommunityStore.getState().closeOnboardingModal();
        return;
      }
      const r = await apiClient.rolePickerGet(serverId, list.picker.id);
      setTree(r);
    } catch (e) {
      showGlobalToast(e instanceof Error ? e.message : t('rolePicker.loadFailed', { defaultValue: 'Failed to load role picker' }), 'warning');
    } finally {
      setLoading(false);
    }
  }, [serverId, showGlobalToast, t]);

  useEffect(() => { loadTree(); }, [loadTree]);

  // Claim handler — mirrors RolePickerChannel.handleClaim. We refetch the tree
  // on success so the "required satisfied" gate is recomputed from live data.
  const handleClaim = async (cat: RolePickerCategory, entry: RolePickerEntry) => {
    if (busyEntryId || !tree) return;

    // Self-roles blocked — bail before the server 403s. Releasing a held role
    // is still allowed, so only gate the claim path.
    if (tree.selfRolesBlocked && !entry.held) {
      showGlobalToast(t('rolePicker.selfRolesBlocked', { defaultValue: 'You are restricted from claiming self-roles in this server.' }), 'warning');
      return;
    }

    setBusyEntryId(entry.id);
    try {
      if (entry.held) {
        await apiClient.rolePickerEntryRelease(serverId, tree.id, entry.id);
      } else {
        await apiClient.rolePickerEntryClaim(serverId, tree.id, entry.id);
      }
      await loadTree();
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string; failed?: ConditionFailure[] };
      if (err.status === 422 && Array.isArray(err.failed)) {
        showGlobalToast(formatFailures(err.failed), 'warning');
      } else {
        showGlobalToast(err.message || t('rolePicker.claimFailed', { defaultValue: 'Failed to update role' }), 'warning');
      }
    } finally {
      setBusyEntryId(null);
    }
  };

  // Required categories are satisfied when each one has >=1 held OR pending
  // entry. A pending entry is a requested manual-approval role — the member has
  // made their pick and the async approval is outside their control, so it must
  // not trap them (held-only would lock out any required category whose entries
  // are all manual-approval). When self-roles are blocked, claims are
  // impossible, so allow Continue regardless.
  const requiredSatisfied = useMemo(() => {
    if (!tree) return false;
    if (tree.selfRolesBlocked) return true;
    return tree.categories
      .filter((c) => c.required)
      // A required category with ZERO entries counts as satisfied. After the
      // server strips hidden entries, an all-hidden required category
      // becomes empty for a non-mod — a some() gate over [] is false, which
      // would trap them in this non-dismissible modal.
      .every((c) => c.entries.length === 0 || c.entries.some((e) => e.held || e.pending));
  }, [tree]);

  const handleContinue = async () => {
    if (completing) return;
    setCompleting(true);
    try {
      await apiClient.onboardingComplete(serverId);
      useCommunityStore.getState().markOnboardingShownThisSession(serverId);
      useCommunityStore.getState().closeOnboardingModal();
    } catch (e) {
      const err = e as { message?: string };
      showGlobalToast(err.message || t('onboarding.completeFailed', { defaultValue: 'Failed to finish onboarding. Please try again.' }), 'warning');
      setCompleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 modal-safe-area">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[8px]" />
      <div
        className="relative w-full max-w-[640px] glass border rounded-[var(--radius-2xl)] shadow-elevation-xl spring-pop-in max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
      >
        {/* Header / hero */}
        <div className="px-7 pt-6 pb-2">
          <div className="flex items-center gap-2 mb-1">
            <Tag size={14} className="text-[var(--cyan-accent)] shrink-0" />
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--cyan-accent)]">
              {t('onboarding.eyebrow', { defaultValue: 'Get started' })}
            </span>
          </div>
          <h2 className="text-lg font-bold text-t-primary">
            {tree?.heroTitle || t('onboarding.title', { defaultValue: 'Pick your roles to continue' })}
          </h2>
          <p className="text-sm text-t-secondary mt-1">
            {tree?.heroDescription || t('onboarding.subtitle', {
              defaultValue: 'Choose the roles that fit you. Some categories are required before you can join.',
            })}
          </p>
        </div>

        {/* Body */}
        <div className="px-7 pb-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={28} className="animate-spin text-[var(--cyan-accent)]" />
            </div>
          ) : !tree ? (
            <p className="text-sm text-t-secondary py-8 text-center">
              {t('onboarding.noRoles', { defaultValue: 'Setting things up…' })}
            </p>
          ) : (
            <>
              {/* Self-roles blocked banner — claims are barred for this member. */}
              {tree.selfRolesBlocked && (
                <p className="text-[11px] text-amber-400 mb-3">
                  {t('rolePicker.selfRolesBlocked', { defaultValue: 'You are restricted from claiming self-roles in this server.' })}
                </p>
              )}

              {tree.categories.length === 0 ? (
                <p className="py-8 text-center text-sm text-t-secondary">
                  {t('rolePicker.noRoles', { defaultValue: 'No roles available yet.' })}
                </p>
              ) : (
                tree.categories.map((cat) => (
                  <div key={cat.id} className="mb-6 last:mb-0">
                    <div className="flex items-center justify-between pb-2 mb-3 border-b border-default">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-t-tertiary flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-[var(--cyan-accent)]" />
                        {cat.name}
                      </span>
                      <span className="flex items-center gap-2">
                        {cat.required && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
                            {t('onboarding.required', { defaultValue: 'Required' })}
                          </span>
                        )}
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-fill-hover border border-default text-t-tertiary">
                          {cat.pickMode === 'single' ? t('selfRoles.pickOne', { defaultValue: 'Pick one' }) : t('selfRoles.pickAny', { defaultValue: 'Pick any' })}
                        </span>
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {cat.entries.map((entry) => (
                        <OnboardingRoleCard
                          key={entry.id}
                          entry={entry}
                          busy={busyEntryId === entry.id}
                          blocked={tree.selfRolesBlocked}
                          onClick={() => handleClaim(cat, entry)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>

        {/* Footer — Continue only, NO Skip/close. */}
        <div className="flex justify-end gap-2 px-7 py-4 border-t border-default">
          <button
            type="button"
            onClick={handleContinue}
            disabled={loading || completing || !requiredSatisfied}
            className="btn-cta px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {completing
              ? t('onboarding.continuing', { defaultValue: 'Finishing…' })
              : t('onboarding.continue', { defaultValue: 'Continue' })}
          </button>
        </div>
      </div>
    </div>
  );
};

// Role card (modal-local; RolePickerChannel.RoleCard is not exported)

const OnboardingRoleCard: React.FC<{ entry: RolePickerEntry; busy: boolean; blocked?: boolean; onClick: () => void }> = ({ entry, busy, blocked, onClick }) => {
  const isLocked = !entry.held && hasUnmetCondition(entry);
  const showRequestButton = entry.requirements?.manualApproval && !entry.held && !entry.pending;
  const blockedClaim = !!blocked && !entry.held;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || blockedClaim}
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
        entry.held
          ? 'btn-cta-selected'
          : 'bg-floating border-default hover:border-[var(--cyan-accent)]/30 hover:bg-fill-hover'
      } disabled:opacity-60 disabled:cursor-wait`}
    >
      <div className="w-9 h-9 rounded-lg bg-fill-hover flex items-center justify-center text-xl shrink-0 overflow-hidden">
        {entry.iconUrl ? (
          <img src={sanitizeImgSrc(entry.iconUrl)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
        ) : entry.emoji ? (
          <span>{entry.emoji}</span>
        ) : (
          <Tag size={16} className="text-t-tertiary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-2 text-sm font-semibold ${entry.held ? 'text-white' : 'text-t-primary'}`}>
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.role.color }} />
          <span className="truncate">{entry.role.name}</span>
        </div>
        <div className={`text-[11px] line-clamp-1 mt-0.5 ${entry.held ? 'text-white/70' : 'text-t-tertiary'}`}>
          {entry.description ?? `${entry.memberCount} member${entry.memberCount !== 1 ? 's' : ''}`}
        </div>
      </div>
      {entry.pending ? (
        <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
          Pending
        </span>
      ) : showRequestButton ? (
        <span className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]">
          Request
        </span>
      ) : isLocked ? (
        <span className="text-amber-400 shrink-0" title="Conditions not met">
          <Lock size={14} />
        </span>
      ) : (
        <span className={`w-6 h-6 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${
          entry.held ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)] text-black' : 'border-default'
        }`}>
          {entry.held && <Check size={12} />}
        </span>
      )}
    </button>
  );
};

// Helpers (replicated from RolePickerChannel)

function hasUnmetCondition(entry: RolePickerEntry): boolean {
  const r = entry.requirements;
  if (!r) return false;
  if (r.manualApproval) return false;
  return !!(r.accountAgeDays || r.tenureDays || r.messageCount || (r.hasRoleIds && r.hasRoleIds.length > 0));
}

function formatFailures(failed: ConditionFailure[]): string {
  return failed
    .map((f) => {
      switch (f.kind) {
        case 'accountAge':
          return `Account must be ${f.required}+ days old (yours: ${f.current})`;
        case 'tenure':
          return `Must be in this server ${f.required}+ days (yours: ${f.current})`;
        case 'hasRole':
          return `Need ${f.missing.length} more role${f.missing.length !== 1 ? 's' : ''} first`;
        case 'excludedRole':
          return 'You hold a role that disqualifies you from this role';
        case 'messageCount':
          return `Need ${f.required}+ messages in this server (yours: ${f.current})`;
        case 'manualApproval':
          return 'Manual approval required';
      }
    })
    .join(' · ');
}

export default OnboardingModal;
