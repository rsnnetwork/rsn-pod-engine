import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Bell, Shield, Eye, CreditCard, Check, Lock, Zap } from 'lucide-react';
import api from '@/lib/api';

function Toggle({ enabled, onToggle, label, description }: {
  enabled: boolean; onToggle: () => void; label: string; description: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-[#1a1a2e]' : 'bg-gray-200'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

const plans = [
  {
    name: 'Starter',
    price: 'Free',
    description: 'Get started with RSN basics',
    features: ['1 Pod membership', 'Join events', 'Basic profile', 'Invite friends'],
    current: true,
  },
  {
    name: 'Pro',
    price: '$19/mo',
    description: 'Unlock the full RSN experience',
    features: ['Unlimited Pods', 'Priority matching', 'Advanced analytics', 'Early event access', 'Custom invite links'],
    current: false,
  },
];

export default function SettingsPage() {
  const { user, checkSession } = useAuthStore();
  const { addToast } = useToastStore();
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [eventReminders, setEventReminders] = useState(true);
  const [matchNotifs, setMatchNotifs] = useState(true);
  const [profileVisible, setProfileVisible] = useState(true);

  // Load preferences from user object
  useEffect(() => {
    if (user) {
      setEmailNotifs(user.notifyEmail ?? true);
      setEventReminders(user.notifyEventReminders ?? true);
      setMatchNotifs(user.notifyMatches ?? true);
      setProfileVisible(user.profileVisible ?? true);
    }
  }, [user]);

  const saveMutation = useMutation({
    mutationFn: () => api.put('/users/me', {
      notifyEmail: emailNotifs,
      notifyEventReminders: eventReminders,
      notifyMatches: matchNotifs,
      profileVisible,
    }),
    onSuccess: () => {
      addToast('Settings saved', 'success');
      checkSession();
    },
    onError: () => addToast('Failed to save settings', 'error'),
  });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Settings</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your account preferences and billing</p>
      </div>

      {/* Notifications */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Notifications</h2>
        </div>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={emailNotifs}
            onToggle={() => setEmailNotifs(!emailNotifs)}
            label="Email notifications"
            description="Receive important updates via email"
          />
          <Toggle
            enabled={eventReminders}
            onToggle={() => setEventReminders(!eventReminders)}
            label="Event reminders"
            description="Get notified before upcoming events"
          />
          <Toggle
            enabled={matchNotifs}
            onToggle={() => setMatchNotifs(!matchNotifs)}
            label="Match notifications"
            description="Get notified about mutual connections"
          />
        </div>
      </Card>

      {/* Privacy */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <Eye className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Privacy</h2>
        </div>
        <div className="divide-y divide-gray-100">
          <Toggle
            enabled={profileVisible}
            onToggle={() => setProfileVisible(!profileVisible)}
            label="Profile visibility"
            description="Allow other members to see your profile"
          />
        </div>
      </Card>

      {/* Account */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Account</h2>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-800">Email</p>
              <p className="text-xs text-gray-400">{user?.email}</p>
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-gray-800">Role</p>
              <p className="text-xs text-gray-400 capitalize">{user?.role}</p>
            </div>
          </div>
        </div>
      </Card>

      {/* Billing & Subscription */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-rsn-red" />
            <h2 className="font-semibold text-[#1a1a2e]">Billing & Subscription</h2>
          </div>
          <Badge variant="brand">Starter</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {plans.map(plan => (
            <div
              key={plan.name}
              className={`rounded-xl border p-5 ${plan.current ? 'border-[#1a1a2e]/30 bg-gray-50' : 'border-gray-200'}`}
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base font-bold text-[#1a1a2e]">{plan.name}</h3>
                {plan.current && <Badge variant="success">Current</Badge>}
              </div>
              <p className="text-xl font-bold text-[#1a1a2e] mb-1">{plan.price}</p>
              <p className="text-xs text-gray-500 mb-3">{plan.description}</p>
              <ul className="space-y-1.5 mb-4">
                {plan.features.map(f => (
                  <li key={f} className="flex items-center gap-2 text-xs text-gray-600">
                    <Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              {plan.current ? (
                <Button variant="secondary" disabled size="sm" className="w-full">Current Plan</Button>
              ) : (
                <Button size="sm" className="w-full">
                  <Zap className="h-3.5 w-3.5 mr-1.5" /> Upgrade
                </Button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 border border-gray-100">
          <Lock className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <div>
            <p className="text-xs text-gray-600">Billing is not yet active</p>
            <p className="text-xs text-gray-400">Stripe integration coming soon. All features free during beta.</p>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} isLoading={saveMutation.isPending}>Save Settings</Button>
      </div>
    </div>
  );
}
