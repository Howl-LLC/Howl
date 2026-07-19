// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import type { ShowcaseCard } from '../../services/api/gameAccounts';
import { GAME_NAMES, GAME_COLORS } from './cardRenderers';
import { Dropdown } from '../ui/dropdown';

const COLOR_PRESETS: (string | null)[] = [
  null,
  'rgba(220,50,50,0.6)',
  'rgba(102,192,244,0.6)',
  'rgba(30,185,128,0.6)',
  'rgba(220,180,50,0.6)',
  'rgba(140,80,220,0.6)',
  'rgba(255,255,255,0.1)',
];

interface MobileCardEditorProps {
  card: ShowcaseCard;
  allowedSizes: string[];
  isMobileGrid?: boolean;
  seasons?: Array<{ seasonId: number; rankName: string | null; rankPoints?: number; rankScore?: number; seasonName?: string | null; seasonFullName?: string | null }>;
  availableStats?: Array<{ key: string; label: string }>;
  maxStats?: number;
  maxSeasons?: number;
  onSizeChange: (size: string) => void;
  onColorChange: (color: string | null) => void;
  onConfigChange: (config: Record<string, unknown>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onClose: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export const MobileCardEditor: React.FC<MobileCardEditorProps> = ({
  card, allowedSizes, isMobileGrid, seasons, availableStats, maxStats, maxSeasons, onSizeChange, onColorChange, onConfigChange,
  onMoveUp, onMoveDown, onDelete, onClose, isFirst, isLast,
}) => {
  const gameName = card.game ? (GAME_NAMES[card.game] || card.game) : card.type;
  const typeLabel = card.type === 'game_rank' ? 'Rank' : card.type === 'game_stats' ? 'Stats' : card.type === 'rank_timeline' ? 'Timeline' : card.type.replace(/_/g, ' ');

  // Filter sizes for mobile grid (max 2 columns)
  const sizes = isMobileGrid
    ? allowedSizes.filter(s => { const [c] = s.split('x').map(Number); return c <= 2; })
    : allowedSizes;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9100] bg-black/50" onClick={onClose} />

      {/* Bottom sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-[9101] bg-panel border-t border-[var(--glass-border)] rounded-t-2xl p-4"
        style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {/* Drag indicator */}
        <div className="w-8 h-0.5 rounded-full mx-auto mb-3" style={{ backgroundColor: 'var(--fill-active)' }} />

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-bold text-t-primary">{gameName}</p>
            <p className="text-[10px] text-t-secondary capitalize">{typeLabel} card</p>
          </div>
          <button type="button" onClick={onDelete}
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: 'rgba(220,50,50,0.1)' }}>
            <Trash2 size={14} style={{ color: 'rgba(220,50,50,0.6)' }} />
          </button>
        </div>

        {/* Size selector */}
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-t-secondary mb-2">Size</p>
          <div className="flex gap-1.5 flex-wrap">
            {sizes.map(size => (
              <button key={size} type="button" onClick={() => onSizeChange(size)}
                className="h-11 px-3 rounded-lg text-xs font-semibold transition-all"
                style={{
                  backgroundColor: card.size === size ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                  border: `1px solid ${card.size === size ? 'color-mix(in srgb, var(--cyan-accent) 30%, transparent)' : 'var(--glass-border)'}`,
                  color: card.size === size ? '#fff' : 'var(--text-secondary)',
                }}>
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* Color selector */}
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-t-secondary mb-2">Color</p>
          <div className="flex gap-2">
            {COLOR_PRESETS.map((c, i) => (
              <button key={i} type="button" onClick={() => onColorChange(c)}
                className="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  backgroundColor: c || (card.game ? GAME_COLORS[card.game] || 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.1)'),
                  borderColor: card.color === c ? 'white' : 'var(--fill-strong)',
                }} />
            ))}
          </div>
        </div>

        {/* Season picker */}
        {card.type === 'game_rank' && seasons && seasons.length > 1 && (() => {
          const [cardCols, cardRows] = (card.size || '1x1').split('x').map(Number);
          const isMultiSize = cardCols > 1 || cardRows > 1;

          if (!isMultiSize) {
            return (
              <div className="mb-4">
                <p className="text-[11px] font-semibold text-t-secondary mb-2">Season</p>
                <Dropdown
                  options={seasons.map(s => ({
                    value: s.seasonId,
                    label: `${s.seasonName || `S${s.seasonId}`}: ${s.rankName || 'Unranked'}${s.seasonFullName ? ` (${s.seasonFullName})` : ''}`,
                  }))}
                  value={(card.config?.seasonId as number) || seasons[0]?.seasonId}
                  onChange={(v) => onConfigChange({ seasonId: v })}
                  size="md"
                />
              </div>
            );
          }

          const max = maxSeasons || 4;
          const selectedSeasons = (card.config?.selectedSeasons as number[]) || [];
          const effectiveSelected = selectedSeasons.length > 0 ? selectedSeasons : seasons.slice(0, max).map(s => s.seasonId);

          return (
            <div className="mb-4">
              <p className="text-[11px] font-semibold text-t-secondary mb-2">
                Seasons ({effectiveSelected.length}/{max})
              </p>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto rounded-lg p-1" style={{ backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid var(--glass-border)' }}>
                {seasons.map(s => {
                  const isSelected = effectiveSelected.includes(s.seasonId);
                  const isCurrent = s.seasonId === seasons[0]?.seasonId;
                  return (
                    <button key={s.seasonId} type="button"
                      onClick={() => {
                        let next: number[];
                        if (isSelected) {
                          next = effectiveSelected.filter(id => id !== s.seasonId);
                        } else if (effectiveSelected.length < max) {
                          next = [...effectiveSelected, s.seasonId];
                        } else {
                          next = effectiveSelected;
                        }
                        onConfigChange({ selectedSeasons: next });
                      }}
                      className="flex items-center gap-2 px-3 h-9 rounded-lg text-[11px] transition-colors text-left"
                      style={{
                        backgroundColor: isSelected ? 'var(--cta-bg, #02385A)' : 'transparent',
                        color: isSelected ? '#fff' : 'var(--text-secondary)',
                      }}>
                      <div className="w-4 h-4 rounded-lg border flex items-center justify-center shrink-0"
                        style={{
                          borderColor: isSelected ? 'var(--cyan-accent)' : 'var(--fill-strong)',
                          backgroundColor: isSelected ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'transparent',
                        }}>
                        {isSelected && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cyan-accent)" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                        )}
                      </div>
                      <span className="flex-1 truncate">
                        {s.seasonName || `S${s.seasonId}`}{isCurrent ? ' · NOW' : ''}: {s.rankName || 'Unranked'}
                        {s.seasonFullName ? ` · ${s.seasonFullName}` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Stat picker for game_stats cards */}
        {card.type === 'game_stats' && availableStats && availableStats.length > 0 && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold text-t-secondary mb-2">
              Stats ({((card.config?.stats as string[]) || []).length}/{maxStats || 3})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {availableStats.map(s => {
                const selected = ((card.config?.stats as string[]) || []).includes(s.key);
                return (
                  <button key={s.key} type="button"
                    onClick={() => {
                      const current = (card.config?.stats as string[]) || [];
                      const max = maxStats || 3;
                      const next = selected
                        ? current.filter(k => k !== s.key)
                        : current.length < max ? [...current, s.key] : current;
                      onConfigChange({ stats: next });
                    }}
                    className="text-[11px] px-3 h-11 rounded-lg transition-colors"
                    style={{
                      backgroundColor: selected ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                      color: selected ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${selected ? 'color-mix(in srgb, var(--cyan-accent) 25%, transparent)' : 'var(--glass-border)'}`,
                    }}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Custom text editor */}
        {card.type === 'custom_text' && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold text-t-secondary mb-2">Text</p>
            <textarea
              className="w-full h-20 px-3 py-2 rounded-lg text-xs outline-none resize-none"
              style={{ backgroundColor: 'rgba(0,0,0,0.4)', color: 'var(--text-secondary)', border: '1px solid var(--glass-border)' }}
              maxLength={200}
              value={(card.config?.text as string) || ''}
              onChange={(e) => onConfigChange({ text: e.target.value })}
              placeholder="Enter your text..."
            />
          </div>
        )}

        {/* Position controls */}
        <div className="mb-2">
          <p className="text-[11px] font-semibold text-t-secondary mb-2">Position</p>
          <div className="flex gap-2">
            <button type="button" onClick={onMoveUp} disabled={isFirst}
              className="flex-1 h-11 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold disabled:opacity-30"
              style={{ backgroundColor: 'var(--fill-hover)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
              <ChevronUp size={12} /> Move up
            </button>
            <button type="button" onClick={onMoveDown} disabled={isLast}
              className="flex-1 h-11 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold disabled:opacity-30"
              style={{ backgroundColor: 'var(--fill-hover)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
              <ChevronDown size={12} /> Move down
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
