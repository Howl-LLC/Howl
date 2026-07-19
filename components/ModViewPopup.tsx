// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { X, MessageCircle, UserMinus, Shield, Clock, ChevronRight, Check, Plus, Info } from 'lucide-react';
import { formatUsername } from '../types';
import { LetterAvatar } from './LetterAvatar';
import { useTranslation } from 'react-i18next';
import { isValidCssColor, colorWithAlpha } from '../utils/securityUtils';

const PERMISSION_LABELS: Record<string, string> = {
  viewChannels: 'View Channels',
  manageChannels: 'Manage Channels',
  manageRoles: 'Manage Roles',
  createExpressions: 'Create Expressions',
  manageExpressions: 'Manage Expressions',
  viewAuditLog: 'View Audit Log',
  manageWebhooks: 'Manage Webhooks',
  manageServer: 'Manage Server',
  createInvite: 'Create Invite',
  changeNickname: 'Change Nickname',
  manageNicknames: 'Manage Nicknames',
  kickMembers: 'Kick, Approve, and Reject Members',
  banMembers: 'Ban Members',
  timeoutMembers: 'Timeout Members',
  sendMessages: 'Send Messages and Create Posts',
  sendMessagesInThreads: 'Send Messages in Threads and Posts',
  embedLinks: 'Embed Links',
  attachFiles: 'Attach Files',
  addReactions: 'Add Reactions',
  mentionEveryone: 'Mention @everyone, @here, and All Roles',
  manageMessages: 'Manage Messages',
  readMessageHistory: 'Read Message History',
  connect: 'Connect',
  speak: 'Speak',
  video: 'Video',
  useVoiceActivity: 'Use Voice Activity',
  muteMembers: 'Mute Members',
  moveMembers: 'Move Members',
  administrator: 'Administrator',
};

export type ModViewData = {
  id: string;
  username: string;
  avatar?: string;
  role: string;
  roleColor?: string;
  roleStyle?: string;
  memberSince: string;
  joinedPlatform: string;
  joinMethod: string;
  messageCount: number;
  linksCount: number;
  mediaCount: number;
  roles: Array<{ name: string; color: string }>;
  modPermissions: string[];
  passedVerification: boolean;
};

interface ModViewPopupProps {
  serverId: string;
  serverName: string;
  member: { id: string; username: string; discriminator?: string; avatar?: string; tag?: string };
  getModView: (serverId: string, userId: string) => Promise<ModViewData>;
  onClose: () => void;
  onKick?: (serverId: string, userId: string) => Promise<void>;
  onAddRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onDirectMessage?: (userId: string) => void;
  serverRoles?: Array<{ id: string; name: string; color: string }>;
}

type ModViewTab = 'message' | 'remove' | 'modview' | 'warnings';

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '–';
  }
}

export const ModViewPopup: React.FC<ModViewPopupProps> = ({
  serverId,
  serverName,
  member,
  getModView,
  onClose,
  onKick,
  onAddRole: _onAddRole,
  onDirectMessage,
  serverRoles = [],
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<ModViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ModViewTab>('modview');
  const [kicking, setKicking] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getModView(serverId, member.id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverId, member.id, getModView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleKick = async () => {
    if (!onKick) return;
    setKicking(true);
    try {
      await onKick(serverId, member.id);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setKicking(false);
    }
  };

  const displayName = formatUsername(member);

  const tabs: { id: ModViewTab; icon: React.ReactNode; label?: string }[] = [
    { id: 'message', icon: <MessageCircle size={18} /> },
    { id: 'remove', icon: <UserMinus size={18} /> },
    { id: 'modview', icon: <Shield size={18} /> },
    { id: 'warnings', icon: <Clock size={18} /> },
  ];

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="Moderation view"
        className="relative w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-app)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <LetterAvatar avatar={member.avatar} username={member.username} size={40} className="rounded-full" />
            <div className="min-w-0">
              <p className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{displayName}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] px-2 py-1 rounded-lg" style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-floating)' }}>ESC</span>
            <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-fill-active transition-colors" aria-label={t('common.close')}>
              <X size={20} style={{ color: 'var(--text-secondary)' }} />
            </button>
          </div>
        </div>

        <div className="flex border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          {tabs.map(({ id, icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`flex items-center justify-center w-12 h-12 border-b-2 transition-colors ${
                activeTab === id ? 'border-[var(--cyan-accent)] text-[var(--cyan-accent)]' : 'border-transparent hover:bg-fill-hover'
              }`}
              style={{ color: activeTab === id ? undefined : 'var(--text-secondary)' }}
              title={id === 'message' ? t('modView.message') : id === 'remove' ? t('modView.remove') : id === 'modview' ? t('modView.modView') : id === 'warnings' ? t('modView.warnings') : t('modView.id')}
            >
              {icon}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>{t('modView.loading')}</div>
          )}
          {error && (
            <div className="py-8 text-center text-sm text-red-400">{error}</div>
          )}
          {!loading && !error && data && activeTab === 'modview' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('modView.serverActivity')}</h3>
                <div className="space-y-2">
                  <button type="button" className="flex items-center justify-between w-full px-3 py-2 rounded-lg hover:bg-fill-hover text-left">
                    <span style={{ color: 'var(--text-primary)' }}>{t('modView.messages')}</span>
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>{data.messageCount} <ChevronRight size={14} /></span>
                  </button>
                  <button type="button" className="flex items-center justify-between w-full px-3 py-2 rounded-lg hover:bg-fill-hover text-left">
                    <span style={{ color: 'var(--text-primary)' }}>{t('modView.links')}</span>
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>{data.linksCount} <ChevronRight size={14} /></span>
                  </button>
                  <button type="button" className="flex items-center justify-between w-full px-3 py-2 rounded-lg hover:bg-fill-hover text-left">
                    <span style={{ color: 'var(--text-primary)' }}>{t('modView.media')}</span>
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>{data.mediaCount} <ChevronRight size={14} /></span>
                  </button>
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3 flex items-center justify-between" style={{ color: 'var(--text-secondary)' }}>
                  <span>{t('modView.modPermissions')}</span>
                  <button type="button" className="flex items-center gap-1 text-[10px] font-normal">
                    {t('modView.all')} ({data.modPermissions.length}) <ChevronRight size={12} />
                  </button>
                </h3>
                <div className="flex flex-wrap gap-2">
                  {data.modPermissions.slice(0, 8).map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs"
                      style={{ backgroundColor: 'var(--bg-floating)', color: 'var(--text-primary)' }}
                    >
                      {t(`modView.perm.${id}`, { defaultValue: PERMISSION_LABELS[id] ?? id })}
                      {(id === 'manageMessages' || id === 'administrator') && <Info size={12} style={{ color: 'var(--cyan-accent)' }} />}
                    </span>
                  ))}
                  {data.modPermissions.length > 8 && (
                    <span className="px-2.5 py-1 rounded-lg text-xs" style={{ backgroundColor: 'var(--bg-floating)', color: 'var(--text-secondary)' }}>
                      {t('modView.moreCount', { count: data.modPermissions.length - 8 })}
                    </span>
                  )}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('modView.roles')}</h3>
                <div className="flex flex-wrap gap-2 items-center">
                  {data.roles.map((r, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium"
                      style={{ backgroundColor: colorWithAlpha(r.color, '30'), color: isValidCssColor(r.color) ? r.color : 'var(--text-primary)' }}
                    >
                      {r.name}
                    </span>
                  ))}
                  {serverRoles.length > 0 && (
                    <button
                      type="button"
                      className="w-8 h-8 rounded-full flex items-center justify-center border-2 border-dashed hover:bg-fill-hover transition-colors"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                      title={t('modView.addRole')}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('modView.account')}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    {data.passedVerification ? <Check size={16} className="text-green-500 shrink-0" /> : null}
                    <span style={{ color: 'var(--text-primary)' }}>
                      {data.passedVerification ? t('modView.passedVerification') : t('modView.verificationPending')}
                    </span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('modView.howlJoinDate')}</span> {formatDate(data.joinedPlatform)}
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('modView.serverJoinDate')}</span> {formatDate(data.memberSince)}
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('modView.joinMethod')}</span> {data.joinMethod}
                  </p>
                </div>
              </section>
            </div>
          )}
          {!loading && !error && activeTab === 'remove' && (
            <div className="py-6 text-center">
              <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                {t('modView.removeConfirm', { username: formatUsername(member), serverName })}
              </p>
              <button
                type="button"
                onClick={() => setConfirmKick(true)}
                disabled={!onKick || kicking}
                className="btn-cta-danger px-4 py-2 rounded-xl font-semibold disabled:opacity-50 transition-colors"
              >
                {kicking ? t('modView.removing') : t('modView.remove')}
              </button>
              {confirmKick && (
                <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50" onClick={() => setConfirmKick(false)}>
                  <div className="rounded-xl p-6 max-w-sm border shadow-2xl" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
                    <p className="text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
                      {t('modView.removeConfirm', { username: formatUsername(member), serverName })}
                    </p>
                    <div className="flex gap-3 justify-end">
                      <button type="button" onClick={() => setConfirmKick(false)} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
                      <button type="button" disabled={kicking} onClick={() => { setConfirmKick(false); handleKick(); }} className="btn-cta-danger px-4 py-2 text-sm rounded-xl disabled:opacity-50 transition-colors">{kicking ? t('modView.removing') : t('common.confirm')}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {!loading && !error && activeTab === 'message' && (
            <div className="py-6 flex flex-col items-center gap-3">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('modView.dmDescription', 'Open a direct message with this user')}</p>
              <button
                onClick={() => { onDirectMessage?.(member.id); onClose(); }}
                disabled={!onDirectMessage}
                className="btn-cta px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-40"
              >
                <span className="flex items-center gap-2"><MessageCircle size={15} /> {t('modView.openDM', 'Open DM')}</span>
              </button>
            </div>
          )}
          {!loading && !error && activeTab === 'warnings' && (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('modView.noWarnings')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
