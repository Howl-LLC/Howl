// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Server } from '../types';
import {
  Shield, Key, LogOut, Settings, User as UserIcon,
  Bell, MessageSquare,
  X, Smartphone, Link2, Palette, Search, Menu,
  Accessibility, Keyboard, Languages, Activity,
  Headphones, Type, MoreHorizontal, CreditCard, Gift, Crown,
  Rocket, Receipt, Users,
  MonitorPlay, Layout, Lock, Crosshair, Grid3X3,
} from 'lucide-react';
import { apiClient } from '../services/api';
import { useIsMobile } from '../hooks/useIsMobile';
import VoiceVideoTab from './settings/VoiceVideoTab';
import { useSettings } from '../contexts/SettingsContext';
import { AppearanceTab } from './settings/AppearanceTab';
import MyAccountTab from './settings/MyAccountTab';
import SocialPrivacyTab from './settings/SocialPrivacyTab';
import SessionsTab from './settings/SessionsTab';
import DataControlsTab from './settings/DataControlsTab';
import BillingTab from './settings/BillingTab';
import { ChatTab } from './settings/ChatTab';
import { AccessibilityTab } from './settings/AccessibilityTab';
import { LanguageTimeTab } from './settings/LanguageTimeTab';
import { StreamerModeTab } from './settings/StreamerModeTab';
import { AdvancedTab } from './settings/AdvancedTab';
import { ConnectionsTab } from './settings/ConnectionsTab';
import { LinkedAppsTab } from './settings/LinkedAppsTab';
import { ActivitySharingTab } from './settings/ActivitySharingTab';
import { ShowcaseTab } from './settings/ShowcaseTab';
import { NotificationsTab } from './settings/NotificationsTab';
import { SubscriptionsTab } from './settings/SubscriptionsTab';
import { PaymentTab } from './settings/PaymentTab';
import { FamilyCenterTab } from './settings/FamilyCenterTab';
import { EncryptionTab } from './settings/EncryptionTab';
import { ServerUpgradesTab } from './settings/ServerUpgradesTab';
import { GiftInventoryTab } from './settings/GiftInventoryTab';
import { KeybindsTab } from './settings/KeybindsTab';
import { GameOverlayTab } from './settings/GameOverlayTab';
import { StreamDeckTab } from './settings/StreamDeckTab';
import LogoutConfirmModal from './LogoutConfirmModal';
import { useSettingsSearch } from '../hooks/useSettingsSearch';
import { SettingsSearchResults } from './settings/SettingsSearchResults';
import type { SettingEntry } from '../utils/settingsRegistry';
import { useAppStore } from '../stores/appStore';
import { billingVisible } from '../shared/instanceConfig';

interface AccountViewProps {
  user: User;
  onLogout?: (keepEncryptionKeys?: boolean) => void;
  onUserUpdate?: (user: User) => void;
  onClose?: () => void;
  statusBarDocked?: boolean;
  /** Top inset (px) to clear the floating Navigator logo in rail-less mode. */
  navTopInset?: number;
  servers?: Server[];
  initialPage?: string;
  initialSubTab?: string;
  initialProfileServerId?: string;
  onKeybindPageActive?: (active: boolean) => void;
  backgroundImage?: string | null;
  onBackgroundImageChange?: (dataUrl: string | null) => void;
  backgroundOpacity?: number;
  onBackgroundOpacityChange?: (opacity: number) => void;
  backgroundBlur?: number;
  onBackgroundBlurChange?: (blur: number) => void;
  bgGifAlwaysPlay?: boolean;
  onBgGifAlwaysPlayChange?: (always: boolean) => void;
  showToast?: (message: string, type?: 'info' | 'warning') => void;
}

type PageId =
  | 'my-account'
  | 'content-social'
  | 'data-privacy'
  | 'authorized-apps'
  | 'activity-sharing'
  | 'showcase'
  | 'devices'
  | 'connections'
  | 'notifications'
  | 'howl-pro'
  | 'server-boost'
  | 'subscriptions'
  | 'gift-inventory'
  | 'billing'
  | 'appearance'
  | 'accessibility'
  | 'voice-video'
  | 'chat'
  | 'keybinds'
  | 'language-time'
  | 'advanced'
  | 'streamer-mode'
  | 'game-overlay'
  | 'streamdeck'
  | 'family-center'
  | 'encryption';

/** Navigation tree: subheadings + items (same tab names and icons) */
const NAV_CATEGORIES: { heading: string; items: { id: PageId; label: string; icon: React.ReactNode }[] }[] = [
  {
    heading: 'Account & Security',
    items: [
      { id: 'my-account', label: 'My Account', icon: <UserIcon size={16} /> },
      { id: 'connections', label: 'Connections', icon: <Link2 size={16} /> },
      { id: 'devices', label: 'Sessions', icon: <Smartphone size={16} /> },
      { id: 'encryption', label: 'Encryption', icon: <Lock size={16} /> },
    ],
  },
  {
    heading: 'Profile & Social',
    items: [
      { id: 'content-social', label: 'Social & Privacy', icon: <MessageSquare size={16} /> },
      { id: 'activity-sharing', label: 'Activity Sharing', icon: <Activity size={16} /> },
      { id: 'showcase', label: 'Showcase', icon: <Layout size={16} /> },
      { id: 'authorized-apps', label: 'Linked Apps', icon: <Key size={16} /> },
    ],
  },
  {
    heading: 'Notifications & Safety',
    items: [
      { id: 'notifications', label: 'Notifications', icon: <Bell size={16} /> },
      { id: 'data-privacy', label: 'Data Controls', icon: <Shield size={16} /> },
      { id: 'family-center', label: 'Family Hub', icon: <Users size={16} /> },
    ],
  },
  {
    heading: 'Premium & Billing',
    items: [
      { id: 'howl-pro', label: 'Howl Pro', icon: <Crown size={16} /> },
      { id: 'server-boost', label: 'Server Power-ups', icon: <Rocket size={16} /> },
      { id: 'subscriptions', label: 'Plans', icon: <Receipt size={16} /> },
      { id: 'gift-inventory', label: 'Gifts & Codes', icon: <Gift size={16} /> },
      { id: 'billing', label: 'Payment', icon: <CreditCard size={16} /> },
    ],
  },
  {
    heading: 'Preferences',
    items: [
      { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
      { id: 'accessibility', label: 'Accessibility', icon: <Accessibility size={16} /> },
      { id: 'voice-video', label: 'Voice & Video', icon: <Headphones size={16} /> },
      { id: 'chat', label: 'Messages', icon: <Type size={16} /> },
      { id: 'keybinds', label: 'Shortcuts', icon: <Keyboard size={16} /> },
      { id: 'game-overlay', label: 'Game Overlay', icon: <Crosshair size={16} /> },
      { id: 'streamdeck', label: 'Stream Deck', icon: <Grid3X3 size={16} /> },
      { id: 'language-time', label: 'Language & Time', icon: <Languages size={16} /> },
      { id: 'streamer-mode', label: 'Broadcast Mode', icon: <MonitorPlay size={16} /> },
      { id: 'advanced', label: 'Advanced', icon: <MoreHorizontal size={16} /> },
    ],
  },
];

/** Map from page ID to i18n translation key for nav labels */
const NAV_LABEL_KEYS: Record<string, string> = {
  'my-account': 'settings.myAccount',
  'content-social': 'settings.socialPrivacy',
  'data-privacy': 'settings.dataPrivacy',
  'authorized-apps': 'settings.authorizedApps',
  'activity-sharing': 'settings.activitySharing',
  'showcase': 'settings.showcase',
  'devices': 'settings.devices',
  'connections': 'settings.connections',
  'notifications': 'settings.notificationsTab',
  'family-center': 'settings.familyCenter',
  'encryption': 'dm.encryption.tabTitle',
  'howl-pro': 'settings.howlPro',
  'server-boost': 'settings.serverBoost',
  'subscriptions': 'settings.subscriptions',
  'gift-inventory': 'settings.giftInventory',
  'billing': 'settings.billing',
  'appearance': 'settings.appearanceTab',
  'accessibility': 'settings.accessibility',
  'voice-video': 'settings.voiceVideoNav',
  'chat': 'settings.chatNav',
  'keybinds': 'settings.keybinds',
  'game-overlay': 'settings.gameOverlay',
  'streamdeck': 'settings.streamDeck',
  'language-time': 'settings.languageTime',
  'streamer-mode': 'settings.streamerMode',
  'advanced': 'settings.advanced',
};

/** Map from heading to i18n translation key */
const NAV_HEADING_KEYS: Record<string, string> = {
  'Account & Security': 'settings.accountSecurity',
  'Profile & Social': 'settings.profileSocial',
  'Notifications & Safety': 'settings.notificationsSafety',
  'Premium & Billing': 'settings.premiumBilling',
  'Preferences': 'settings.preferences',
  'Privacy': 'settings.privacy',
};

export const AccountView: React.FC<AccountViewProps> = React.memo(({ user, onLogout, onUserUpdate, onClose, statusBarDocked, navTopInset = 0, servers = [], initialPage, initialSubTab, initialProfileServerId, onKeybindPageActive, backgroundImage, onBackgroundImageChange, backgroundOpacity = 0.15, onBackgroundOpacityChange, backgroundBlur = 0, onBackgroundBlurChange, bgGifAlwaysPlay = false, onBgGifAlwaysPlayChange, showToast }) => {
  const {
    theme: currentTheme, setTheme: onThemeChange,
    uiDensity: propUiDensity, setUiDensity: onUiDensityChange,
    chatMessageDisplay: propChatMessageDisplay, setChatMessageDisplay: onChatMessageDisplayChange,
    messageGroupSpacing, setMessageGroupSpacing: onMessageGroupSpacingChange,
    chatFontSize, setChatFontSize: onChatFontSizeChange,
    zoomLevel, setZoomLevel: onZoomLevelChange,
    voiceSettings, updateVoice: onVoiceSettingsChange,
  } = useSettings();
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [activePage, setActivePage] = useState<PageId>((initialPage as PageId) || 'my-account');
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBlurTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const searchResults = useSettingsSearch(searchQuery);
  // Self-host instances with billing disabled hide the entire Premium & Billing
  // category. Default-permissive: when instanceConfig is null (hosted / older
  // backend) billingVisible returns true and the category renders unchanged.
  const showBilling = billingVisible(useAppStore(s => s.instanceConfig));
  const navCategories = showBilling
    ? NAV_CATEGORIES
    : NAV_CATEGORIES.filter((cat) => cat.heading !== 'Premium & Billing');

  useEffect(() => {
    onKeybindPageActive?.(activePage === 'keybinds');
    return () => onKeybindPageActive?.(false);
  }, [activePage, onKeybindPageActive]);

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialPage) setActivePage(initialPage as PageId);
  }, [initialPage]);

  useEffect(() => {
    contentScrollRef.current?.scrollTo(0, 0);
  }, [activePage]);

  const [subscription, setSubscription] = useState<{ plan: string | null; status: string | null; currentPeriodEnd: string | null } | null>(null);

  useEffect(() => {
    if (activePage === 'howl-pro' || activePage === 'subscriptions' || activePage === 'billing' || activePage === 'my-account' || activePage === 'appearance' || activePage === 'voice-video') {
      apiClient.getSubscription().then(setSubscription).catch(() => setSubscription(null));
    }
  }, [activePage]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);
  const resize = useCallback((e: MouseEvent) => {
    if (!isResizing.current || !sidebarRef.current) return;
    const sidebarLeft = sidebarRef.current.getBoundingClientRect().left;
    setSidebarWidth(Math.min(Math.max(e.clientX - sidebarLeft, 200), 340));
  }, []);
  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    return () => { window.removeEventListener('mousemove', resize); window.removeEventListener('mouseup', stopResizing); };
  }, [resize, stopResizing]);

  const navigateToPage = useCallback((page: string) => setActivePage(page as PageId), []);

  const onSearchSelect = useCallback((entry: SettingEntry) => {
    setActivePage(entry.tab as PageId);
    setSearchQuery('');
    setSearchOpen(false);
    setMobileSidebarOpen(false);
    // Give React time to render the new tab before scrolling to the anchor
    setTimeout(() => {
      const el = document.getElementById(`setting-${entry.id}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('setting-search-highlight');
      setTimeout(() => el.classList.remove('setting-search-highlight'), 2000);
    }, 80);
  }, []);

  const handleSearchFocus = useCallback(() => {
    if (searchBlurTimer.current) clearTimeout(searchBlurTimer.current);
    setSearchOpen(true);
  }, []);

  const handleSearchBlur = useCallback(() => {
    searchBlurTimer.current = setTimeout(() => setSearchOpen(false), 200);
  }, []);

  const renderAppearance = () => (
    <AppearanceTab
      user={user}
      isMobile={isMobile}
      currentTheme={currentTheme}
      onThemeChange={onThemeChange}
      uiDensity={propUiDensity}
      onUiDensityChange={onUiDensityChange}
      chatMessageDisplay={propChatMessageDisplay}
      onChatMessageDisplayChange={onChatMessageDisplayChange}
      messageGroupSpacing={messageGroupSpacing}
      onMessageGroupSpacingChange={onMessageGroupSpacingChange}
      chatFontSize={chatFontSize}
      onChatFontSizeChange={onChatFontSizeChange}
      zoomLevel={zoomLevel}
      onZoomLevelChange={onZoomLevelChange}
      backgroundImage={backgroundImage}
      onBackgroundImageChange={onBackgroundImageChange}
      backgroundOpacity={backgroundOpacity}
      onBackgroundOpacityChange={onBackgroundOpacityChange}
      backgroundBlur={backgroundBlur}
      onBackgroundBlurChange={onBackgroundBlurChange}
      bgGifAlwaysPlay={bgGifAlwaysPlay}
      onBgGifAlwaysPlayChange={onBgGifAlwaysPlayChange}
      subscription={subscription}
    />
  );

  const renderPageContent = () => {
    switch (activePage) {
      case 'my-account':
        return <MyAccountTab user={user} onUserUpdate={onUserUpdate} onLogout={onLogout} servers={servers} subscription={subscription} initialSubTab={initialSubTab} initialProfileServerId={initialProfileServerId} showToast={showToast} />;
      case 'appearance':
        return renderAppearance();
      case 'voice-video':
        return <VoiceVideoTab voiceSettings={voiceSettings} onVoiceSettingsChange={onVoiceSettingsChange} subscription={subscription} />;
      case 'content-social':
        return <SocialPrivacyTab servers={servers} currentUser={user} />;
      case 'data-privacy':
        return <DataControlsTab user={user} />;
      case 'authorized-apps':
        return <LinkedAppsTab />;
      case 'activity-sharing':
        return <ActivitySharingTab onNavigate={navigateToPage} />;
      case 'showcase':
        return <ShowcaseTab userId={user.id} />;
      case 'devices':
        return <SessionsTab />;
      case 'connections':
        return <ConnectionsTab />;
      case 'notifications':
        return <NotificationsTab onNavigate={navigateToPage} />;
      case 'howl-pro':
        return <BillingTab user={user} onNavigate={navigateToPage} />;
      case 'server-boost':
        return <ServerUpgradesTab onNavigate={navigateToPage} />;
      case 'subscriptions':
        return <SubscriptionsTab onNavigate={navigateToPage} />;
      case 'gift-inventory':
        return <GiftInventoryTab />;
      case 'billing':
        return <PaymentTab onNavigate={navigateToPage} />;
      case 'accessibility':
        return <AccessibilityTab />;
      case 'chat':
        return <ChatTab />;
      case 'keybinds':
        return <KeybindsTab />;
      case 'game-overlay':
        return <GameOverlayTab />;
      case 'streamdeck':
        return <StreamDeckTab />;
      case 'language-time':
        return <LanguageTimeTab />;
      case 'streamer-mode':
        return <StreamerModeTab />;
      case 'advanced':
        return <AdvancedTab />;
      // Activity privacy settings are in SocialPrivacyTab and LinkedAppsTab
      case 'family-center':
        return <FamilyCenterTab user={user} />;
      case 'encryption':
        return <EncryptionTab user={user} />;
      default:
        return <MyAccountTab user={user} onUserUpdate={onUserUpdate} onLogout={onLogout} servers={servers} subscription={subscription} initialSubTab={initialSubTab} initialProfileServerId={initialProfileServerId} showToast={showToast} />;
    }
  };

  return (
    <div className={`flex-1 flex overflow-hidden animate-in fade-in duration-500 ${isMobile ? 'p-0 gap-0 flex-col' : 'p-4 gap-4'}`} style={{ backgroundColor: 'var(--bg-chat)' }}>

      {/* Mobile header with menu toggle */}
      {isMobile && (
        <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-panel)' }}>
          <button type="button" onClick={() => setMobileSidebarOpen((v) => !v)} className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider" style={{ color: 'var(--cyan-accent)' }}>
            <Menu size={18} />
            <span>{t('common.settings')}</span>
          </button>
          <button type="button" onClick={() => onClose?.()} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Mobile sidebar overlay */}
      {/* Mobile settings sidebar overlay */}
      {isMobile && (
        <div
          className="fixed inset-0 z-[var(--z-overlay)] flex"
          style={{ visibility: mobileSidebarOpen ? 'visible' : 'hidden', transitionProperty: 'visibility', transitionDuration: '0ms', transitionDelay: mobileSidebarOpen ? '0ms' : '300ms' }}
          onClick={() => setMobileSidebarOpen(false)}
        >
          <div
            className="absolute inset-0 transition-opacity duration-300"
            style={{ backgroundColor: 'var(--overlay-backdrop)', opacity: mobileSidebarOpen ? 1 : 0 }}
          />
          <div
            className="relative w-[min(240px,70vw)] h-full flex flex-col safe-area-bottom safe-area-left safe-area-top transition-transform duration-300 ease-out"
            style={{ backgroundColor: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-subtle)', transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)', boxShadow: mobileSidebarOpen ? '4px 0 24px rgba(0,0,0,0.4)' : 'none' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-14 flex items-center justify-between px-4 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
              <span className="flex items-center gap-2 text-xs font-black uppercase tracking-wider" style={{ color: 'var(--cyan-accent)' }}>
                <Settings size={14} /> Configuration
              </span>
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-fill-active"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-2 border-b shrink-0 relative" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] transition-colors focus-within:border-[var(--cyan-accent)]/30 focus-within:ring-1 focus-within:ring-[var(--cyan-accent)]/20" style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)' }}>
                <Search size={14} className="shrink-0 text-t-secondary" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={handleSearchFocus}
                  onBlur={handleSearchBlur}
                  placeholder={t('settings.searchSettings')}
                  className="flex-1 min-w-0 bg-transparent border-none outline-none placeholder:text-t-secondary"
                  style={{ color: 'var(--text-primary)' }}
                />
              </div>
              {searchOpen && searchQuery.trim() && (
                <SettingsSearchResults results={searchResults} onSelect={onSearchSelect} onClose={() => { setSearchOpen(false); setSearchQuery(''); }} />
              )}
            </div>
            <div className="flex-1 overflow-y-auto py-4 px-2 pb-24 min-h-0">
              {navCategories.map((cat) => (
                <div key={cat.heading} className="mb-4">
                  <p className="text-[11px] font-medium uppercase px-3 mb-2" style={{ color: 'var(--cyan-accent)', opacity: 0.7 }}>{t(NAV_HEADING_KEYS[cat.heading] ?? cat.heading, cat.heading)}</p>
                  {cat.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { setActivePage(item.id as PageId); setMobileSidebarOpen(false); }}
                      className={`w-full flex items-center px-3 py-2.5 rounded-xl text-left transition-all mb-0.5 ${activePage === item.id ? 'btn-cta-selected' : 'hover:bg-fill-hover'}`}
                      style={activePage === item.id ? undefined : { color: 'var(--text-secondary)' }}
                    >
                      <span className="mr-3" style={{ color: activePage === item.id ? '#fff' : undefined }}>{item.icon}</span>
                      <span className="text-[11px] font-bold uppercase tracking-wider truncate">{t(NAV_LABEL_KEYS[item.id] ?? item.id, item.label)}</span>
                    </button>
                  ))}
                </div>
              ))}
              <div className="pt-4 px-3 border-t mt-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <button onClick={() => { setShowLogoutModal(true); setMobileSidebarOpen(false); }} className="flex items-center text-red-500/60 hover:text-red-400 text-[10px] font-semibold">
                  <LogOut size={14} className="mr-3" /> {t('settings.logout')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating TOC Sidebar (Configuration / Navigation_Tree) - desktop only */}
      {!isMobile && (
      <div
        ref={sidebarRef}
        style={{ width: `${sidebarWidth}px`, backgroundColor: 'var(--bg-panel)', marginTop: navTopInset || undefined }}
        className="relative flex flex-col shrink-0 border border-default rounded-2xl transition-[width] duration-75 ease-out overflow-hidden shadow-2xl backdrop-blur-xl"
      >
        <div className="h-16 flex items-center px-6 border-b border-default bg-fill-hover shrink-0">
          <span className="text-[var(--cyan-accent)] font-black text-[10px] uppercase tracking-[0.3em] opacity-80 flex items-center">
            <Settings size={14} className="mr-2" /> Configuration
          </span>
        </div>

        {/* Search bar below Configuration heading */}
        <div className="p-3 border-b border-default shrink-0 relative">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-default text-[11px] transition-colors focus-within:border-[var(--cyan-accent)]/30 focus-within:ring-1 focus-within:ring-[var(--cyan-accent)]/20" style={{ backgroundColor: 'var(--bg-input)' }}>
            <Search size={14} className="shrink-0 text-t-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
              placeholder={t('settings.searchSettings')}
              className="flex-1 min-w-0 bg-transparent border-none outline-none placeholder:text-t-secondary"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
          {searchOpen && searchQuery.trim() && (
            <SettingsSearchResults results={searchResults} onSelect={onSearchSelect} onClose={() => { setSearchOpen(false); setSearchQuery(''); }} />
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 pb-6 space-y-1 min-h-0" style={statusBarDocked ? { paddingBottom: 80 } : undefined}>
          {navCategories.map((cat) => (
              <div key={cat.heading} className="mb-4">
                <p className="px-3 py-1.5 text-[11px] font-medium uppercase ml-1 mb-1" style={{ color: 'var(--cyan-accent)', opacity: 0.7 }}>
                  {t(NAV_HEADING_KEYS[cat.heading] ?? cat.heading, cat.heading)}
                </p>
                {cat.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActivePage(item.id)}
                    className={`w-full flex items-center px-4 py-3 rounded-xl transition-all group ${
                      activePage === item.id
                        ? 'btn-cta-selected'
                        : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary'
                    }`}
                  >
                    <span className={`mr-3 transition-colors ${activePage === item.id ? 'text-white' : 'text-t-secondary group-hover:text-t-primary'}`}>
                      {item.icon}
                    </span>
                    <span className="text-[11px] font-semibold truncate">{t(NAV_LABEL_KEYS[item.id] ?? item.id, item.label)}</span>
                  </button>
                ))}
              </div>
          ))}

          <div className="pt-8 px-3 border-t border-default mt-8">
            <button
              onClick={() => setShowLogoutModal(true)}
              className="flex items-center text-red-500/60 hover:text-red-400 transition-all text-[10px] font-semibold group"
            >
              <LogOut size={14} className="mr-3 group-hover:-translate-x-1 transition-transform" />
              {t('settings.logout')}
            </button>
          </div>
        </div>

        {/* Resize Handle */}
        <div
          onMouseDown={startResizing}
          className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-[var(--cyan-accent)]/20 active:bg-[var(--cyan-accent)]/40 transition-colors z-50 group"
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-fill-active rounded-full group-hover:bg-[var(--cyan-accent)]/40" />
        </div>
      </div>
      )}

      {/* Main Content Area */}
      <div className={`flex-1 flex overflow-hidden min-h-0 ${isMobile ? 'gap-0' : 'gap-4'}`}>
        <div
          ref={contentScrollRef}
          className={`flex-1 overflow-y-auto scroll-smooth min-w-0 ${isMobile ? '' : 'border border-default rounded-2xl shadow-inner'}`}
          style={{ backgroundColor: 'var(--bg-chat)' }}
        >
          <div className={isMobile ? 'p-4 pb-28' : 'p-8'} style={statusBarDocked && !isMobile ? { paddingBottom: 96 } : undefined}>
            {renderPageContent()}
          </div>
        </div>

        {/* Close button column - desktop only */}
        {!isMobile && (
        <div className="w-14 shrink-0 flex flex-col items-center pt-8" style={{ backgroundColor: 'var(--bg-chat)' }}>
          <button
            type="button"
            onClick={() => onClose?.()}
            className="w-9 h-9 rounded-full border border-[var(--border-strong)] flex items-center justify-center transition-all hover:border-[var(--border-strong)] hover:bg-fill-hover group"
          >
            <X size={18} className="transition-colors" style={{ color: 'var(--text-secondary)' }} />
          </button>
          <p className="text-[9px] font-bold uppercase tracking-widest mt-2" style={{ color: 'var(--text-secondary)' }}>ESC</p>
        </div>
        )}
      </div>
      {showLogoutModal && (
        <LogoutConfirmModal
          onConfirm={(keepKeys) => { setShowLogoutModal(false); onLogout?.(keepKeys); }}
          onCancel={() => setShowLogoutModal(false)}
        />
      )}
    </div>
  );
});
