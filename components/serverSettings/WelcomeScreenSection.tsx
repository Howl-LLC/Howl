// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareHeart, Plus, Trash2, ChevronUp, ChevronDown, Hash, Volume2, Megaphone } from 'lucide-react';
import { Server, serverHasPerm, Channel } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import type { WelcomeScreen, WelcomeChannelEntry } from '../../services/api/community';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/modal';
import { Dropdown } from '../ui/dropdown';
import { Button } from '../ui/button';
import {
  SectionHeader,
  Card,
  Toggle,
  SettingRow,
  PrimaryButton,
  EmptyState,
} from '../settings/SettingsWidgets';

const MAX_WELCOME_CHANNELS = 5;

export interface WelcomeScreenSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

function channelIcon(type: Channel['type']) {
  if (type === 'voice') return <Volume2 size={13} />;
  if (type === 'stage') return <Megaphone size={13} />;
  return <Hash size={13} />;
}

export const WelcomeScreenSection: React.FC<WelcomeScreenSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const canManage = serverHasPerm(server, 'manageServer');

  const [data, setData] = useState<WelcomeScreen | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDescription, setSavingDescription] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [description, setDescription] = useState('');
  const [savingChannel, setSavingChannel] = useState(false);

  // Add-channel modal
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerChannelId, setPickerChannelId] = useState<string>('');
  const [pickerDescription, setPickerDescription] = useState('');
  const [pickerEmoji, setPickerEmoji] = useState('');

  // Edit-row state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraftDescription, setEditDraftDescription] = useState('');
  const [editDraftEmoji, setEditDraftEmoji] = useState('');

  // Available channels (text/announcement-style only)
  const eligibleChannels = useMemo(
    () => (server.channels ?? []).filter((c) => c.type === 'text'),
    [server.channels],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiClient.serverWelcomeGet(server.id);
      setData(next);
      setEnabled(next.welcomeScreenEnabled);
      setDescription(next.welcomeScreenDescription ?? '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('welcomeScreen.loadFailed', { defaultValue: 'Failed to load welcome screen' });
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [server.id, showToast, t]);

  useEffect(() => { if (canManage) refresh(); }, [canManage, refresh]);

  // Live sync: when any admin updates the welcome screen (toggle, description,
  // channel add/edit/remove/reorder), backend emits `server-welcome-updated`
  // with the full welcome payload. We can adopt it directly without refetching.
  useEffect(() => {
    if (!canManage) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string; welcome: WelcomeScreen }) => {
      if (payload.serverId !== server.id || !payload.welcome) return;
      setData(payload.welcome);
      setEnabled(payload.welcome.welcomeScreenEnabled);
      setDescription(payload.welcome.welcomeScreenDescription ?? '');
    };
    sock.on('server-welcome-updated', handler);
    return () => { sock.off('server-welcome-updated', handler); };
  }, [canManage, server.id]);

  const persistTopLevel = useCallback(async (updates: Partial<Pick<WelcomeScreen, 'welcomeScreenEnabled' | 'welcomeScreenDescription'>>) => {
    setSavingDescription(true);
    try {
      const next = await apiClient.serverWelcomePatch(server.id, updates);
      setData(next);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('welcomeScreen.saveFailed', { defaultValue: 'Failed to save welcome screen' }), 'error');
    } finally {
      setSavingDescription(false);
    }
  }, [server.id, showToast, t]);

  const handleAddChannel = useCallback(async () => {
    if (!pickerChannelId || !pickerDescription.trim()) return;
    if ((data?.welcomeChannels.length ?? 0) >= MAX_WELCOME_CHANNELS) {
      showToast(t('welcomeScreen.maxReached', { defaultValue: 'Maximum of 5 welcome channels' }), 'error');
      return;
    }
    setSavingChannel(true);
    try {
      const entry = await apiClient.serverWelcomeChannelAdd(server.id, {
        channelId: pickerChannelId,
        description: pickerDescription.trim().slice(0, 200),
        emoji: pickerEmoji.trim() || null,
        position: (data?.welcomeChannels.length ?? 0),
      });
      setData((prev) => prev ? { ...prev, welcomeChannels: [...prev.welcomeChannels, entry] } : prev);
      setPickerOpen(false);
      setPickerChannelId('');
      setPickerDescription('');
      setPickerEmoji('');
      showToast(t('welcomeScreen.added', { defaultValue: 'Welcome channel added' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('welcomeScreen.addFailed', { defaultValue: 'Failed to add welcome channel' }), 'error');
    } finally {
      setSavingChannel(false);
    }
  }, [pickerChannelId, pickerDescription, pickerEmoji, data, server.id, showToast, t]);

  const handleRemove = useCallback(async (entry: WelcomeChannelEntry) => {
    try {
      await apiClient.serverWelcomeChannelDelete(server.id, entry.id);
      setData((prev) => prev ? { ...prev, welcomeChannels: prev.welcomeChannels.filter((c) => c.id !== entry.id) } : prev);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('welcomeScreen.removeFailed', { defaultValue: 'Failed to remove channel' }), 'error');
    }
  }, [server.id, showToast, t]);

  const handleReorder = useCallback(async (entry: WelcomeChannelEntry, direction: 'up' | 'down') => {
    if (!data) return;
    const list = [...data.welcomeChannels].sort((a, b) => a.position - b.position);
    const idx = list.findIndex((c) => c.id === entry.id);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    const tmp = list[idx];
    list[idx] = list[targetIdx];
    list[targetIdx] = tmp;
    const reposed = list.map((c, i) => ({ ...c, position: i }));
    setData({ ...data, welcomeChannels: reposed });
    try {
      // Persist both swapped entries' new positions
      await Promise.all([
        apiClient.serverWelcomeChannelUpdate(server.id, list[idx].id, { position: idx }),
        apiClient.serverWelcomeChannelUpdate(server.id, list[targetIdx].id, { position: targetIdx }),
      ]);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('welcomeScreen.reorderFailed', { defaultValue: 'Failed to reorder' }), 'error');
      refresh();
    }
  }, [data, refresh, server.id, showToast, t]);

  const startEditRow = (entry: WelcomeChannelEntry) => {
    setEditingId(entry.id);
    setEditDraftDescription(entry.description);
    setEditDraftEmoji(entry.emoji ?? '');
  };

  const saveEditRow = useCallback(async () => {
    if (!editingId) return;
    try {
      const updated = await apiClient.serverWelcomeChannelUpdate(server.id, editingId, {
        description: editDraftDescription.trim().slice(0, 200),
        emoji: editDraftEmoji.trim() || null,
      });
      setData((prev) => prev ? { ...prev, welcomeChannels: prev.welcomeChannels.map((c) => c.id === updated.id ? updated : c) } : prev);
      setEditingId(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('welcomeScreen.saveFailed', { defaultValue: 'Failed to save welcome screen' }), 'error');
    }
  }, [editingId, editDraftDescription, editDraftEmoji, server.id, showToast, t]);

  if (!canManage) {
    return (
      <div className="max-w-2xl">
        <SectionHeader title={t('welcomeScreen.title', { defaultValue: 'Welcome Screen' })} icon={<MessageSquareHeart size={24} />} />
        <EmptyState icon={<MessageSquareHeart size={40} />}
          title={t('welcomeScreen.noPermission', { defaultValue: 'You don\'t have permission to manage the welcome screen.' })}
          desc={t('welcomeScreen.noPermissionDesc', { defaultValue: 'Ask a server admin with the Manage Server permission.' })} />
      </div>
    );
  }

  const sortedChannels = (data?.welcomeChannels ?? []).slice().sort((a, b) => a.position - b.position);
  const channelsRemaining = MAX_WELCOME_CHANNELS - sortedChannels.length;
  const usedChannelIds = new Set(sortedChannels.map((c) => c.channelId));

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader
        title={t('welcomeScreen.title', { defaultValue: 'Welcome Screen' })}
        desc={t('welcomeScreen.headerDesc', { defaultValue: 'Greet new members with a guided tour of your server.' })}
        icon={<MessageSquareHeart size={24} />}
      />

      <Card accent={enabled}>
        <SettingRow
          title={t('welcomeScreen.toggleTitle', { defaultValue: 'Show welcome screen' })}
          desc={t('welcomeScreen.toggleDesc', { defaultValue: 'When enabled, new joiners see this screen on first message.' })}
        >
          <Toggle
            checked={enabled}
            disabled={loading || savingDescription}
            onChange={(v) => { setEnabled(v); persistTopLevel({ welcomeScreenEnabled: v }); }}
          />
        </SettingRow>
        {enabled && (
          <div className="mt-4 pt-4 border-t border-default">
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('welcomeScreen.descriptionLabel', { defaultValue: 'Welcome description' })}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 300))}
              onBlur={() => persistTopLevel({ welcomeScreenDescription: description.trim() || null })}
              rows={3}
              maxLength={300}
              placeholder={t('welcomeScreen.descriptionPlaceholder', { defaultValue: 'Welcome! Here\'s what makes our community special…' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
            />
            <p className="text-[11px] text-t-secondary mt-1 text-right tabular-nums">{description.length} / 300</p>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-t-primary">
              {t('welcomeScreen.channelsTitle', { defaultValue: 'Welcome channels' })}
            </p>
            <p className="text-[12px] text-t-secondary mt-0.5">
              {t('welcomeScreen.channelsDesc', { defaultValue: 'Up to 5 channels new members should check first.' })}
            </p>
          </div>
          <button type="button"
            onClick={() => { setPickerOpen(true); setPickerChannelId(''); setPickerDescription(''); setPickerEmoji(''); }}
            disabled={channelsRemaining <= 0 || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-default hover:bg-fill-hover transition-all text-sm text-t-accent disabled:opacity-40 disabled:cursor-not-allowed">
            <Plus size={14} /> {t('welcomeScreen.addChannel', { defaultValue: 'Add channel' })}
          </button>
        </div>
        {loading ? (
          <div className="py-10 text-center text-[12px] text-t-secondary">{t('serverSettings.loading')}</div>
        ) : sortedChannels.length === 0 ? (
          <EmptyState icon={<MessageSquareHeart size={32} />}
            title={t('welcomeScreen.noChannels', { defaultValue: 'No welcome channels yet' })}
            desc={t('welcomeScreen.noChannelsDesc', { defaultValue: 'Add up to 5 to get started.' })} />
        ) : (
          <ul className="space-y-2">
            {sortedChannels.map((entry, idx) => {
              const ch = (server.channels ?? []).find((c) => c.id === entry.channelId);
              const isEditing = editingId === entry.id;
              return (
                <li key={entry.id} className="rounded-xl border border-default bg-floating p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      <button type="button" onClick={() => handleReorder(entry, 'up')}
                        disabled={idx === 0}
                        className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary disabled:opacity-30 disabled:cursor-not-allowed">
                        <ChevronUp size={12} />
                      </button>
                      <button type="button" onClick={() => handleReorder(entry, 'down')}
                        disabled={idx === sortedChannels.length - 1}
                        className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary disabled:opacity-30 disabled:cursor-not-allowed">
                        <ChevronDown size={12} />
                      </button>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium text-t-primary">
                        {entry.emoji ? <span className="text-base leading-none">{entry.emoji}</span> : <span className="text-t-secondary">{channelIcon(ch?.type ?? 'text')}</span>}
                        <span>{ch?.name ?? entry.channelName ?? entry.channelId}</span>
                      </div>
                      {isEditing ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex gap-2">
                            <input
                              value={editDraftEmoji}
                              onChange={(e) => setEditDraftEmoji(e.target.value.slice(0, 8))}
                              maxLength={8}
                              placeholder="🎉"
                              className="w-16 rounded-lg px-2 py-1.5 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary text-center"
                            />
                            <input
                              value={editDraftDescription}
                              onChange={(e) => setEditDraftDescription(e.target.value.slice(0, 200))}
                              maxLength={200}
                              placeholder={t('welcomeScreen.channelDescPlaceholder', { defaultValue: 'What members will find here' })}
                              className="flex-1 rounded-lg px-3 py-1.5 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
                              autoFocus
                            />
                          </div>
                          <div className="flex gap-2 justify-end">
                            <button type="button" onClick={() => setEditingId(null)} className="text-[12px] text-t-secondary hover:text-t-primary transition-colors px-2 py-1">
                              {t('common.cancel')}
                            </button>
                            <button type="button" onClick={saveEditRow} className="btn-cta text-[12px] px-3 py-1 transition-all">
                              {t('common.save', { defaultValue: 'Save' })}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => startEditRow(entry)}
                          className="mt-1 text-[12px] text-t-secondary text-left hover:text-t-primary transition-colors w-full truncate">
                          {entry.description || t('welcomeScreen.noDescription', { defaultValue: 'Click to add a description' })}
                        </button>
                      )}
                    </div>
                    <button type="button" onClick={() => handleRemove(entry)}
                      className="p-1.5 rounded-md hover:bg-red-400/15 text-t-secondary hover:text-red-400 transition-colors shrink-0">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ─── Add channel modal ────────────────────────────────────────────── */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} size="md">
        <ModalHeader>
          <h3 className="text-lg font-semibold text-t-primary">{t('welcomeScreen.addChannel', { defaultValue: 'Add welcome channel' })}</h3>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('welcomeScreen.pickChannel', { defaultValue: 'Channel' })}
            </label>
            <Dropdown
              value={pickerChannelId}
              onChange={setPickerChannelId}
              options={[
                { value: '', label: t('welcomeScreen.selectChannel', { defaultValue: 'Select a channel…' }) },
                ...eligibleChannels
                  .filter((c) => !usedChannelIds.has(c.id))
                  .map((c) => ({ value: c.id, label: `# ${c.name}` })),
              ]}
              size="md"
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('welcomeScreen.emojiOptional', { defaultValue: 'Emoji (optional)' })}
            </label>
            <input
              value={pickerEmoji}
              onChange={(e) => setPickerEmoji(e.target.value.slice(0, 8))}
              maxLength={8}
              placeholder="🎉"
              className="w-24 rounded-xl px-3 py-2.5 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary text-center"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-2 text-t-secondary">
              {t('welcomeScreen.channelDescription', { defaultValue: 'Description' })}
            </label>
            <textarea
              value={pickerDescription}
              onChange={(e) => setPickerDescription(e.target.value.slice(0, 200))}
              rows={3}
              maxLength={200}
              placeholder={t('welcomeScreen.channelDescPlaceholder', { defaultValue: 'What members will find here' })}
              className="w-full rounded-xl px-4 py-3 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
            />
            <p className="text-[11px] text-t-secondary mt-1 text-right tabular-nums">{pickerDescription.length} / 200</p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="md" onClick={() => setPickerOpen(false)}>{t('common.cancel')}</Button>
          <PrimaryButton onClick={handleAddChannel} disabled={!pickerChannelId || !pickerDescription.trim() || savingChannel} loading={savingChannel}>
            {t('welcomeScreen.add', { defaultValue: 'Add' })}
          </PrimaryButton>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default WelcomeScreenSection;
