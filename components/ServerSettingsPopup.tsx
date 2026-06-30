// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Server, Channel, ChannelCategory, formatUsername, ServerSettings, serverHasPerm } from '../types';
import { X, Shield, Users, Link2, Check, ChevronRight, Pencil, MessageCircle, UserMinus, Clock, Ban, Smile, Image, Music, Package, ExternalLink, ShieldAlert, FileText, Bot, LayoutTemplate, Settings, Megaphone, Eye, UserPlus, Heart, Download, FolderOpen, Menu, MessageSquareHeart, BarChart3, ClipboardList, Tag } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { ModViewPopup } from './ModViewPopup';
import { ServerIcon } from './ServerIcon';
import { GLASS_MENU_CLASS, ContextMenuContainer } from '../utils/contextMenuStyles';
import { apiClient } from '../services/api';
import { isValidCssColor } from '../utils/securityUtils';
import type { ServerMemberRole, ServerMemberWithRole, ServerInvite, RoleStyle, LinkedRoleRequirement, ServerRole, ServerRoleFromAPI } from '../types/server';
import { apiRoleToServerRole } from '../types/server';
export type { ServerMemberRole, ServerMemberWithRole, ServerInvite, RoleStyle, LinkedRoleRequirement, ServerRole, ServerRoleFromAPI };
import { SectionHeader, Card, ConfirmDialog } from './settings/SettingsWidgets';
import { ProfileSection } from './serverSettings/ProfileSection';
import { EngagementSection, AccessSection } from './serverSettings/SetupSections';
import { CommunitySection } from './serverSettings/CommunitySection';
import { WelcomeScreenSection } from './serverSettings/WelcomeScreenSection';
import { InsightsSection } from './serverSettings/InsightsSection';
import { ApplicationsSection } from './serverSettings/ApplicationsSection';
import { EmojiSection, StickersSection, SoundboardSection } from './serverSettings/ContentSections';
import { MembersSection } from './serverSettings/MembersSection';
import { RolesSection } from './serverSettings/RolesSection';
import { SelfRolesSection } from './serverSettings/SelfRolesSection';
import { InvitesSection } from './serverSettings/InvitesSection';
import { SafetySection } from './serverSettings/SafetySection';
import { AutoModSection } from './serverSettings/AutoModSection';
import { BansSection } from './serverSettings/BansSection';
import { AuditLogSection } from './serverSettings/AuditLogSection';
import { TemplatesSection } from './serverSettings/TemplatesSection';
import { ImportHistorySection } from './serverSettings/ImportHistorySection';
import { ChannelsSection } from './serverSettings/ChannelsSection';

export type SettingsSection =
  | 'profile' | 'engagement' | 'access' | 'channels'
  | 'emoji' | 'stickers' | 'soundboard'
  | 'members' | 'roles' | 'selfRoles' | 'invites'
  | 'integrations' | 'appDirectory'
  | 'safetySetup' | 'auditLog' | 'bans' | 'autoMod'
  | 'enableCommunity' | 'welcomeScreen' | 'insights' | 'applications'
  | 'serverTemplate'
  | 'importHistory';

interface ServerSettingsPopupProps {
  server: Server;
  memberCount?: number;
  serverMembers?: ServerMemberWithRole[];
  onClose: () => void;
  onUpdateServer?: (server: Server) => void;
  onCreateInvite?: (serverId: string, options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; label?: string; shareable?: boolean }) => Promise<{ id: string; code: string; link: string; label?: string; shareable: boolean }>;
  onDeleteInvite?: (serverId: string, inviteId: string) => Promise<void>;
  onUpdateInvite?: (serverId: string, inviteId: string, data: { label?: string | null; shareable?: boolean }) => Promise<ServerInvite>;
  getServerInvites?: (serverId: string) => Promise<ServerInvite[]>;
  initialSection?: SettingsSection;
  getServerRoles?: (serverId: string) => Promise<ServerRoleFromAPI[]>;
  onUpdateRole?: (serverId: string, roleId: string, data: Partial<ServerRole>) => Promise<void>;
  onCreateRole?: (serverId: string, data: Partial<ServerRole>) => Promise<ServerRoleFromAPI>;
  onDeleteRole?: (serverId: string, roleId: string) => Promise<void>;
  onAddMemberToRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRemoveMemberFromRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRolesUpdated?: () => void;
  onKickMember?: (serverId: string, userId: string) => Promise<void>;
  getMemberModView?: (serverId: string, userId: string) => Promise<import('./ModViewPopup').ModViewData>;
  onLeaveServer?: (serverId: string) => void | Promise<void>;
  onTransferOwnershipAndLeave?: (serverId: string, newOwnerId: string) => void | Promise<void>;
  onDeleteServer?: (serverId: string) => void | Promise<void>;
  otherServerMembers?: ServerMemberWithRole[];
  currentUserId?: string;
  onCreateChannel?: (serverId: string, name: string, type: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker', categoryId: string) => Promise<Channel>;
  onUpdateChannel?: (serverId: string, channelId: string, data: { name?: string; description?: string | null; ageRestricted?: boolean }) => Promise<Channel>;
  onDeleteChannel?: (serverId: string, channelId: string) => Promise<void>;
  onCreateCategory?: (serverId: string, name: string) => Promise<ChannelCategory>;
  onUpdateCategory?: (serverId: string, categoryId: string, data: { name?: string }) => Promise<ChannelCategory>;
  onDeleteCategory?: (serverId: string, categoryId: string) => Promise<void>;
  onReorderChannels?: (serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>) => Promise<void>;
  onReorderCategories?: (serverId: string, categories: Array<{ id: string; position: number }>) => Promise<void>;
}

// Main component

export const ServerSettingsPopup: React.FC<ServerSettingsPopupProps> = ({
  server, memberCount = 0, serverMembers = [], onClose, onUpdateServer, onCreateInvite, onDeleteInvite, onUpdateInvite, getServerInvites,
  getServerRoles, onUpdateRole, onCreateRole, onDeleteRole, onAddMemberToRole, onRemoveMemberFromRole,
  onRolesUpdated, onKickMember, getMemberModView, currentUserId,
  onCreateChannel, onUpdateChannel, onDeleteChannel,
  onCreateCategory, onUpdateCategory, onDeleteCategory,
  onReorderChannels, onReorderCategories, initialSection,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection ?? 'profile');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [localMembers, setLocalMembers] = useState<ServerMemberWithRole[]>(serverMembers);
  useEffect(() => { setLocalMembers(serverMembers); }, [serverMembers]);

  // Member context menu state
  type MemberRow = ServerMemberWithRole & { tag?: string; memberSince?: string | Date; joinedPlatform?: string | Date; joinMethod?: string; roles?: ServerMemberRole[] };
  const [memberMenuAnchor, setMemberMenuAnchor] = useState<{ member: MemberRow; x: number; y: number } | null>(null);
  const [memberMenuRoles, setMemberMenuRoles] = useState<ServerRole[]>([]);
  const [modViewMember, setModViewMember] = useState<MemberRow | null>(null);

  // Roles (for member context menu)
  const [roles2, setRoles2] = useState<ServerRole[]>([]);

  // Server Settings (backend)
  const [serverSettings, setServerSettings] = useState<ServerSettings | null>(null);
  const [_settingsLoading, setSettingsLoading] = useState(false);
  const [_settingsSaving, setSettingsSaving] = useState(false);

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  // Error toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }; }, []);
  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const canKick = serverHasPerm(server, 'kickMembers');
  const canBan = serverHasPerm(server, 'banMembers');
  const canManageRoles = serverHasPerm(server, 'manageRoles');
  const canManageChannels = serverHasPerm(server, 'manageChannels');
  const canManageServer = serverHasPerm(server, 'manageServer');
  const canViewAuditLog = serverHasPerm(server, 'viewAuditLog');

  const closeMemberMenu = useCallback(() => setMemberMenuAnchor(null), []);

  // Load roles (for member context menu)
  useEffect(() => {
    if ((activeSection === 'roles' || activeSection === 'members') && getServerRoles) {
      getServerRoles(server.id).then((r) => {
        setRoles2(r.map(apiRoleToServerRole));
        setMemberMenuRoles(r.map(apiRoleToServerRole));
      }).catch(() => {});
    }
  }, [activeSection, server.id, getServerRoles]);

  // Load server settings
  useEffect(() => {
    if (['safetySetup', 'engagement', 'access', 'enableCommunity', 'profile'].includes(activeSection)) {
      setSettingsLoading(true);
      apiClient.getServerSettings(server.id).then((s) => {
        setServerSettings(s);
      }).catch(() => showToast(t('serverSettings.failedToLoadSettings'), 'error')).finally(() => setSettingsLoading(false));
    }
  }, [activeSection, server.id]);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (confirmDialog) setConfirmDialog(null); else onClose(); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, confirmDialog]);

  // Save helpers
  const saveSettings = async (data: Partial<ServerSettings>) => {
    setSettingsSaving(true);
    try {
      const updated = await apiClient.updateServerSettings(server.id, data);
      setServerSettings(updated);
    } catch {
      showToast(t('serverSettings.failedToSaveSettings'), 'error');
    }
    setSettingsSaving(false);
  };

  // Navigation
  const NAV_GROUP_KEYS: Record<string, string> = { SETUP: 'serverSettings.setup', COMMUNITY: 'serverSettings.communityGroup', CONTENT: 'serverSettings.content', MEMBERS: 'serverSettings.membersSection', MODERATION: 'serverSettings.moderation', TOOLS: 'serverSettings.tools' };
  const navSections: { id: SettingsSection; label: string; icon: React.ReactNode; group: string; comingSoon?: boolean }[] = [
    { id: 'profile', label: t('serverSettings.overview'), icon: <Settings size={16} />, group: 'SETUP' },
    { id: 'channels', label: t('serverSettings.channelsAndCategories'), icon: <FolderOpen size={16} />, group: 'SETUP' },
    { id: 'engagement', label: t('serverSettings.alerts'), icon: <Megaphone size={16} />, group: 'SETUP' },
    { id: 'access', label: t('serverSettings.entryRules'), icon: <UserPlus size={16} />, group: 'SETUP' },
    { id: 'enableCommunity', label: t('serverSettings.communityHub'), icon: <Heart size={16} />, group: 'COMMUNITY' },
    { id: 'welcomeScreen', label: t('serverSettings.welcomeScreen', { defaultValue: 'Welcome Screen' }), icon: <MessageSquareHeart size={16} />, group: 'COMMUNITY' },
    { id: 'insights', label: t('serverSettings.insights', { defaultValue: 'Insights' }), icon: <BarChart3 size={16} />, group: 'COMMUNITY' },
    { id: 'applications', label: t('serverSettings.applications', { defaultValue: 'Applications' }), icon: <ClipboardList size={16} />, group: 'COMMUNITY' },
    { id: 'emoji', label: t('serverSettings.emoji'), icon: <Smile size={16} />, group: 'CONTENT' },
    { id: 'stickers', label: t('serverSettings.stickers'), icon: <Image size={16} />, group: 'CONTENT' },
    { id: 'soundboard', label: t('serverSettings.soundboard'), icon: <Music size={16} />, group: 'CONTENT' },
    { id: 'members', label: t('serverSettings.membersLabel'), icon: <Users size={16} />, group: 'MEMBERS' },
    { id: 'roles', label: t('serverSettings.roles'), icon: <Shield size={16} />, group: 'MEMBERS' },
    { id: 'selfRoles', label: t('serverSettings.selfRoles', { defaultValue: 'Self Roles' }), icon: <Tag size={16} />, group: 'MEMBERS' },
    { id: 'invites', label: t('serverSettings.invites'), icon: <Link2 size={16} />, group: 'MEMBERS' },
    { id: 'safetySetup', label: t('serverSettings.safety'), icon: <ShieldAlert size={16} />, group: 'MODERATION' },
    { id: 'autoMod', label: t('serverSettings.autoFilter'), icon: <Bot size={16} />, group: 'MODERATION' },
    { id: 'bans', label: t('serverSettings.banList'), icon: <Ban size={16} />, group: 'MODERATION' },
    { id: 'auditLog', label: t('serverSettings.changeLog'), icon: <FileText size={16} />, group: 'MODERATION' },
    { id: 'serverTemplate', label: t('serverSettings.templates'), icon: <LayoutTemplate size={16} />, group: 'TOOLS' },
    { id: 'importHistory', label: t('serverSettings.importHistory'), icon: <Download size={16} />, group: 'TOOLS' },
    { id: 'integrations', label: t('serverSettings.extensions'), icon: <Package size={16} />, group: 'TOOLS', comingSoon: true },
    { id: 'appDirectory', label: t('serverSettings.addOns'), icon: <ExternalLink size={16} />, group: 'TOOLS', comingSoon: true },
  ];
  // Gate sensitive sections behind permissions
  const permGatedSections = new Set<string>();
  if (!canManageChannels && !canManageServer) permGatedSections.add('channels');
  if (!canManageRoles) permGatedSections.add('roles');
  if (!canManageRoles) permGatedSections.add('selfRoles');
  if (!canBan) permGatedSections.add('bans');
  if (!canManageServer) {
    permGatedSections.add('autoMod');
    permGatedSections.add('engagement');
    permGatedSections.add('access');
    permGatedSections.add('enableCommunity');
    permGatedSections.add('welcomeScreen');
    permGatedSections.add('insights');
    permGatedSections.add('serverTemplate');
    permGatedSections.add('importHistory');
  }
  if (!serverHasPerm(server, 'manageMembers')) permGatedSections.add('applications');
  if (!canViewAuditLog) permGatedSections.add('auditLog');
  if (!serverHasPerm(server, 'manageExpressions')) {
    permGatedSections.add('emoji');
    permGatedSections.add('stickers');
    permGatedSections.add('soundboard');
  }
  if (!serverHasPerm(server, 'createInvite') && !canManageServer) permGatedSections.add('invites');
  const visibleNavSections = navSections.filter((s) => !permGatedSections.has(s.id));
  const navGroupOrder = ['SETUP', 'COMMUNITY', 'CONTENT', 'MEMBERS', 'MODERATION', 'TOOLS'];

  // Render

  const content = (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-6xl h-full sm:h-[92vh] sm:max-h-[960px] flex flex-col sm:flex-row rounded-none sm:rounded-2xl border border-default shadow-2xl overflow-hidden spring-pop-in safe-area-top safe-area-bottom bg-panel"
        style={{ pointerEvents: 'auto' }}
        onClick={(e) => e.stopPropagation()}>

        {/* Close button */}
        <button onClick={onClose} className="absolute top-3 right-3 sm:top-4 sm:right-4 z-10 w-9 h-9 flex items-center justify-center rounded-full hover:bg-fill-hover transition-all text-t-secondary" aria-label={t('serverSettings.closeEsc')}>
          <X size={18} />
        </button>

        {/* ─── Mobile header with menu toggle ──────────────────────────── */}
        {isMobile && (
          <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b border-default" style={{ backgroundColor: 'var(--bg-sidebar, var(--bg-app))' }}>
            <button type="button" onClick={() => setMobileSidebarOpen((v) => !v)} className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-t-accent">
              <Menu size={18} />
              <span>{visibleNavSections.find((s) => s.id === activeSection)?.label ?? t('serverSettings.settingsLabel')}</span>
            </button>
          </div>
        )}

        {/* ─── Mobile sidebar overlay ────────────────────────────────────── */}
        {isMobile && (
          <div
            className="fixed inset-0 z-[var(--z-modal)] flex"
            style={{ visibility: mobileSidebarOpen ? 'visible' : 'hidden', transitionProperty: 'visibility', transitionDuration: '0ms', transitionDelay: mobileSidebarOpen ? '0ms' : '300ms' }}
            onClick={() => setMobileSidebarOpen(false)}
          >
            <div
              className="absolute inset-0 transition-opacity duration-300"
              style={{ backgroundColor: 'var(--overlay-backdrop)', opacity: mobileSidebarOpen ? 1 : 0 }}
            />
            <div
              className="relative w-72 max-w-[80vw] h-full flex flex-col safe-area-bottom safe-area-left safe-area-top transition-transform duration-300 ease-out"
              style={{ backgroundColor: 'var(--bg-sidebar, var(--bg-app))', borderRight: '1px solid var(--border-subtle)', transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)', boxShadow: mobileSidebarOpen ? '4px 0 24px rgba(0,0,0,0.4)' : 'none' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-14 flex items-center justify-between px-4 border-b border-default shrink-0">
                <span className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-t-accent">
                  <Settings size={14} /> {server.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileSidebarOpen(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-fill-hover text-t-secondary"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-4 px-2 pb-24 min-h-0">
                {navGroupOrder.map((group) => {
                  const sections = visibleNavSections.filter((s) => s.group === group);
                  if (sections.length === 0) return null;
                  return (
                    <div key={group} className="mb-4">
                      <p className="px-3 mb-1.5 text-[9px] font-semibold text-t-secondary opacity-60">
                        {t(NAV_GROUP_KEYS[group] ?? '')}
                      </p>
                      {sections.map((section) => {
                        const isActive = activeSection === section.id;
                        return (
                          <button key={section.id} type="button"
                            onClick={() => { setActiveSection(section.id); setMobileSidebarOpen(false); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-[13px] transition-all relative mb-0.5 ${isActive ? 'overflow-hidden' : 'hover:bg-fill-hover'}`}
                            style={{ color: isActive ? '#fff' : 'var(--text-secondary)', backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' : undefined }}>
                            <span style={{ opacity: isActive ? 1 : 0.5, color: isActive ? 'var(--cyan-accent)' : undefined }}>{section.icon}</span>
                            <span className="flex-1 truncate">{section.label}</span>
                            {section.comingSoon && <span className="text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase bg-floating text-t-secondary">{t('serverSettings.soon')}</span>}
                            {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg" style={{ background: 'var(--cyan-accent)' }} />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─── Left sidebar (desktop only) ───────────────────────────────── */}
        {!isMobile && (
        <aside className="w-56 shrink-0 flex flex-col overflow-y-auto border-r border-default" style={{ backgroundColor: 'var(--bg-sidebar, var(--bg-app))' }}>
          <div className="p-4 pb-3 flex items-center gap-3">
            <ServerIcon icon={server.icon} name={server.name} size={28} className="rounded-lg shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold truncate text-t-primary">{server.name}</h2>
              <p className="text-[10px] text-t-secondary">{t('serverSettings.settingsLabel')}</p>
            </div>
          </div>
          <nav className="p-2 flex-1">
            {navGroupOrder.map((group) => {
              const sections = visibleNavSections.filter((s) => s.group === group);
              if (sections.length === 0) return null;
              return (
                <div key={group} className="mb-4">
                  <p className="px-3 mb-1.5 text-[9px] font-semibold text-t-secondary opacity-60">
                    {t(NAV_GROUP_KEYS[group] ?? '')}
                  </p>
                  {sections.map((section) => {
                    const isActive = activeSection === section.id;
                    return (
                      <button key={section.id} type="button"
                        onClick={() => { setActiveSection(section.id); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-left text-[13px] transition-all relative mb-0.5 ${isActive ? 'font-semibold overflow-hidden' : 'hover:bg-fill-hover'}`}
                        style={{ color: isActive ? '#fff' : 'var(--text-secondary)', backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' : undefined }}>
                        <span style={{ opacity: isActive ? 1 : 0.5, color: isActive ? 'var(--cyan-accent)' : undefined }}>{section.icon}</span>
                        <span className="flex-1 truncate">{section.label}</span>
                        {section.comingSoon && <span className="text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase bg-floating text-t-secondary">{t('serverSettings.soon')}</span>}
                        {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg" style={{ background: 'var(--cyan-accent)' }} />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </aside>
        )}

        {/* ─── Main content area ─────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ pointerEvents: 'auto' }}>
          <div className="flex-1 overflow-y-auto p-6 sm:p-8">

            {activeSection === 'profile' && (
              <ProfileSection server={server} memberCount={memberCount} serverSettings={serverSettings} onUpdateServer={onUpdateServer} showToast={showToast} saveSettings={saveSettings} />
            )}
            {activeSection === 'channels' && (canManageChannels || canManageServer) && (
              <ChannelsSection
                server={server} showToast={showToast}
                onCreateChannel={onCreateChannel} onUpdateChannel={onUpdateChannel} onDeleteChannel={onDeleteChannel}
                onCreateCategory={onCreateCategory} onUpdateCategory={onUpdateCategory} onDeleteCategory={onDeleteCategory}
                onReorderChannels={onReorderChannels} onReorderCategories={onReorderCategories}
              />
            )}
            {activeSection === 'engagement' && (
              <EngagementSection server={server} serverSettings={serverSettings} saveSettings={saveSettings} showToast={showToast} />
            )}
            {activeSection === 'access' && (
              <AccessSection server={server} serverSettings={serverSettings} saveSettings={saveSettings} showToast={showToast} />
            )}
            {activeSection === 'emoji' && (
              <EmojiSection server={server} showToast={showToast} />
            )}
            {activeSection === 'stickers' && (
              <StickersSection server={server} showToast={showToast} />
            )}
            {activeSection === 'soundboard' && (
              <SoundboardSection server={server} showToast={showToast} />
            )}
            {activeSection === 'members' && (
              <MembersSection server={server} memberCount={memberCount} localMembers={localMembers} setLocalMembers={setLocalMembers} showToast={showToast} roles={roles2} getServerRoles={getServerRoles} onAddMemberToRole={onAddMemberToRole} onRolesUpdated={onRolesUpdated} onMemberMenuOpen={(member, x, y) => setMemberMenuAnchor({ member, x, y })} onRolesChanged={(r) => { setRoles2(r); setMemberMenuRoles(r); }} />
            )}
            {activeSection === 'roles' && canManageRoles && (
              <RolesSection server={server} localMembers={localMembers} setLocalMembers={setLocalMembers} showToast={showToast} getServerRoles={getServerRoles} onUpdateRole={onUpdateRole} onCreateRole={onCreateRole} onDeleteRole={onDeleteRole} onAddMemberToRole={onAddMemberToRole} onRemoveMemberFromRole={onRemoveMemberFromRole} onRolesUpdated={onRolesUpdated} />
            )}
            {activeSection === 'selfRoles' && canManageRoles && (
              <SelfRolesSection server={server} showToast={showToast} />
            )}
            {activeSection === 'invites' && (
              <InvitesSection server={server} showToast={showToast} currentUserId={currentUserId} onCreateInvite={onCreateInvite} onDeleteInvite={onDeleteInvite} onUpdateInvite={onUpdateInvite} getServerInvites={getServerInvites} />
            )}
            {activeSection === 'safetySetup' && (
              <SafetySection server={server} serverSettings={serverSettings} saveSettings={saveSettings} showToast={showToast} />
            )}
            {activeSection === 'autoMod' && canManageServer && (
              <AutoModSection server={server} showToast={showToast} />
            )}
            {activeSection === 'bans' && canBan && (
              <BansSection server={server} showToast={showToast} />
            )}
            {activeSection === 'auditLog' && canViewAuditLog && (
              <AuditLogSection server={server} showToast={showToast} />
            )}
            {activeSection === 'enableCommunity' && (
              <CommunitySection server={server} showToast={showToast} />
            )}
            {activeSection === 'welcomeScreen' && canManageServer && (
              <WelcomeScreenSection server={server} showToast={showToast} />
            )}
            {activeSection === 'insights' && canManageServer && (
              <InsightsSection server={server} showToast={showToast} />
            )}
            {activeSection === 'applications' && serverHasPerm(server, 'manageMembers') && (
              <ApplicationsSection server={server} showToast={showToast} />
            )}
            {activeSection === 'serverTemplate' && (
              <TemplatesSection server={server} showToast={showToast} />
            )}
            {activeSection === 'importHistory' && (
              <ImportHistorySection server={server} showToast={showToast} />
            )}
            {activeSection === 'integrations' && (
              <div className="max-w-2xl space-y-6">
                <SectionHeader title={t('serverSettings.extensions')} desc={t('serverSettings.extensionsDesc')} icon={<Package size={24} />} />
                <Card>
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-app-surface">
                      <Package size={28} className="opacity-30 text-t-secondary" />
                    </div>
                    <p className="text-sm font-semibold mb-1 text-t-primary">{t('serverSettings.comingSoon')}</p>
                    <p className="text-xs text-center max-w-xs text-t-secondary">{t('serverSettings.extensionsComingSoon')}</p>
                  </div>
                </Card>
              </div>
            )}
            {activeSection === 'appDirectory' && (
              <div className="max-w-2xl space-y-6">
                <SectionHeader title={t('serverSettings.addOns')} desc={t('serverSettings.addOnsDesc')} icon={<ExternalLink size={24} />} />
                <Card>
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-app-surface">
                      <ExternalLink size={28} className="opacity-30 text-t-secondary" />
                    </div>
                    <p className="text-sm font-semibold mb-1 text-t-primary">{t('serverSettings.comingSoon')}</p>
                    <p className="text-xs text-center max-w-xs text-t-secondary">{t('serverSettings.addOnsComingSoon')}</p>
                  </div>
                </Card>
              </div>
            )}

          </div>
        </main>
      </div>

      {/* Member context menu */}
      {memberMenuAnchor && (() => {
        return (
          <>
            <div className="fixed inset-0 z-[9000]" aria-hidden onClick={closeMemberMenu} />
            <ContextMenuContainer
              x={memberMenuAnchor.x}
              y={memberMenuAnchor.y}
              estWidth={224}
              estHeight={380}
              className={`fixed z-[9001] w-56 py-1.5 min-w-0 ${GLASS_MENU_CLASS} glass`}
              onClick={(e) => e.stopPropagation()}>
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary" onClick={closeMemberMenu}>
                <Eye size={15} className="shrink-0 opacity-50" /> {t('serverSettings.profileMenu')}
              </button>
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary" onClick={closeMemberMenu}>
                <MessageCircle size={15} className="shrink-0 opacity-50" /> {t('serverSettings.directMessage')}
              </button>
              <div className="h-px my-1 bg-[var(--border-subtle)]" />
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary" onClick={closeMemberMenu}>
                <Pencil size={15} className="shrink-0 opacity-50" /> {t('serverSettings.setNickname')}
              </button>
              {canManageRoles && (memberMenuAnchor.member.role ?? '').toLowerCase() !== 'owner' && (
                <div className="relative group/roles">
                  <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary">
                    <Shield size={15} className="shrink-0 opacity-50" /> {t('serverSettings.changeRole', 'Change Role')}
                    <ChevronRight size={12} className="ml-auto opacity-40" />
                  </button>
                  <div className="absolute left-full top-0 ml-1 w-48 py-1 rounded-xl border border-default shadow-2xl hidden group-hover/roles:block bg-floating">
                    {roles2.filter(r => r.name !== 'Owner').map(r => (
                      <button key={r.id} type="button"
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary ${(memberMenuAnchor.member.role ?? '').toLowerCase() === r.name.toLowerCase() ? 'opacity-50' : ''}`}
                        onClick={async () => {
                          if ((memberMenuAnchor.member.role ?? '').toLowerCase() === r.name.toLowerCase()) return;
                          const targetId = memberMenuAnchor!.member.id;
                          try {
                            await onAddMemberToRole?.(server.id, r.id, targetId);
                            setLocalMembers(prev => prev.map(mem => mem.id === targetId ? { ...mem, role: r.name } : mem));
                            onRolesUpdated?.();
                            if (getServerRoles) { const updRoles = await getServerRoles(server.id); setRoles2(updRoles.map(apiRoleToServerRole)); }
                            showToast(t('serverSettings.roleChangedTo', { name: r.name }));
                          } catch { showToast(t('serverSettings.roleChangeFailed', 'Failed to change role'), 'error'); }
                          closeMemberMenu();
                        }}>
                        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: isValidCssColor(r.color) ? r.color : '#99aab5' }} />
                        {r.name}
                        {(memberMenuAnchor.member.role ?? '').toLowerCase() === r.name.toLowerCase() && <Check size={12} className="ml-auto opacity-60" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fill-hover transition-colors text-t-primary"
                onClick={() => { setModViewMember(memberMenuAnchor.member); closeMemberMenu(); }}>
                <Shield size={15} className="shrink-0 opacity-50" /> {t('serverSettings.inspect')}
              </button>
              <div className="h-px my-1 bg-[var(--border-subtle)]" />
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-red-400/10 text-red-400 transition-colors" onClick={closeMemberMenu}>
                <Clock size={15} className="shrink-0" /> {t('serverSettings.muteTemporarily')}
              </button>
              {canKick && currentUserId !== memberMenuAnchor.member.id && (memberMenuAnchor.member.role ?? '').toLowerCase() !== 'owner' && (
                <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-red-400/10 text-red-400 transition-colors"
                  onClick={() => setConfirmDialog({ title: t('serverSettings.removeMember'), desc: t('serverSettings.removeMemberConfirm', { username: formatUsername(memberMenuAnchor!.member) }), confirmLabel: t('common.remove'), danger: true, onConfirm: async () => { try { await onKickMember?.(server.id, memberMenuAnchor!.member.id); onRolesUpdated?.(); showToast(t('serverSettings.memberRemoved')); } catch { showToast(t('serverSettings.failedToRemoveMember'), 'error'); } closeMemberMenu(); setConfirmDialog(null); } })}>
                  <UserMinus size={15} className="shrink-0" /> {t('serverSettings.remove')}
                </button>
              )}
              {canBan && currentUserId !== memberMenuAnchor.member.id && (memberMenuAnchor.member.role ?? '').toLowerCase() !== 'owner' && (
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-red-400/10 text-red-400 transition-colors"
                onClick={() => setConfirmDialog({ title: t('serverSettings.banMember'), desc: t('serverSettings.banMemberConfirm', { username: formatUsername(memberMenuAnchor!.member) }), confirmLabel: t('common.ban'), danger: true, onConfirm: async () => {
                  try { await apiClient.banServerMember(server.id, memberMenuAnchor!.member.id, t('serverSettings.bannedFromSettings')); onRolesUpdated?.(); showToast(t('serverSettings.memberBanned')); }
                  catch { showToast(t('serverSettings.failedToBanMember'), 'error'); }
                  closeMemberMenu(); setConfirmDialog(null);
                }})}>
                <Ban size={15} className="shrink-0" /> {t('serverSettings.ban')}
              </button>
              )}
            </ContextMenuContainer>
          </>
        );
      })()}

      {/* Mod View popup */}
      {modViewMember && getMemberModView && (
        <ModViewPopup
          serverId={server.id} serverName={server.name}
          member={{ id: modViewMember.id, username: modViewMember.username, discriminator: modViewMember.discriminator, avatar: modViewMember.avatar ?? undefined, tag: modViewMember.tag }}
          getModView={getMemberModView}
          onClose={() => setModViewMember(null)}
          onKick={canKick && currentUserId !== modViewMember.id && (modViewMember.role ?? '').toLowerCase() !== 'owner' ? onKickMember : undefined}
          onAddRole={onAddMemberToRole}
          serverRoles={memberMenuRoles.map((r) => ({ id: r.id, name: r.name, color: r.color }))}
        />
      )}

      {/* Confirm dialog */}
      {confirmDialog && (
        <ConfirmDialog {...confirmDialog} onCancel={() => setConfirmDialog(null)} />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] px-5 py-2.5 rounded-xl text-sm font-medium shadow-2xl animate-in slide-in-from-bottom-4 duration-200"
          style={{ backgroundColor: toast.type === 'error' ? 'var(--danger)' : 'var(--cyan-accent)', color: 'var(--text-on-accent)' }}>
          {toast.message}
        </div>
      )}
    </div>
  );

  return createPortal(content, document.body);
};
