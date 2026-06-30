// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronDown, Check, AlertTriangle, X,
  Users, Hash, Zap, RefreshCw, Settings, Ban, ScrollText, Shield,
} from 'lucide-react';
import {
  adminApi,
  type AdminServerDetail,
  type AdminServerSettings,
  type AdminServerBan,
  type AdminServerAuditEntry,
  type AdminAutomodRule,
} from '../api';
import { BTN_PRIMARY, CARD, SELECT_CLS } from '../components/styles';
import {
  ConfirmModal, DataTable, Pagination, AdminAvatar,
  ServerAdminStatusBadges, ServerAdminActionButtons, hydrateFlagsFromServer,
  type Column, type ServerAdminFlagsState,
} from '../components';
import { formatDate, formatRelative, statusDot, safeColor } from '../utils';

interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

type TabId = 'info' | 'settings' | 'bans' | 'audit' | 'automod';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'info', label: 'Info', icon: <Hash size={14} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={14} /> },
  { id: 'bans', label: 'Bans', icon: <Ban size={14} /> },
  { id: 'audit', label: 'Audit Log', icon: <ScrollText size={14} /> },
  { id: 'automod', label: 'Automod', icon: <Shield size={14} /> },
];

// Audit log action color helper

function serverAuditActionColor(action: string): string {
  const colors: Record<string, string> = {
    member_ban: 'bg-red-500/15 text-red-300 border-red-500/25',
    member_unban: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    member_kick: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    member_role_update: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    channel_create: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
    channel_update: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
    channel_delete: 'bg-red-500/15 text-red-300 border-red-500/25',
    role_create: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    role_update: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    role_delete: 'bg-red-500/15 text-red-300 border-red-500/25',
    server_update: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
    invite_create: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
    invite_delete: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
    message_delete: 'bg-red-500/15 text-red-300 border-red-500/25',
    message_pin: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  };
  return colors[action] || 'bg-white/5 text-slate-300 border-white/10';
}

const AUDIT_ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'member_ban', label: 'Member Ban' },
  { value: 'member_unban', label: 'Member Unban' },
  { value: 'member_kick', label: 'Member Kick' },
  { value: 'member_role_update', label: 'Role Update' },
  { value: 'channel_create', label: 'Channel Create' },
  { value: 'channel_update', label: 'Channel Update' },
  { value: 'channel_delete', label: 'Channel Delete' },
  { value: 'role_create', label: 'Role Create' },
  { value: 'role_update', label: 'Role Update' },
  { value: 'role_delete', label: 'Role Delete' },
  { value: 'server_update', label: 'Server Update' },
  { value: 'invite_create', label: 'Invite Create' },
  { value: 'invite_delete', label: 'Invite Delete' },
  { value: 'message_delete', label: 'Message Delete' },
  { value: 'message_pin', label: 'Message Pin' },
];

// Settings Tab

const SettingsTab: React.FC<{ serverId: string }> = ({ serverId }) => {
  const [settings, setSettings] = useState<AdminServerSettings | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.getServerSettings(serverId).then(res => {
      if (!cancelled) { setSettings(res.settings); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setError('Failed to load settings'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [serverId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading settings...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300">
        <AlertTriangle size={16} /> {error}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className={`${CARD} p-8 text-center`}>
        <Settings size={24} className="mx-auto mb-3 text-slate-600" />
        <p className="text-sm text-slate-500">Default settings</p>
      </div>
    );
  }

  const grid: { label: string; value: React.ReactNode }[] = [
    { label: 'Verification Level', value: <span className="capitalize">{settings.verificationLevel}</span> },
    { label: 'Content Filter Level', value: <span className="capitalize">{settings.contentFilter}</span> },
    { label: 'Join Method', value: <span className="capitalize">{settings.joinMethod}</span> },
    { label: 'Community Features', value: settings.communityEnabled ? <span className="text-emerald-400 font-medium">Enabled</span> : <span className="text-slate-400">Disabled</span> },
    { label: 'Discovery', value: settings.discoveryEnabled ? <span className="text-emerald-400 font-medium">Enabled</span> : <span className="text-slate-400">Disabled</span> },
    { label: 'DM Spam Filter', value: settings.dmSpamFilter ? <span className="text-emerald-400 font-medium">On</span> : <span className="text-slate-400">Off</span> },
    { label: 'Default Notifications', value: <span className="capitalize">{settings.defaultNotifications}</span> },
    { label: 'Welcome Message', value: settings.welcomeEnabled ? <span className="text-emerald-400 font-medium">Enabled</span> : <span className="text-slate-400">Disabled</span> },
    { label: 'Message Retention', value: settings.messageRetentionDays ? `${settings.messageRetentionDays} days` : <span className="text-slate-400">Unlimited</span> },
    { label: 'Audit Log Retention', value: `${settings.auditLogRetentionDays} days` },
  ];

  return (
    <div className="space-y-5">
      <div className={`${CARD} p-5`}>
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-slate-500/15 flex items-center justify-center"><Settings size={14} className="text-slate-400" /></div>
          Server Settings
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {grid.map(item => (
            <div key={item.label} className="space-y-1">
              <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">{item.label}</div>
              <div className="text-sm text-slate-200">{item.value}</div>
            </div>
          ))}
        </div>

        {settings.description && (
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mb-1.5">Description</div>
            <p className="text-sm text-slate-300">{settings.description}</p>
          </div>
        )}

        {settings.rules && settings.rules.length > 0 && (
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mb-2">Server Rules ({settings.rules.length})</div>
            <ol className="list-decimal list-inside space-y-1.5">
              {settings.rules.map((rule, i) => (
                <li key={i} className="text-sm text-slate-300">{rule}</li>
              ))}
            </ol>
          </div>
        )}

        {settings.blockedNicknames && settings.blockedNicknames.length > 0 && (
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mb-2">Blocked Nicknames ({settings.blockedNicknames.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {settings.blockedNicknames.map((nick, i) => (
                <span key={i} className="text-xs px-2 py-0.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300">{nick}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Bans Tab

const BansTab: React.FC<{ serverId: string }> = ({ serverId }) => {
  const navigate = useNavigate();
  const [bans, setBans] = useState<AdminServerBan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getServerBans(serverId, p);
      setBans(res.bans);
      setTotal(res.total);
      setPage(res.page);
      setPages(res.pages);
    } catch {
      setError('Failed to load bans');
    }
    setLoading(false);
  }, [serverId]);

  useEffect(() => { fetch(1); }, [fetch]);

  if (error) {
    return (
      <div className="px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300">
        <AlertTriangle size={16} /> {error}
      </div>
    );
  }

  const columns: Column<AdminServerBan>[] = [
    {
      key: 'user',
      header: 'Banned User',
      render: (ban) => {
        const u = ban.user;
        if (!u) return <span className="text-slate-500 text-xs">Deleted user</span>;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/users/${u.id}`); }}
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
          >
            <AdminAvatar src={u.avatar} name={u.username} size={28} />
            <span className="text-white font-medium">{u.username}<span className="text-slate-500">#{u.discriminator}</span></span>
          </button>
        );
      },
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (ban) => <span className="text-slate-300 text-xs">{ban.reason || <span className="text-slate-600 italic">No reason</span>}</span>,
    },
    {
      key: 'bannedBy',
      header: 'Banned By',
      render: (ban) => {
        const b = ban.bannedBy;
        if (!b) return <span className="text-slate-500 text-xs">Unknown</span>;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/users/${b.id}`); }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <AdminAvatar src={b.avatar} name={b.username} size={24} />
            <span className="text-slate-300 text-xs">{b.username}</span>
          </button>
        );
      },
    },
    {
      key: 'date',
      header: 'Date',
      render: (ban) => <span className="text-slate-500 text-xs">{formatRelative(ban.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <DataTable
        columns={columns}
        data={bans}
        rowKey={(b) => b.id}
        loading={loading}
        emptyIcon={<Ban size={20} className="mx-auto mb-2 opacity-40" />}
        emptyMessage="No bans"
      />
      <Pagination page={page} pages={pages} total={total} onPageChange={fetch} label="bans" />
    </div>
  );
};

// Audit Log Tab

const AuditLogTab: React.FC<{ serverId: string }> = ({ serverId }) => {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<AdminServerAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('');

  const fetchEntries = useCallback(async (p: number, action?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getServerAuditLog(serverId, p, action || undefined);
      setEntries(res.entries);
      setTotal(res.total);
      setPage(res.page);
      setPages(res.pages);
    } catch {
      setError('Failed to load audit log');
    }
    setLoading(false);
  }, [serverId]);

  useEffect(() => { fetchEntries(1, actionFilter); }, [fetchEntries, actionFilter]);

  if (error) {
    return (
      <div className="px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300">
        <AlertTriangle size={16} /> {error}
      </div>
    );
  }

  const columns: Column<AdminServerAuditEntry>[] = [
    {
      key: 'time',
      header: 'Time',
      render: (entry) => <span className="text-slate-500 text-xs whitespace-nowrap">{formatRelative(entry.createdAt)}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (entry) => {
        const a = entry.actor;
        if (!a) return <span className="text-slate-500 text-xs">System</span>;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/users/${a.id}`); }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <AdminAvatar src={a.avatar} name={a.username} size={24} />
            <span className="text-white text-xs font-medium">{a.username}</span>
          </button>
        );
      },
    },
    {
      key: 'action',
      header: 'Action',
      render: (entry) => (
        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border ${serverAuditActionColor(entry.action)}`}>
          {entry.action.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (entry) => {
        if (!entry.targetType && !entry.targetId) return <span className="text-slate-600 text-xs">--</span>;
        return (
          <span className="text-slate-300 text-xs">
            {entry.targetType && <span className="text-slate-500 capitalize">{entry.targetType}: </span>}
            <code className="bg-white/5 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-400">{entry.targetId}</code>
          </span>
        );
      },
    },
    {
      key: 'details',
      header: 'Details',
      render: (entry) => {
        if (!entry.details || Object.keys(entry.details).length === 0) return <span className="text-slate-600 text-xs">--</span>;
        const summary = Object.entries(entry.details).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
        return <span className="text-slate-400 text-xs truncate max-w-48 block" title={summary}>{summary}</span>;
      },
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className={`w-48 ${SELECT_CLS}`}
        >
          {AUDIT_ACTION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <DataTable
        columns={columns}
        data={entries}
        rowKey={(e) => e.id}
        loading={loading}
        emptyIcon={<ScrollText size={20} className="mx-auto mb-2 opacity-40" />}
        emptyMessage="No audit log entries"
      />
      <Pagination page={page} pages={pages} total={total} onPageChange={(p) => fetchEntries(p, actionFilter)} label="entries" />
    </div>
  );
};

// Automod Tab

function automodConfigSummary(rule: AdminAutomodRule): string {
  const config = rule.config;
  if (!config) return 'No config';
  switch (rule.type) {
    case 'keyword_filter': {
      const keywords = config.keywords;
      if (Array.isArray(keywords)) return `${keywords.length} keyword${keywords.length !== 1 ? 's' : ''}`;
      return 'Keyword filter';
    }
    case 'spam_filter': {
      const threshold = config.threshold;
      if (threshold !== undefined) return `Threshold: ${threshold}`;
      return 'Spam filter';
    }
    case 'link_filter': {
      const allowlist = config.allowlist;
      if (Array.isArray(allowlist)) return `${allowlist.length} allowed domain${allowlist.length !== 1 ? 's' : ''}`;
      return 'Link filter';
    }
    case 'mention_spam': {
      const maxMentions = config.maxMentions;
      if (maxMentions !== undefined) return `Max mentions: ${maxMentions}`;
      return 'Mention spam';
    }
    case 'invite_filter':
      return 'Blocks server invites';
    default: {
      const keys = Object.keys(config);
      if (keys.length === 0) return 'Default config';
      return keys.slice(0, 2).map(k => `${k}: ${String(config[k])}`).join(', ');
    }
  }
}

function automodTypeBadge(type: string): React.ReactNode {
  const colors: Record<string, string> = {
    keyword_filter: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    spam_filter: 'bg-red-500/15 text-red-300 border-red-500/25',
    link_filter: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    mention_spam: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    invite_filter: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
  };
  const cls = colors[type] || 'bg-white/5 text-slate-300 border-white/10';
  return (
    <span className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border ${cls}`}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

const AutomodTab: React.FC<{ serverId: string }> = ({ serverId }) => {
  const [rules, setRules] = useState<AdminAutomodRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.getServerAutomodRules(serverId).then(res => {
      if (!cancelled) { setRules(res.rules); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setError('Failed to load automod rules'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [serverId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading automod rules...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300">
        <AlertTriangle size={16} /> {error}
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className={`${CARD} p-8 text-center`}>
        <Shield size={24} className="mx-auto mb-3 text-slate-600" />
        <p className="text-sm text-slate-500">No automod rules configured</p>
      </div>
    );
  }

  return (
    <div className={`${CARD} p-5`}>
      <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center"><Shield size={14} className="text-violet-400" /></div>
        Automod Rules ({rules.length})
      </h3>
      <div className="space-y-2">
        {rules.map(rule => (
          <div key={rule.id} className="flex items-center gap-4 py-3 px-4 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-white text-sm font-medium">{rule.name}</span>
                {automodTypeBadge(rule.type)}
              </div>
              <div className="text-xs text-slate-500">{automodConfigSummary(rule)}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className={`w-2 h-2 rounded-full ${rule.enabled ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-red-400 shadow-sm shadow-red-400/50'}`} />
              <span className={`text-xs font-medium ${rule.enabled ? 'text-emerald-400' : 'text-red-400'}`}>
                {rule.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <span className="text-[10px] text-slate-600 shrink-0">{formatRelative(rule.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Main Page

const ServerDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [selectedServer, setSelectedServer] = useState<AdminServerDetail | null>(null);
  const [loadingServer, setLoadingServer] = useState(true);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [serverPowerUpLoading, setServerPowerUpLoading] = useState<string | null>(null);
  const [editPowerUpTier, setEditPowerUpTier] = useState<number>(0);
  const [editPowerUpDuration, setEditPowerUpDuration] = useState<number>(0);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('info');

  // Live admin-moderation flag snapshot. Hydrated from the server detail
  // payload on load and updated in place by ServerAdminActionButtons after
  // each successful action so the badges + button labels track without a
  // round-trip refetch.
  const [flags, setFlags] = useState<ServerAdminFlagsState>({
    featured: false, verified: false, hidden: false, suspended: false, discoveryOverride: false,
  });

  const selectServer = useCallback(async (serverId: string) => {
    setLoadingServer(true);
    setSelectedServer(null);
    setActionResult(null);
    try {
      const s = await adminApi.getServer(serverId);
      setSelectedServer(s);
      setFlags(hydrateFlagsFromServer(s));
      setEditPowerUpTier(s.powerUpTier);
      setEditPowerUpDuration(0);
      setExpandedMembers(new Set());
    } catch {
      setActionResult({ type: 'error', message: 'Failed to load server' });
    }
    setLoadingServer(false);
  }, []);

  useEffect(() => { if (id) selectServer(id); }, [id, selectServer]);

  if (loadingServer) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading server...
      </div>
    );
  }

  if (!selectedServer) {
    return (
      <div className="text-center py-20">
        {actionResult && (
          <div className="mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300">
            <AlertTriangle size={16} /> {actionResult.message}
          </div>
        )}
        <button onClick={() => navigate('/servers')} className="text-sm text-slate-400 hover:text-white flex items-center gap-2 mx-auto">
          <ChevronLeft size={16} /> Back to servers
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
      <button onClick={() => navigate('/servers')}
        className="flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-5 -ml-1 transition-colors"><ChevronLeft size={16} /> Back to servers</button>

      {actionResult && (
        <div className={`mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100 transition-opacity"><X size={14} /></button>
        </div>
      )}

      {/* Server header */}
      <div className={`${CARD} p-6 mb-5`}>
        <div className="flex items-start gap-5">
          <div className="shrink-0">
            <AdminAvatar src={selectedServer.icon} name={selectedServer.name} size={72} rounded={16} fallback={<div className="rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center text-indigo-300 font-bold" style={{ width: 72, height: 72, fontSize: 28 }}>{selectedServer.name.charAt(0).toUpperCase()}</div>} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-bold text-white tracking-tight">{selectedServer.name}</h2>
              <span className={`text-[11px] font-bold px-3 py-1.5 rounded-lg border ${
                selectedServer.powerUpTier >= 3 ? 'border-violet-500/40 bg-violet-500/20 text-violet-300' :
                selectedServer.powerUpTier >= 2 ? 'border-cyan-500/40 bg-cyan-500/20 text-cyan-300' :
                selectedServer.powerUpTier >= 1 ? 'border-blue-500/40 bg-blue-500/20 text-blue-300' :
                'border-white/[0.06] bg-white/[0.03] text-slate-500'
              }`}>Tier {selectedServer.powerUpTier}</span>
              <ServerAdminStatusBadges flags={flags} />
            </div>
            <div className="mt-2 flex items-center gap-5 text-xs text-slate-500 flex-wrap">
              <span>ID: <code className="bg-white/5 px-2 py-0.5 rounded-md font-mono text-slate-400">{selectedServer.id}</code></span>
              <span>Created {formatDate(selectedServer.createdAt)}</span>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <div className="flex items-center gap-1.5 text-sm"><Users size={14} className="text-slate-400" /><span className="text-white font-medium">{selectedServer.memberCount}</span><span className="text-slate-500">members</span></div>
              <div className="flex items-center gap-1.5 text-sm"><Hash size={14} className="text-slate-400" /><span className="text-white font-medium">{selectedServer.channelCount}</span><span className="text-slate-500">channels</span></div>
              <div className="flex items-center gap-1.5 text-sm"><Zap size={14} className="text-cyan-400" /><span className="text-white font-medium">{selectedServer.powerUpCount}</span><span className="text-slate-500">power-ups ({selectedServer.realPowerUpCount} real)</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* Moderation actions — feature/verify/hide/suspend + Discovery
          Override. Lives between the server-info card and the tab bar so
          it's accessible no matter which tab is open. The same buttons
          render on the ServerActions page for the Discovery Queue review
          flow; both share the underlying ServerAdminActionButtons
          component (admin/src/components/ServerAdminActions.tsx). */}
      <ServerAdminActionButtons
        serverId={selectedServer.id}
        serverName={selectedServer.name}
        flags={flags}
        onFlagsChange={setFlags}
        onActionResult={setActionResult}
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1.5 mb-5 p-1 rounded-xl bg-white/[0.02] border border-white/[0.04]">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === tab.id
                ? 'bg-white/[0.08] text-white'
                : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'info' && (
        <>
          {/* Power-up tier management */}
          <div className={`${CARD} p-5 mb-5`}>
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center"><Zap size={14} className="text-cyan-400" /></div> Power-up Tier</h3>
            {selectedServer.powerUpStatus && (
              <div className="mb-3 px-4 py-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs flex items-center gap-2">
                <Zap size={13} /> {selectedServer.powerUpStatus === 'admin_granted' ? 'Permanent (admin-granted)' : `Expires ${selectedServer.powerUpPeriodEnd ? new Date(selectedServer.powerUpPeriodEnd).toLocaleDateString() : '\u2014'}`}
              </div>
            )}
            <div className="flex items-center gap-3 mb-4">
              {[0, 1, 2, 3].map((t) => (
                <button
                  key={t}
                  onClick={() => { setEditPowerUpTier(t); if (t === 0) setEditPowerUpDuration(0); }}
                  className={`flex-1 py-3 rounded-xl border text-sm font-bold transition-all duration-200 ${
                    editPowerUpTier === t
                      ? 'border-cyan-500/40 bg-cyan-500/20 text-cyan-300 shadow-sm shadow-cyan-500/10'
                      : 'border-white/[0.06] text-slate-400 hover:bg-white/5 hover:text-white hover:border-white/10'
                  }`}
                >
                  Tier {t}<div className="text-[10px] font-normal mt-0.5 opacity-60">{[0, 2, 7, 14][t]} power-ups</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-end">
              {editPowerUpTier > 0 && (
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-[10px] text-slate-500 font-medium uppercase">Duration</label>
                  <select value={editPowerUpDuration} onChange={(e) => setEditPowerUpDuration(parseInt(e.target.value))} className={`w-36 ${SELECT_CLS}`}>
                    <option value={0}>Permanent</option>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              <button
                disabled={serverPowerUpLoading === selectedServer.id || editPowerUpTier === selectedServer.powerUpTier}
                onClick={() => {
                  const tierLabel = `Tier ${editPowerUpTier} (${[0, 2, 7, 14][editPowerUpTier]} power-ups)`;
                  const durationLabel = editPowerUpTier > 0 ? (editPowerUpDuration === 0 ? ' \u2014 Permanent' : ` \u2014 ${editPowerUpDuration} month${editPowerUpDuration > 1 ? 's' : ''}`) : '';
                  setConfirmModal({ title: 'Change Power-up Tier', message: `Set ${selectedServer.name}'s power-up tier from Tier ${selectedServer.powerUpTier} to ${tierLabel}${durationLabel}?`, confirmLabel: `Set ${tierLabel}`, onConfirm: async () => {
                    setServerPowerUpLoading(selectedServer.id);
                    try {
                      const result = await adminApi.setServerPowerUpTier(selectedServer.id, editPowerUpTier, editPowerUpTier > 0 ? editPowerUpDuration : undefined);
                      setSelectedServer(prev => prev ? { ...prev, powerUpCount: result.powerUpCount, powerUpTier: result.powerUpTier, powerUpStatus: result.powerUpStatus, powerUpPeriodEnd: result.periodEnd } : prev);
                      const durMsg = result.permanent ? '(Permanent)' : result.periodEnd ? `(until ${new Date(result.periodEnd).toLocaleDateString()})` : '';
                      setActionResult({ type: 'success', message: `Power-up tier set to Tier ${editPowerUpTier} ${durMsg}`.trim() });
                    } catch { setActionResult({ type: 'error', message: 'Failed to set power-up tier' }); }
                    setServerPowerUpLoading(null);
                  }});
                }}
                className={`${BTN_PRIMARY} shrink-0`}
              >{serverPowerUpLoading === selectedServer.id ? 'Saving...' : 'Save'}</button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            {/* Channels */}
            <div className={`${CARD} p-5`}>
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center"><Hash size={14} className="text-indigo-400" /></div> Channels ({selectedServer.channels.length})</h3>
              <div className="space-y-1.5 text-sm max-h-48 overflow-y-auto pr-1">
                {selectedServer.channels.map(ch => (
                  <div key={ch.id} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/[0.03]">
                    <span className="text-slate-500 text-xs w-5">{ch.type === 'text' ? '#' : '\uD83D\uDD0A'}</span>
                    <span className="text-slate-300 truncate">{ch.name}</span>
                  </div>
                ))}
                {selectedServer.channels.length === 0 && <div className="text-slate-500 py-2">No channels</div>}
              </div>
            </div>

            {/* Active power-ups */}
            <div className={`${CARD} p-5`}>
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center"><Zap size={14} className="text-violet-400" /></div> Active Power-ups ({selectedServer.realPowerUpCount})</h3>
              <div className="space-y-1.5 text-sm max-h-48 overflow-y-auto pr-1">
                {selectedServer.powerUps.map(b => (
                  <div key={b.id} className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white/[0.03]">
                    <AdminAvatar src={b.user.avatar} name={b.user.username} size={24} />
                    <span className="text-slate-300">{b.user.username}<span className="text-slate-500">#{b.user.discriminator}</span></span>
                    <span className="text-[10px] text-slate-500 ml-auto">{formatRelative(b.createdAt)}</span>
                  </div>
                ))}
                {selectedServer.powerUps.length === 0 && <div className="text-slate-500 py-2">No active power-ups from users</div>}
              </div>
            </div>
          </div>

          {/* Members */}
          <div className={`${CARD} p-5`}>
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5"><div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center"><Users size={14} className="text-emerald-400" /></div> Members ({selectedServer.memberCount})</h3>
            <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
              {selectedServer.members.map(m => {
                const isExpanded = expandedMembers.has(m.id);
                return (
                  <div key={m.id} className="rounded-xl overflow-hidden">
                    <div className="flex items-center gap-3 py-2 px-3 hover:bg-white/[0.03] cursor-pointer transition-colors"
                      onClick={() => navigate(`/users/${m.id}`)}>
                      <AdminAvatar src={m.avatar} name={m.username} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium text-sm">{m.username}<span className="text-slate-500">#{m.discriminator}</span></span>
                          {statusDot(m.status)}
                        </div>
                      </div>
                      {m.serverRole ? (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-md border" style={{ color: safeColor(m.serverRole.color), borderColor: `${safeColor(m.serverRole.color)}30`, backgroundColor: `${safeColor(m.serverRole.color)}12` }}>{m.serverRole.name}</span>
                      ) : (
                        <span className="text-[11px] text-slate-500 capitalize px-2 py-0.5 rounded-md bg-white/[0.03]">{m.role}</span>
                      )}
                      {m.joinedAt && <span className="text-[10px] text-slate-600 shrink-0">{formatRelative(m.joinedAt)}</span>}
                      <button type="button" className="p-1 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white transition-all shrink-0" onClick={(e) => { e.stopPropagation(); setExpandedMembers(prev => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; }); }}>
                        <ChevronDown size={14} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-3 pb-2.5 pt-0.5 ml-11 space-y-1.5">
                        {m.serverRole ? (
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: safeColor(m.serverRole.color) }} />
                            <span className="text-xs text-slate-300 font-medium">{m.serverRole.name}</span>
                            <span className="text-[10px] text-slate-600">Position: {m.serverRole.position}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full shrink-0 bg-slate-600" />
                            <span className="text-xs text-slate-400 capitalize">{m.role}</span>
                            <span className="text-[10px] text-slate-600">(no custom role assigned)</span>
                          </div>
                        )}
                        {selectedServer.roles && selectedServer.roles.length > 0 && (
                          <div className="mt-1">
                            <span className="text-[10px] text-slate-600 uppercase tracking-wider font-medium">All server roles</span>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {selectedServer.roles.map(r => (
                                <span key={r.id} className={`text-[10px] px-1.5 py-0.5 rounded border ${m.serverRole?.id === r.id ? 'font-bold' : 'opacity-40'}`}
                                  style={{ color: safeColor(r.color), borderColor: `${safeColor(r.color)}30`, backgroundColor: m.serverRole?.id === r.id ? `${safeColor(r.color)}18` : 'transparent' }}>
                                  {r.name}{r.locked ? ' \uD83D\uDD12' : ''} ({r.memberCount})
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {m.joinedAt && <div className="text-[10px] text-slate-600 mt-1">Joined {new Date(m.joinedAt).toLocaleDateString()} ({formatRelative(m.joinedAt)})</div>}
                      </div>
                    )}
                  </div>
                );
              })}
              {selectedServer.members.length === 0 && <div className="text-sm text-slate-500 py-4 text-center">No members</div>}
              {selectedServer.memberCount > 100 && <div className="text-xs text-slate-600 text-center mt-3">Showing first 100 of {selectedServer.memberCount} members</div>}
            </div>
          </div>
        </>
      )}

      {activeTab === 'settings' && id && <SettingsTab serverId={id} />}
      {activeTab === 'bans' && id && <BansTab serverId={id} />}
      {activeTab === 'audit' && id && <AuditLogTab serverId={id} />}
      {activeTab === 'automod' && id && <AutomodTab serverId={id} />}

      {/* Confirm modal */}
      <ConfirmModal
        open={!!confirmModal}
        onClose={() => setConfirmModal(null)}
        onConfirm={() => { if (confirmModal) confirmModal.onConfirm(); }}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmText={confirmModal?.confirmLabel}
        danger={confirmModal?.danger}
      />
    </div>
  );
};

export default ServerDetailPage;
