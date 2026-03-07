import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Calendar, Mail, User, LogOut, Menu, X, Shield, Settings, CreditCard, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import Avatar from '@/components/ui/Avatar';
import ToastContainer from '@/components/ui/Toast';

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => { logout(); navigate('/login'); };

  const mainLinks = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/pods', icon: Users, label: 'Pods' },
    { to: '/invites', icon: Mail, label: 'Invite' },
    { to: '/sessions', icon: Calendar, label: 'Events' },
    ...(user?.role === 'admin' ? [{ to: '/admin/users', icon: Shield, label: 'Admin' }] : []),
  ];

  const bottomLinks = [
    { to: '/profile', icon: User, label: 'Profile' },
    { to: '/settings', icon: Settings, label: 'Settings' },
    { to: '/billing', icon: CreditCard, label: 'Billing' },
    { to: '/support', icon: HelpCircle, label: 'Support' },
  ];

  const renderLink = (l: typeof mainLinks[0], closeMobile = false) => (
    <NavLink
      key={l.to} to={l.to} end={l.to === '/'}
      onClick={() => closeMobile && setMobileOpen(false)}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 group',
        isActive
          ? 'bg-brand-600/20 text-brand-400'
          : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200',
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
      </nav>
      <div className="px-3 mt-auto">
        <div className="border-t border-surface-800 pt-3 mb-2 flex flex-col gap-0.5">
          {bottomLinks.map(l => renderLink(l, closeMobile))}
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-surface-400 hover:bg-red-500/10 hover:text-red-400 transition-all duration-200 w-full"
        >
          <LogOut className="h-4.5 w-4.5 shrink-0" />
          Log out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-surface-950">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-60 border-r border-surface-800 bg-surface-900/60 backdrop-blur-sm">
        <div className="px-5 py-5 flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-brand-500 flex items-center justify-center text-white font-bold text-sm">R</div>
          <h1 className="text-lg font-bold text-surface-100 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>RSN</h1>
        </div>
        {sidebarContent()}
        {user && (
          <div className="p-3 border-t border-surface-800 flex items-center gap-2.5">
            <Avatar name={user.displayName || user.email} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-surface-200 truncate">{user.displayName || 'User'}</p>
              <p className="text-xs text-surface-500 truncate">{user.role}</p>
            </div>
          </div>
        )}
      </aside>

      {/* Mobile header */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="md:hidden flex items-center justify-between border-b border-surface-800 bg-surface-900/60 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-brand-500 flex items-center justify-center text-white font-bold text-xs">R</div>
            <h1 className="text-lg font-bold text-surface-100">RSN</h1>
          </div>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="text-surface-400 hover:text-surface-200 transition-colors">
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </header>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute inset-0 z-40 flex animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <div className="relative w-64 bg-surface-900 border-r border-surface-800 flex flex-col pt-16 pb-4 animate-slide-in-left">
              {sidebarContent(true)}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-surface-800 bg-surface-900/80 backdrop-blur-sm">
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
                isActive ? 'text-brand-400 scale-110' : 'text-surface-500',
              )}
            >
              <l.icon className="h-5 w-5 mb-0.5" />
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <ToastContainer />
    </div>
  );
}
