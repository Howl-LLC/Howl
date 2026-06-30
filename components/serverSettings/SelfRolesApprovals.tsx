// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, ClipboardCheck } from 'lucide-react';
import type { Server } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import type { RoleClaimRequestRow } from '../../services/api/rolePickers';
import { LetterAvatar } from '../LetterAvatar';
import { Card, EmptyState } from '../settings/SettingsWidgets';

export interface SelfRolesApprovalsProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onPendingCount: (n: number) => void;
}

type Status = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const SelfRolesApprovals: React.FC<SelfRolesApprovalsProps> = ({ server, showToast, onPendingCount }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>('pending');
  const [rows, setRows] = useState<RoleClaimRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.roleClaimRequestsList(server.id, { status });
      setRows(r.requests);
      if (status === 'pending') onPendingCount(r.requests.length);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.loadFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [server.id, status, onPendingCount, showToast, t]);

  useEffect(() => { fetch(); }, [fetch]);

  // Live refresh — when admin A decides, admin B's queue updates without refresh.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      fetch();
    };
    sock.on('role-claim-request-updated', handler);
    return () => { sock.off('role-claim-request-updated', handler); };
  }, [server.id, fetch]);

  const decide = async (requestId: string, decision: 'approve' | 'reject') => {
    setDecidingId(requestId);
    try {
      await apiClient.roleClaimRequestDecide(server.id, requestId, { decision });
      setRows((prev) => prev.filter((r) => r.id !== requestId));
      showToast(decision === 'approve' ? t('selfRoles.approved', { defaultValue: 'Role granted' }) : t('selfRoles.rejected', { defaultValue: 'Request rejected' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('selfRoles.decideFailed', { defaultValue: 'Failed to decide' }), 'error');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Status filter */}
      <div className="flex gap-1 p-1 rounded-lg bg-fill-hover w-fit">
        {(['pending', 'approved', 'rejected'] as Status[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${status === s ? 'bg-app-surface text-t-primary' : 'text-t-secondary hover:text-t-primary'}`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <Card>
          <p className="py-4 text-center text-sm text-t-secondary">{t('common.loading')}</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardCheck size={36} />}
            title={t('selfRoles.noRequests', { defaultValue: 'No requests' })}
            desc={status === 'pending'
              ? t('selfRoles.noRequestsPending', { defaultValue: 'Nothing in the queue right now.' })
              : t('selfRoles.noRequestsHistorical', { defaultValue: 'No requests with this status.' })
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl border border-default bg-floating">
              <LetterAvatar avatar={r.applicant.avatar} username={r.applicant.username} size={36} className="rounded-full mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-t-primary">{r.applicant.username}</span>
                  <span className="text-xs text-t-secondary">{r.applicant.discriminator ? `#${r.applicant.discriminator}` : ''}</span>
                  <span className="text-xs text-t-tertiary">·</span>
                  <span className="text-xs text-t-secondary">requesting</span>
                  {r.role && (
                    <span className="text-xs font-semibold inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ backgroundColor: `${r.role.color}22`, color: r.role.color }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: r.role.color }} />
                      {r.role.name}
                    </span>
                  )}
                </div>
                {r.applicantMessage && (
                  <p className="text-xs text-t-secondary mt-1.5 italic">"{r.applicantMessage}"</p>
                )}
                <p className="text-[10px] text-t-tertiary mt-1">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
              {status === 'pending' && (
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={decidingId === r.id}
                    onClick={() => decide(r.id, 'reject')}
                    className="px-2.5 py-1.5 text-xs rounded-md border border-default text-t-secondary hover:text-red-400 hover:border-red-400/30 transition-colors disabled:opacity-50"
                    title={t('selfRoles.reject', { defaultValue: 'Reject' })}
                  >
                    <X size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={decidingId === r.id}
                    onClick={() => decide(r.id, 'approve')}
                    className="btn-cta px-3 py-1.5 text-xs font-semibold rounded-xl transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Check size={12} />
                    {t('selfRoles.approve', { defaultValue: 'Approve' })}
                  </button>
                </div>
              )}
              {status !== 'pending' && r.decidedBy && (
                <span className="text-[10px] text-t-tertiary shrink-0 mt-2">
                  by {r.decidedBy.username}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
