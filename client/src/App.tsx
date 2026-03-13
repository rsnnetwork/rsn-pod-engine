import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import AppLayout from '@/components/layout/AppLayout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import LandingPage from '@/features/public/LandingPage';
import HowItWorksPage from '@/features/public/HowItWorksPage';
import AboutPage from '@/features/public/AboutPage';
import ReasonsPage from '@/features/public/ReasonsPage';
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
import AdminDashboardPage from '@/features/admin/AdminDashboardPage';
import AdminUsersPage from '@/features/admin/AdminUsersPage';
import AdminJoinRequestsPage from '@/features/admin/AdminJoinRequestsPage';
import AdminPodsPage from '@/features/admin/AdminPodsPage';
import AdminSessionsPage from '@/features/admin/AdminSessionsPage';
import SettingsPage from '@/features/settings/SettingsPage';
import BillingPage from '@/features/billing/BillingPage';
import SupportPage from '@/features/support/SupportPage';
import NotFoundPage from '@/features/misc/NotFoundPage';
import RequestToJoinPage from '@/features/auth/RequestToJoinPage';
import OnboardingPage from '@/features/onboarding/OnboardingPage';

export default function App() {
  const { checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, []);

  return (
    <Routes>
      {/* Public pages */}
      <Route path="/welcome" element={<LandingPage />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/reasons" element={<ReasonsPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/request-to-join" element={<RequestToJoinPage />} />
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
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/join-requests" element={<AdminJoinRequestsPage />} />
        <Route path="/admin/pods" element={<AdminPodsPage />} />
        <Route path="/admin/sessions" element={<AdminSessionsPage />} />
      </Route>

      {/* Protected without layout (full-screen) */}
      <Route path="/onboarding" element={<ProtectedRoute><OnboardingPage /></ProtectedRoute>} />
      <Route path="/session/:sessionId/live" element={<ProtectedRoute><LiveSessionPage /></ProtectedRoute>} />
      <Route path="/session/:sessionId/host" element={<ProtectedRoute><HostDashboardPage /></ProtectedRoute>} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
