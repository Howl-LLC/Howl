// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Camera, Plus, Hash, Volume2, ChevronDown, Loader2 } from 'lucide-react';
import type { Server } from '../types';
import { apiClient } from '../services/api';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

interface TemplatePreviewPageProps {
  code: string;
  onServerCreated: (server: Server) => void;
  onCancel: () => void;
  userName?: string;
}

interface ResolvedTemplate {
  name: string;
  description?: string | null;
  code: string;
  channelSnapshot?: Array<{ name: string; type: string }> | null;
  roleSnapshot?: Array<{ name: string; color: string; permissions?: Record<string, boolean> }> | null;
  categorySnapshot?: Array<{
    name: string;
    position: number;
    channels: Array<{ name: string; type: string; position: number }>;
  }> | null;
  settingsSnapshot?: unknown;
  usageCount: number;
  serverName: string;
  createdAt: string;
}

export const TemplatePreviewPage: React.FC<TemplatePreviewPageProps> = ({ code, onServerCreated, onCancel, userName }) => {
  const { t } = useTranslation();

  const [template, setTemplate] = useState<ResolvedTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [serverName, setServerName] = useState('');
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const iconFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setNotFound(false);
      try {
        const data = await apiClient.resolveTemplate(code) as ResolvedTemplate;
        if (!cancelled) {
          setTemplate(data);
          setServerName(`${userName ? userName + "'s " : ''}${data.name} server`);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [code, userName]);

  const handleIconUpload = async (file: File) => {
    if (!file.type.startsWith('image/') || !['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
      setUploadError('Only PNG, JPG, and GIF files are allowed.');
      return;
    }
    setIconUploading(true);
    setUploadError(null);
    try {
      const r = await apiClient.uploadFile(file);
      setIconUrl(r.url);
    } catch {
      setUploadError('Upload failed. Please try again.');
    } finally {
      setIconUploading(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const server = await apiClient.createServerFromTemplate(code, serverName.trim() || undefined, iconUrl || undefined);
      onServerCreated(server);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create server');
    } finally {
      setCreating(false);
    }
  };

  const categories = template?.categorySnapshot ?? [];
  const flatChannels = (template?.channelSnapshot ?? []) as Array<{ name: string; type: string }>;
  const roles = (template?.roleSnapshot ?? []) as Array<{ name: string; color: string; permissions?: Record<string, boolean> }>;
  const totalChannels = categories.length > 0
    ? categories.reduce((sum, cat) => sum + cat.channels.length, 0)
    : flatChannels.length;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-md animate-in fade-in duration-300" onClick={onCancel} />
      <div
        className="w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-lg relative spring-pop-in glass"
        style={{
          border: '1px solid var(--glass-border)',
          boxShadow: '0 0 0 1px var(--fill-hover), var(--glass-shadow)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hidden file input */}
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

        {/* Loading state */}
        {loading && (
          <div className="px-6 py-16 flex flex-col items-center justify-center gap-3">
            <Loader2 size={28} className="text-white/30 animate-spin" />
            <p className="text-sm text-white/40">{t('template.loading')}</p>
          </div>
        )}

        {/* Not found state */}
        {!loading && notFound && (
          <div className="px-6 py-12 flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-lg font-bold text-white/80">{t('template.notFound')}</p>
            <p className="text-sm text-white/35">{t('template.notFoundDesc')}</p>
            <button
              type="button"
              onClick={onCancel}
              className="mt-3 px-5 py-2 text-sm font-semibold rounded-xl bg-fill-active hover:bg-fill-strong text-white/80 transition-all"
            >
              {t('template.goHome')}
            </button>
          </div>
        )}

        {/* Template found */}
        {!loading && template && (
          <>
            {/* Header */}
            <div className="px-6 pt-5 pb-1 flex items-start justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/30 mb-1">{t('template.pageTitle')}</p>
                <h2 className="text-lg font-bold text-white/90 tracking-tight truncate">{template.name}</h2>
                {template.description && <p className="text-xs text-white/40 mt-0.5">{template.description}</p>}
                <p className="text-[10px] text-white/25 mt-1">
                  {t('template.from', { serverName: template.serverName })} &middot; {t('template.usedTimes', { count: template.usageCount })}
                </p>
              </div>
              <button onClick={onCancel} className="p-1.5 text-white/30 hover:text-white hover:bg-fill-active rounded-lg transition-all mt-0.5 shrink-0"><X size={18} /></button>
            </div>

            <div className="px-6 pt-4 pb-2">
              {/* Channel preview */}
              <div className="bg-fill-hover border border-default rounded-xl p-3 max-h-[180px] overflow-y-auto mb-4">
                {categories.length > 0 ? categories.map((cat, ci) => (
                  <div key={ci} className={ci > 0 ? 'mt-2.5' : ''}>
                    <div className="flex items-center gap-1 mb-1">
                      <ChevronDown size={10} className="text-white/25" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/35">{cat.name}</span>
                    </div>
                    {cat.channels.map((ch, chi) => (
                      <div
                        key={chi}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] ${ci === 0 && chi === 0 ? 'bg-fill-hover text-white/70' : 'text-white/35'}`}
                      >
                        {ch.type === 'voice' ? <Volume2 size={12} className="shrink-0 opacity-50" /> : <Hash size={12} className="shrink-0 opacity-50" />}
                        <span className="truncate">{ch.name}</span>
                      </div>
                    ))}
                  </div>
                )) : flatChannels.map((ch, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] ${i === 0 ? 'bg-fill-hover text-white/70' : 'text-white/35'}`}
                  >
                    {ch.type === 'voice' ? <Volume2 size={12} className="shrink-0 opacity-50" /> : <Hash size={12} className="shrink-0 opacity-50" />}
                    <span className="truncate">{ch.name}</span>
                  </div>
                ))}
              </div>

              {/* Roles + summary row */}
              <div className="flex flex-wrap gap-2 mb-4">
                {roles.length > 0 && roles.map((role, i) => (
                  <span key={i} className="flex items-center gap-1.5 bg-fill-hover border border-default rounded-lg px-2.5 py-1 text-[10px] text-white/45">
                    <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: role.color || '#99aab5' }} />
                    {role.name}
                  </span>
                ))}
                <span className="bg-fill-hover border border-default rounded-lg px-2.5 py-1 text-[10px] text-white/30">
                  {categories.length} cat &middot; {totalChannels} ch &middot; {roles.length} roles
                </span>
              </div>

              {/* Divider */}
              <div className="border-t border-default mb-4" />

              {/* Creation form */}
              <div className="flex gap-4 items-start">
                {/* Icon upload */}
                <div className="shrink-0">
                  <button
                    type="button"
                    onClick={() => iconFileInputRef.current?.click()}
                    disabled={iconUploading}
                    className="relative w-[72px] h-[72px] rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-fill-hover hover:bg-fill-hover hover:border-[var(--border-strong)] transition-all flex flex-col items-center justify-center gap-0.5 group cursor-pointer overflow-hidden"
                  >
                    {iconUrl ? (
                      <LazyGif src={iconUrl} frameSrc={getFrameUrl(iconUrl)} alt="Server icon" className="absolute inset-0 w-full h-full object-cover rounded-2xl" />
                    ) : iconUploading ? (
                      <Loader2 size={18} className="text-white/30 animate-spin" />
                    ) : (
                      <>
                        <Camera size={16} className="text-white/25 group-hover:text-white/40 transition-colors" />
                        <span className="text-[8px] font-medium text-white/25 group-hover:text-white/40 transition-colors">{t('template.addIcon')}</span>
                      </>
                    )}
                    {!iconUrl && !iconUploading && (
                      <div
                        className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                        style={{ background: 'var(--cyan-accent)' }}
                      >
                        <Plus size={10} className="text-[rgba(0,30,30,0.95)]" />
                      </div>
                    )}
                  </button>
                  <p className="text-[9px] text-white/20 text-center mt-1">{t('template.optional')}</p>
                </div>

                {/* Server name */}
                <div className="flex-1 min-w-0">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-white/40 block mb-2">{t('template.serverNameLabel')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={serverName}
                    onChange={(e) => { setServerName(e.target.value); setCreateError(null); }}
                    placeholder="My server"
                    className="w-full bg-fill-hover border border-default rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:border-[var(--fill-strong)] focus:bg-fill-hover outline-none transition-all"
                    disabled={creating}
                    maxLength={100}
                  />
                </div>
              </div>

              {uploadError && <p className="text-red-400 text-xs font-medium mt-2">{uploadError}</p>}
              {createError && <p className="text-red-400 text-xs font-medium mt-2">{createError}</p>}
            </div>

            {/* Bottom bar */}
            <div className="px-6 py-4 border-t border-default flex items-center justify-between">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-xs font-medium text-white/40 hover:text-white/70 transition-colors"
              >
                {t('template.cancel')}
              </button>
              <button
                type="button"
                disabled={!serverName.trim() || creating}
                onClick={handleCreate}
                className="btn-cta px-6 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {creating ? t('template.creating') : t('template.createFromThis')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
