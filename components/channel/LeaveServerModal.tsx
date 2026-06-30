// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatUsername } from '../../types';
import { Dropdown } from '../ui/dropdown';

interface LeaveServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  server: { id: string; name: string };
  isAdmin: boolean;
  otherServerMembers: Array<{ id: string; username: string; discriminator?: string }>;
  onLeaveServer?: (serverId: string) => void | Promise<void>;
  onTransferOwnershipAndLeave?: (serverId: string, newOwnerId: string) => void | Promise<void>;
  onDeleteServer?: (serverId: string, password: string) => void | Promise<void>;
}

export const LeaveServerModal: React.FC<LeaveServerModalProps> = ({
  isOpen,
  onClose,
  server,
  isAdmin,
  otherServerMembers,
  onLeaveServer,
  onTransferOwnershipAndLeave,
  onDeleteServer,
}) => {
  const { t } = useTranslation();
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [transferToUserId, setTransferToUserId] = useState<string>('');
  const [deletePassword, setDeletePassword] = useState('');

  const memberOptions = useMemo(
    () => otherServerMembers.map((m) => ({ value: m.id, label: formatUsername(m) })),
    [otherServerMembers]
  );

  if (!isOpen) return null;

  const title = isAdmin ? t('channels.youreTheOwner') : t('channels.leaveServerQuestion');

  const content = isAdmin ? (
    <div className="space-y-6">
      <div className="p-6 bg-amber-500/5 border border-amber-500/20 rounded-2xl flex flex-col items-center text-center">
        <ShieldAlert size={48} className="text-amber-500 mb-4" />
        <p className="text-sm text-slate-400 font-medium">{t('channels.youOwnServer', { serverName: server.name })}</p>
      </div>
      {leaveError && <p className="text-red-400 text-sm text-center">{leaveError}</p>}
      {otherServerMembers.length > 0 ? (
        <div className="space-y-3">
          <label className="text-[11px] font-semibold uppercase tracking-wider block" style={{ color: 'var(--text-secondary)' }}>{t('channels.transferOwnershipTo')}</label>
          <Dropdown
            options={memberOptions}
            value={transferToUserId || null}
            onChange={(v) => setTransferToUserId(v)}
            placeholder={t('channels.selectMember')}
            searchable
          />
          <button
            type="button"
            disabled={leaveLoading || !transferToUserId || !onTransferOwnershipAndLeave}
            onClick={async () => {
              if (!onTransferOwnershipAndLeave || !transferToUserId) return;
              setLeaveError(null);
              setLeaveLoading(true);
              try {
                await onTransferOwnershipAndLeave(server.id, transferToUserId);
                onClose();
              } catch (e) {
                setLeaveError(e instanceof Error ? e.message : t('channels.failedToTransfer'));
              } finally {
                setLeaveLoading(false);
              }
            }}
            className="btn-cta w-full py-3 text-sm rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {leaveLoading ? t('channels.transferring') : t('channels.transferAndLeave')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500 text-center">{t('channels.noOtherMembers')}</p>
      )}
      <div className="h-px bg-fill-active" />
      <div className="space-y-3">
        <p className="text-[11px] font-semibold text-center" style={{ color: 'var(--text-secondary)' }}>{t('channels.orDeleteServer')}</p>
        <input
          type="password"
          value={deletePassword}
          onChange={(e) => setDeletePassword(e.target.value)}
          placeholder={t('channels.enterPasswordToDelete', 'Enter your password to confirm')}
          className="w-full bg-fill-hover border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-t-primary outline-none focus:border-red-500/50 placeholder:text-t-secondary"
          autoComplete="current-password"
        />
        <button
          type="button"
          disabled={leaveLoading || !onDeleteServer || !deletePassword}
          onClick={async () => {
            if (!onDeleteServer || !deletePassword) return;
            setLeaveError(null);
            setLeaveLoading(true);
            try {
              await onDeleteServer(server.id, deletePassword);
              onClose();
            } catch (e) {
              setLeaveError(e instanceof Error ? e.message : t('channels.failedToDeleteServer'));
            } finally {
              setLeaveLoading(false);
            }
          }}
          className="btn-cta-danger w-full py-3 text-sm rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {leaveLoading ? t('common.deleting') : t('channels.deleteServerAndLeave')}
        </button>
      </div>
      <button type="button" onClick={onClose} className="w-full py-2.5 bg-fill-hover font-semibold text-sm rounded-xl hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
        {t('common.cancel')}
      </button>
    </div>
  ) : (
    <div className="space-y-6">
      <div className="p-6 bg-red-500/5 border border-red-500/20 rounded-2xl flex flex-col items-center text-center">
        <ShieldAlert size={48} className="text-red-500 mb-4 animate-pulse" />
        <p className="text-sm text-slate-400 font-medium">{t('channels.sureLeaveServer', { serverName: server.name })}</p>
      </div>
      {leaveError && <p className="text-red-400 text-sm text-center">{leaveError}</p>}
      <div className="grid grid-cols-2 gap-4">
        <button type="button" onClick={onClose} className="py-3 bg-fill-hover font-semibold text-sm rounded-xl hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
        <button
          type="button"
          disabled={leaveLoading || !onLeaveServer}
          onClick={async () => {
            if (!onLeaveServer) return;
            setLeaveError(null);
            setLeaveLoading(true);
            try {
              await onLeaveServer(server.id);
              onClose();
            } catch (e) {
              setLeaveError(e instanceof Error ? e.message : t('channels.failedToLeaveServer'));
            } finally {
              setLeaveLoading(false);
            }
          }}
          className="btn-cta-danger py-3 text-sm rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {leaveLoading ? t('channels.leaving') : t('common.leave')}
        </button>
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
         <div className="p-6 pb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>{title}</h2>
            <button onClick={onClose} className="p-2 hover:bg-fill-active transition-colors rounded-lg" style={{ color: 'var(--text-secondary)' }}><X size={18} /></button>
         </div>
         <div className="p-6 pt-2">{content}</div>
      </div>
    </div>,
    document.body
  );
};
