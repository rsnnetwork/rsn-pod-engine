import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Calendar, Mail, User, LogOut, Menu, X, Shield, Settings, HelpCircle, Heart, MessageSquare, Sparkles, CircleDashed } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { cn, isAdmin } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useScrollReveal } from '@/hooks/useScrollReveal';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { connectSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import Avatar from '@/components/ui/Avatar';
import Modal from '@/components/ui/Modal';
import ToastContainer from '@/components/ui/Toast';
import NotificationBell from '@/components/ui/NotificationBell';
import ChatQuickAccess from '@/components/ui/ChatQuickAccess';

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const isOnAdmin = location.pathname.startsWith('/admin');

  // Keep socket connected on all pages for real-time notifications
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (token) connectSocket(token);
    return () => { /* don't disconnect — live event pages manage their own connection */ };
  }, []);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  useScrollReveal();

  const handleLogout = async () => {
    setLogoutModalOpen(false);
    await logout();
    navigate('/login');
  };

  // REASON P3a — ship ≠ launch: the Circles nav appears only once circles
  // exist (or for admins, who can create the first one). Deploying the code
  // activates nothing until the seed circles are created.
  // realtime: skip — nav visibility only; circles are admin-created rarities and the list refetches on every /circles visit
  const { data: circlesForNav } = useQuery({
    queryKey: ['circles'],
    queryFn: () => api.get('/circles').then(r => r.data.data ?? []),
    staleTime: 60_000,
  });
  const showCircles = isAdmin(user?.role) || (circlesForNav?.length ?? 0) > 0;

  // The badge has to be live from ANY page, so the count is fetched in the
  // layout rather than on the suggestions page. It rides the same entity
  // invalidation as everything else keyed on the user.
  const { data: agentList } = useQuery({
    queryKey: ['agents', false],
    queryFn: () => api.get('/agents').then(r => r.data.data as Array<{ matchCount: number }>),
    enabled: !!user?.id,
    meta: { entities: user?.id ? [E.user(user.id)] : [] },
  });
  const suggestionCount = (agentList ?? []).reduce((n, a) => n + (a.matchCount || 0), 0);

  // The desktop sidebar and the mobile drawer share `renderLink` below, but the
  // sidebar is only CSS-hidden on mobile (`hidden md:flex`) — it stays mounted
  // in the DOM, and the drawer is closed by default. A badge inside `renderLink`
  // alone would be invisible from any page on a phone unless the hamburger menu
  // is open. `isDesktopNav` decides which single spot actually mounts the badge
  // element, so there's always exactly one in the DOM (never a duplicate node
  // for the same `data-testid`, which would break a strict-mode Playwright
  // locator) and it is visible without opening the drawer on mobile.
  const isDesktopNav = useMediaQuery('(min-width: 768px)');

  const mainLinks = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    // Wave 2: agents are how you look for people now. /matches remains
    // reachable as the browse-everyone fallback, just not the front door.
    // 13 Aug: labelled "Suggestions" — the page holds standing searches and
    // what they found, which is not the same as a list of matches.
    { to: '/agents', icon: Sparkles, label: 'Suggestions' },
    ...(showCircles ? [{ to: '/circles', icon: CircleDashed, label: 'Circles' }] : []),
    { to: '/pods', icon: Users, label: 'Pods' },
    { to: '/invites', icon: Mail, label: 'Invite' },
    { to: '/sessions', icon: Calendar, label: 'Events' },
    { to: '/encounters', icon: Heart, label: 'People' },
    { to: '/messages', icon: MessageSquare, label: 'Messages' },
    ...(isAdmin(user?.role) ? [
      { to: '/admin', icon: Shield, label: 'Admin' },
    ] : []),
  ];

  const adminSubLinks = [
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/pods', label: 'Pods' },
    { to: '/admin/sessions', label: 'Events' },
    { to: '/admin/join-requests', label: 'Join Requests' },
    { to: '/admin/moderation', label: 'Moderation' },
    { to: '/admin/templates', label: 'Templates' },
    { to: '/admin/email', label: 'Email' },
    { to: '/admin/support', label: 'Support' },
  ];

  const bottomLinks = [
    { to: '/profile', icon: User, label: 'Profile' },
    { to: '/settings', icon: Settings, label: 'Settings' },
    { to: '/support', icon: HelpCircle, label: 'Support' },
  ];

  const renderLink = (l: typeof mainLinks[0], closeMobile = false) => (
    <NavLink
      key={l.to} to={l.to} end={l.to === '/'}
      onClick={() => closeMobile && setMobileOpen(false)}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 group',
        isActive
          ? 'bg-rsn-red-light text-rsn-red font-semibold border-l-2 border-rsn-red'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800',
      )}
    >
      <l.icon className="h-4.5 w-4.5 shrink-0" />
      <span className="truncate">{l.label}</span>
      {/* `!closeMobile` (true only for the drawer's call to renderLink, never
          the always-mounted desktop aside) is load-bearing, not decorative.
          `isDesktopNav` alone raced: `mobileOpen` is never reset on resize,
          so rotating a tablet/foldable past 768px while the drawer was open
          left BOTH this instance and the aside's instance satisfying
          `isDesktopNav && label === 'Suggestions'` at once — two DOM nodes
          sharing data-testid="nav-suggestions-badge", which breaks a
          strict-mode Playwright locator. The drawer already doesn't need its
          own copy: on mobile the count rides the hamburger badge in the
          header instead, so the drawer's sidebar-style badge is suppressed
          unconditionally, not just "while desktop nav is active". */}
      {isDesktopNav && !closeMobile && l.label === 'Suggestions' && suggestionCount > 0 && (
        <span
          data-testid="nav-suggestions-badge"
          className="ml-auto min-w-[20px] shrink-0 rounded-full bg-rsn-red px-1.5 py-0.5 text-center text-[11px] font-bold text-white"
        >
          {suggestionCount}
        </span>
      )}
    </NavLink>
  );

  const sidebarContent = (closeMobile = false) => (
    <>
      <nav className="flex flex-col gap-0.5 px-3 flex-1">
        {mainLinks.map(l => renderLink(l, closeMobile))}
        {isOnAdmin && isAdmin(user?.role) && (
          <div className="ml-6 mt-1 flex flex-col gap-0.5 border-l border-gray-200 pl-2">
            {adminSubLinks.map(l => (
              <NavLink
                key={l.to} to={l.to}
                onClick={() => closeMobile && setMobileOpen(false)}
                className={({ isActive }) => cn(
                  'text-xs px-2 py-1.5 rounded-md transition-colors',
                  isActive ? 'text-rsn-red font-semibold bg-rsn-red-light' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100',
                )}
              >{l.label}</NavLink>
            ))}
          </div>
        )}
      </nav>
      <div className="px-3 mt-auto">
        <div className="border-t border-gray-200 pt-3 mb-2 flex flex-col gap-0.5">
          {bottomLinks.map(l => renderLink(l, closeMobile))}
        </div>
        <button
          onClick={() => { if (closeMobile) setMobileOpen(false); setLogoutModalOpen(true); }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all duration-200 w-full"
        >
          <LogOut className="h-4.5 w-4.5 shrink-0" />
          Log out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-[100dvh] bg-white text-[#1a1a2e]">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-60 border-r border-gray-200 bg-gray-50/60 backdrop-blur-sm">
        <div className="px-5 py-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>
            <img src="/rsn-logo.png" alt="RSN" className="h-8 w-auto" />
          </div>
          <div className="flex items-center gap-1">
            <ChatQuickAccess />
            <NotificationBell />
          </div>
        </div>
        {sidebarContent()}
        {user && (
          <div
            onClick={() => navigate('/profile')}
            className="p-3 border-t border-gray-200 flex items-center gap-2.5 cursor-pointer hover:bg-gray-100 transition-colors"
          >
            <Avatar name={user.displayName || user.email} src={user.avatarUrl} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{user.displayName || 'User'}</p>
              <p className="text-xs text-gray-400 truncate">{user.role}</p>
            </div>
          </div>
        )}
      </aside>

      {/* Mobile header */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="md:hidden flex items-center justify-between border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>
            <img src="/rsn-logo.png" alt="RSN" className="h-7 w-auto" />
          </div>
          <div className="flex items-center gap-1">
            <ChatQuickAccess />
            <NotificationBell />
            <div className="relative">
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                className="text-gray-500 hover:text-gray-800 transition-colors ml-1"
              >
                {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </button>
              {/* Mobile has no persistently-visible "Suggestions" nav item (the
                  drawer that carries it is closed by default), so the badge
                  rides the hamburger here instead — same count, same testid as
                  the desktop sidebar's badge, never both mounted at once. */}
              {!isDesktopNav && suggestionCount > 0 && (
                <span
                  data-testid="nav-suggestions-badge"
                  className="pointer-events-none absolute -top-1 -right-0.5 min-w-[16px] rounded-full bg-rsn-red px-1 py-0.5 text-center text-[10px] font-bold leading-none text-white"
                >
                  {suggestionCount}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute inset-0 z-40 flex animate-fade-in">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <div className="relative w-64 bg-white border-r border-gray-200 flex flex-col pt-16 pb-4 animate-slide-in-left">
              {sidebarContent(true)}
            </div>
          </div>
        )}

        {/* T1-2 — non-blocking onboarding banner. Replaces the old hard
            redirect from ProtectedRoute. Users who haven't completed
            onboarding can use the app; this nudges them without blocking. */}
        {user && (user as any).onboardingCompleted === false && location.pathname !== '/onboarding' && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-3 text-sm">
            <span className="text-amber-900">
              <strong>Complete your profile</strong> to unlock matching and a richer experience.
            </span>
            <button
              onClick={() => navigate('/onboarding')}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-md text-xs font-medium whitespace-nowrap transition-colors"
            >
              Complete now
            </button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8 bg-white">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-gray-200 bg-white/90 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
          {[
            { to: '/', icon: LayoutDashboard, label: 'Home' },
            { to: '/pods', icon: Users, label: 'Pods' },
            { to: '/sessions', icon: Calendar, label: 'Events' },
            { to: '/invites', icon: Mail, label: 'Invite' },
            { to: '/profile', icon: User, label: 'Profile' },
          ].map(l => (
            <NavLink
              key={l.to} to={l.to} end={l.to === '/'}
              className={({ isActive }) => cn(
                'flex-1 flex flex-col items-center py-2 text-xs transition-all duration-200',
                isActive ? 'text-rsn-red scale-110 font-semibold' : 'text-gray-400',
              )}
            >
              <l.icon className="h-5 w-5 mb-0.5" />
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Modal open={logoutModalOpen} onClose={() => setLogoutModalOpen(false)} title="Log out" className="max-w-sm">
        <p className="text-sm text-gray-600 mb-6">Are you sure you want to log out?</p>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => setLogoutModalOpen(false)}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
          >
            Log Out
          </button>
        </div>
      </Modal>

      <ToastContainer />
    </div>
  );
}
