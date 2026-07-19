import { useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { connectSocket, disconnectSocket, getSocket, reconnectSocket } from '@/lib/socket';
import { useEntityChangedHandler } from '@/realtime/useEntityChangedHandler';
import { useToastStore } from '@/stores/toastStore';

// Backward-compat: old invite emails (pre-cbcef30) pointed users at
// `/sessions/:id/live` (plural). The actual route is `/session/:id/live`
// (singular). Anyone who still has an old email in their inbox keeps
// working forever because we redirect the bad URL to the right one.
function LiveRedirectCompat() {
  const { sessionId } = useParams();
  return <Navigate to={`/session/${sessionId}/live`} replace />;
}
import { useAuthStore } from '@/stores/authStore';
import AppLayout from '@/components/layout/AppLayout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import LoginPage from '@/features/auth/LoginPage';
import VerifyPage from '@/features/auth/VerifyPage';
import HomePage from '@/features/home/HomePage';
import ProfilePage from '@/features/profile/ProfilePage';
import PublicProfilePage from '@/features/profile/PublicProfilePage';
import PodsPage from '@/features/pods/PodsPage';
import PodDetailPage from '@/features/pods/PodDetailPage';
import SessionsPage from '@/features/sessions/SessionsPage';
import SessionDetailPage from '@/features/sessions/SessionDetailPage';
import CreateSessionPage from '@/features/sessions/CreateSessionPage';
import InvitesPage from '@/features/invites/InvitesPage';
import InviteAcceptPage from '@/features/invites/InviteAcceptPage';
import LiveSessionPage from '@/features/live/LiveSessionPage';
import SessionGuard from '@/features/live/SessionGuard';
import HostDashboardPage from '@/features/host/HostDashboardPage';
import RecapPage from '@/features/sessions/RecapPage';
import MessagesPage from '@/features/messages/MessagesPage';
import EncounterHistoryPage from '@/features/sessions/EncounterHistoryPage';
import MatchesPage from '@/features/matches/MatchesPage';
import CirclesPage from '@/features/circles/CirclesPage';
import CircleDetailPage from '@/features/circles/CircleDetailPage';
import AdminDashboardPage from '@/features/admin/AdminDashboardPage';
import AdminAnalyticsPage from '@/features/admin/AdminAnalyticsPage';
import AdminJoinRequestActionPage from '@/features/admin/AdminJoinRequestActionPage';
import AdminUsersPage from '@/features/admin/AdminUsersPage';
import AdminJoinRequestsPage from '@/features/admin/AdminJoinRequestsPage';
import AdminPodsPage from '@/features/admin/AdminPodsPage';
import AdminSessionsPage from '@/features/admin/AdminSessionsPage';
import AdminModerationPage from '@/features/admin/AdminModerationPage';
import AdminTemplatesPage from '@/features/admin/AdminTemplatesPage';
import AdminEmailPage from '@/features/admin/AdminEmailPage';
import AdminSupportPage from '@/features/admin/AdminSupportPage';
import SettingsPage from '@/features/settings/SettingsPage';
import BillingPage from '@/features/billing/BillingPage';
import SupportPage from '@/features/support/SupportPage';
import NotFoundPage from '@/features/misc/NotFoundPage';
import RequestToJoinPage from '@/features/auth/RequestToJoinPage';
import ChatbotOnboarding from '@/features/onboarding/ChatbotOnboarding';

export default function App() {
  const { checkSession } = useAuthStore();
  // Bug 32 (19 May Ali) — keep ONE Socket.IO connection alive for the
  // user's whole authenticated session. Pre-fix the socket was created
  // with autoConnect:false and only connectSocket()-ed by
  // useSessionSocket inside live event pages. On every other page
  // (Home, Pods, Invites, etc.) the WebSocket was never opened — so the
  // server's pod:membership_updated / entity:changed broadcasts had
  // nowhere to land in the browser. NotificationBell registered
  // listeners on a socket that wasn't connected; nothing fired. Connect
  // here on app boot whenever a token is present, refresh when it
  // changes, disconnect on logout. Live-event pages call connectSocket
  // again, which is a no-op when already connected.
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isSessionChecked = useAuthStore((s) => s.isSessionChecked);
  const addToast = useToastStore((s) => s.addToast);

  // Track the last token we handed the socket so we can distinguish "first
  // connect" from "token rotated" — the latter needs a hard
  // disconnect+connect to escape socket.io's reconnect-retry state if a
  // stale token put us there.
  const lastConnectedTokenRef = useRef<string | null>(null);
  const connectErrorBannerShownRef = useRef(false);

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    // Bug 32 (19 May Ali) — do NOT connect until checkSession has finished
    // validating whatever token came out of localStorage. Connecting with a
    // stale token sends socket.io into reconnect-backoff, after which
    // subsequent connect() calls are no-ops and the new token (when refresh
    // succeeds) keeps trying to ride the dead connection.
    if (!isSessionChecked) return;

    if (!(isAuthenticated && accessToken)) {
      disconnectSocket();
      lastConnectedTokenRef.current = null;
      connectErrorBannerShownRef.current = false;
      return;
    }

    const previousToken = lastConnectedTokenRef.current;
    if (previousToken && previousToken !== accessToken) {
      // Token rotated mid-session (refresh path). Force a fresh handshake
      // — plain connect() is a no-op while the engine is in retry-backoff.
      reconnectSocket(accessToken);
    } else {
      connectSocket(accessToken);
    }
    lastConnectedTokenRef.current = accessToken;
    // Reset the banner suppression — a new token means we're allowed to
    // notify the user again if THIS one also fails.
    connectErrorBannerShownRef.current = false;
  }, [accessToken, isAuthenticated, isSessionChecked]);

  // Bug 32 (19 May Ali) — surface persistent socket failures to the user.
  // socket.io retries silently up to 20× by default; without this listener
  // the UI just looks "frozen" while realtime is dead. Console-log every
  // attempt for dev visibility, toast a single banner after N failures so
  // we don't spam.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const CONNECT_ERROR_THRESHOLD = 3;
    let attempts = 0;

    const onConnect = () => {
      attempts = 0;
      connectErrorBannerShownRef.current = false;
    };
    const onConnectError = (err: Error) => {
      attempts += 1;
      // eslint-disable-next-line no-console
      console.warn(`[socket] connect_error (attempt ${attempts}):`, err?.message ?? err);
      if (attempts >= CONNECT_ERROR_THRESHOLD && !connectErrorBannerShownRef.current) {
        connectErrorBannerShownRef.current = true;
        addToast('Live updates disconnected — trying to reconnect…', 'error');
      }
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
  }, [addToast]);

  // Realtime migration Phase 1 (19 May Ali) — mount the generic
  // entity:changed handler at the app root. Every query that declares
  // meta.entities will be auto-invalidated when the server emits a
  // matching entity. Replaces NotificationBell's hard-coded query-key
  // list as queries migrate to the new pattern over Phases 3a–3g.
  // Phase 5 — useLegacyInvalidationBridge deleted. useEntityChangedHandler
  // now owns all realtime cache invalidation; every query declares
  // meta.entities and the server emits entity:changed for every mutation.
  useEntityChangedHandler();

  return (
    <Routes>
      {/* Public pages */}
      <Route path="/welcome" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/request-to-join" element={<RequestToJoinPage />} />
      <Route path="/auth/verify" element={<VerifyPage />} />
      <Route path="/invite/:code" element={<InviteAcceptPage />} />
      {/* Admin email-action page — token IS the auth, no session required. */}
      <Route path="/admin/jr/:token" element={<AdminJoinRequestActionPage />} />

      {/* Protected with layout */}
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/profile/:userId" element={<PublicProfilePage />} />
        <Route path="/pods" element={<PodsPage />} />
        <Route path="/pods/:podId" element={<PodDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/new" element={<CreateSessionPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="/sessions/:sessionId/recap" element={<RecapPage />} />
        <Route path="/encounters" element={<EncounterHistoryPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/circles" element={<CirclesPage />} />
        <Route path="/circles/:circleId" element={<CircleDetailPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        {/* Feature 18 (13 May spec) — one-click DM open. The recap, profile,
            and post-event pages send users to /messages/new/:userId, which
            renders the same page in "compose new" mode for that target user.
            Order matters: this must precede /:conversationId so "new" isn't
            interpreted as a conversation id. */}
        <Route path="/messages/new/:userId" element={<MessagesPage />} />
        <Route path="/messages/:conversationId" element={<MessagesPage />} />
        <Route path="/invites" element={<InvitesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/analytics" element={<AdminAnalyticsPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/join-requests" element={<AdminJoinRequestsPage />} />
        <Route path="/admin/pods" element={<AdminPodsPage />} />
        <Route path="/admin/sessions" element={<AdminSessionsPage />} />
        <Route path="/admin/moderation" element={<AdminModerationPage />} />
        <Route path="/admin/templates" element={<AdminTemplatesPage />} />
        <Route path="/admin/email" element={<AdminEmailPage />} />
        <Route path="/admin/support" element={<AdminSupportPage />} />
      </Route>

      {/* Protected without layout (full-screen) */}
      <Route path="/onboarding" element={<ProtectedRoute><ChatbotOnboarding /></ProtectedRoute>} />
      <Route path="/session/:sessionId/live" element={<ProtectedRoute><SessionGuard><LiveSessionPage /></SessionGuard></ProtectedRoute>} />
      <Route path="/session/:sessionId/host" element={<ProtectedRoute><HostDashboardPage /></ProtectedRoute>} />
      <Route path="/sessions/:sessionId/live" element={<LiveRedirectCompat />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
