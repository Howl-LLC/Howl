// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Loader2, X, AlertTriangle, Send } from 'lucide-react';
import { apiClient } from '../../services/api';
import type { VerificationStatusResponse } from '../../services/api/verification';
import { Card, PrimaryButton } from '../settings/SettingsWidgets';

export interface VerificationRequestSectionProps {
  serverId: string;
  /** Owner-only. The parent already gates on role==='owner'. */
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export const VerificationRequestSection: React.FC<VerificationRequestSectionProps> = ({
  serverId,
  showToast,
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<VerificationStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  // Form state
  const [orgName, setOrgName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [notes, setNotes] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiClient.serverVerificationStatus(serverId);
      setData(next);
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      if (status === 403) {
        // Not owner — silently render nothing.
        setData(null);
      } else if (status === 404 || status === 501) {
        // Backend hasn't shipped yet.
        setData({ alreadyVerified: false, request: null });
      } else {
        const msg = e instanceof Error ? e.message : 'Failed to load verification status';
        showToast(msg, 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [serverId, showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = useCallback(async () => {
    if (!orgName.trim() || !websiteUrl.trim()) return;
    setSubmitting(true);
    try {
      const created = await apiClient.serverVerificationSubmit(serverId, {
        organizationName: orgName.trim(),
        websiteUrl: websiteUrl.trim(),
        additionalNotes: notes.trim() || null,
      });
      setData({ alreadyVerified: false, request: created });
      setOrgName('');
      setWebsiteUrl('');
      setNotes('');
      showToast(
        t('verificationSection.submitted', {
          defaultValue: 'Verification request submitted. We\'ll review and email you with a decision.',
        }),
      );
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      if (status === 429) {
        showToast(
          t('verificationSection.cooldown', {
            defaultValue: 'You can\'t resubmit yet — wait for the cooldown to end.',
          }),
          'error',
        );
      } else if (status === 409) {
        showToast(
          t('verificationSection.alreadyExists', {
            defaultValue: 'A pending request already exists for this server.',
          }),
          'error',
        );
      } else {
        const msg = e instanceof Error ? e.message : 'Failed to submit verification request';
        showToast(msg, 'error');
      }
      // Refresh so the UI re-syncs (cooldown/pending state may be different).
      void refresh();
    } finally {
      setSubmitting(false);
    }
  }, [serverId, orgName, websiteUrl, notes, refresh, showToast, t]);

  const handleWithdraw = useCallback(async () => {
    if (!confirm(t('verificationSection.confirmWithdraw', { defaultValue: 'Withdraw your verification request?' }))) return;
    setWithdrawing(true);
    try {
      const updated = await apiClient.serverVerificationWithdraw(serverId);
      setData((prev) => ({
        alreadyVerified: prev?.alreadyVerified ?? false,
        request: updated,
      }));
      showToast(t('verificationSection.withdrawn', { defaultValue: 'Verification request withdrawn.' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to withdraw';
      showToast(msg, 'error');
    } finally {
      setWithdrawing(false);
    }
  }, [serverId, showToast, t]);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-6">
          <Loader2 size={18} className="animate-spin text-t-secondary" />
        </div>
      </Card>
    );
  }

  if (!data) return null;

  // Already verified (grandfathered)
  if (data.alreadyVerified) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 w-8 h-8 rounded-full bg-sky-500/20 flex items-center justify-center shrink-0">
            <ShieldCheck size={18} className="text-sky-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-t-primary">
              {t('verificationSection.verifiedTitle', { defaultValue: 'Verified by Howl' })}
            </p>
            <p className="text-[12px] text-t-secondary mt-1">
              {t('verificationSection.verifiedDesc', {
                defaultValue: 'Your server has the official Verified badge. The blue shield is shown on your discovery card and public profile.',
              })}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const req = data.request;
  const isPending = req?.status === 'pending';
  const isRejected = req?.status === 'rejected';
  const inCooldown = !!(isRejected && req?.cooldownUntil && new Date(req.cooldownUntil).getTime() > Date.now());
  const cooldownDaysLeft = req?.cooldownUntil
    ? Math.max(0, Math.ceil((new Date(req.cooldownUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck size={16} className="text-sky-400" />
        <p className="text-sm font-semibold text-t-primary">
          {t('verificationSection.title', { defaultValue: 'Apply for the Verified by Howl badge' })}
        </p>
      </div>
      <p className="text-[12px] text-t-secondary mb-4">
        {t('verificationSection.headerDesc', {
          defaultValue: 'For official organizations and brands. Howl admins manually review every request — we visit your website and check your public presence before approving.',
        })}
      </p>

      {/* Pending state */}
      {isPending && req && (
        <div className="space-y-3">
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5">
            <p className="text-[12px] text-yellow-300 font-medium">
              {t('verificationSection.pendingTitle', { defaultValue: 'Application pending review' })}
            </p>
            <p className="text-[11px] text-t-secondary mt-1">
              {t('verificationSection.pendingDesc', {
                defaultValue: 'Submitted {{when}}. We\'ll email you when an admin makes a decision.',
                when: new Date(req.createdAt).toLocaleDateString(),
              })}
            </p>
          </div>
          <div className="text-[11px] text-t-secondary space-y-1">
            <p><span className="text-t-primary font-medium">{t('verificationSection.orgLabel', { defaultValue: 'Organization' })}:</span> {req.organizationName}</p>
            <p>
              <span className="text-t-primary font-medium">{t('verificationSection.websiteLabel', { defaultValue: 'Website' })}:</span>{' '}
              <a href={req.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-t-accent hover:underline break-all">{req.websiteUrl}</a>
            </p>
            {req.additionalNotes && (
              <p><span className="text-t-primary font-medium">{t('verificationSection.notesLabel', { defaultValue: 'Notes' })}:</span> {req.additionalNotes}</p>
            )}
          </div>
          <button
            type="button"
            onClick={handleWithdraw}
            disabled={withdrawing}
            className="btn-secondary text-[11px] px-2.5 py-1 inline-flex items-center gap-1"
          >
            {withdrawing ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
            {t('verificationSection.withdraw', { defaultValue: 'Withdraw' })}
          </button>
        </div>
      )}

      {/* Rejected (cooldown active) */}
      {inCooldown && req && (
        <div className="space-y-3">
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle size={12} className="mt-0.5 text-red-400 shrink-0" />
              <div className="flex-1">
                <p className="text-[12px] text-red-300 font-medium">
                  {t('verificationSection.rejectedTitle', { defaultValue: 'Application not accepted' })}
                </p>
                {req.decisionNote && (
                  <p className="text-[11px] text-t-secondary mt-1.5 whitespace-pre-wrap">{req.decisionNote}</p>
                )}
                <p className="text-[11px] text-t-secondary mt-2">
                  {t('verificationSection.cooldownNotice', {
                    defaultValue: 'You can re-apply in {{days}} day(s).',
                    days: cooldownDaysLeft,
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* No active/blocking request — show apply form */}
      {!isPending && !inCooldown && (
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">
              {t('verificationSection.orgFieldLabel', { defaultValue: 'Organization name' })} *
            </label>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              maxLength={120}
              placeholder={t('verificationSection.orgPlaceholder', { defaultValue: 'e.g. Acme Inc.' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">
              {t('verificationSection.websiteFieldLabel', { defaultValue: 'Official website URL' })} *
            </label>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              maxLength={512}
              placeholder="https://example.com"
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
            />
            <p className="text-[10px] text-t-secondary mt-1">
              {t('verificationSection.websiteHint', {
                defaultValue: 'Admins will visit this URL to verify the org\'s legitimacy.',
              })}
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1.5 text-t-secondary">
              {t('verificationSection.notesFieldLabel', { defaultValue: 'Additional notes (optional)' })}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2048}
              rows={3}
              placeholder={t('verificationSection.notesPlaceholder', {
                defaultValue: 'Optional: link your verified social accounts, mention press coverage, or anything else that helps admins verify your identity.',
              })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary resize-y"
            />
          </div>
          {isRejected && req && (
            <div className="rounded-md border border-default bg-floating px-3 py-2 text-[11px] text-t-secondary">
              {t('verificationSection.previousRejection', {
                defaultValue: 'Previous application was not accepted. You can re-apply now.',
              })}
              {req.decisionNote && <p className="mt-1.5 whitespace-pre-wrap text-t-primary">{req.decisionNote}</p>}
            </div>
          )}
          <div>
            <PrimaryButton
              onClick={handleSubmit}
              disabled={submitting || !orgName.trim() || !websiteUrl.trim()}
              loading={submitting}
            >
              <span className="inline-flex items-center gap-2">
                <Send size={14} />
                {t('verificationSection.submit', { defaultValue: 'Submit application' })}
              </span>
            </PrimaryButton>
          </div>
        </div>
      )}
    </Card>
  );
};
