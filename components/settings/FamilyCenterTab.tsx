// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, MessageCircle, Eye } from 'lucide-react';
import { apiClient } from '../../services/api';
import type { FamilyLinkInfo, FamilyActivity } from '../../services/api';
import type { User } from '../../types';
import { Toggle } from './SettingsWidgets';

type FamilyCenterSubTab = 'activity' | 'my-family' | 'settings';

interface FamilyCenterTabProps {
  user: User;
}

export const FamilyCenterTab: React.FC<FamilyCenterTabProps> = ({ user: _user }) => {
  const { t } = useTranslation();
  const [familyLinks, setFamilyLinks] = useState<FamilyLinkInfo[]>([]);
  const [familyActivity, setFamilyActivity] = useState<Record<string, FamilyActivity>>({});
  const [familyLoading, setFamilyLoading] = useState(false);
  const [linkChildUsername, setLinkChildUsername] = useState('');
  const [linkChildDiscriminator, setLinkChildDiscriminator] = useState('');
  const [familyError, setFamilyError] = useState<string | null>(null);
  const [familyCenterSubTab, setFamilyCenterSubTab] = useState<FamilyCenterSubTab>('activity');
  const [restrictionConfirm, setRestrictionConfirm] = useState<{ linkId: string; field: string; value: boolean; childName: string } | null>(null);
  const [familyActionConfirm, setFamilyActionConfirm] = useState<{ action: () => Promise<void>; title: string; message: string } | null>(null);

  useEffect(() => {
    setFamilyLoading(true);
    apiClient.getFamilyLinks()
      .then(setFamilyLinks)
      .catch((err) => { console.error('Failed to load family links', err); })
      .finally(() => setFamilyLoading(false));
  }, []);

  const activeLinks = familyLinks.filter((l) => l.status === 'active');
  const pendingLinks = familyLinks.filter((l) => l.status === 'pending');
  const parentLinks = activeLinks.filter((l) => l.role === 'parent');

  const loadActivity = useCallback(async (linkId: string) => {
    if (familyActivity[linkId]) return;
    try {
      const data = await apiClient.getFamilyActivity(linkId);
      setFamilyActivity((prev) => ({ ...prev, [linkId]: data }));
    } catch (err) {
      console.error('Failed to load family activity', err);
    }
  }, [familyActivity]);

  // Load activity for all parent links when activity tab is active
  useEffect(() => {
    if (familyCenterSubTab !== 'activity') return;
    parentLinks.forEach((link) => {
      if (!familyActivity[link.id]) loadActivity(link.id);
    });
  }, [familyCenterSubTab, parentLinks.length]);

  const handleRestrictionChange = async (linkId: string, field: string, value: boolean, childName: string) => {
    if (!value) {
      // Disabling a protection — require confirmation
      setRestrictionConfirm({ linkId, field, value, childName });
      return;
    }
    // Enabling a protection — apply immediately
    try {
      const r = await apiClient.updateFamilyRestrictions(linkId, { [field]: value });
      setFamilyLinks((prev) => prev.map((l) => l.id === linkId ? { ...l, restriction: r } : l));
    } catch (err) {
      console.error('Failed to update restriction', err);
      setFamilyError(t('settings.family.failedToUpdateRestriction'));
    }
  };

  const confirmRestrictionDisable = async () => {
    if (!restrictionConfirm) return;
    const { linkId, field, value } = restrictionConfirm;
    setRestrictionConfirm(null);
    try {
      const r = await apiClient.updateFamilyRestrictions(linkId, { [field]: value });
      setFamilyLinks((prev) => prev.map((l) => l.id === linkId ? { ...l, restriction: r } : l));
    } catch (err) {
      console.error('Failed to update restriction', err);
      setFamilyError(t('settings.family.failedToUpdateRestriction'));
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
        <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.familyHub')}</h2>
      <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.description')}</p>

      {familyError && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center justify-between">
          <span>{familyError}</span>
          <button type="button" onClick={() => setFamilyError(null)} className="text-red-400 hover:text-red-300 ml-2">&times;</button>
        </div>
      )}

      <div id="setting-family-center-sub-tab" className="flex gap-1 border-b border-[var(--glass-border)] mb-6">
        {(['activity', 'my-family', 'settings'] as const).map((tab) => (
          <button key={tab} type="button" onClick={() => setFamilyCenterSubTab(tab)}
            className={`px-4 py-2.5 text-[11px] font-semibold border-b-2 transition-colors -mb-px ${familyCenterSubTab === tab ? 'text-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'text-t-secondary border-transparent hover:text-t-primary'}`}>
            {tab === 'activity' ? t('settings.family.activity') : tab === 'my-family' ? t('settings.family.myFamily') : t('settings.family.settings')}
          </button>
        ))}
      </div>

      {familyLoading ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
      ) : (
        <>
          {familyCenterSubTab === 'activity' && (
            <>
              {parentLinks.length === 0 ? (
                <div className="border border-default rounded-2xl p-8 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                  <h3 className="text-lg font-black mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.family.stayInformed')}</h3>
                  <p className="text-sm mb-6 max-w-xl" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.linkChildDescription')}</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {parentLinks.map((link) => {
                    const act = familyActivity[link.id];
                    return (
                      <div key={link.id} className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                        <div className="flex items-center gap-3 mb-4">
                          <div className="w-10 h-10 rounded-full bg-fill-active flex items-center justify-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{link.child.username.slice(0, 2).toUpperCase()}</div>
                          <div>
                            <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{link.child.username}{link.child.discriminator ? `#${link.child.discriminator}` : ''}</p>
                            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.last7Days')}</p>
                          </div>
                        </div>
                        {act ? (
                          <div className="grid grid-cols-2 gap-4">
                            <div className="border border-default rounded-xl p-4" style={{ backgroundColor: 'var(--bg-input)' }}>
                              <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.messagesSent')}</p>
                              <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>{act.weeklyMessageCount}</p>
                            </div>
                            <div className="border border-default rounded-xl p-4" style={{ backgroundColor: 'var(--bg-input)' }}>
                              <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.serversJoined')}</p>
                              <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>{act.serverCount}</p>
                            </div>
                            {act.recentSessions.length > 0 && (
                              <div className="col-span-2 border border-default rounded-xl p-4" style={{ backgroundColor: 'var(--bg-input)' }}>
                                <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.recentDevices')}</p>
                                <ul className="space-y-1">
                                  {act.recentSessions.map((s, i) => (
                                    <li key={i} className="text-[11px]" style={{ color: 'var(--text-primary)' }}>{s.deviceName} ({s.os})</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.loadingActivity')}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
                {[
                  { icon: <MessageCircle size={20} className="text-[var(--cyan-accent)]" />, title: t('settings.family.messagesPrivate'), desc: t('settings.family.messagesPrivateDesc') },
                  { icon: <Eye size={20} className="text-[var(--cyan-accent)]" />, title: t('settings.family.transparentSharing'), desc: t('settings.family.transparentSharingDesc') },
                  { icon: <Users size={20} className="text-[var(--cyan-accent)]" />, title: t('settings.family.easySetup'), desc: t('settings.family.easySetupDesc') },
                ].map((card) => (
                  <div key={card.title} className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                    <div className="w-12 h-12 rounded-full border border-[var(--glass-border)] flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--bg-input)' }}>{card.icon}</div>
                    <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{card.title}</h4>
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{card.desc}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {familyCenterSubTab === 'my-family' && (
            <div className="space-y-6">
              {/* Link a child account */}
              <div id="setting-link-child-account" className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.family.linkChildAccount')}</h3>
                {familyError && <p className="text-xs text-red-400 mb-3">{familyError}</p>}
                <div className="flex gap-2 mb-3">
                  <input id="setting-link-child-username" type="text" placeholder={t('settings.username')} value={linkChildUsername} onChange={(e) => setLinkChildUsername(e.target.value)}
                    className="flex-1 rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50" style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                  <input id="setting-link-child-discriminator" type="text" placeholder="0000" value={linkChildDiscriminator} onChange={(e) => setLinkChildDiscriminator(e.target.value.replace('#', ''))} maxLength={4}
                    className="w-24 rounded-lg px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50" style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                </div>
                <button id="setting-send-link-request" type="button" disabled={!linkChildUsername || linkChildDiscriminator.length !== 4}
                  onClick={async () => {
                    setFamilyError(null);
                    try {
                      const link = await apiClient.createFamilyLink(linkChildUsername, linkChildDiscriminator);
                      setFamilyLinks((prev) => [link, ...prev]);
                      setLinkChildUsername(''); setLinkChildDiscriminator('');
                    } catch (e: unknown) { setFamilyError(e instanceof Error ? e.message : t('settings.family.failedToSendLinkRequest')); }
                  }}
                  className="btn-cta text-[10px] px-5 py-2.5 rounded-xl transition-all disabled:opacity-50">
                  {t('settings.family.sendLinkRequest')}
                </button>
              </div>

              {/* Pending links */}
              {pendingLinks.length > 0 && (
                <div id="setting-accept-link-request" className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                  <span id="setting-decline-link-request" />
                  <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.family.pendingRequests')}</h3>
                  <ul className="space-y-3">
                    {pendingLinks.map((link) => {
                      const other = link.role === 'parent' ? link.child : link.parent;
                      return (
                        <li key={link.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                          <div>
                            <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{other.username}{other.discriminator ? `#${other.discriminator}` : ''}</p>
                            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{link.role === 'parent' ? t('settings.family.waitingForChild') : t('settings.family.wantsToLinkAsParent')}</p>
                          </div>
                          <div className="flex gap-2">
                            {link.role === 'child' && (
                              <button type="button" onClick={async () => {
                                try { await apiClient.acceptFamilyLink(link.id); setFamilyLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, status: 'active' } : l)); } catch (err) { console.error('Failed to accept family link', err); setFamilyError(t('settings.family.failedToAcceptLink')); }
                              }} className="btn-cta text-[10px] px-3 py-1.5 rounded-xl transition-all">{t('common.accept')}</button>
                            )}
                            <button type="button" onClick={() => setFamilyActionConfirm({
                              title: t('settings.family.declineLinkRequest'),
                              message: t('settings.family.declineLinkMessage', { username: other.username }),
                              action: async () => {
                                try { await apiClient.revokeFamilyLink(link.id); setFamilyLinks((prev) => prev.filter((l) => l.id !== link.id)); } catch (err) { console.error('Failed to decline family link', err); setFamilyError(t('settings.family.failedToDeclineLink')); }
                              },
                            })} className="btn-cta-danger text-[10px] px-3 py-1.5 rounded-xl transition-all">{t('common.decline')}</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Active links */}
              {activeLinks.length > 0 && (
                <div id="setting-unlink-account" className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                  <span id="setting-approve-unlink" />
                  <span id="setting-deny-unlink" />
                  <span id="setting-request-unlink" />
                  <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.family.linkedAccounts')}</h3>
                  <ul className="space-y-3">
                    {activeLinks.map((link) => {
                      const other = link.role === 'parent' ? link.child : link.parent;
                      const hasUnlinkRequest = !!link.unlinkRequestedAt;
                      return (
                        <li key={link.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-fill-active flex items-center justify-center text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>{other.username.slice(0, 2).toUpperCase()}</div>
                            <div>
                              <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{other.username}{other.discriminator ? `#${other.discriminator}` : ''}</p>
                              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{link.role === 'parent' ? t('settings.family.child') : t('settings.family.parent')}</p>
                              {link.role === 'parent' && hasUnlinkRequest && (
                                <p className="text-[10px] text-amber-400 mt-0.5">{t('settings.family.unlinkRequestedByChild')}</p>
                              )}
                              {link.role === 'child' && hasUnlinkRequest && (
                                <p className="text-[10px] text-amber-400 mt-0.5">{t('settings.family.unlinkRequestedWaiting')}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {link.role === 'parent' && hasUnlinkRequest && (
                              <>
                                <button type="button" onClick={() => setFamilyActionConfirm({
                                  title: t('settings.family.approveUnlink'),
                                  message: t('settings.family.approveUnlinkMessage', { username: other.username }),
                                  action: async () => {
                                    try { await apiClient.approveFamilyUnlink(link.id); setFamilyLinks((prev) => prev.filter((l) => l.id !== link.id)); } catch (err) { console.error('Failed to approve unlink', err); setFamilyError(t('settings.family.failedToApproveUnlink')); }
                                  },
                                })} className="btn-cta text-[10px] px-3 py-1.5 rounded-xl transition-all">{t('settings.family.approve')}</button>
                                <button type="button" onClick={async () => {
                                  try { await apiClient.denyFamilyUnlink(link.id); setFamilyLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, unlinkRequestedAt: null } : l)); } catch (err) { console.error('Failed to deny unlink', err); setFamilyError(t('settings.family.failedToDenyUnlink')); }
                                }} className="btn-cta-danger text-[10px] px-3 py-1.5 rounded-xl transition-all">{t('settings.family.deny')}</button>
                              </>
                            )}
                            {link.role === 'parent' && (
                              <button type="button" onClick={() => setFamilyActionConfirm({
                                title: t('settings.family.unlinkAccount'),
                                message: t('settings.family.unlinkAccountMessage', { username: other.username }),
                                action: async () => {
                                  try { await apiClient.revokeFamilyLink(link.id); setFamilyLinks((prev) => prev.filter((l) => l.id !== link.id)); } catch (err) { console.error('Failed to unlink', err); setFamilyError(t('settings.family.failedToUnlink')); }
                                },
                              })} className="btn-cta-danger text-[10px] px-3 py-1.5 rounded-xl transition-all">{t('settings.family.unlink')}</button>
                            )}
                            {link.role === 'child' && !hasUnlinkRequest && (
                              <button type="button" onClick={() => setFamilyActionConfirm({
                                title: t('settings.family.requestUnlink'),
                                message: t('settings.family.requestUnlinkMessage', { username: other.username }),
                                action: async () => {
                                  try {
                                    const result = await apiClient.requestFamilyUnlink(link.id);
                                    setFamilyLinks((prev) => prev.map((l) => l.id === link.id ? { ...l, unlinkRequestedAt: result.unlinkRequestedAt } : l));
                                  } catch (err) { console.error('Failed to request unlink', err); setFamilyError(t('settings.family.failedToRequestUnlink')); }
                                },
                              })} className="text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all">{t('settings.family.requestUnlink')}</button>
                            )}
                            {link.role === 'child' && hasUnlinkRequest && (
                              <span className="text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-fill-hover border border-[var(--glass-border)]" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.pending')}</span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {activeLinks.length === 0 && pendingLinks.length === 0 && (
                <p className="text-xs py-4" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.noFamilyLinks')}</p>
              )}
            </div>
          )}

          {familyCenterSubTab === 'settings' && (
            <div className="space-y-6">
              {parentLinks.length === 0 ? (
                <div className="border border-default rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--bg-panel)' }}>
                  <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('settings.family.noChildAccounts')}</p>
                  <p className="text-xs max-w-sm mx-auto" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.linkChildForRestrictions')}</p>
                </div>
              ) : (
                parentLinks.map((link, linkIdx) => (
                  <div key={link.id} className="border border-default rounded-2xl p-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
                    <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                      {t('settings.family.restrictionsFor', { username: link.child.username })}
                    </h3>
                    <div className="space-y-3">
                      <div id={linkIdx === 0 ? 'setting-block-dm-non-friends' : undefined} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('settings.family.blockDmNonFriends')}</p>
                          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.blockDmNonFriendsDesc')}</p>
                        </div>
                        <Toggle checked={link.restriction?.blockDmFromNonFriends ?? false} onChange={(v) => handleRestrictionChange(link.id, 'blockDmFromNonFriends', v, link.child.username)} />
                      </div>
                      <div id={linkIdx === 0 ? 'setting-block-server-join' : undefined} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('settings.family.blockServerJoin')}</p>
                          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.blockServerJoinDesc')}</p>
                        </div>
                        <Toggle checked={link.restriction?.blockServerJoin ?? false} onChange={(v) => handleRestrictionChange(link.id, 'blockServerJoin', v, link.child.username)} />
                      </div>
                      <div id={linkIdx === 0 ? 'setting-daily-time-limit' : undefined} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.family.dailyTimeLimit')}</p>
                          <p className="text-[11px] mt-0.5" style={{ color: 'rgba(148,163,184,0.4)' }}>{t('settings.family.comingSoon')}</p>
                        </div>
                        <input type="number" min={0} max={1440} placeholder="∞"
                          disabled
                          defaultValue={link.restriction?.dailyTimeLimitMinutes ?? ''}
                          className="w-20 text-center rounded-lg px-2 py-1.5 text-sm border outline-none opacity-40 cursor-not-allowed"
                          style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {/* Restriction disable confirmation dialog */}
      {restrictionConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-2xl border p-6 max-w-sm w-full mx-4" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.family.disableProtection')}</h3>
            <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.family.disableProtectionMessage', { childName: restrictionConfirm.childName })}
            </p>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => setRestrictionConfirm(null)} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={confirmRestrictionDisable} className="btn-cta-danger px-4 py-2 text-sm rounded-xl">{t('settings.family.disable')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Family action confirmation dialog */}
      {familyActionConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-2xl border p-6 max-w-sm w-full mx-4" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{familyActionConfirm.title}</h3>
            <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>{familyActionConfirm.message}</p>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => setFamilyActionConfirm(null)} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={async () => { await familyActionConfirm.action(); setFamilyActionConfirm(null); }} className="btn-cta-danger px-4 py-2 text-sm rounded-xl">{t('common.confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FamilyCenterTab;
