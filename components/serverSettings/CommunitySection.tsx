// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Heart, Check, X, Upload, Plus, AlertTriangle, ExternalLink, Loader2, Globe } from 'lucide-react';
import { Server, serverHasPerm } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import type { CommunityConfig, CommunityEligibility, VanityCheckResult } from '../../services/api/community';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { getBackendOrigin } from '../../config';
import {
  SectionHeader,
  Card,
  Toggle,
  SelectField,
  SettingRow,
  EmptyState,
} from '../settings/SettingsWidgets';
import { Modal, ModalBody, ModalFooter } from '../ui/modal';
import { Button } from '../ui/button';
import { DiscoveryEligibilityPanel } from './DiscoveryEligibilityPanel';
import { VerificationRequestSection } from './VerificationRequestSection';

// Static data (will move to backend `/discover/categories`)
const CATEGORY_OPTIONS = [
  { value: 'gaming', labelKey: 'communitySection.catGaming', label: 'Gaming' },
  { value: 'music', labelKey: 'communitySection.catMusic', label: 'Music' },
  { value: 'education', labelKey: 'communitySection.catEducation', label: 'Education' },
  { value: 'science_tech', labelKey: 'communitySection.catScienceTech', label: 'Science & Tech' },
  { value: 'entertainment', labelKey: 'communitySection.catEntertainment', label: 'Entertainment' },
  { value: 'art', labelKey: 'communitySection.catArt', label: 'Art' },
  { value: 'lifestyle', labelKey: 'communitySection.catLifestyle', label: 'Lifestyle' },
  { value: 'sports', labelKey: 'communitySection.catSports', label: 'Sports' },
  { value: 'finance', labelKey: 'communitySection.catFinance', label: 'Finance' },
  { value: 'community', labelKey: 'communitySection.catCommunity', label: 'Community' },
  { value: 'other', labelKey: 'communitySection.catOther', label: 'Other' },
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'it', label: 'Italiano' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'ru', label: 'Русский' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '中文' },
  { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'tr', label: 'Türkçe' },
];

const TAG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Vanity slug must be 3–32 chars, start and end with alphanumeric, only
 * lowercase letters, digits, or single dashes inside. Validated character
 * by character to avoid superlinear regex backtracking on hostile input.
 */
function isValidVanitySlug(s: string): boolean {
  if (s.length < 3 || s.length > 32) return false;
  if (!/^[a-z0-9]/.test(s)) return false;
  if (!/[a-z0-9]$/.test(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isLower = c >= 97 && c <= 122; // a-z
    const isDigit = c >= 48 && c <= 57;  // 0-9
    const isDash = c === 45;             // -
    if (!isLower && !isDigit && !isDash) return false;
  }
  if (s.includes('--')) return false;
  return true;
}

function normalizeTag(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export interface CommunitySectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onOpenAccountSettings?: () => void;
}

export const CommunitySection: React.FC<CommunitySectionProps> = ({ server, showToast, onOpenAccountSettings }) => {
  const { t } = useTranslation();

  // Discovery x Age-Restriction mutual exclusion
  // If any channel in the server has ageRestricted=true, discovery must be
  // disabled. Compute from the server's channel list (already in props).
  const hasAgeRestrictedChannels = useMemo(
    () => (server.channels ?? []).some((c) => c.ageRestricted === true),
    [server.channels],
  );

  // Permission gate
  const canManage = serverHasPerm(server, 'manageServer');

  // Data
  const [eligibility, setEligibility] = useState<CommunityEligibility | null>(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(true);
  const [config, setConfig] = useState<CommunityConfig | null>(null);
  const [savingEnabled, setSavingEnabled] = useState(false);
  // Bumped after any save that could change discovery eligibility (longDescription,
  // bannerSplash, community-mode toggle, settings PATCH). The
  // DiscoveryEligibilityPanel re-fetches on increment so owners see eligibility
  // flip green seconds after the save lands instead of waiting for the 5-min
  // Redis TTL.
  const [discoveryEligibilityRefreshKey, setDiscoveryEligibilityRefreshKey] = useState(0);
  const bumpDiscoveryEligibility = useCallback(() => {
    setDiscoveryEligibilityRefreshKey((n) => n + 1);
  }, []);

  // Rules channel designation (server settings, not community config).
  const [rulesChannelId, setRulesChannelId] = useState<string | null>(null);
  const [savingChannelDesignation, setSavingChannelDesignation] = useState(false);

  // Text channels available for designation. Voice/stage/forum channels are
  // not eligible — rules/updates pages need to render messages.
  const textChannels = useMemo(
    () => (server.channels ?? []).filter((c) => c.type === 'text'),
    [server.channels],
  );

  const refreshEligibility = useCallback(async () => {
    if (!canManage) return;
    setEligibilityLoading(true);
    try {
      const next = await apiClient.serverCommunityEligibility(server.id);
      setEligibility(next);
    } catch (e) {
      // Network/server error — surface as toast but keep prior eligibility
      const msg = e instanceof Error ? e.message : t('communitySection.eligibilityError', { defaultValue: 'Failed to load eligibility' });
      showToast(msg, 'error');
    } finally {
      setEligibilityLoading(false);
    }
  }, [canManage, server.id, showToast, t]);

  const refreshConfig = useCallback(async () => {
    if (!canManage) return;
    // Prefer the canonical GET /community projection which includes
    // vanityUrl/discoverableSince — fields that don't live on the
    // ServerSettings row. Fall back to ServerSettings if the new endpoint
    // isn't deployed yet (404). The two reads are independent: ServerSettings
    // is needed regardless for rules/updates channel designations.
    const [canonicalSettled, rawSettled] = await Promise.all([
      apiClient.serverCommunityGet(server.id).then(
        (v) => ({ ok: true as const, value: v }),
        (e: { status?: number } | unknown) => {
          const status = (e as { status?: number } | undefined)?.status;
          if (status === 404 || status === 501) return { ok: false as const };
          throw e;
        },
      ),
      apiClient.getServerSettings(server.id).catch(() => null),
    ]);

    const raw = rawSettled as
      | (Awaited<ReturnType<typeof apiClient.getServerSettings>> & {
          category?: string | null;
          subcategory?: string | null;
          tags?: unknown;
          language?: string | null;
          longDescription?: string | null;
          bannerSplash?: string | null;
          discoverableSince?: string | null;
        })
      | null;
    setRulesChannelId(raw?.rulesChannelId ?? null);

    if (canonicalSettled.ok) {
      setConfig(canonicalSettled.value);
      return;
    }

    // Legacy fallback path. `vanityUrl` lives on Server, not ServerSettings —
    // seed it from the `server` prop on first load (prev === null). On
    // subsequent refreshes, trust `prev` since claim+release handlers update
    // `prev` directly.
    const serverWithVanity = server as Server & { vanityUrl?: string | null };
    setConfig((prev) => {
      const next: CommunityConfig = {
        communityEnabled: raw?.communityEnabled ?? false,
        discoveryEnabled: raw?.discoveryEnabled ?? false,
        category: raw?.category ?? null,
        subcategory: raw?.subcategory ?? null,
        tags: Array.isArray(raw?.tags) ? (raw.tags as string[]) : [],
        language: raw?.language ?? 'en',
        longDescription: raw?.longDescription ?? null,
        bannerSplash: raw?.bannerSplash ?? null,
        vanityUrl: prev ? prev.vanityUrl : (serverWithVanity.vanityUrl ?? null),
        vanityChangeEligibleAt: prev?.vanityChangeEligibleAt ?? null,
        discoverableSince: raw?.discoverableSince ?? null,
      };
      return prev ? { ...prev, ...next } : next;
    });
  }, [canManage, server]);

  useEffect(() => {
    refreshEligibility();
    refreshConfig();
  }, [refreshEligibility, refreshConfig]);

  // Live sync: another admin enabling/disabling community or updating discovery
  // config emits `server-community-updated` to the server room. Refetch the
  // canonical config so the form reflects their changes without a refresh.
  useEffect(() => {
    if (!canManage) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      refreshConfig();
      refreshEligibility();
    };
    sock.on('server-community-updated', handler);
    return () => { sock.off('server-community-updated', handler); };
  }, [canManage, server.id, refreshConfig, refreshEligibility]);

  // Refresh eligibility on window focus so the checklist reflects newly-met
  // requirements (e.g. owner just enabled MFA in another tab).
  useEffect(() => {
    const onFocus = () => { refreshEligibility(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshEligibility]);

  // Form state (only edited once enabled)
  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [language, setLanguage] = useState('en');
  const [longDescription, setLongDescription] = useState('');
  const [bannerSplash, setBannerSplash] = useState<string | null>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [savingForm, setSavingForm] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const bannerFileInputRef = useRef<HTMLInputElement>(null);

  // Initial hydrate from config — do this only once. After that, the form
  // fields are authoritative; external config changes (e.g. another admin
  // editing) won't clobber an in-flight edit. Auto-save (effect below) keeps
  // server in sync.
  const initialHydrateDoneRef = useRef(false);
  const lastSavedFormRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config || initialHydrateDoneRef.current) return;
    initialHydrateDoneRef.current = true;
    setCategory(config.category ?? '');
    setSubcategory(config.subcategory ?? '');
    setTags(Array.isArray(config.tags) ? config.tags : []);
    setLanguage(config.language ?? 'en');
    setLongDescription(config.longDescription ?? '');
    setBannerSplash(config.bannerSplash);
    lastSavedFormRef.current = JSON.stringify([
      config.category ?? '',
      (config.subcategory ?? '').trim(),
      Array.isArray(config.tags) ? config.tags : [],
      config.language ?? 'en',
      (config.longDescription ?? '').trim(),
      config.bannerSplash,
    ]);
  }, [config]);

  // Vanity URL
  const [vanityDraft, setVanityDraft] = useState('');
  const [vanityCheck, setVanityCheck] = useState<VanityCheckResult | null>(null);
  const [vanityChecking, setVanityChecking] = useState(false);
  const [vanitySaving, setVanitySaving] = useState(false);
  const vanityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Slug pending confirmation in the type-to-confirm modal. Null when no
  // claim is in progress; the modal mounts iff this is non-null.
  const [vanityConfirmSlug, setVanityConfirmSlug] = useState<string | null>(null);

  useEffect(() => {
    setVanityDraft(config?.vanityUrl ?? '');
  }, [config?.vanityUrl]);

  useEffect(() => {
    if (vanityDebounceRef.current) clearTimeout(vanityDebounceRef.current);
    const slug = vanityDraft.trim().toLowerCase();
    if (!slug || slug === (config?.vanityUrl ?? '')) {
      setVanityCheck(null);
      setVanityChecking(false);
      return;
    }
    if (!isValidVanitySlug(slug)) {
      setVanityCheck({ slug, available: false, reason: 'invalid' });
      setVanityChecking(false);
      return;
    }
    setVanityChecking(true);
    vanityDebounceRef.current = setTimeout(async () => {
      try {
        const result = await apiClient.vanityCheck(slug);
        setVanityCheck(result);
      } catch {
        setVanityCheck({ slug, available: false, reason: 'invalid' });
      } finally {
        setVanityChecking(false);
      }
    }, 350);
    return () => {
      if (vanityDebounceRef.current) clearTimeout(vanityDebounceRef.current);
    };
  }, [vanityDraft, config?.vanityUrl]);

  // Click handler for the Claim button: instead of submitting straight to
  // the backend, stage the slug in the type-to-confirm modal so the owner
  // is forced to acknowledge the 30-day cooldown before committing.
  const handleVanityClaim = useCallback(() => {
    const slug = vanityDraft.trim().toLowerCase();
    if (!slug || vanityCheck?.available === false) return;
    setVanityConfirmSlug(slug);
  }, [vanityDraft, vanityCheck]);

  // Actual API submit, fired only from the modal once the user has retyped
  // their slug. Refreshes the canonical config on success so the freshly
  // armed cooldown shows up in the UI immediately.
  const submitVanityClaim = useCallback(async (slug: string) => {
    setVanitySaving(true);
    try {
      await apiClient.serverVanityClaim(server.id, slug);
      setConfig((prev) => (prev ? { ...prev, vanityUrl: slug } : prev));
      void refreshConfig();
      setVanityConfirmSlug(null);
      showToast(t('communitySection.vanityClaimed', { defaultValue: 'Vanity URL claimed' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('communitySection.vanityClaimFailed', { defaultValue: 'Failed to claim vanity URL' }), 'error');
    } finally {
      setVanitySaving(false);
    }
  }, [server.id, refreshConfig, showToast, t]);

  const handleVanityRelease = useCallback(async () => {
    setVanitySaving(true);
    try {
      await apiClient.serverVanityRelease(server.id);
      setConfig((prev) => (prev ? { ...prev, vanityUrl: null } : prev));
      setVanityDraft('');
      showToast(t('communitySection.vanityReleased', { defaultValue: 'Vanity URL released' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('communitySection.vanityReleaseFailed', { defaultValue: 'Failed to release vanity URL' }), 'error');
    } finally {
      setVanitySaving(false);
    }
  }, [server.id, showToast, t]);

  // Tags
  const addTag = useCallback((raw: string) => {
    const normalized = normalizeTag(raw);
    if (!normalized) {
      setTagError(t('communitySection.tagInvalid', { defaultValue: 'Tags must use letters, numbers, or dashes' }));
      return;
    }
    if (!TAG_PATTERN.test(normalized) || normalized.length < 2) {
      setTagError(t('communitySection.tagTooShort', { defaultValue: 'Tag must be at least 2 characters' }));
      return;
    }
    if (tags.includes(normalized)) {
      setTagError(t('communitySection.tagDuplicate', { defaultValue: 'Tag already added' }));
      return;
    }
    if (tags.length >= 5) {
      setTagError(t('communitySection.tagsMax', { defaultValue: 'Maximum of 5 tags' }));
      return;
    }
    setTags((prev) => [...prev, normalized]);
    setTagDraft('');
    setTagError(null);
  }, [tags, t]);

  const removeTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((x) => x !== tag));
    setTagError(null);
  }, []);

  // Banner splash upload
  const handleBannerUpload = useCallback(async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      showToast(t('communitySection.fileTooLarge', { defaultValue: 'File too large' }), 'error');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      showToast(t('communitySection.unsupportedImageType', { defaultValue: 'Unsupported image type' }), 'error');
      return;
    }
    setBannerUploading(true);
    try {
      const r = await apiClient.uploadFile(file);
      const url = r.url.startsWith('/') ? getBackendOrigin() + r.url : r.url;
      setBannerSplash(url);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('communitySection.uploadFailed', { defaultValue: 'Upload failed' }), 'error');
    } finally {
      setBannerUploading(false);
    }
  }, [showToast, t]);

  // Save / enable / disable
  const handleEnable = useCallback(async () => {
    if (!eligibility?.eligible) return;
    setSavingEnabled(true);
    try {
      // Discovery listing is gated by size/age/activity bars on top of
      // community-mode quality checks. Probe eligibility before sending so
      // ineligible servers enable community mode without 422'ing on the
      // discovery flag — the panel below explains what's needed to get
      // listed publicly. The owner can flip discovery on later via the
      // community PATCH endpoint once eligible.
      const discoveryElig = await apiClient.serverDiscoveryEligibility(server.id);
      // Block discovery when any channel has age-restriction enabled
      // (mutual-exclusion constraint — backend rejects too, but we mirror here).
      const canEnableDiscovery = discoveryElig.eligible && !hasAgeRestrictedChannels;
      const updated = await apiClient.serverCommunityEnable(server.id, {
        discoveryEnabled: canEnableDiscovery,
      });
      setConfig((prev) => (prev ? { ...prev, ...updated } : updated));
      showToast(
        discoveryElig.eligible
          ? t('communitySection.enabled', { defaultValue: 'Community mode enabled' })
          : t('communitySection.enabledNoDiscovery', {
              defaultValue: 'Community mode enabled. Server isn\'t yet eligible for Discover.',
            }),
      );
      bumpDiscoveryEligibility();
      await Promise.all([refreshConfig(), refreshEligibility()]);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('communitySection.enableFailed', { defaultValue: 'Failed to enable community mode' }), 'error');
    } finally {
      setSavingEnabled(false);
    }
  }, [eligibility, server.id, hasAgeRestrictedChannels, showToast, t, refreshConfig, refreshEligibility, bumpDiscoveryEligibility]);

  const handleDisable = useCallback(async () => {
    setSavingEnabled(true);
    try {
      const updated = await apiClient.serverCommunityDisable(server.id);
      setConfig((prev) => (prev ? { ...prev, ...updated } : updated));
      showToast(t('communitySection.disabled', { defaultValue: 'Community mode disabled' }));
      bumpDiscoveryEligibility();
      await Promise.all([refreshConfig(), refreshEligibility()]);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('communitySection.disableFailed', { defaultValue: 'Failed to disable community mode' }), 'error');
    } finally {
      setSavingEnabled(false);
    }
  }, [server.id, showToast, t, refreshConfig, refreshEligibility, bumpDiscoveryEligibility]);

  // Vanity URLs are a community-tier perk: the owner can claim one only
  // after every other quality check passes (eligible to enable community
  // mode), or once community mode is already enabled. Releasing an existing
  // slug stays open regardless of state — handled separately by VanityField.
  const isCommunityEligible = (eligibility?.eligible ?? false) || (config?.communityEnabled === true);

  // Days remaining on the 30-day cooldown before another vanity-URL claim
  // can succeed. 0 when no cooldown is active. Compute from the ISO string
  // the backend ships in `config.vanityChangeEligibleAt` so client clock
  // skew shows up consistently here and in the cooldown banner copy.
  const vanityCooldownDays = (() => {
    const iso = config?.vanityChangeEligibleAt;
    if (!iso) return 0;
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 0;
    return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  })();
  const canClaimVanity = isCommunityEligible && vanityCooldownDays === 0;

  // Auto-save the community form on a debounce. No more "Save Changes" button —
  // every field change schedules a save 800ms after the last edit. Vanity slug
  // is intentionally NOT included here: claims arm a 30-day cooldown and must
  // go through the explicit Claim button + type-to-confirm modal.
  useEffect(() => {
    if (!config || lastSavedFormRef.current === null) return;
    if (longDescription.length > 4096) return; // user will see length counter; don't try to save invalid
    const current = JSON.stringify([
      category,
      subcategory.trim(),
      tags,
      language,
      longDescription.trim(),
      bannerSplash,
    ]);
    if (current === lastSavedFormRef.current) return;

    const timer = setTimeout(async () => {
      setSavingForm(true);
      try {
        const updated = await apiClient.serverCommunityUpdate(server.id, {
          category: category || null,
          subcategory: subcategory.trim() || null,
          tags,
          language,
          longDescription: longDescription.trim() || null,
          bannerSplash,
        });
        lastSavedFormRef.current = current;
        setConfig((prev) => (prev ? { ...prev, ...updated } : updated));
        bumpDiscoveryEligibility();
      } catch (e) {
        showToast(e instanceof Error ? e.message : t('communitySection.saveFailed', { defaultValue: 'Failed to save' }), 'error');
      } finally {
        setSavingForm(false);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [category, subcategory, tags, language, longDescription, bannerSplash, config, server.id, showToast, t, bumpDiscoveryEligibility]);

  // Permission gate
  if (!canManage) {
    return (
      <div className="max-w-2xl">
        <SectionHeader title={t('serverSettings.communityHub')} desc={t('serverSettings.communityHubDesc')} icon={<Heart size={24} />} />
        <EmptyState icon={<Heart size={40} />}
          title={t('communitySection.noPermission', { defaultValue: 'You don\'t have permission to manage community features.' })}
          desc={t('communitySection.noPermissionDesc', { defaultValue: 'Ask a server admin with the Manage Server permission to configure this.' })} />
      </div>
    );
  }

  const communityEnabled = config?.communityEnabled ?? false;

  // Channel designation save
  const saveChannelDesignation = useCallback(async (patch: { rulesChannelId?: string | null }) => {
    setSavingChannelDesignation(true);
    try {
      await apiClient.updateServerSettings(server.id, patch);
      if ('rulesChannelId' in patch) setRulesChannelId(patch.rulesChannelId ?? null);
      void refreshEligibility();
      // Channel designation feeds community_eligible, which gates discovery
      // eligibility. Re-fetch so the panel below reflects the new state.
      bumpDiscoveryEligibility();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('communitySection.channelDesignationFailed', { defaultValue: 'Failed to update channel designation' });
      showToast(msg, 'error');
    } finally {
      setSavingChannelDesignation(false);
    }
  }, [server.id, refreshEligibility, showToast, t, bumpDiscoveryEligibility]);

  const channelDesignationCardRef = useRef<HTMLDivElement | null>(null);
  const scrollToChannelDesignation = useCallback(() => {
    channelDesignationCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Scroll targets for the public-listing metadata checks. Each ref points at
  // the field whose value gates the matching eligibility check, so the
  // "Pick category" / "Add tag" / etc. CTAs in the checklist can jump the
  // owner straight to the input that's still empty.
  const categoryFieldRef = useRef<HTMLDivElement | null>(null);
  const tagsFieldRef = useRef<HTMLDivElement | null>(null);
  const longDescriptionFieldRef = useRef<HTMLDivElement | null>(null);
  const bannerFieldRef = useRef<HTMLDivElement | null>(null);
  const vanityFieldRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Eligibility CTA mapping
  const ctaForFix = (fix?: string | null): { label: string; onClick: () => void } | null => {
    if (!fix) return null;
    if (fix === 'mfa' && onOpenAccountSettings) {
      return { label: t('communitySection.fixMfa', { defaultValue: 'Enable MFA' }), onClick: onOpenAccountSettings };
    }
    if (fix === 'rulesChannel') {
      return { label: t('communitySection.fixRulesChannel', { defaultValue: 'Pick channel' }), onClick: scrollToChannelDesignation };
    }
    if (fix === 'category') {
      return { label: t('communitySection.fixCategory', { defaultValue: 'Pick category' }), onClick: () => scrollTo(categoryFieldRef) };
    }
    if (fix === 'tags') {
      return { label: t('communitySection.fixTags', { defaultValue: 'Add tag' }), onClick: () => scrollTo(tagsFieldRef) };
    }
    if (fix === 'longDescription') {
      return { label: t('communitySection.fixLongDescription', { defaultValue: 'Write description' }), onClick: () => scrollTo(longDescriptionFieldRef) };
    }
    if (fix === 'bannerSplash') {
      return { label: t('communitySection.fixBannerSplash', { defaultValue: 'Upload banner' }), onClick: () => scrollTo(bannerFieldRef) };
    }
    return null;
  };

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader
        title={t('serverSettings.communityHub')}
        desc={t('communitySection.headerDesc', { defaultValue: 'Open your server up to the world. Configure category, tags, vanity URL, and a public profile.' })}
        icon={<Heart size={24} />}
      />

      {/* ─── Eligibility checklist ──────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-t-primary">{t('communitySection.eligibilityTitle', { defaultValue: 'Community mode requirements' })}</p>
          {eligibilityLoading && <Loader2 size={14} className="animate-spin text-t-secondary" />}
        </div>
        {eligibility && eligibility.checks.length === 0 && !eligibilityLoading && (
          <p className="text-[12px] text-t-secondary">{t('communitySection.eligibilityNoData', { defaultValue: 'Eligibility checks will appear here once the backend is available.' })}</p>
        )}
        <ul className="space-y-2">
          {(eligibility?.checks ?? []).map((c) => {
            const cta = ctaForFix(c.fix);
            return (
              <li key={c.key} className="flex items-start gap-3 py-1.5">
                <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${c.met ? 'bg-emerald-500/20' : 'bg-red-500/15'}`}>
                  {c.met ? <Check size={11} className="text-emerald-400" /> : <X size={11} className="text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-t-primary">{c.label}</p>
                  {c.explanation && <p className="text-[11px] mt-0.5 text-t-secondary">{c.explanation}</p>}
                </div>
                {!c.met && cta && (
                  <button type="button" onClick={cta.onClick}
                    className="btn-secondary text-[11px] px-2.5 py-1 shrink-0">
                    {cta.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {/* ─── Community channel designations ────────────────────────────────── */}
      <div ref={channelDesignationCardRef}>
        <Card>
          <p className="text-sm font-semibold mb-1 text-t-primary">{t('communitySection.channelDesignationsTitle', { defaultValue: 'Rules channel' })}</p>
          <p className="text-[12px] mb-4 text-t-secondary">
            {t('communitySection.channelDesignationsDesc', { defaultValue: 'Pick the text channel that hosts your server rules. This satisfies the rules-channel eligibility check.' })}
          </p>
          {textChannels.length === 0 ? (
            <p className="text-[11px] text-t-secondary">{t('communitySection.channelDesignationsNoChannels', { defaultValue: 'Create at least one text channel to designate it.' })}</p>
          ) : (
            <SelectField
              value={rulesChannelId ?? ''}
              disabled={savingChannelDesignation}
              onChange={(v) => { void saveChannelDesignation({ rulesChannelId: v || null }); }}
              options={[
                { value: '', label: t('communitySection.channelUnset', { defaultValue: 'Not set' }) },
                ...textChannels.map((c) => ({ value: c.id, label: `# ${c.name}` })),
              ]}
            />
          )}
        </Card>
      </div>

      {/* ─── Configuration form (always visible — required to enable) ─────── */}
      <Card>
        <div className="space-y-5">
          <div ref={categoryFieldRef}>
            <SelectField
              label={t('communitySection.categoryLabel', { defaultValue: 'Category' })}
              value={category}
              onChange={setCategory}
              options={[
                { value: '', label: t('communitySection.selectCategory', { defaultValue: 'Select a category…' }) },
                ...CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey, { defaultValue: o.label }) })),
              ]}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('communitySection.subcategoryLabel', { defaultValue: 'Subcategory (optional)' })}
            </label>
            <input
              value={subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
              maxLength={64}
              placeholder={t('communitySection.subcategoryPlaceholder', { defaultValue: 'e.g. retro RPGs' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
            />
          </div>
          <div ref={tagsFieldRef}>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('communitySection.tagsLabel', { defaultValue: 'Tags (max 5)' })}
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border border-default bg-floating text-t-primary">
                  {tag}
                  <button type="button" onClick={() => removeTag(tag)} className="hover:text-red-400 transition-colors text-t-secondary" aria-label={t('common.remove')}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={tagDraft}
                onChange={(e) => { setTagDraft(e.target.value); setTagError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                    e.preventDefault();
                    if (tagDraft.trim()) addTag(tagDraft);
                  } else if (e.key === 'Backspace' && !tagDraft && tags.length > 0) {
                    removeTag(tags[tags.length - 1]);
                  }
                }}
                maxLength={32}
                placeholder={t('communitySection.tagsPlaceholder', { defaultValue: 'add-a-tag and press enter' })}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
              />
              <button type="button" onClick={() => addTag(tagDraft)} disabled={!tagDraft.trim() || tags.length >= 5}
                className="px-3 py-2 rounded-xl border border-default hover:bg-fill-hover transition-all text-t-secondary disabled:opacity-40 disabled:cursor-not-allowed">
                <Plus size={14} />
              </button>
            </div>
            {tagError && <p className="text-[11px] text-red-400 mt-2">{tagError}</p>}
            <p className="text-[11px] text-t-secondary mt-2">
              {t('communitySection.tagsHelp', { defaultValue: 'Lowercase, dash-separated. e.g. "tabletop-rpg".' })}
            </p>
          </div>
          <SelectField
            label={t('communitySection.languageLabel', { defaultValue: 'Primary language' })}
            value={language}
            onChange={setLanguage}
            options={LANGUAGE_OPTIONS}
          />
          <div ref={longDescriptionFieldRef}>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('communitySection.longDescriptionLabel', { defaultValue: 'Long description' })}
            </label>
            <textarea
              value={longDescription}
              onChange={(e) => setLongDescription(e.target.value.slice(0, 4096))}
              rows={6}
              maxLength={4096}
              placeholder={t('communitySection.longDescriptionPlaceholder', { defaultValue: 'What\'s your community all about?' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
            />
            <p className="text-[11px] text-t-secondary mt-1 text-right tabular-nums">
              {longDescription.length} / 4096
            </p>
          </div>
          <div ref={bannerFieldRef}>
            <label className="block text-[11px] font-medium mb-1 text-t-secondary">
              {t('communitySection.bannerSplashLabel', { defaultValue: 'Public banner' })}
            </label>
            <p className="text-[11px] text-t-secondary mb-2 leading-snug">
              {t('communitySection.bannerSplashHelper', { defaultValue: 'Shown to non-members on Discover and your public server profile. This is different from the internal server banner in Overview, which only members see.' })}
            </p>
            <div className="h-32 rounded-xl border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer hover:border-[var(--cyan-accent)]/50 transition-all group border-default bg-app-surface"
              onClick={() => bannerFileInputRef.current?.click()}>
              {bannerSplash ? (
                <img src={sanitizeImgSrc(bannerSplash)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
              ) : (
                <div className="flex flex-col items-center gap-1">
                  <Upload size={20} className="opacity-40 group-hover:opacity-70 transition-opacity text-t-secondary" />
                  <span className="text-[11px] text-t-secondary">{bannerUploading ? t('serverSettings.uploading') : t('communitySection.uploadBanner', { defaultValue: 'Upload a banner' })}</span>
                </div>
              )}
            </div>
            <input
              ref={bannerFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) handleBannerUpload(e.target.files[0]); }}
            />
            {bannerSplash && (
              <button type="button" onClick={() => setBannerSplash(null)} className="text-[11px] text-t-secondary hover:text-red-400 transition-colors mt-2">
                {t('communitySection.removeBanner', { defaultValue: 'Remove banner' })}
              </button>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end items-center gap-2 h-5">
          {savingForm && (
            <span className="text-[11px] text-t-secondary">
              {t('serverSettings.saving', { defaultValue: 'Saving…' })}
            </span>
          )}
        </div>
      </Card>

      {/* ─── Vanity URL (community-tier perk; gated by eligibility/enabled) ─ */}
      <div ref={vanityFieldRef}>
        <Card>
          <p className="text-sm font-semibold mb-1 text-t-primary">{t('communitySection.vanityTitle', { defaultValue: 'Vanity URL' })}</p>
          <p className="text-[12px] mb-4 text-t-secondary">
            {t('communitySection.vanityDesc', { defaultValue: 'Claim a custom invite link like app.howlpro.com/s/your-name. 3–32 lowercase letters, numbers, or dashes.' })}
          </p>
          {!isCommunityEligible && !config?.vanityUrl && (
            <div className="mb-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
              <p className="text-[12px] text-yellow-300">
                {t('communitySection.vanityLocked', {
                  defaultValue: 'Vanity URLs unlock once your server meets every community-mode requirement, or once community mode is enabled.',
                })}
              </p>
            </div>
          )}
          {vanityCooldownDays > 0 && (
            <div className="mb-3 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2">
              <p className="text-[12px] text-cyan-300">
                {t('communitySection.vanityCooldown', {
                  count: vanityCooldownDays,
                  defaultValue: 'You can change your vanity URL again in {{count}} day(s).',
                })}
              </p>
            </div>
          )}
          <VanityField
            value={vanityDraft}
            onChange={setVanityDraft}
            checking={vanityChecking}
            check={vanityCheck}
            onClaim={handleVanityClaim}
            onRelease={handleVanityRelease}
            currentVanity={config?.vanityUrl ?? null}
            busy={vanitySaving}
            canClaim={canClaimVanity}
            t={t}
          />
          <PublicJoinToggle serverId={server.id} showToast={showToast} t={t} />
        </Card>
      </div>

      {/* ─── Enable/Disable toggle ────────────────────────────────────────── */}
      <Card accent={communityEnabled}>
        <SettingRow
          title={t('communitySection.toggleTitle', { defaultValue: 'Community mode' })}
          desc={
            communityEnabled
              ? t('communitySection.toggleEnabledDesc', { defaultValue: 'Your server is configured for the community directory.' })
              : t('communitySection.toggleDisabledDesc', { defaultValue: 'Turn on once every requirement is met.' })
          }
        >
          <Toggle
            checked={communityEnabled}
            disabled={savingEnabled || (!communityEnabled && !eligibility?.eligible)}
            onChange={(v) => { if (v) handleEnable(); else handleDisable(); }}
          />
        </SettingRow>
        {!communityEnabled && !eligibility?.eligible && !eligibilityLoading && (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-yellow-400">
            <AlertTriangle size={12} />
            {t('communitySection.notEligibleHint', { defaultValue: 'Resolve every requirement to enable community mode.' })}
          </div>
        )}
      </Card>

      {/* ─── Discoverability banner (only meaningful once enabled) ────────── */}
      {communityEnabled && <DiscoverabilityBanner config={config} server={server} t={t} />}

      {/* ─── Discovery eligibility (size/age/activity bars) ────────────────── */}
      {/* Visible before community mode is enabled so owners can preview the
          additional bars (age/members/activity) they'll need to clear to
          appear on Discover, not just to flip community mode on. */}
      <DiscoveryEligibilityPanel serverId={server.id} refreshKey={discoveryEligibilityRefreshKey} />

      {/* ─── "Verified by Howl" application — owner-only ───────────────────── */}
      {communityEnabled && server.myRole?.toLowerCase() === 'owner' && (
        <VerificationRequestSection serverId={server.id} showToast={showToast} />
      )}

      {/* ─── Vanity claim type-to-confirm modal ──────────────────────────── */}
      {vanityConfirmSlug && (
        <VanityClaimConfirmModal
          slug={vanityConfirmSlug}
          isReplacing={!!config?.vanityUrl && config.vanityUrl !== vanityConfirmSlug}
          previousSlug={config?.vanityUrl ?? null}
          busy={vanitySaving}
          onCancel={() => setVanityConfirmSlug(null)}
          onConfirm={() => { void submitVanityClaim(vanityConfirmSlug); }}
          t={t}
        />
      )}
    </div>
  );
};

// Discoverability banner
interface DiscoverabilityBannerProps {
  config: CommunityConfig | null;
  server: Server;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const DiscoverabilityBanner: React.FC<DiscoverabilityBannerProps> = ({ config, server, t }) => {
  // Hide entirely when community mode isn't on — eligibility checklist already
  // covers that state with more useful guidance.
  if (!config?.communityEnabled) return null;

  // `suspendedAt` lives on Server but isn't in the shared TS type yet (admin-
  // only field). Read defensively.
  const suspendedAt = (server as Server & { suspendedAt?: string | null }).suspendedAt ?? null;
  const isSuspended = !!suspendedAt;
  const discoveryOn = config.discoveryEnabled === true;
  const isLive = discoveryOn && !isSuspended;

  const hasAgeRestricted = (server.channels ?? []).some((c) => c.ageRestricted === true);

  const reasons: string[] = [];
  if (!discoveryOn) reasons.push(t('communitySection.bannerReasonDiscoveryOff', { defaultValue: 'Discovery is turned off.' }));
  if (isSuspended) reasons.push(t('communitySection.bannerReasonSuspended', { defaultValue: 'This server has been suspended by Howl staff.' }));
  if (hasAgeRestricted) reasons.push(t('serverSettings.discoveryDisabledByAgeRestriction', { defaultValue: 'Remove age restrictions from your channels to list this server in Discovery.' }));

  const vanitySlug = config.vanityUrl;
  const discoverHref = vanitySlug ? `/discover?q=${encodeURIComponent(vanitySlug)}` : '/discover';

  if (isLive) {
    return (
      <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-start gap-3">
        <div className="mt-0.5 w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
          <Check size={11} className="text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-emerald-300 font-medium">
            {t('communitySection.bannerLiveTitle', { defaultValue: 'Your server is live on Discover' })}
          </p>
        </div>
        <Link to={discoverHref}
          className="text-[11px] font-semibold px-2.5 py-1 rounded-md border border-emerald-500/40 hover:bg-emerald-500/15 transition-colors text-emerald-300 shrink-0 inline-flex items-center gap-1">
          <Globe size={11} />
          {t('communitySection.bannerViewOnDiscover', { defaultValue: 'View' })}
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-start gap-3">
      <div className="mt-0.5 w-5 h-5 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0">
        <AlertTriangle size={11} className="text-yellow-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-yellow-300 font-medium">
          {t('communitySection.bannerNotLiveTitle', { defaultValue: 'Your server is not currently visible on Discover' })}
        </p>
        {reasons.length > 0 && (
          <ul className="text-[11px] mt-1 text-t-secondary list-disc list-inside space-y-0.5">
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
};

// Vanity claim confirmation modal
//
// Vanity claims arm a 30-day cooldown on the next change, so we force the
// owner through a type-to-confirm step before the claim is submitted to the
// backend. The pattern matches the destructive-action confirms used elsewhere
// (account delete, server delete) — explicit acknowledgement that the action
// has consequences they can't immediately reverse.

interface VanityClaimConfirmModalProps {
  slug: string;
  isReplacing: boolean;
  previousSlug: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: (key: string, opts?: { defaultValue?: string; slug?: string; previous?: string; count?: number }) => string;
}

const VanityClaimConfirmModal: React.FC<VanityClaimConfirmModalProps> = ({ slug, isReplacing, previousSlug, busy, onCancel, onConfirm, t }) => {
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === slug;
  return (
    <Modal open onClose={busy ? () => {} : onCancel} size="sm" showClose={false}>
      <ModalBody className="pt-6">
        <h3 className="text-lg font-semibold mb-2 text-t-primary">
          {isReplacing
            ? t('communitySection.vanityConfirmTitleReplace', { defaultValue: 'Change your vanity URL?' })
            : t('communitySection.vanityConfirmTitleClaim', { defaultValue: 'Claim this vanity URL?' })}
        </h3>
        <p className="text-sm text-t-secondary mb-3">
          {t('communitySection.vanityConfirmBody', {
            defaultValue: 'Once you claim this URL, you cannot change it again for 30 days. You can release it any time, but you still won\'t be able to claim a new one until the 30-day window is over.',
          })}
        </p>

        <div className="rounded-lg border border-default bg-app-surface px-3 py-2 mb-3">
          <p className="text-[11px] text-t-secondary mb-0.5">{t('communitySection.vanityConfirmNewLabel', { defaultValue: 'New vanity URL' })}</p>
          <p className="text-sm font-mono text-t-primary break-all">app.howlpro.com/s/{slug}</p>
        </div>
        {isReplacing && previousSlug && (
          <div className="rounded-lg border border-default bg-app-surface px-3 py-2 mb-3 opacity-70">
            <p className="text-[11px] text-t-secondary mb-0.5">{t('communitySection.vanityConfirmReplaceLabel', { defaultValue: 'Replacing' })}</p>
            <p className="text-sm font-mono text-t-primary break-all line-through">app.howlpro.com/s/{previousSlug}</p>
          </div>
        )}

        <p className="text-[12px] text-t-secondary mb-2">
          {t('communitySection.vanityConfirmRetypePrompt', {
            defaultValue: 'Type the slug below to confirm.',
          })}
        </p>
        <div className="flex items-center gap-2 rounded-xl border border-default bg-app-surface px-3 focus-within:ring-2 focus-within:ring-[var(--cyan-accent)]/40 transition-all">
          <span className="text-[12px] text-t-secondary select-none">app.howlpro.com/s/</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value.toLowerCase())}
            placeholder={slug}
            autoFocus
            disabled={busy}
            maxLength={32}
            className="flex-1 bg-transparent outline-none py-2.5 text-sm text-t-primary disabled:cursor-not-allowed font-mono"
          />
          {matches && <Check size={14} className="text-emerald-400" />}
        </div>
        {typed && !matches && (
          <p className="text-[11px] mt-2 text-yellow-300/80">
            {t('communitySection.vanityConfirmRetypeMismatch', { defaultValue: 'Doesn\'t match the slug above.' })}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onCancel} disabled={busy}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!matches || busy}
          className="btn-cta px-4 py-2 rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy
            ? t('communitySection.vanityConfirmSubmitting', { defaultValue: 'Claiming…' })
            : isReplacing
              ? t('communitySection.vanityConfirmReplaceCta', { defaultValue: 'Change vanity URL' })
              : t('communitySection.vanityConfirmClaimCta', { defaultValue: 'Claim vanity URL' })}
        </button>
      </ModalFooter>
    </Modal>
  );
};

// Vanity field subcomponent
interface VanityFieldProps {
  value: string;
  onChange: (v: string) => void;
  checking: boolean;
  check: VanityCheckResult | null;
  onClaim: () => void;
  onRelease: () => void;
  currentVanity: string | null;
  busy: boolean;
  /**
   * Whether the server passes the gate to claim a vanity URL (community-mode
   * eligible OR community already enabled). When false, the input is locked
   * and Claim is disabled, but Release stays available so an existing slug
   * can always be relinquished.
   */
  canClaim: boolean;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const VanityField: React.FC<VanityFieldProps> = ({ value, onChange, checking, check, onClaim, onRelease, currentVanity, busy, canClaim, t }) => {
  const slug = value.trim().toLowerCase();
  const isCurrent = !!currentVanity && slug === currentVanity;
  const submitDisabled = busy || checking || !slug || isCurrent || (check ? !check.available : false) || !canClaim;
  const { color, label, icon } = useMemo(() => {
    if (!slug) return { color: 'text-t-secondary', label: '', icon: null as React.ReactNode };
    if (isCurrent) return { color: 'text-t-secondary', label: t('communitySection.vanityCurrent', { defaultValue: 'Current vanity URL' }), icon: <Check size={14} className="text-emerald-400" /> };
    if (checking) return { color: 'text-t-secondary', label: t('communitySection.checking', { defaultValue: 'Checking…' }), icon: <Loader2 size={14} className="animate-spin" /> };
    if (!check) return { color: 'text-t-secondary', label: '', icon: null };
    if (check.available) return { color: 'text-emerald-400', label: t('communitySection.vanityAvailable', { defaultValue: 'Available' }), icon: <Check size={14} className="text-emerald-400" /> };
    const reason = check.reason === 'invalid'
      ? t('communitySection.vanityInvalid', { defaultValue: 'Invalid format' })
      : check.reason === 'reserved'
        ? t('communitySection.vanityReserved', { defaultValue: 'Reserved' })
        : check.reason === 'denylisted'
          ? t('communitySection.vanityDenylisted', { defaultValue: 'Not allowed' })
          : t('communitySection.vanityTaken', { defaultValue: 'Taken' });
    return { color: 'text-red-400', label: reason, icon: <X size={14} className="text-red-400" /> };
  }, [slug, isCurrent, checking, check, t]);

  return (
    <div>
      <div className="flex items-stretch gap-2">
        <div className={`flex-1 flex items-center gap-2 rounded-xl border border-default bg-app-surface px-3 focus-within:ring-2 focus-within:ring-[var(--cyan-accent)]/40 transition-all ${!canClaim ? 'opacity-60' : ''}`}>
          <span className="text-[12px] text-t-secondary select-none">app.howlpro.com/s/</span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            maxLength={32}
            placeholder="your-server"
            disabled={!canClaim}
            className="flex-1 bg-transparent outline-none py-2.5 text-sm text-t-primary disabled:cursor-not-allowed"
          />
          {icon && <span className="shrink-0">{icon}</span>}
        </div>
        {currentVanity && isCurrent ? (
          <button type="button" onClick={onRelease} disabled={busy}
            className="btn-secondary px-4 py-2 text-sm">
            {t('communitySection.release', { defaultValue: 'Release' })}
          </button>
        ) : (
          <button type="button" onClick={onClaim} disabled={submitDisabled}
            className="btn-cta px-4 py-2 rounded-xl transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {t('communitySection.claim', { defaultValue: 'Claim' })}
          </button>
        )}
      </div>
      {label && <p className={`text-[11px] mt-2 ${color}`}>{label}</p>}
      {currentVanity && (
        <p className="text-[11px] text-t-secondary mt-2 inline-flex items-center gap-1">
          <ExternalLink size={11} />
          <span>{`app.howlpro.com/s/${currentVanity}`}</span>
        </p>
      )}
    </div>
  );
};

// Public-join toggle
// Surfaces the joinMethod selector as a single Discord-parity toggle: ON
// flips joinMethod to 'discoverable' (anyone with the public link can join);
// OFF reverts to 'invite_only' (the safe default). Hidden when joinMethod is
// 'apply_to_join' to avoid stomping that more nuanced state — owners using
// applications can still configure it from Server Settings → Entry Rules.
interface PublicJoinToggleProps {
  serverId: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const PublicJoinToggle: React.FC<PublicJoinToggleProps> = ({ serverId, showToast, t }) => {
  const [joinMethod, setJoinMethod] = useState<string>('invite_only');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient.getServerSettings(serverId).then((s) => {
      if (cancelled) return;
      setJoinMethod((s.joinMethod ?? 'invite_only') as string);
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [serverId]);

  if (!loaded || joinMethod === 'apply_to_join') return null;

  const handleChange = async (v: boolean) => {
    const next = v ? 'discoverable' : 'invite_only';
    setSaving(true);
    try {
      await apiClient.updateServerSettings(serverId, { joinMethod: next });
      setJoinMethod(next);
      showToast(t(v ? 'communitySection.publicJoinOn' : 'communitySection.publicJoinOff', {
        defaultValue: v ? 'Public link join enabled' : 'Public link join disabled',
      }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update join method', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-default">
      <SettingRow
        title={t('communitySection.publicJoinTitle', { defaultValue: 'Anyone with the link can join' })}
        desc={t('communitySection.publicJoinDesc', { defaultValue: 'When on, the vanity URL itself is the join link. Anyone visiting the public profile can join with one click. When off, members must use a private invite.' })}
      >
        <Toggle checked={joinMethod === 'discoverable'} disabled={saving} onChange={handleChange} />
      </SettingRow>
    </div>
  );
};

export default CommunitySection;
