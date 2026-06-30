// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { ProfileBadges, BADGE_DEFAULT_ORDER } from '../ProfileBadges';
import { Toggle, SettingsSection } from './SettingsWidgets';

export type BadgeDisplayValue = { hidden: string[]; order: string[] };

/** Order the earned set by the user's saved `order`, then canonical default, then any extras. */
export function orderedEarned(earned: string[], order: string[]): string[] {
  const inEarned = new Set(earned);
  const result: string[] = [];
  const push = (k: string) => { if (inEarned.has(k) && !result.includes(k)) result.push(k); };
  for (const k of order) push(k);
  for (const k of BADGE_DEFAULT_ORDER) push(k);
  for (const k of earned) push(k);
  return result;
}

interface BadgeDisplaySectionProps {
  earned: string[];
  value: BadgeDisplayValue;
  disabled: boolean;
  onChange: (next: BadgeDisplayValue) => void;
}

export function BadgeDisplaySection({ earned, value, disabled, onChange }: BadgeDisplaySectionProps) {
  const { t } = useTranslation();
  const dragKeyRef = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const rows = orderedEarned(earned, value.order);
  const hiddenSet = new Set(value.hidden);

  const toggle = useCallback((key: string, show: boolean) => {
    const hidden = show
      ? value.hidden.filter((k) => k !== key)
      : [...new Set([...value.hidden, key])];
    onChange({ hidden, order: value.order });
  }, [value, onChange]);

  const handleDragStart = useCallback((e: React.DragEvent, key: string) => {
    dragKeyRef.current = key;
    setDragKey(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    const dragged = dragKeyRef.current;
    dragKeyRef.current = null;
    setDragKey(null);
    if (!dragged || dragged === targetKey) return;
    const current = orderedEarned(earned, value.order);
    const from = current.indexOf(dragged);
    const to = current.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    onChange({ hidden: value.hidden, order: next });
  }, [earned, value, onChange]);

  const handleDragEnd = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
  }, []);

  return (
    <SettingsSection title={t('settings.privacy.badgeDisplayTitle', 'Badge display')} className="mb-6">
      <p className="text-[11px] mb-4 text-t-secondary">
        {t('settings.privacy.badgeDisplayDesc', 'Choose which of your earned badges to show, and drag to reorder them.')}
      </p>
      {earned.length === 0 ? (
        <p className="text-[11px] text-t-tertiary">
          {t('settings.privacy.badgeDisplayEmpty', "You haven't earned any badges yet.")}
        </p>
      ) : (
        <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
          {rows.map((key) => (
            <div
              key={key}
              data-badge-key={key}
              draggable={!disabled}
              onDragStart={!disabled ? (e) => handleDragStart(e, key) : undefined}
              onDragOver={!disabled ? handleDragOver : undefined}
              onDrop={!disabled ? (e) => handleDrop(e, key) : undefined}
              onDragEnd={!disabled ? handleDragEnd : undefined}
              className="flex items-center justify-between py-2"
              style={{ opacity: dragKey === key ? 0.4 : 1 }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <GripVertical size={14} className="shrink-0 cursor-grab active:cursor-grabbing text-t-tertiary" />
                <ProfileBadges badges={[key]} size="sm" />
              </div>
              <Toggle checked={!hiddenSet.has(key)} onChange={(v) => toggle(key, v)} disabled={disabled} />
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
