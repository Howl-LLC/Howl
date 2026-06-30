// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BookPlus } from 'lucide-react';
import { useContextMenuPosition, GLASS_MENU_CLASS, GLASS_MENU_STYLE } from '../utils/contextMenuStyles';

interface Props {
  x: number;
  y: number;
  /** Misspelt word the cursor was on, or null if right-clicked plain
   *  text. Drives whether suggestions / Add-to-Dictionary appear. */
  misspelledWord: string | null;
  /** Suggestions list — Chromium computed these in the main process
   *  and we forward them via IPC. Empty array if no misspelt word. */
  suggestions: string[];
  /** Edit-flag hints from Chromium's `params.editFlags` so we render
   *  the standard cut/copy/paste/select-all rows in their realistic
   *  enabled/disabled state. */
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
  /** Replace the misspelt word with the chosen suggestion. */
  onReplaceMisspelling: (suggestion: string) => void;
  /** Add the misspelt word to the user's persistent OS dictionary. */
  onAddToDictionary: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClose: () => void;
}

const SHORTCUT_MOD = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

/** Right-click menu shown inside the message composer — the Howl-styled
 *  custom replacement for Chromium's built-in context menu in Electron.
 *  On web the browser's native menu shows instead (so this component
 *  doesn't render there).
 *
 *  Layout, top to bottom:
 *  - Suggestions for the misspelt word (clickable, replace via the
 *    Electron `replaceMisspelling` API).
 *  - Add to Dictionary (writes through to the OS user dictionary).
 *  - Cut / Copy / Paste / Select All (standard editing actions).
 *
 *  The Spellcheck toggle, Send-Message-Button toggle, and Languages
 *  picker live in Settings → Accessibility instead — same pattern Discord
 *  uses for less-frequent options. */
export const ComposerContextMenu: React.FC<Props> = ({
  x, y,
  misspelledWord, suggestions,
  canCut, canCopy, canPaste, canSelectAll,
  onReplaceMisspelling, onAddToDictionary,
  onCut, onCopy, onPaste, onSelectAll,
  onClose,
}) => {
  const { t } = useTranslation();
  const { menuRef, style: posStyle } = useContextMenuPosition(x, y, 240, 280);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onWindowBlur = () => onClose();
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onWindowBlur);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('blur', onWindowBlur); };
  }, [onClose]);

  const baseRow = 'w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium transition-colors';
  const enabledRow = `${baseRow} hover:bg-fill-hover text-t-primary`;
  const disabledRow = `${baseRow} opacity-40 cursor-default text-t-primary`;

  const item = (label: string, onClick: () => void, opts?: { icon?: React.ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean }) => {
    const disabled = !!opts?.disabled;
    return (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => { if (!disabled) { onClick(); onClose(); } }}
        className={disabled ? disabledRow : enabledRow}
        style={opts?.danger && !disabled ? { color: 'var(--danger)' } : undefined}
      >
        {opts?.icon}
        <span className="flex-1">{label}</span>
        {opts?.shortcut && <span className="text-[11px] font-mono tabular-nums opacity-60 shrink-0">{opts.shortcut}</span>}
      </button>
    );
  };

  const sep = () => <div className="h-px mx-2 my-1" style={{ backgroundColor: 'var(--glass-border)' }} />;

  const hasSuggestions = !!misspelledWord && suggestions.length > 0;
  const showSpellcheckSection = !!misspelledWord;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[calc(var(--z-modal)+10)]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
        className={`fixed z-[calc(var(--z-modal)+11)] min-w-[240px] max-w-[320px] py-1.5 ${GLASS_MENU_CLASS}`}
        style={{ ...GLASS_MENU_STYLE, ...posStyle }}
      >
        {showSpellcheckSection && (
          <>
            {hasSuggestions ? (
              suggestions.slice(0, 5).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  role="menuitem"
                  onClick={() => { onReplaceMisspelling(suggestion); onClose(); }}
                  className={enabledRow}
                  style={{ fontWeight: 600 }}
                >
                  <span className="flex-1 truncate">{suggestion}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 mx-1.5 text-[12px] italic" style={{ color: 'var(--text-secondary)' }}>
                {t('composer.contextMenu.noSuggestions', { defaultValue: 'No suggestions' })}
              </div>
            )}
            {sep()}
            {item(
              t('composer.contextMenu.addToDictionary', { defaultValue: 'Add to Dictionary' }),
              onAddToDictionary,
              { icon: <BookPlus size={14} className="shrink-0 opacity-70" /> },
            )}
            {sep()}
          </>
        )}
        {item(t('composer.contextMenu.cut', { defaultValue: 'Cut' }), onCut, { shortcut: `${SHORTCUT_MOD}+X`, disabled: !canCut })}
        {item(t('composer.contextMenu.copy', { defaultValue: 'Copy' }), onCopy, { shortcut: `${SHORTCUT_MOD}+C`, disabled: !canCopy })}
        {item(t('composer.contextMenu.paste', { defaultValue: 'Paste' }), onPaste, { shortcut: `${SHORTCUT_MOD}+V`, disabled: !canPaste })}
        {item(t('composer.contextMenu.selectAll', { defaultValue: 'Select All' }), onSelectAll, { shortcut: `${SHORTCUT_MOD}+A`, disabled: !canSelectAll })}
      </div>
    </>,
    document.body,
  );
};
