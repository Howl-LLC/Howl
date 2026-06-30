// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Smile, Image, Music, Plus, Trash2, Upload, Play, Volume2 } from 'lucide-react';
import { Server } from '../../types';
import type { CustomEmoji as CustomEmojiType, ServerSticker, SoundboardSound } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { SectionHeader, Card, InputField, PrimaryButton, EmptyState, ConfirmDialog } from '../settings/SettingsWidgets';

// Common props

interface ContentSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// EmojiSection

export const EmojiSection: React.FC<ContentSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const [customEmojis, setCustomEmojis] = useState<CustomEmojiType[]>([]);
  const [emojisLoading, setEmojisLoading] = useState(false);
  const [emojiName, setEmojiName] = useState('');
  const [emojiFile, setEmojiFile] = useState<File | null>(null);
  const [emojiUploading, setEmojiUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const emojiFileRef = useRef<HTMLInputElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  useEffect(() => {
    setEmojisLoading(true);
    apiClient.getServerEmojis(server.id).then(setCustomEmojis).catch(() => showToast(t('serverSettings.failedToLoadEmoji'), 'error')).finally(() => setEmojisLoading(false));
  }, [server.id]);

  // Live sync: another admin uploading or removing an emoji emits
  // `server-emoji-created` / `server-emoji-deleted`. Refetch the list.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getServerEmojis(server.id).then(setCustomEmojis).catch(() => {});
    };
    sock.on('server-emoji-created', handler);
    sock.on('server-emoji-deleted', handler);
    return () => {
      sock.off('server-emoji-created', handler);
      sock.off('server-emoji-deleted', handler);
    };
  }, [server.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.emoji')} desc={t('serverSettings.emojiDesc')} icon={<Smile size={24} />} />
      <Card>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.uploadEmoji')}</p>
        <div className="flex gap-3 items-end">
          <InputField label={t('serverSettings.name')} value={emojiName} onChange={(e) => setEmojiName((e.target as HTMLInputElement).value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))} placeholder="emoji_name" className="flex-1" maxLength={32} />
          <div className="flex-1">
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.image')}</label>
            <input ref={emojiFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { if (e.target.files?.[0]) setEmojiFile(e.target.files[0]); }} />
            <button type="button" onClick={() => emojiFileRef.current?.click()}
              className="w-full flex items-center gap-2 rounded-xl px-4 py-3 text-sm border outline-none hover:bg-fill-hover transition-all text-left"
              style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: emojiFile ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              <Upload size={14} className="shrink-0 opacity-60" />
              <span className="truncate">{emojiFile ? emojiFile.name : t('serverSettings.chooseImage')}</span>
            </button>
          </div>
          <PrimaryButton loading={emojiUploading} disabled={!emojiName.trim() || !emojiFile || emojiUploading} onClick={async () => {
            if (!emojiFile) return;
            setEmojiUploading(true); setUploadError(null);
            try {
              const r = await apiClient.uploadFile(emojiFile);
              await apiClient.uploadServerEmoji(server.id, emojiName, r.url);
              setEmojiName(''); setEmojiFile(null); if (emojiFileRef.current) emojiFileRef.current.value = '';
              setCustomEmojis(await apiClient.getServerEmojis(server.id));
              showToast(t('serverSettings.emojiAdded'));
            } catch (err) { showToast(err instanceof Error ? err.message : t('serverSettings.uploadFailed'), 'error'); }
            setEmojiUploading(false);
          }}><Plus size={14} className="inline mr-1" /> {t('serverSettings.add')}</PrimaryButton>
        </div>
        {uploadError && <p className="text-sm text-red-400 mt-2">{uploadError}</p>}
      </Card>
      {emojisLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        customEmojis.length === 0 ? <EmptyState icon={<Smile size={40} />} title={t('serverSettings.noCustomEmoji')} desc={t('serverSettings.uploadFirstEmoji')} /> :
        <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2">
          {customEmojis.map((e) => (
            <div key={e.id} className="group relative flex flex-col items-center gap-1 p-2 rounded-xl hover:bg-fill-hover transition-all">
              <img src={sanitizeImgSrc(e.imageUrl)} alt={e.name} className="w-10 h-10 object-contain" loading="lazy" decoding="async" width={40} height={40} />
              <span className="text-[9px] truncate w-full text-center" style={{ color: 'var(--text-secondary)' }}>:{e.name}:</span>
              <button type="button" onClick={() => setConfirmDialog({ title: t('serverSettings.deleteEmoji'), desc: t('serverSettings.removeEmojiConfirm', { name: e.name }), confirmLabel: t('common.delete'), danger: true, onConfirm: async () => { await apiClient.deleteServerEmoji(server.id, e.id); setCustomEmojis(await apiClient.getServerEmojis(server.id)); setConfirmDialog(null); showToast(t('serverSettings.emojiRemoved')); } })}
                className="absolute top-0.5 right-0.5 p-1 rounded-full opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      }
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};

// StickersSection

export const StickersSection: React.FC<ContentSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const [stickers, setStickers] = useState<ServerSticker[]>([]);
  const [stickersLoading, setStickersLoading] = useState(false);
  const [stickerName, setStickerName] = useState('');
  const [stickerFile, setStickerFile] = useState<File | null>(null);
  const [stickerUploading, setStickerUploading] = useState(false);
  const [stickerDesc, setStickerDesc] = useState('');
  const [_uploadError, setUploadError] = useState<string | null>(null);
  const stickerFileRef = useRef<HTMLInputElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  useEffect(() => {
    setStickersLoading(true);
    apiClient.getServerStickers(server.id).then(setStickers).catch(() => showToast(t('serverSettings.failedToLoadStickers'), 'error')).finally(() => setStickersLoading(false));
  }, [server.id]);

  // Live sync: refetch when another admin adds or removes a sticker.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getServerStickers(server.id).then(setStickers).catch(() => {});
    };
    sock.on('server-sticker-created', handler);
    sock.on('server-sticker-deleted', handler);
    return () => {
      sock.off('server-sticker-created', handler);
      sock.off('server-sticker-deleted', handler);
    };
  }, [server.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.stickers')} desc={t('serverSettings.stickersDesc')} icon={<Image size={24} />} />
      <Card>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.uploadSticker')}</p>
        <div className="grid grid-cols-3 gap-3">
          <InputField label={t('serverSettings.name')} value={stickerName} onChange={(e) => setStickerName((e.target as HTMLInputElement).value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))} placeholder="sticker_name" maxLength={32} />
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.image')}</label>
            <input ref={stickerFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { if (e.target.files?.[0]) setStickerFile(e.target.files[0]); }} />
            <button type="button" onClick={() => stickerFileRef.current?.click()}
              className="w-full flex items-center gap-2 rounded-xl px-4 py-3 text-sm border outline-none hover:bg-fill-hover transition-all text-left"
              style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: stickerFile ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              <Upload size={14} className="shrink-0 opacity-60" />
              <span className="truncate">{stickerFile ? stickerFile.name : t('serverSettings.chooseImage')}</span>
            </button>
          </div>
          <InputField label={t('serverSettings.description')} value={stickerDesc} onChange={(e) => setStickerDesc((e.target as HTMLInputElement).value)} placeholder={t('common.optional')} />
        </div>
        <PrimaryButton className="mt-3" loading={stickerUploading} disabled={!stickerName.trim() || !stickerFile || stickerUploading} onClick={async () => {
          if (!stickerFile) return;
          setStickerUploading(true); setUploadError(null);
          try {
            const r = await apiClient.uploadFile(stickerFile);
            await apiClient.uploadServerSticker(server.id, stickerName, r.url, stickerDesc || undefined);
            setStickerName(''); setStickerFile(null); setStickerDesc(''); if (stickerFileRef.current) stickerFileRef.current.value = '';
            setStickers(await apiClient.getServerStickers(server.id));
            showToast(t('serverSettings.stickerAdded'));
          } catch (err) { showToast(err instanceof Error ? err.message : t('serverSettings.uploadFailed'), 'error'); }
          setStickerUploading(false);
        }}><Plus size={14} className="inline mr-1" /> {t('serverSettings.add')}</PrimaryButton>
      </Card>
      {stickersLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        stickers.length === 0 ? <EmptyState icon={<Image size={40} />} title={t('serverSettings.noStickers')} desc={t('serverSettings.uploadFirstSticker')} /> :
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          {stickers.map((s) => (
            <div key={s.id} className="group relative flex flex-col items-center gap-1.5 p-3 rounded-2xl border hover:bg-fill-hover transition-all" style={{ borderColor: 'var(--border-subtle)' }}>
              <img src={sanitizeImgSrc(s.imageUrl)} alt={s.name} className="w-16 h-16 object-contain" loading="lazy" decoding="async" width={64} height={64} />
              <span className="text-[11px] font-medium truncate w-full text-center" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
              {s.description && <span className="text-[9px] truncate w-full text-center" style={{ color: 'var(--text-secondary)' }}>{s.description}</span>}
              <button type="button" onClick={() => setConfirmDialog({ title: t('serverSettings.deleteSticker'), desc: t('serverSettings.removeConfirm', { name: s.name }), confirmLabel: t('common.delete'), danger: true, onConfirm: async () => { await apiClient.deleteServerSticker(server.id, s.id); setStickers(await apiClient.getServerStickers(server.id)); setConfirmDialog(null); showToast(t('serverSettings.stickerRemoved')); } })}
                className="absolute top-1 right-1 p-1 rounded-full opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      }
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};

// SoundboardSection

export const SoundboardSection: React.FC<ContentSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const [sounds, setSounds] = useState<SoundboardSound[]>([]);
  const [soundsLoading, setSoundsLoading] = useState(false);
  const [soundName, setSoundName] = useState('');
  const [soundFile, setSoundFile] = useState<File | null>(null);
  const [soundUploading, setSoundUploading] = useState(false);
  const [soundEmoji, setSoundEmoji] = useState('');
  const [soundVolume, setSoundVolume] = useState(1);
  const [_uploadError, setUploadError] = useState<string | null>(null);
  const soundFileRef = useRef<HTMLInputElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);

  useEffect(() => {
    setSoundsLoading(true);
    apiClient.getServerSounds(server.id).then(setSounds).catch(() => showToast(t('serverSettings.failedToLoadSounds'), 'error')).finally(() => setSoundsLoading(false));
  }, [server.id]);

  // Live sync: refetch when another admin adds or removes a soundboard clip.
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string }) => {
      if (payload.serverId !== server.id) return;
      apiClient.getServerSounds(server.id).then(setSounds).catch(() => {});
    };
    sock.on('server-soundboard-created', handler);
    sock.on('server-soundboard-deleted', handler);
    return () => {
      sock.off('server-soundboard-created', handler);
      sock.off('server-soundboard-deleted', handler);
    };
  }, [server.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader title={t('serverSettings.soundboard')} desc={t('serverSettings.soundboardDesc')} icon={<Music size={24} />} />
      <Card>
        <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.uploadSound')}</p>
        <div className="grid grid-cols-2 gap-3">
          <InputField label={t('serverSettings.name')} value={soundName} onChange={(e) => setSoundName((e.target as HTMLInputElement).value.replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 32))} placeholder="sound_name" maxLength={32} />
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.audioFile')}</label>
            <input ref={soundFileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) setSoundFile(e.target.files[0]); }} />
            <button type="button" onClick={() => soundFileRef.current?.click()}
              className="w-full flex items-center gap-2 rounded-xl px-4 py-3 text-sm border outline-none hover:bg-fill-hover transition-all text-left"
              style={{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-subtle)', color: soundFile ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              <Upload size={14} className="shrink-0 opacity-60" />
              <span className="truncate">{soundFile ? soundFile.name : t('serverSettings.chooseAudio')}</span>
            </button>
          </div>
          <InputField label={t('serverSettings.emojiOptional')} value={soundEmoji} onChange={(e) => setSoundEmoji((e.target as HTMLInputElement).value)} placeholder="🔊" />
          <div>
            <label className="block text-[11px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.volumeLabel', { percent: Math.round(soundVolume * 100) })}</label>
            <input type="range" min="0" max="1" step="0.05" value={soundVolume} onChange={(e) => setSoundVolume(parseFloat(e.target.value))} className="w-full accent-[var(--cyan-accent)] mt-2" />
          </div>
        </div>
        <PrimaryButton className="mt-3" loading={soundUploading} disabled={!soundName.trim() || !soundFile || soundUploading} onClick={async () => {
          if (!soundFile) return;
          setSoundUploading(true); setUploadError(null);
          try {
            const r = await apiClient.uploadFile(soundFile);
            await apiClient.uploadServerSound(server.id, soundName, r.url, soundEmoji || undefined, soundVolume);
            setSoundName(''); setSoundFile(null); setSoundEmoji(''); setSoundVolume(1); if (soundFileRef.current) soundFileRef.current.value = '';
            setSounds(await apiClient.getServerSounds(server.id));
            showToast(t('serverSettings.soundAdded'));
          } catch (err) { showToast(err instanceof Error ? err.message : t('serverSettings.uploadFailed'), 'error'); }
          setSoundUploading(false);
        }}><Plus size={14} className="inline mr-1" /> {t('serverSettings.add')}</PrimaryButton>
      </Card>
      {soundsLoading ? <EmptyState icon={<span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />} title={t('serverSettings.loading')} desc="" /> :
        sounds.length === 0 ? <EmptyState icon={<Volume2 size={40} />} title={t('serverSettings.noSounds')} desc={t('serverSettings.uploadFirstSound')} /> :
        <div className="space-y-2">
          {sounds.map((s) => (
            <div key={s.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border hover:bg-fill-hover transition-all" style={{ borderColor: 'var(--border-subtle)' }}>
              <button type="button" onClick={() => { const url = s.audioUrl; if (!url || (!url.startsWith('/') && !url.startsWith(window.location.origin))) return; const a = new Audio(url); a.volume = s.volume; a.play(); }}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-fill-active transition-all" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--cyan-accent)' }}>
                <Play size={16} />
              </button>
              <span className="text-lg">{s.emoji || '🔊'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</p>
                <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('serverSettings.volumePercent', { percent: Math.round(s.volume * 100) })}</p>
              </div>
              <button type="button" onClick={() => setConfirmDialog({ title: t('serverSettings.deleteSound'), desc: t('serverSettings.removeConfirm', { name: s.name }), confirmLabel: t('common.delete'), danger: true, onConfirm: async () => { await apiClient.deleteServerSound(server.id, s.id); setSounds(await apiClient.getServerSounds(server.id)); setConfirmDialog(null); showToast(t('serverSettings.soundRemoved')); } })}
                className="p-2 rounded-lg hover:bg-red-500/20 transition-all" style={{ color: 'var(--text-secondary)' }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      }
      {confirmDialog && <ConfirmDialog title={confirmDialog.title} desc={confirmDialog.desc} confirmLabel={confirmDialog.confirmLabel} danger={confirmDialog.danger} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
};

export default EmojiSection;
