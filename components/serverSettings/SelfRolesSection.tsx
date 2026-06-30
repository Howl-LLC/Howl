// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, UserPlus } from 'lucide-react';
import type { Server } from '../../types';
import type { ServerRoleFromAPI } from '../../types/server';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { SectionHeader, Card } from '../settings/SettingsWidgets';
import { SelfRolesPickers } from './SelfRolesPickers';
import { SelfRolesApprovals } from './SelfRolesApprovals';

const AUTO_ROLE_CAP = 5;

export interface AutoAssignRolesProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

/**
 * Mod-only block (manageRoles): pick the roles every new member is granted on
 * join. This is an admin surface, so `hidden` roles are intentionally NOT
 * filtered out here — the hidden-strip is only for member-facing surfaces.
 * @everyone and locked roles are excluded for UX (they can't be auto-assigned).
 * The server caps the selection at 5 and is authoritative; the disabled state
 * is just a hint.
 */
export const AutoAssignRoles: React.FC<AutoAssignRolesProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const serverId = server.id;
  const [roles, setRoles] = useState<ServerRoleFromAPI[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allRoles, current] = await Promise.all([
          apiClient.getServerRoles(serverId),
          apiClient.autoRolesGet(serverId),
        ]);
        if (cancelled) return;
        setRoles(allRoles);
        setSelected(current.roleIds);
      } catch (e) {
        if (!cancelled) showToast(e instanceof Error ? e.message : t('selfRoles.loadFailed', { defaultValue: 'Failed to load picker' }), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [serverId, showToast, t]);

  // UX-only exclusions; the server enforces what is actually assignable.
  const assignable = roles.filter((r) => !r.isEveryone && !r.locked);
  const atCap = selected.length >= AUTO_ROLE_CAP;

  const persist = async (next: string[]) => {
    const prev = selected;
    setSelected(next); // optimistic
    try {
      await apiClient.autoRolesSet(serverId, next);
      showToast(t('autoRoles.saved', { defaultValue: 'Auto-assigned roles updated' }));
    } catch (e) {
      setSelected(prev); // revert
      showToast(e instanceof Error ? e.message : t('selfRoles.saveFailed', { defaultValue: 'Failed to save' }), 'error');
    }
  };

  const toggle = (roleId: string, checked: boolean) => {
    if (checked) {
      if (selected.includes(roleId) || atCap) return;
      persist([...selected, roleId]);
    } else {
      persist(selected.filter((id) => id !== roleId));
    }
  };

  return (
    <Card>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-t-primary flex items-center gap-2">
          <UserPlus size={16} className="text-[var(--cyan-accent)]" />
          {t('autoRoles.title', { defaultValue: 'Auto-assigned roles' })}
        </h3>
        <p className="text-xs text-t-secondary mt-1">
          {t('autoRoles.desc', { defaultValue: 'Roles every new member receives automatically when they join. Up to 5 roles.' })}
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-t-secondary py-4">{t('common.loading')}</p>
      ) : assignable.length === 0 ? (
        <p className="text-sm text-t-secondary py-4">
          {t('autoRoles.noRoles', { defaultValue: 'No assignable roles. Create a role in the Roles tab first.' })}
        </p>
      ) : (
        <>
          <div className="space-y-1 max-h-[360px] overflow-y-auto">
            {assignable.map((r) => {
              const isSelected = selected.includes(r.id);
              const isDisabled = !isSelected && atCap;
              return (
                <label
                  key={r.id}
                  data-autorole-row
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-fill-hover cursor-pointer'}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isDisabled}
                    onChange={(e) => toggle(r.id, e.target.checked)}
                    className="shrink-0 accent-[var(--cyan-accent)]"
                  />
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                  <span className="flex-1 text-sm font-medium text-t-primary">{r.name}</span>
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-t-secondary mt-2">
            {atCap
              ? t('autoRoles.capReached', { defaultValue: 'Maximum 5 reached' })
              : t('autoRoles.capHint', { defaultValue: 'Up to 5 roles' })}
          </p>
        </>
      )}
    </Card>
  );
};

export interface SelfRolesSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

type Tab = 'pickers' | 'approvals';

export const SelfRolesSection: React.FC<SelfRolesSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('pickers');
  const [pendingCount, setPendingCount] = useState(0);

  // Initial pending-count fetch + live updates so the badge stays accurate
  // even when the admin is on the Pickers tab.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await apiClient.roleClaimRequestsList(server.id, { status: 'pending', limit: 50 });
        if (!cancelled) setPendingCount(r.requests.length);
      } catch { /* best-effort */ }
    };
    refresh();
    const sock = socketService.getSocket();
    if (!sock) return () => { cancelled = true; };
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      refresh();
    };
    sock.on('role-claim-request-updated', handler);
    return () => {
      cancelled = true;
      sock.off('role-claim-request-updated', handler);
    };
  }, [server.id]);

  return (
    <div className="max-w-5xl">
      <SectionHeader
        title={t('serverSettings.selfRoles', { defaultValue: 'Self Roles' })}
        desc={t('serverSettings.selfRolesDesc', {
          defaultValue: 'Pickers let members claim roles on their own. Configure which roles are claimable, where the picker lives, and any conditions before a member can take a role.',
        })}
        icon={<Tag size={24} />}
      />

      {/* Sub-tabs */}
      <div className="flex border-b border-default mb-4">
        <button
          type="button"
          onClick={() => setTab('pickers')}
          className={`px-4 py-2 text-sm transition-colors ${tab === 'pickers' ? 'text-[var(--cyan-accent)] border-b-2 border-[var(--cyan-accent)] -mb-px' : 'text-t-secondary hover:text-t-primary'}`}
        >
          {t('serverSettings.selfRolesPickers', { defaultValue: 'Pickers' })}
        </button>
        <button
          type="button"
          onClick={() => setTab('approvals')}
          className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === 'approvals' ? 'text-[var(--cyan-accent)] border-b-2 border-[var(--cyan-accent)] -mb-px' : 'text-t-secondary hover:text-t-primary'}`}
        >
          {t('serverSettings.selfRolesApprovals', { defaultValue: 'Approvals' })}
          {pendingCount > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500 text-amber-950">{pendingCount}</span>
          )}
        </button>
      </div>

      {tab === 'pickers' && (
        <div className="space-y-4">
          <AutoAssignRoles server={server} showToast={showToast} />
          <SelfRolesPickers server={server} showToast={showToast} />
        </div>
      )}
      {tab === 'approvals' && <SelfRolesApprovals server={server} showToast={showToast} onPendingCount={setPendingCount} />}
    </div>
  );
};

export default SelfRolesSection;
