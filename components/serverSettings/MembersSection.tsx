// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Users, Search, ChevronLeft, ChevronRight, MoreHorizontal, Check } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { Server } from '../../types';
import type { ServerMemberWithRole, ServerMemberRole, ServerRole, ServerRoleFromAPI } from '../../types/server';
import { apiRoleToServerRole } from '../../types/server';
import { SectionHeader, Card, EmptyState } from '../settings/SettingsWidgets';
import { LetterAvatar } from '../LetterAvatar';
import { isValidCssColor } from '../../utils/securityUtils';

// Types

export type MemberRow = ServerMemberWithRole & { tag?: string; memberSince?: string | Date; joinedPlatform?: string | Date; joinMethod?: string; roles?: ServerMemberRole[] };

export interface MembersSectionProps {
  server: Server;
  memberCount: number;
  localMembers: ServerMemberWithRole[];
  setLocalMembers: React.Dispatch<React.SetStateAction<ServerMemberWithRole[]>>;
  showToast: (message: string, type?: 'success' | 'error') => void;
  roles: ServerRole[];
  getServerRoles?: (serverId: string) => Promise<ServerRoleFromAPI[]>;
  onAddMemberToRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRolesUpdated?: () => void;
  onMemberMenuOpen: (member: MemberRow, x: number, y: number) => void;
  onRolesChanged?: (roles: ServerRole[]) => void;
}

// Constants

const ROLE_COLORS: Record<string, string> = { owner: '#f59e0b', member: '#06b6d4', moderator: '#8b5cf6', default: '#64748b' };

// Component

export const MembersSection: React.FC<MembersSectionProps> = ({
  server, memberCount, localMembers, setLocalMembers, showToast, roles,
  getServerRoles, onAddMemberToRole, onRolesUpdated, onMemberMenuOpen, onRolesChanged,
}) => {
  const { t } = useTranslation();

  // State
  const [membersSearch, setMembersSearch] = useState('');
  const [membersSortBy, setMembersSortBy] = useState<'name' | 'memberSince' | 'joinedPlatform' | 'joinMethod' | 'roles'>('memberSince');
  const [membersPage, setMembersPage] = useState(1);
  const [membersPageSize] = useState(12);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [roleDropdownMemberId, setRoleDropdownMemberId] = useState<string | null>(null);
  const [roleDropdownRect, setRoleDropdownRect] = useState<{ left: number; top: number } | null>(null);
  const [roleAssigning, setRoleAssigning] = useState(false);
  const [roles2, setRoles2] = useState<ServerRole[]>(roles);

  // Keep roles2 in sync with incoming prop
  React.useEffect(() => { setRoles2(roles); }, [roles]);

  // Helpers

  const formatRelative = (d: string | Date | undefined) => {
    if (!d) return '–';
    const date = typeof d === 'string' ? new Date(d) : d;
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('serverSettings.justNow');
    if (mins < 60) return t('serverSettings.minutesAgo', { mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('serverSettings.hoursAgo', { hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return t('serverSettings.daysAgo', { days });
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  };

  // Memos

  const membersWithExtras = useMemo(() => {
    return localMembers.map((m) => ({
      ...m,
      tag: m.tag ?? `${m.username.toLowerCase().replace(/\s/g, '')}_${m.id.slice(-5)}`,
      memberSince: m.memberSince ?? undefined,
      joinedPlatform: m.joinedPlatform ?? undefined,
      joinMethod: m.joinMethod ?? 'Unknown',
      roles: m.roles ?? (m.role ? [{ name: m.role, color: ROLE_COLORS[m.role.toLowerCase()] ?? ROLE_COLORS.default }] : [{ name: 'member', color: ROLE_COLORS.member }]),
    }));
  }, [localMembers]);

  const filteredMembers = useMemo(() => {
    let list = [...membersWithExtras];
    if (membersSearch.trim()) {
      const q = membersSearch.toLowerCase();
      list = list.filter((m) => m.username.toLowerCase().includes(q) || (m.tag ?? '').toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      if (membersSortBy === 'name') return a.username.localeCompare(b.username);
      if (membersSortBy === 'roles') return (a.role ?? '').localeCompare(b.role ?? '');
      if (membersSortBy === 'memberSince') return new Date(b.memberSince ?? 0).getTime() - new Date(a.memberSince ?? 0).getTime();
      if (membersSortBy === 'joinedPlatform') return new Date(b.joinedPlatform ?? 0).getTime() - new Date(a.joinedPlatform ?? 0).getTime();
      return 0;
    });
    return list;
  }, [membersWithExtras, membersSearch, membersSortBy]);

  const totalMemberPages = Math.max(1, Math.ceil(filteredMembers.length / membersPageSize));
  const pagedMembers = filteredMembers.slice((membersPage - 1) * membersPageSize, membersPage * membersPageSize);

  // Render

  return (
    <div className="max-w-4xl space-y-5">
      <SectionHeader title={t('serverSettings.membersLabel')} desc={t('serverSettings.membersDesc', { count: memberCount || localMembers.length })} icon={<Users size={24} />} />
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-t-secondary" />
          <input value={membersSearch} onChange={(e) => { setMembersSearch(e.target.value); setMembersPage(1); }} placeholder={t('serverSettings.find')}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary" />
        </div>
        <Dropdown<typeof membersSortBy>
          options={[
            { value: 'memberSince', label: t('serverSettings.joined') },
            { value: 'name', label: t('serverSettings.name') },
            { value: 'roles', label: t('serverSettings.role') },
          ]}
          value={membersSortBy}
          onChange={(v) => setMembersSortBy(v)}
          size="sm"
        />
      </div>
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead>
            <tr className="border-b border-default">
              <th className="text-left px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-t-secondary">
                <input type="checkbox" className="mr-2 accent-[var(--cyan-accent)]"
                  checked={selectedMemberIds.size === pagedMembers.length && pagedMembers.length > 0}
                  onChange={() => setSelectedMemberIds(selectedMemberIds.size === pagedMembers.length ? new Set() : new Set(pagedMembers.map((m) => m.id)))} />
                {t('serverSettings.member')}</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-t-secondary">{t('serverSettings.role')}</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold uppercase tracking-wider hidden sm:table-cell text-t-secondary">{t('serverSettings.joined')}</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {pagedMembers.map((m) => (
              <tr key={m.id} className="border-b border-default hover:bg-fill-hover transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" className="accent-[var(--cyan-accent)]"
                      checked={selectedMemberIds.has(m.id)}
                      onChange={() => { const next = new Set(selectedMemberIds); next.has(m.id) ? next.delete(m.id) : next.add(m.id); setSelectedMemberIds(next); }} />
                    <LetterAvatar avatar={m.avatar} username={m.username} size={32} className="rounded-full" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate text-t-primary">{m.username}</p>
                      {m.discriminator && <p className="text-[10px] text-t-secondary">#{m.discriminator}</p>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 relative">
                  <button type="button"
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRoleDropdownRect({ left: r.left, top: r.bottom + 4 }); setRoleDropdownMemberId(roleDropdownMemberId === m.id ? null : m.id); }}
                    disabled={(m.role ?? '').toLowerCase() === 'owner'}
                    className="px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer hover:ring-1 hover:ring-white/20 transition-all disabled:cursor-default disabled:hover:ring-0"
                    style={{ backgroundColor: `${ROLE_COLORS[m.role?.toLowerCase() ?? ''] ?? ROLE_COLORS.default}20`, color: ROLE_COLORS[m.role?.toLowerCase() ?? ''] ?? ROLE_COLORS.default }}>
                    {m.role ?? 'member'} {(m.role ?? '').toLowerCase() !== 'owner' && <ChevronRight size={10} className="inline ml-0.5 -rotate-90" />}
                  </button>
                  {roleDropdownMemberId === m.id && roleDropdownRect && createPortal(
                    <>
                      <div className="fixed inset-0 z-[9000]" onClick={() => setRoleDropdownMemberId(null)} />
                      <div className="fixed z-[9001] w-48 py-1 rounded-xl border border-default shadow-2xl bg-floating"
                        style={{ left: roleDropdownRect.left, top: roleDropdownRect.top }}>
                        <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-t-secondary">{t('serverSettings.changeRole', 'Change Role')}</p>
                        {roles2.filter(r => (!r.locked || r.name !== 'Owner') && !r.isEveryone).map(r => (
                          <button key={r.id} type="button"
                            disabled={roleAssigning}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary ${(m.role ?? '').toLowerCase() === r.name.toLowerCase() ? 'opacity-50' : ''}`}
                            onClick={async () => {
                              if ((m.role ?? '').toLowerCase() === r.name.toLowerCase()) return;
                              setRoleAssigning(true);
                              try {
                                await onAddMemberToRole?.(server.id, r.id, m.id);
                                setLocalMembers(prev => prev.map(mem => mem.id === m.id ? { ...mem, role: r.name } : mem));
                                onRolesUpdated?.();
                                if (getServerRoles) { const updRoles = await getServerRoles(server.id); setRoles2(updRoles.map(apiRoleToServerRole)); onRolesChanged?.(updRoles.map(apiRoleToServerRole)); }
                                showToast(t('serverSettings.roleChangedTo', { name: r.name }));
                              } catch { showToast(t('serverSettings.roleChangeFailed', 'Failed to change role'), 'error'); }
                              setRoleAssigning(false);
                              setRoleDropdownMemberId(null);
                            }}>
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: isValidCssColor(r.color) ? r.color : '#99aab5' }} />
                            {r.name}
                            {(m.role ?? '').toLowerCase() === r.name.toLowerCase() && <Check size={12} className="ml-auto opacity-60" />}
                          </button>
                        ))}
                      </div>
                    </>,
                    document.body
                  )}
                </td>
                <td className="px-4 py-3 text-xs hidden sm:table-cell text-t-secondary">{formatRelative(m.memberSince)}</td>
                <td className="px-4 py-3">
                  <button type="button" onClick={(e) => onMemberMenuOpen(m, e.clientX, e.clientY)}
                    className="p-1.5 rounded-lg hover:bg-fill-hover transition-all text-t-secondary">
                    <MoreHorizontal size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {pagedMembers.length === 0 && <EmptyState icon={<Users size={40} />} title={t('serverSettings.noMembersFound')} desc={t('serverSettings.tryDifferentSearch')} />}
      </Card>
      {totalMemberPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" disabled={membersPage <= 1} onClick={() => setMembersPage((p) => p - 1)}
            className="p-2 rounded-lg hover:bg-fill-hover disabled:opacity-20 transition-all text-t-secondary"><ChevronLeft size={16} /></button>
          <span className="text-xs font-medium text-t-secondary">{membersPage} / {totalMemberPages}</span>
          <button type="button" disabled={membersPage >= totalMemberPages} onClick={() => setMembersPage((p) => p + 1)}
            className="p-2 rounded-lg hover:bg-fill-hover disabled:opacity-20 transition-all text-t-secondary"><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
};

export default MembersSection;
