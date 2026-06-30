// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { ConditionRequirements } from '../../services/api/rolePickers';
import type { ServerRoleFromAPI } from '../../types/server';
import { GLASS_MENU_CLASS } from '../../utils/contextMenuStyles';

export interface RoleConditionsPopoverProps {
  anchorRect: DOMRect | null;
  requirements: ConditionRequirements;
  allRoles: ServerRoleFromAPI[];
  onClose: () => void;
  onSave: (req: ConditionRequirements | null) => void | Promise<void>;
}

export const RoleConditionsPopover: React.FC<RoleConditionsPopoverProps> = ({
  anchorRect, requirements, allRoles, onClose, onSave,
}) => {
  const { t } = useTranslation();
  const popRef = useRef<HTMLDivElement>(null);

  const [accountAgeOn, setAccountAgeOn] = useState(typeof requirements.accountAgeDays === 'number');
  const [accountAgeDays, setAccountAgeDays] = useState(requirements.accountAgeDays ?? 7);
  const [tenureOn, setTenureOn] = useState(typeof requirements.tenureDays === 'number');
  const [tenureDays, setTenureDays] = useState(requirements.tenureDays ?? 7);
  const [hasRoleOn, setHasRoleOn] = useState(Array.isArray(requirements.hasRoleIds) && requirements.hasRoleIds.length > 0);
  const [hasRoleIds, setHasRoleIds] = useState<string[]>(requirements.hasRoleIds ?? []);
  const [excludeRoleOn, setExcludeRoleOn] = useState(Array.isArray(requirements.excludeRoleIds) && requirements.excludeRoleIds.length > 0);
  const [excludeRoleIds, setExcludeRoleIds] = useState<string[]>(requirements.excludeRoleIds ?? []);
  const [msgCountOn, setMsgCountOn] = useState(typeof requirements.messageCount === 'number');
  const [messageCount, setMessageCount] = useState(requirements.messageCount ?? 10);
  const [approvalOn, setApprovalOn] = useState(requirements.manualApproval === true);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const save = () => {
    const r: ConditionRequirements = {};
    if (accountAgeOn) r.accountAgeDays = Math.max(0, accountAgeDays | 0);
    if (tenureOn) r.tenureDays = Math.max(0, tenureDays | 0);
    if (hasRoleOn && hasRoleIds.length > 0) r.hasRoleIds = hasRoleIds;
    if (excludeRoleOn && excludeRoleIds.length > 0) r.excludeRoleIds = excludeRoleIds;
    if (msgCountOn) r.messageCount = Math.max(0, messageCount | 0);
    if (approvalOn) r.manualApproval = true;
    onSave(Object.keys(r).length === 0 ? null : r);
  };

  const eligibleRoles = allRoles.filter((r) => !r.isEveryone);

  // Position: anchored to right of the trigger, clamped to viewport.
  const popoverWidth = 360;
  const popoverHeight = 460;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 9999;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 9999;
  const left = anchorRect
    ? Math.min(Math.max(8, anchorRect.right + 8), vw - popoverWidth - 8)
    : (vw - popoverWidth) / 2;
  const top = anchorRect
    ? Math.min(Math.max(8, anchorRect.top), vh - popoverHeight - 8)
    : (vh - popoverHeight) / 2;

  return createPortal(
    <div
      ref={popRef}
      className={`fixed z-[var(--z-popover)] py-3 px-3 rounded-2xl border shadow-2xl ${GLASS_MENU_CLASS} glass`}
      style={{ left, top, width: popoverWidth }}
    >
      <h4 className="text-sm font-semibold text-t-primary mb-1">
        {t('selfRoles.conditions', { defaultValue: 'Conditions' })}
      </h4>
      <p className="text-[11px] text-t-secondary mb-3">
        {t('selfRoles.conditionsDesc', {
          defaultValue: 'Members must satisfy all checked conditions before claiming this role.',
        })}
      </p>

      <div className="space-y-2 max-h-[340px] overflow-y-auto">
        <ConditionRow
          checked={accountAgeOn}
          onToggle={() => setAccountAgeOn((v) => !v)}
          label={t('selfRoles.condAccountAge', { defaultValue: 'Account age' })}
          hint="Howl account is at least N days old"
        >
          <NumberInput value={accountAgeDays} onChange={setAccountAgeDays} suffix="days" />
        </ConditionRow>

        <ConditionRow
          checked={tenureOn}
          onToggle={() => setTenureOn((v) => !v)}
          label={t('selfRoles.condTenure', { defaultValue: 'Server tenure' })}
          hint="Member of this server for N days"
        >
          <NumberInput value={tenureDays} onChange={setTenureDays} suffix="days" />
        </ConditionRow>

        <ConditionRow
          checked={hasRoleOn}
          onToggle={() => setHasRoleOn((v) => !v)}
          label={t('selfRoles.condHasRole', { defaultValue: 'Has another role first' })}
          hint="Already holds the chosen role(s)"
        >
          <select
            multiple
            value={hasRoleIds}
            onChange={(e) => setHasRoleIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
            className="w-full text-xs rounded-md border border-default bg-app-surface text-t-primary p-2 outline-none focus:border-[var(--cyan-accent)]/40"
            size={Math.min(5, eligibleRoles.length)}
          >
            {eligibleRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </ConditionRow>

        <ConditionRow
          checked={excludeRoleOn}
          onToggle={() => setExcludeRoleOn((v) => !v)}
          label={t('selfRoles.condExcludeRole', { defaultValue: 'Excluded by another role' })}
          hint="Cannot hold any of the chosen role(s)"
        >
          <select
            multiple
            value={excludeRoleIds}
            onChange={(e) => setExcludeRoleIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
            className="w-full text-xs rounded-md border border-default bg-app-surface text-t-primary p-2 outline-none focus:border-[var(--cyan-accent)]/40"
            size={Math.min(5, eligibleRoles.length)}
          >
            {eligibleRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </ConditionRow>

        <ConditionRow
          checked={msgCountOn}
          onToggle={() => setMsgCountOn((v) => !v)}
          label={t('selfRoles.condMessageCount', { defaultValue: 'Message count' })}
          hint="Sent N messages in this server"
        >
          <NumberInput value={messageCount} onChange={setMessageCount} suffix="messages" />
        </ConditionRow>

        <ConditionRow
          checked={approvalOn}
          onToggle={() => setApprovalOn((v) => !v)}
          label={t('selfRoles.condApproval', { defaultValue: 'Manual approval' })}
          hint="Request goes to mod queue (Approvals tab)"
        />
      </div>

      <div className="flex gap-2 justify-end pt-3 mt-3 border-t border-default">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded-md text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={save}
          className="btn-cta px-4 py-1.5 text-xs transition-all"
        >
          {t('common.save', { defaultValue: 'Save' })}
        </button>
      </div>
    </div>,
    document.body,
  );
};

const ConditionRow: React.FC<{
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  children?: React.ReactNode;
}> = ({ checked, onToggle, label, hint, children }) => (
  <div className={`p-2 rounded-lg ${checked ? 'bg-[var(--accent-muted)]' : 'hover:bg-fill-hover'} transition-colors`}>
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-start gap-2 text-left"
    >
      <span className={`shrink-0 w-4 h-4 rounded-lg border flex items-center justify-center mt-0.5 ${checked ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)] text-black' : 'border-default'}`}>
        {checked && <Check size={10} />}
      </span>
      <span className="flex-1">
        <span className="block text-[12px] font-medium text-t-primary">{label}</span>
        <span className="block text-[10px] text-t-secondary">{hint}</span>
      </span>
    </button>
    {checked && children && <div className="mt-2 pl-6">{children}</div>}
  </div>
);

const NumberInput: React.FC<{
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}> = ({ value, onChange, suffix }) => (
  <div className="flex items-center gap-2 text-xs text-t-secondary">
    <span>at least</span>
    <input
      type="number"
      min="0"
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
      className="w-16 rounded-md border border-default bg-app-surface text-t-primary text-center px-2 py-1 outline-none focus:border-[var(--cyan-accent)]/40"
    />
    {suffix && <span>{suffix}</span>}
  </div>
);
