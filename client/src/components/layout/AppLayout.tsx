import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Calendar, Mail, User, LogOut, Menu, X, Shield, Settings, HelpCircle, Heart } from 'lucide-react';
import { cn, isAdmin } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useScrollReveal } from '@/hooks/useScrollReveal';
import { connectSocket } from '@/lib/socket';
import Avatar from '@/components/ui/Avatar';
import Modal from '@/components/ui/Modal';
import ToastContainer from '@/components/ui/Toast';
import NotificationBell from '@/components/ui/NotificationBell';

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

  const mainLinks = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/pods', icon: Users, label: 'Pods' },
    { to: '/invites', icon: Mail, label: 'Invite' },
    { to: '/sessions', icon: Calendar, label: 'Events' },
    { to: '/encounters', icon: Heart, label: 'People' },
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
      {l.label}
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
    <div className="flex h-screen bg-white text-[#1a1a2e]">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-60 border-r border-gray-200 bg-gray-50/60 backdrop-blur-sm">
        <div className="px-5 py-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>
            <img src="/rsn-logo.png" alt="RSN" className="h-8 w-auto" />
          </div>
          <NotificationBell />
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
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button onClick={() => setMobileOpen(!mobileOpen)} className="text-gray-500 hover:text-gray-800 transition-colors">
              {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
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

        <main className="flex-1 overflow-y-auto p-4 md:p-8 bg-white">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-gray-200 bg-white/90 backdrop-blur-sm">
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
