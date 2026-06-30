// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { adminApi, type AuthUser } from './api';
import { AdminLayout } from './components';

// Page imports

import LoginPage from './pages/LoginPage';
import ForcePasswordChangePage from './pages/ForcePasswordChangePage';
import OverviewPage from './pages/OverviewPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ProtocolDistributionPage from './pages/ProtocolDistributionPage';
import UsersPage from './pages/UsersPage';
import UserDetailPage from './pages/UserDetailPage';
import ServersPage from './pages/ServersPage';
import ServerDetailPage from './pages/ServerDetailPage';
import InvitesPage from './pages/InvitesPage';
import ReportsPage from './pages/ReportsPage';
import ContentSafetyPage from './pages/ContentSafetyPage';
import ForumsPage from './pages/ForumsPage';
import ThreadsPage from './pages/ThreadsPage';
import PollsPage from './pages/PollsPage';
import AuditLogPage from './pages/AuditLogPage';
import DataRequestsPage from './pages/DataRequestsPage';
import SecurityPage from './pages/SecurityPage';
import AccountsPage from './pages/AccountsPage';
import DiscoveryPage from './pages/Discovery';
import ServerActionsPage from './pages/ServerActions';
import ServerReportsPage from './pages/ServerReports';
import VerificationRequestsPage from './pages/VerificationRequests';

// Error Boundary

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(145deg, #050810 0%, #0a1628 40%, #0d0f20 100%)' }}>
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-red-500/15 border border-red-500/20 flex items-center justify-center mx-auto mb-5">
              <AlertTriangle size={28} className="text-red-400" />
            </div>
            <h1 className="text-xl font-bold text-white mb-2">Something went wrong</h1>
            <p className="text-sm text-slate-400 mb-6">An unexpected error occurred in the admin panel.</p>
            <button onClick={() => window.location.reload()}
              className="px-6 py-3 rounded-xl bg-red-500/20 text-red-300 border border-red-500/30 text-sm font-bold hover:bg-red-500/30 transition-all duration-200"
            >Reload Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Root App

export const App: React.FC = () => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  // Register session-expired callback
  useEffect(() => {
    adminApi.onSessionExpired(() => {
      adminApi.clearToken();
      setUser(null);
    });
  }, []);

  // Cross-tab logout sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'howl_admin_logout_signal' && e.newValue) {
        adminApi.clearToken();
        setUser(null);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Try to restore session on mount
  useEffect(() => {
    const tryRestore = async () => {
      const token = adminApi.getToken();
      if (!token) {
        const refreshed = await adminApi.refreshAccessToken();
        if (!refreshed) { setChecking(false); return; }
      }
      try {
        const u = await adminApi.me();
        setUser(u);
      } catch {
        adminApi.clearToken();
      }
      setChecking(false);
    };
    tryRestore();
  }, []);

  const handleLogout = useCallback(async () => {
    await adminApi.logout();
    adminApi.clearToken();
    setUser(null);
    // Signal other admin tabs to log out
    try { localStorage.setItem('howl_admin_logout_signal', String(Date.now())); } catch { /* best-effort */ }
  }, []);

  // Loading screen while checking auth
  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm" style={{ background: 'linear-gradient(145deg, #050810 0%, #0a1628 40%, #0d0f20 100%)' }}>
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading...
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          {/* ── Unauthenticated routes ─── */}
          <Route
            path="/login"
            element={
              user
                ? <Navigate to="/" replace />
                : <LoginPage onLogin={setUser} />
            }
          />
          <Route
            path="/change-password"
            element={
              !user
                ? <Navigate to="/login" replace />
                : !user.forcePasswordChange
                  ? <Navigate to="/" replace />
                  : <ForcePasswordChangePage onComplete={async () => {
                      try { const u = await adminApi.me(); setUser(u); } catch { setUser({ ...user, forcePasswordChange: false }); }
                    }} />
            }
          />

          {/* ── Authenticated routes ─── */}
          <Route
            element={
              !user
                ? <Navigate to="/login" replace />
                : user.forcePasswordChange
                  ? <Navigate to="/change-password" replace />
                  : <AdminLayout user={user} onLogout={handleLogout} />
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="protocol-distribution" element={<ProtocolDistributionPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="servers/:id" element={<ServerDetailPage />} />
            <Route path="invites" element={<InvitesPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="server-reports" element={<ServerReportsPage />} />
            <Route path="verification-requests" element={<VerificationRequestsPage />} />
            <Route path="discovery" element={<DiscoveryPage />} />
            <Route path="discovery/:id" element={<ServerActionsPage />} />
            <Route path="content-safety" element={<ContentSafetyPage />} />
            <Route path="forums" element={<ForumsPage />} />
            <Route path="threads" element={<ThreadsPage />} />
            <Route path="polls" element={<PollsPage />} />
            <Route path="audit-log" element={<AuditLogPage />} />
            <Route path="data-requests" element={<DataRequestsPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="accounts" element={
              user && (user.role === 'owner' || user.role === 'superadmin')
                ? <AccountsPage user={user} />
                : <Navigate to="/" replace />
            } />
          </Route>

          {/* Catch-all: redirect to login or home */}
          <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
};
