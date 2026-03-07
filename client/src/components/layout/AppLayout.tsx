import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Home, Users, Calendar, Mail, User, LogOut, Menu, X, Heart, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import Avatar from '@/components/ui/Avatar';
import ToastContainer from '@/components/ui/Toast';

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => { logout(); navigate('/login'); };

  const links = [
    { to: '/', icon: Home, label: 'Home' },
    { to: '/pods', icon: Users, label: 'Pods' },
    { to: '/sessions', icon: Calendar, label: 'Sessions' },
    { to: '/encounters', icon: Heart, label: 'Encounters' },
    { to: '/invites', icon: Mail, label: 'Invites' },
    { to: '/profile', icon: User, label: 'Profile' },
    ...(user?.role === 'admin' ? [{ to: '/admin/users', icon: Shield, label: 'Admin' }] : []),
  ];

  const nav = (
    <nav className="flex flex-col gap-1 px-3 flex-1">
      {links.map(l => (
        <NavLink
          key={l.to} to={l.to} end={l.to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 group',
            isActive
              ? 'bg-brand-600/20 text-brand-400 shadow-sm shadow-brand-500/10'
              : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200 hover:translate-x-1',
          )}
        >
          <l.icon className="h-5 w-5 transition-transform duration-200 group-hover:scale-110" />
          {l.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-screen bg-surface-950">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r border-surface-800 bg-surface-900/60 backdrop-blur-sm">
        <div className="p-6">
          <h1 className="text-xl font-bold bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/')}>RSN</h1>
        </div>
        {nav}
        {user && (
          <div className="p-4 border-t border-surface-800 flex items-center gap-3 group">
            <Avatar name={user.displayName || user.email} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-surface-200 truncate">{user.displayName || 'User'}</p>
              <p className="text-xs text-surface-500 truncate">{user.role}</p>
            </div>
            <button
              onClick={handleLogout}
              className="text-surface-500 hover:text-red-400 transition-all duration-200 hover:scale-110"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </aside>

      {/* Mobile header */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="md:hidden flex items-center justify-between border-b border-surface-800 bg-surface-900/60 px-4 py-3 backdrop-blur-sm">
          <h1 className="text-lg font-bold bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">RSN</h1>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="text-surface-400 hover:text-surface-200 transition-colors">
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </header>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute inset-0 z-40 flex animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <div className="relative w-64 bg-surface-900 border-r border-surface-800 flex flex-col pt-16 animate-slide-in-left">
              {nav}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-surface-800 bg-surface-900/80 backdrop-blur-sm">
          {[
            { to: '/', icon: Home, label: 'Home' },
            { to: '/pods', icon: Users, label: 'Pods' },
            { to: '/sessions', icon: Calendar, label: 'Sessions' },
            { to: '/encounters', icon: Heart, label: 'Encounters' },
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
