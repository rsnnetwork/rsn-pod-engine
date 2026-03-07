import { useState } from 'react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Bell, Shield, Eye } from 'lucide-react';

function Toggle({ enabled, onToggle, label, description }: {
  enabled: boolean; onToggle: () => void; label: string; description: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-sm font-medium text-surface-200">{label}</p>
        <p className="text-xs text-surface-500">{description}</p>
      </div>
      <button
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-brand-500' : 'bg-surface-700'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [sessionReminders, setSessionReminders] = useState(true);
  const [matchNotifs, setMatchNotifs] = useState(true);
  const [profileVisible, setProfileVisible] = useState(true);

  const handleSave = () => {
    addToast('Settings saved', 'success');
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-surface-100">Settings</h1>
        <p className="text-surface-400 text-sm mt-1">Manage your account preferences</p>
      </div>

      {/* Notifications */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="h-5 w-5 text-brand-400" />
          <h2 className="font-semibold text-surface-100">Notifications</h2>
        </div>
        <div className="divide-y divide-surface-800">
          <Toggle
            enabled={emailNotifs}
            onToggle={() => setEmailNotifs(!emailNotifs)}
            label="Email notifications"
            description="Receive important updates via email"
          />
          <Toggle
            enabled={sessionReminders}
            onToggle={() => setSessionReminders(!sessionReminders)}
            label="Session reminders"
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
          <Eye className="h-5 w-5 text-brand-400" />
          <h2 className="font-semibold text-surface-100">Privacy</h2>
        </div>
        <div className="divide-y divide-surface-800">
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
          <Shield className="h-5 w-5 text-brand-400" />
          <h2 className="font-semibold text-surface-100">Account</h2>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-surface-200">Email</p>
              <p className="text-xs text-surface-500">{user?.email}</p>
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-surface-200">Role</p>
              <p className="text-xs text-surface-500 capitalize">{user?.role}</p>
            </div>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave}>Save Settings</Button>
      </div>
    </div>
  );
}
