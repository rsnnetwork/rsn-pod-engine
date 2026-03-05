import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Home, Users, Calendar, Mail, User, LogOut, Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import Avatar from '@/components/ui/Avatar';
import ToastContainer from '@/components/ui/Toast';

const links = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/pods', icon: Users, label: 'Pods' },
  { to: '/sessions', icon: Calendar, label: 'Sessions' },
  { to: '/invites', icon: Mail, label: 'Invites' },
  { to: '/profile', icon: User, label: 'Profile' },
];

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => { logout(); navigate('/login'); };

  const nav = (
    <nav className="flex flex-col gap-1 px-3 flex-1">
      {links.map(l => (
        <NavLink
          key={l.to} to={l.to} end={l.to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
            isActive ? 'bg-brand-600/20 text-brand-400' : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200',
          )}
        >
          <l.icon className="h-5 w-5" />
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
          <h1 className="text-xl font-bold bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">RSN</h1>
        </div>
        {nav}
        {user && (
          <div className="p-4 border-t border-surface-800 flex items-center gap-3">
            <Avatar name={user.displayName || user.email} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-surface-200 truncate">{user.displayName || 'User'}</p>
            </div>
            <button onClick={handleLogout} className="text-surface-500 hover:text-red-400 transition-colors"><LogOut className="h-4 w-4" /></button>
          </div>
        )}
      </aside>

      {/* Mobile header */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="md:hidden flex items-center justify-between border-b border-surface-800 bg-surface-900/60 px-4 py-3">
          <h1 className="text-lg font-bold bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">RSN</h1>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="text-surface-400">
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </header>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden absolute inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
            <div className="relative w-64 bg-surface-900 border-r border-surface-800 flex flex-col pt-16">
              {nav}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-surface-800 bg-surface-900/80 backdrop-blur-sm">
          {links.slice(0, 4).map(l => (
            <NavLink
              key={l.to} to={l.to} end={l.to === '/'}
              className={({ isActive }) => cn(
                'flex-1 flex flex-col items-center py-2 text-xs transition-colors',
                isActive ? 'text-brand-400' : 'text-surface-500',
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
