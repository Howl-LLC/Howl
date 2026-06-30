// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Plus, X, Camera, ArrowLeft, ChevronRight, Loader2, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/api';
import { Toggle } from '../settings/SettingsWidgets';

/* ── Built-in template definitions ──────────────────────────────────────────── */

const BUILT_IN_TEMPLATES = [
  {
    key: 'gaming', name: 'Gaming', emoji: '\u{1F3AE}',
    preview: [{ cat: 'Info', channels: ['# announcements', '# rules'] }, { cat: 'General', channels: ['# general', '# memes', '# clips'] }, { cat: 'Gaming', channels: ['# lfg', '# game-chat', '# strategy'] }, { cat: 'Voice', channels: ['\u{1F50A} lobby-1', '\u{1F50A} lobby-2', '\u{1F50A} afk'] }],
  },
  {
    key: 'friends', name: 'Friends', emoji: '\u{1F49C}',
    preview: [{ cat: 'General', channels: ['# general', '# photos', '# memes'] }, { cat: 'Hangout', channels: ['\u{1F50A} lounge', '\u{1F50A} music', '\u{1F50A} stream'] }],
  },
  {
    key: 'study-group', name: 'Study Group', emoji: '\u{1F4DA}',
    preview: [{ cat: 'Info', channels: ['# announcements', '# resources'] }, { cat: 'General', channels: ['# general', '# homework-help', '# study-tips'] }, { cat: 'Subjects', channels: ['# math', '# science', '# english'] }, { cat: 'Voice', channels: ['\u{1F50A} study-room-1', '\u{1F50A} study-room-2'] }],
  },
  {
    key: 'school-club', name: 'School Club', emoji: '\u{1F3EB}',
    preview: [{ cat: 'Info', channels: ['# announcements', '# schedule'] }, { cat: 'General', channels: ['# general', '# ideas', '# off-topic'] }, { cat: 'Voice', channels: ['\u{1F50A} meeting-room', '\u{1F50A} hangout'] }],
  },
  {
    key: 'local-community', name: 'Community', emoji: '\u{1F3D8}\u{FE0F}',
    preview: [{ cat: 'Info', channels: ['# announcements', '# rules', '# events'] }, { cat: 'General', channels: ['# general', '# marketplace', '# recommendations'] }, { cat: 'Voice', channels: ['\u{1F50A} town-hall', '\u{1F50A} hangout'] }],
  },
  {
    key: 'artists-creators', name: 'Artists', emoji: '\u{1F3A8}',
    preview: [{ cat: 'Info', channels: ['# announcements', '# rules'] }, { cat: 'Showcase', channels: ['# art-share', '# wip', '# commissions'] }, { cat: 'Voice', channels: ['\u{1F50A} studio', '\u{1F50A} critique'] }],
  },
  {
    key: 'content-creators', name: 'Content Creators', emoji: '\u{1F4E1}', howlExclusive: true as const,
    preview: [{ cat: 'General', channels: ['# general', '# collabs', '# self-promo'] }, { cat: 'Content', channels: ['# feedback', '# clips-highlights', '# behind-the-scenes'] }, { cat: 'Voice', channels: ['\u{1F50A} stream-planning', '\u{1F50A} watch-party'] }],
  },
  {
    key: 'dev-team', name: 'Dev Team', emoji: '\u{1F4BB}', howlExclusive: true as const,
    preview: [{ cat: 'Development', channels: ['# bugs', '# feature-requests', '# code-review', '# docs'] }, { cat: 'General', channels: ['# general', '# introductions', '# off-topic'] }, { cat: 'Voice', channels: ['\u{1F50A} standup', '\u{1F50A} pair-programming'] }],
  },
] as const;

type BuiltInTemplate = (typeof BUILT_IN_TEMPLATES)[number];

/* ── Props ──────────────────────────────────────────────────────────────────── */

interface CreateJoinServerModalProps {
  open: boolean;
  onClose: () => void;
  onCreateServer?: (name: string, options?: { icon?: string; template?: string; community?: boolean }) => Promise<void>;
  onJoinServer?: (code: string) => Promise<void>;
  onServerCreated?: (server: { id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }) => void;
  userName?: string;
}

/* ── Component ──────────────────────────────────────────────────────────────── */

export const CreateJoinServerModal: React.FC<CreateJoinServerModalProps> = ({
  open,
  onClose,
  onCreateServer,
  onJoinServer,
  onServerCreated,
  userName,
}) => {
  const { t } = useTranslation();

  // View state
  const [modalView, setModalView] = useState<'select' | 'customize' | 'join' | 'template'>('select');
  const [selectedTemplate, setSelectedTemplate] = useState<BuiltInTemplate | null>(null);

  // Customize state
  const [serverNameInput, setServerNameInput] = useState('');
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  /** Local blob: URL of the picked file. Renders instantly; the uploaded `iconUrl` may
   *  take a beat to become reachable on the CDN, so we keep this for the preview UI. */
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [createServerLoading, setCreateServerLoading] = useState(false);
  const [createServerError, setCreateServerError] = useState<string | null>(null);
  const [makeCommunity, setMakeCommunity] = useState(false);
  const iconFileInputRef = useRef<HTMLInputElement>(null);

  // Join state
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [joinServerLoading, setJoinServerLoading] = useState(false);
  const [joinServerError, setJoinServerError] = useState<string | null>(null);

  // Template code state
  const [templateCodeInput, setTemplateCodeInput] = useState('');
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const closeAndReset = () => {
    onClose();
    setModalView('select');
    setSelectedTemplate(null);
    setServerNameInput('');
    setIconUrl(null);
    if (iconPreview?.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
    setIconPreview(null);
    setIconUploading(false);
    setUploadError(null);
    setInviteCodeInput('');
    setTemplateCodeInput('');
    setTemplateNameInput('');
    setJoinServerError(null);
    setCreateServerError(null);
    setTemplateError(null);
    setMakeCommunity(false);
  };

  useEffect(() => {
    return () => {
      if (iconPreview?.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
    };
  }, [iconPreview]);

  const goToCustomize = (tmpl: BuiltInTemplate | null) => {
    setSelectedTemplate(tmpl);
    const defaultName = tmpl
      ? `${userName ? userName + "'s " : ''}${tmpl.name} server`
      : `${userName ? userName + "'s " : ''}server`;
    setServerNameInput(defaultName);
    setIconUrl(null);
    if (iconPreview?.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
    setIconPreview(null);
    setUploadError(null);
    setCreateServerError(null);
    setMakeCommunity(false);
    setModalView('customize');
  };

  const handleIconUpload = async (file: File) => {
    if (!file.type.startsWith('image/') || !['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
      setUploadError(t('servers.onlyPngJpgGif', { defaultValue: 'Only PNG, JPG, and GIF files are allowed.' }));
      return;
    }
    if (iconPreview?.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
    setIconPreview(URL.createObjectURL(file));
    setIconUploading(true);
    setUploadError(null);
    try {
      const r = await apiClient.uploadFile(file);
      setIconUrl(r.url);
    } catch {
      setUploadError(t('servers.uploadFailed', { defaultValue: 'Upload failed. Please try again.' }));
      if (iconPreview?.startsWith('blob:')) URL.revokeObjectURL(iconPreview);
      setIconPreview(null);
    } finally {
      setIconUploading(false);
    }
  };

  const handleCreate = async () => {
    const name = serverNameInput.trim();
    if (!name || !onCreateServer) return;
    setCreateServerLoading(true);
    setCreateServerError(null);
    try {
      await onCreateServer(name, {
        icon: iconUrl ?? undefined,
        template: selectedTemplate?.key,
        community: makeCommunity || undefined,
      });
      closeAndReset();
    } catch (err) {
      setCreateServerError(err instanceof Error ? err.message : t('servers.failedToCreate', { defaultValue: 'Failed to create server' }));
    } finally {
      setCreateServerLoading(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-md animate-in fade-in duration-300" onClick={closeAndReset} />
      <div
        className="w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-lg relative spring-pop-in glass"
        style={{
          border: '1px solid var(--glass-border)',
          boxShadow: `0 0 0 1px var(--border-subtle), var(--glass-shadow)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hidden file input for icon upload */}
        <input
          ref={iconFileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.[0]) handleIconUpload(e.target.files[0]);
            e.target.value = '';
          }}
        />

        {/* ─── Select View: Template Picker ─── */}
        {modalView === 'select' && (
          <div className="animate-in fade-in duration-300">
            {/* Header */}
            <div className="px-7 pt-6 pb-1 flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-t-secondary mb-1">{t('servers.newServer')}</p>
                <h2 className="text-lg font-bold text-t-primary tracking-tight">{t('servers.howToStart')}</h2>
              </div>
              <button onClick={closeAndReset} className="p-1.5 text-t-secondary hover:text-t-primary hover:bg-fill-active rounded-lg transition-all mt-0.5"><X size={18} /></button>
            </div>

            <div className="px-7 pt-4 pb-2">
              {/* Start from scratch hero card */}
              <button
                type="button"
                onClick={() => goToCustomize(null)}
                className="w-full flex items-center gap-4 p-4 rounded-xl border transition-all duration-200 group cursor-pointer mb-5"
                style={{
                  background: 'color-mix(in srgb, var(--cyan-accent) 6%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)',
                }}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform"
                  style={{ background: 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)' }}
                >
                  <Plus size={24} className="text-[var(--cyan-accent)]" />
                </div>
                <div className="text-left flex-1 min-w-0">
                  <p className="text-sm font-semibold text-t-primary">{t('servers.startFromScratch')}</p>
                  <p className="text-xs text-t-secondary mt-0.5">{t('servers.blankServerYourRules')}</p>
                </div>
                <ChevronRight size={16} className="text-t-secondary group-hover:text-t-primary transition-colors shrink-0" />
              </button>

              {/* Template section label */}
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-t-secondary mb-3">{t('servers.orPickTemplate')}</p>

              {/* Template grid */}
              <div className="grid grid-cols-2 gap-2.5 max-h-[340px] overflow-y-auto pr-1 scrollbar-thin">
                {BUILT_IN_TEMPLATES.map((tmpl) => {
                  const totalChannels = tmpl.preview.reduce((sum, cat) => sum + cat.channels.length, 0);
                  const previewChannels = tmpl.preview.flatMap((cat) => cat.channels).slice(0, 3);
                  const extraCount = totalChannels - previewChannels.length;
                  return (
                    <button
                      key={tmpl.key}
                      type="button"
                      onClick={() => goToCustomize(tmpl)}
                      className="relative flex flex-col p-3.5 bg-fill-hover border border-default rounded-xl hover:bg-fill-hover hover:border-[var(--glass-border)] transition-all duration-200 text-left group cursor-pointer"
                    >
                      {'howlExclusive' in tmpl && (
                        <span
                          className="absolute top-2.5 right-2.5 px-1.5 py-px rounded-full text-[9px] font-semibold"
                          style={{
                            background: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)',
                            color: 'color-mix(in srgb, var(--cyan-accent) 70%, transparent)',
                          }}
                        >HOWL</span>
                      )}
                      <div className="flex items-center gap-2 mb-2.5">
                        <span className="text-xs font-semibold text-t-primary truncate">{tmpl.name}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {previewChannels.map((ch, i) => (
                          <span key={i} className="bg-fill-hover border border-default rounded-md px-1.5 py-0.5 text-t-secondary text-[10px] truncate max-w-[90px]">{ch}</span>
                        ))}
                        {extraCount > 0 && (
                          <span className="bg-fill-hover border border-default rounded-md px-1.5 py-0.5 text-t-secondary text-[10px]">+{extraCount}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Bottom bar */}
            <div className="px-7 py-4 mt-2 border-t border-default flex gap-3">
              <button
                type="button"
                onClick={() => { setModalView('join'); setInviteCodeInput(''); setJoinServerError(null); }}
                className="btn-secondary flex-1 py-2.5 text-xs"
              >
                {t('servers.joinWithInvite', { defaultValue: 'Join with invite' })}
              </button>
              <button
                type="button"
                onClick={() => { setModalView('template'); setTemplateError(null); }}
                className="btn-secondary flex-1 py-2.5 text-xs"
              >
                {t('servers.useTemplateCode', { defaultValue: 'Use template code' })}
              </button>
            </div>
          </div>
        )}

        {/* ─── Customize View: Name + Icon + Preview ─── */}
        {modalView === 'customize' && (
          <div className="animate-in slide-in-from-right-8 duration-500">
            {/* Header */}
            <div className="px-7 pt-6 pb-1 flex items-start justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-t-secondary mb-1">
                  {selectedTemplate ? selectedTemplate.name : t('servers.customServer', { defaultValue: 'Custom Server' })}
                </p>
                <h2 className="text-lg font-bold text-t-primary tracking-tight">{t('servers.setupYourServer')}</h2>
              </div>
              <button onClick={closeAndReset} className="p-1.5 text-t-secondary hover:text-t-primary hover:bg-fill-active rounded-lg transition-all mt-0.5"><X size={18} /></button>
            </div>

            <div className="px-7 pt-4 pb-2">
              {/* Icon + Name row */}
              <div className="flex gap-5 items-start">
                {/* Icon upload square */}
                <div className="shrink-0">
                  <button
                    type="button"
                    onClick={() => iconFileInputRef.current?.click()}
                    disabled={iconUploading}
                    className="relative w-[88px] h-[88px] rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-fill-hover hover:bg-fill-hover hover:border-[var(--border-strong)] transition-all flex flex-col items-center justify-center gap-1 group cursor-pointer overflow-hidden"
                  >
                    {iconPreview ? (
                      <>
                        <img src={iconPreview} alt="Server icon" className="absolute inset-0 w-full h-full object-cover rounded-2xl" draggable={false} />
                        {iconUploading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-2xl">
                            <Loader2 size={20} className="text-white animate-spin" />
                          </div>
                        )}
                      </>
                    ) : iconUploading ? (
                      <Loader2 size={20} className="text-t-secondary animate-spin" />
                    ) : (
                      <>
                        <Camera size={20} className="text-t-secondary group-hover:text-t-primary transition-colors" />
                        <span className="text-[9px] font-medium text-t-secondary group-hover:text-t-primary transition-colors">{t('servers.addIcon')}</span>
                      </>
                    )}
                    {!iconPreview && !iconUploading && (
                      <div
                        className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ background: 'var(--cyan-accent)' }}
                      >
                        <Plus size={12} className="text-[rgba(0,30,30,0.95)]" />
                      </div>
                    )}
                  </button>
                  <p className="text-[10px] text-t-secondary text-center mt-1.5">{t('common.optional')}</p>
                </div>

                {/* Server name input */}
                <div className="flex-1 min-w-0">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-t-secondary block mb-2">{t('servers.serverName')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={serverNameInput}
                    onChange={(e) => { setServerNameInput(e.target.value); setCreateServerError(null); }}
                    placeholder={t('servers.serverNamePlaceholder')}
                    className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-t-primary placeholder-[var(--text-secondary)] focus:border-[var(--border-strong)] focus:bg-fill-hover outline-none transition-all"
                    disabled={createServerLoading}
                    maxLength={100}
                  />
                  <p className="text-[10px] text-t-secondary mt-2 leading-relaxed">
                    {t('servers.agreeToGuidelines', { defaultValue: "By creating a server you agree to Howl's" })}{' '}
                    <Link
                      to="/community-guidelines"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--cyan-accent)] hover:underline focus:outline-none focus:underline"
                    >
                      {t('servers.communityGuidelines', { defaultValue: 'Community Guidelines' })}
                    </Link>
                  </p>
                </div>
              </div>

              {/* ─── Community toggle ─── */}
              <button
                type="button"
                onClick={() => setMakeCommunity((v) => !v)}
                className="mt-4 w-full flex items-start gap-3.5 p-3.5 rounded-xl text-left transition-all"
                style={{
                  background: makeCommunity
                    ? 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)'
                    : 'color-mix(in srgb, var(--cyan-accent) 4%, transparent)',
                  border: makeCommunity
                    ? '1px solid color-mix(in srgb, var(--cyan-accent) 35%, transparent)'
                    : '1px solid color-mix(in srgb, var(--cyan-accent) 15%, transparent)',
                }}
                aria-pressed={makeCommunity}
              >
                <div
                  className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center"
                  style={{
                    background: 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--cyan-accent) 30%, transparent)',
                  }}
                >
                  <Globe size={18} className="text-[var(--cyan-accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-t-primary">
                    {t('servers.makeCommunity', { defaultValue: 'Make this a community server' })}
                  </p>
                  <p className="text-[12px] text-t-secondary leading-snug mt-0.5">
                    {t('servers.makeCommunityDesc', { defaultValue: 'List on Discover, accept join requests, get insights, and build a public presence. You can change this setting later in Server Settings → Community Hub.' })}
                  </p>
                </div>
                <div className="shrink-0 mt-0.5" onClick={(e) => e.stopPropagation()}>
                  <Toggle checked={makeCommunity} onChange={setMakeCommunity} />
                </div>
              </button>
              {makeCommunity && (
                <p className="mt-2 text-[11px] text-t-secondary leading-snug px-1">
                  {t('servers.makeCommunityNotice', { defaultValue: "We'll surface the Community Hub setup checklist after creation. Your server won't be listed publicly until it's configured." })}
                </p>
              )}

              {uploadError && <p className="text-red-400 text-xs font-medium mt-2">{uploadError}</p>}

              {/* Template preview: "What you'll get" */}
              {selectedTemplate && (
                <div className="mt-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-t-secondary mb-2.5">{t('servers.whatYouGet')}</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedTemplate.preview.map((cat) => (
                      <div key={cat.cat} className="bg-fill-hover border border-default rounded-lg px-3 py-2 min-w-0">
                        <p className="text-[10px] font-semibold text-t-secondary uppercase tracking-wider mb-1">{cat.cat}</p>
                        <div className="flex flex-col gap-0.5">
                          {cat.channels.map((ch, i) => (
                            <span key={i} className="text-[11px] text-t-secondary truncate">{ch}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {createServerError && <p className="text-red-400 text-xs font-medium mt-3">{createServerError}</p>}
            </div>

            {/* Bottom bar */}
            <div className="px-7 py-4 mt-1 border-t border-default flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setModalView('select'); setCreateServerError(null); }}
                className="flex items-center gap-1.5 text-xs font-medium text-t-secondary hover:text-t-primary transition-colors"
              >
                <ArrowLeft size={14} />
                {t('common.back', { defaultValue: 'Back' })}
              </button>
              <button
                type="button"
                disabled={!serverNameInput.trim() || createServerLoading}
                onClick={handleCreate}
                className="btn-cta px-6 py-2.5 text-sm rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {createServerLoading ? t('servers.creating') : t('servers.createServer')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Join View (unchanged) ─── */}
        {modalView === 'join' && (
          <div>
            <div className="px-7 pt-6 pb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-t-primary tracking-tight">{t('sidebar.joinNetwork')}</h2>
              <button onClick={closeAndReset} className="p-1.5 text-t-secondary hover:text-t-primary hover:bg-fill-active rounded-lg transition-all"><X size={18} /></button>
            </div>
            <div className="px-7 pb-6 pt-3">
              <div className="space-y-6 animate-in slide-in-from-right-8 duration-500">
                <div className="space-y-2">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-t-secondary block">{t('sidebar.inviteSequence')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={inviteCodeInput}
                    onChange={(e) => { setInviteCodeInput(e.target.value); setJoinServerError(null); }}
                    placeholder={t('sidebar.inviteCodeExample')}
                    className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-t-primary placeholder-[var(--text-secondary)] focus:border-[var(--border-strong)] focus:bg-fill-hover outline-none transition-all"
                    disabled={joinServerLoading}
                  />
                </div>
                {joinServerError && <p className="text-red-400 text-xs font-medium">{joinServerError}</p>}
                <button
                  type="button"
                  disabled={!inviteCodeInput.trim() || joinServerLoading}
                  onClick={async () => {
                    const code = inviteCodeInput.trim();
                    if (!code || !onJoinServer) return;
                    setJoinServerLoading(true);
                    setJoinServerError(null);
                    try {
                      await onJoinServer(code);
                      setInviteCodeInput('');
                      setModalView('select');
                      closeAndReset();
                    } catch (err) {
                      setJoinServerError(err instanceof Error ? err.message : t('sidebar.invalidOrExpiredInvite'));
                    } finally {
                      setJoinServerLoading(false);
                    }
                  }}
                  className="btn-cta w-full py-3 text-sm rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {joinServerLoading ? t('sidebar.joining') : t('sidebar.syncNetwork')}
                </button>
                <button type="button" onClick={() => { setModalView('select'); setJoinServerError(null); }} className="w-full text-xs font-medium text-t-secondary hover:text-t-primary transition-colors">{t('common.back')}</button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Template Code View (unchanged) ─── */}
        {modalView === 'template' && (
          <div>
            <div className="px-7 pt-6 pb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-t-primary tracking-tight">{t('servers.createFromTemplate')}</h2>
              <button onClick={closeAndReset} className="p-1.5 text-t-secondary hover:text-t-primary hover:bg-fill-active rounded-lg transition-all"><X size={18} /></button>
            </div>
            <div className="px-7 pb-6 pt-3">
              <div className="space-y-6 animate-in slide-in-from-right-8 duration-500">
                <div className="space-y-2">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-t-secondary block">{t('servers.templateCode')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={templateCodeInput}
                    onChange={(e) => { setTemplateCodeInput(e.target.value); setTemplateError(null); }}
                    placeholder={t('servers.templateCodePlaceholder')}
                    className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-t-primary placeholder-[var(--text-secondary)] focus:border-[var(--border-strong)] focus:bg-fill-hover outline-none transition-all"
                    disabled={templateLoading}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-t-secondary block">{t('servers.serverNameOptional')}</label>
                  <input
                    type="text"
                    value={templateNameInput}
                    onChange={(e) => setTemplateNameInput(e.target.value)}
                    placeholder={t('servers.defaultsToTemplateName')}
                    className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-t-primary placeholder-[var(--text-secondary)] focus:border-[var(--border-strong)] focus:bg-fill-hover outline-none transition-all"
                    disabled={templateLoading}
                  />
                </div>
                {templateError && <p className="text-red-400 text-xs font-medium">{templateError}</p>}
                <button
                  type="button"
                  disabled={!templateCodeInput.trim() || templateLoading}
                  onClick={async () => {
                    const code = templateCodeInput.trim();
                    if (!code) return;
                    setTemplateLoading(true);
                    setTemplateError(null);
                    try {
                      const server = await apiClient.createServerFromTemplate(code, templateNameInput.trim() || undefined);
                      onServerCreated?.(server);
                      closeAndReset();
                    } catch (err) {
                      setTemplateError(err instanceof Error ? err.message : t('servers.failedToCreateFromTemplate', { defaultValue: 'Failed to create server from template' }));
                    } finally {
                      setTemplateLoading(false);
                    }
                  }}
                  className="btn-cta w-full py-3 text-sm rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {templateLoading ? t('servers.creating') : t('servers.createFromTemplate')}
                </button>
                <button type="button" onClick={() => { setModalView('select'); setTemplateError(null); }} className="w-full text-xs font-medium text-t-secondary hover:text-t-primary transition-colors">{t('common.back')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
