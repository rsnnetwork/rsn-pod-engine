import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import AppLayout from '@/components/layout/AppLayout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import LoginPage from '@/features/auth/LoginPage';
import VerifyPage from '@/features/auth/VerifyPage';
import HomePage from '@/features/home/HomePage';
import ProfilePage from '@/features/profile/ProfilePage';
import PodsPage from '@/features/pods/PodsPage';
import PodDetailPage from '@/features/pods/PodDetailPage';
import SessionsPage from '@/features/sessions/SessionsPage';
import SessionDetailPage from '@/features/sessions/SessionDetailPage';
import CreateSessionPage from '@/features/sessions/CreateSessionPage';
import InvitesPage from '@/features/invites/InvitesPage';
import InviteAcceptPage from '@/features/invites/InviteAcceptPage';
import LiveSessionPage from '@/features/live/LiveSessionPage';
import HostDashboardPage from '@/features/host/HostDashboardPage';
import RecapPage from '@/features/sessions/RecapPage';
import EncounterHistoryPage from '@/features/sessions/EncounterHistoryPage';
import AdminUsersPage from '@/features/admin/AdminUsersPage';
import NotFoundPage from '@/features/misc/NotFoundPage';

export default function App() {
  const { checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, []);

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/verify" element={<VerifyPage />} />
      <Route path="/invite/:code" element={<InviteAcceptPage />} />

      {/* Protected with layout */}
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/pods" element={<PodsPage />} />
        <Route path="/pods/:podId" element={<PodDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/new" element={<CreateSessionPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="/sessions/:sessionId/recap" element={<RecapPage />} />
        <Route path="/encounters" element={<EncounterHistoryPage />} />
        <Route path="/invites" element={<InvitesPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
      </Route>

      {/* Protected without layout (full-screen) */}
      <Route path="/session/:sessionId/live" element={<ProtectedRoute><LiveSessionPage /></ProtectedRoute>} />
      <Route path="/session/:sessionId/host" element={<ProtectedRoute><HostDashboardPage /></ProtectedRoute>} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
