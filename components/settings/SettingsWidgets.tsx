// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Modal, ModalBody, ModalFooter } from '../ui/modal';
import { Dropdown } from '../ui/dropdown';

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full border transition-colors shrink-0 ${checked ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)]/50' : 'bg-fill-hover border-[var(--glass-border)]'}`}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <span className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${checked ? 'left-5' : 'left-[2px]'}`} />
    </button>
  );
}

export function SettingsSection({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-[var(--glass-border)] rounded-2xl overflow-hidden bg-panel ${className}`}>
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--glass-border)]">
        <h3 className="text-sm font-black uppercase tracking-wider text-t-primary">{title}</h3>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

export const ToggleRow = ({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <div className="flex items-center justify-between py-4 border-b border-[var(--glass-border)] last:border-b-0">
    <div className="flex-1 min-w-0 mr-4">
      <p className="text-sm font-semibold text-t-primary">{label}</p>
      {description && <p className="text-xs mt-0.5 text-t-secondary">{description}</p>}
    </div>
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 ${checked ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}>
      <span className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-[18px]' : ''}`} />
    </button>
  </div>
);

export const RadioOption = ({ label, description, value, selected, onChange }: { label: string; description?: string; value: string; selected: boolean; onChange: (v: string) => void }) => (
  <button type="button" onClick={() => onChange(value)} className="flex items-center gap-3 py-2.5 w-full text-left group">
    <div className={`w-4 h-4 rounded-full border-[1.5px] flex items-center justify-center shrink-0 transition-colors ${selected ? 'border-[var(--cyan-accent)] bg-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
      {selected && <div className="w-2 h-2 rounded-full bg-white" />}
    </div>
    <div>
      <p className="text-sm font-medium text-t-primary">{label}</p>
      {description && <p className="text-xs mt-0.5 text-t-secondary">{description}</p>}
    </div>
  </button>
);

export const SectionCard = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <div className="border border-[var(--glass-border)] rounded-2xl p-6 mb-6 bg-panel">
    {title && <h3 className="font-black text-xs uppercase tracking-wider mb-4 text-t-primary">{title}</h3>}
    {children}
  </div>
);

export const SliderRow = ({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) => (
  <div className="mb-5">
    <div className="flex items-center justify-between mb-2">
      <p className="text-[11px] font-medium text-t-secondary">{label}</p>
      <span className="text-xs font-semibold tabular-nums text-[var(--cyan-accent)]">{value}{unit ?? ''}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="appearance-none w-full h-4 rounded-full bg-transparent cursor-pointer [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--cyan-accent)] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:-mt-[5px] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--cyan-accent)] [&::-moz-range-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
      style={{ background: `linear-gradient(to right, color-mix(in srgb, var(--cyan-accent) 40%, transparent) 0%, color-mix(in srgb, var(--cyan-accent) 40%, transparent) ${((value - min) / (max - min)) * 100}%, var(--fill-active) ${((value - min) / (max - min)) * 100}%, var(--fill-active) 100%)`, borderRadius: '9999px' }}
    />
  </div>
);

export const SelectRow = ({ label, description, value, options, onChange, disabled }: { label: string; description?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; disabled?: boolean }) => (
  <div className="flex items-center justify-between py-3 gap-4">
    <div className="flex-1 min-w-0">
      <p className={`text-sm font-semibold ${disabled ? 'text-t-secondary' : 'text-t-primary'}`}>{label}</p>
      {description && <p className="text-xs mt-0.5 text-t-secondary">{description}</p>}
    </div>
    {/* Fixed-width wrapper is deliberate. The shared Dropdown trigger uses
     *  `w-full` internally so it fills whatever container it's in; without
     *  a sized wrapper here the Dropdown demands 100% of the flex row's
     *  width, squeezing the label + description to a few characters per
     *  line. w-48 (192 px) fits all option labels in this app (longest:
     *  "DFN3 Light"). */}
    <div className="w-48 flex-shrink-0">
      <Dropdown
        options={options}
        value={value}
        onChange={onChange}
        size="sm"
        disabled={disabled}
      />
    </div>
  </div>
);

export const SectionHeader: React.FC<{ title: string; desc?: string; icon?: React.ReactNode }> = ({ title, desc, icon }) => (
  <div className="mb-8">
    <div className="flex items-center gap-3 mb-1">
      {icon && <span className="opacity-50">{icon}</span>}
      <h1 className="text-2xl font-semibold tracking-tight text-t-primary">{title}</h1>
    </div>
    {desc && <p className="text-sm mt-1 max-w-lg text-t-secondary">{desc}</p>}
  </div>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string; accent?: boolean }> = ({ children, className = '', accent }) => (
  <div className={`rounded-2xl border p-5 bg-floating ${accent ? 'border-[var(--cyan-accent)]' : 'border-default'} ${className}`}
    style={{ boxShadow: accent ? '0 0 20px rgba(0,200,200,0.05)' : undefined }}>
    {children}
  </div>
);

export const InputField: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { label?: string }> = ({ label, className = '', ...props }) => (
  <div>
    {label && <label className="block text-[11px] font-medium mb-2 text-t-secondary">{label}</label>}
    <input {...props} className={`w-full rounded-xl px-4 py-3 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface border-default text-t-primary ${className}`}
      style={{ ...props.style }} />
  </div>
);

export const SelectField: React.FC<{ label?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean }> = ({ label, value, onChange, options, disabled }) => (
  <div>
    {label && <label className="block text-[11px] font-medium mb-2 text-t-secondary">{label}</label>}
    <Dropdown
      options={options}
      value={value}
      onChange={onChange}
      size="md"
      disabled={disabled}
      className="w-full"
    />
  </div>
);

export const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }> = ({ children, loading, className = '', ...props }) => (
  <Button variant="primary" size="md" loading={loading} className={className} {...props}>
    {children}
  </Button>
);

export const DangerButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }> = ({ children, loading, className = '', ...props }) => (
  <Button variant="danger-solid" size="md" loading={loading} className={className} {...props}>
    {children}
  </Button>
);

export const EmptyState: React.FC<{ icon: React.ReactNode; title: string; desc: string }> = ({ icon, title, desc }) => (
  <div className="flex flex-col items-center justify-center py-20 opacity-50">
    <div className="mb-4">{icon}</div>
    <p className="font-semibold text-sm mb-1 text-t-primary">{title}</p>
    <p className="text-xs text-center max-w-xs text-t-secondary">{desc}</p>
  </div>
);

export const SettingRow: React.FC<{ title: string; desc?: string; children?: React.ReactNode; value?: string; masked?: boolean; onEdit?: () => void }> = ({ title, desc, children, value, masked, onEdit }) => {
  const [revealed, setRevealed] = React.useState(false);
  // If "value" mode (AccountView-style row with label/value/edit)
  if (value !== undefined) {
    const display = masked && !revealed ? value.replace(/./g, '\u2022') : value;
    return (
      <div
        className={`flex items-center justify-between py-3.5 px-5 border-b border-[var(--glass-border)] last:border-b-0 group rounded-lg transition-all ${onEdit ? 'cursor-pointer hover:bg-fill-hover' : ''}`}
        onClick={onEdit}
      >
        <div className="min-w-0 flex items-center gap-3">
          <span className="text-[11px] font-medium text-t-secondary uppercase w-24 shrink-0">{title}</span>
          <span className="text-sm font-medium truncate text-t-primary">
            {display}
            {masked && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setRevealed(!revealed); }}
                className="ml-2 text-[var(--cyan-accent)] text-[10px] font-bold uppercase hover:underline"
              >
                {revealed ? 'Hide' : 'Show'}
              </button>
            )}
          </span>
        </div>
      </div>
    );
  }
  // Default mode (ServerSettingsPopup-style row with title/desc/children)
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-t-primary">{title}</p>
        {desc && <p className="text-xs mt-0.5 text-t-secondary">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
};

export const ConfirmDialog: React.FC<{ title: string; desc: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }> = ({ title, desc, confirmLabel, danger, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onCancel} size="sm" showClose={false}>
      <ModalBody className="pt-6">
        <h3 className="text-lg font-semibold mb-2 text-t-primary">{title}</h3>
        <p className="text-sm text-t-secondary">{desc}</p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        {danger
          ? <DangerButton onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</DangerButton>
          : <PrimaryButton onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</PrimaryButton>}
      </ModalFooter>
    </Modal>
  );
};
