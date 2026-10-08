import { useState, useEffect, useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { User } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import Badge from '@/components/ui/Badge';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Bell, Shield, Eye, CreditCard, Check, Lock, Zap, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

/**
 * Phase J (1 May 2026 spec) — per-channel toggles for chat notifications.
 * Stefan: "the possibility should be there, and be changed in your settings".
 */
function MessageNotificationPrefsCard() {
  const { addToast } = useToastStore();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data: prefs, refetch } = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => api.get('/notification-prefs').then(r => r.data.data),
    meta: { entities: currentUserId ? [E.userNotifications(currentUserId)] : [] },
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.put('/notification-prefs', patch),
    onSuccess: () => { refetch(); },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to save', 'error'),
  });

  const set = (key: string, value: boolean) => updateMutation.mutate({ [key]: value });

  if (!prefs) return null;

  const rows = [
    { key: 'dm', label: 'Direct messages', description: 'When someone sends you a 1:1 message' },
    { key: 'poke', label: 'Meeting requests', description: 'When someone you haven\'t met sends you a meeting request' },
    { key: 'group', label: 'Group + pod chats', description: 'New messages in your group + pod conversations' },
    { key: 'invite', label: 'Event + pod invites', description: 'When someone invites you to an event or pod' },
    { key: 'report_resolved', label: 'Report resolved', description: 'When an admin acts on a report you submitted' },
  ];

  return (
    <Card className="animate-fade-in-up">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-5 w-5 text-rsn-red" />
        <h2 className="font-semibold text-[#1a1a2e]">Messaging notifications</h2>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 items-center text-xs text-gray-400 mb-2 px-1">
        <span></span>
        <span className="text-center">Bell</span>
        <span className="text-center">Email</span>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.map(row => (
          <div key={row.key} className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center py-3">
            <div>
              <p className="text-sm font-medium text-gray-800">{row.label}</p>
              <p className="text-xs text-gray-400">{row.description}</p>
            </div>
            <button
              onClick={() => set(`${row.key}_bell`, !prefs[`${row.key}_bell`])}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] ${prefs[`${row.key}_bell`] ? 'bg-rsn-red' : 'bg-gray-200'}`}
              aria-label={`Toggle ${row.label} bell`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${prefs[`${row.key}_bell`] ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <button
              onClick={() => set(`${row.key}_email`, !prefs[`${row.key}_email`])}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] ${prefs[`${row.key}_email`] ? 'bg-rsn-red' : 'bg-gray-200'}`}
              aria-label={`Toggle ${row.label} email`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${prefs[`${row.key}_email`] ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Toggle({ enabled, onToggle, label, description }: {
  enabled: boolean; onToggle: () => void; label: string; description: string;
}) {
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p id={descriptionId} className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        aria-describedby={descriptionId}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] ${enabled ? 'bg-rsn-red' : 'bg-gray-200'}`}
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

/** The five switches the Save button writes, in the order they are compared. */
const PREF_KEYS = ['notifyEmail', 'notifyEventReminders', 'notifyMatches', 'profileVisible', 'inviteOptOutPublicEvents'] as const;
type PrefKey = (typeof PREF_KEYS)[number];
type Prefs = Pick<User, PrefKey>;

const pickPrefs = (u: Prefs): Prefs => ({
  notifyEmail: u.notifyEmail,
  notifyEventReminders: u.notifyEventReminders,
  notifyMatches: u.notifyMatches,
  profileVisible: u.profileVisible,
  inviteOptOutPublicEvents: u.inviteOptOutPublicEvents,
});

/** What the switches show, and the server values they were last brought up to date with. */
type View = { prefs: Prefs; base: Prefs };

/** Where the server's value moved since `from`, it wins; everywhere else the member's edit stands. */
const followServer = (mine: Prefs, from: Prefs, to: Prefs): Prefs => {
  let out: Prefs | null = null;
  for (const key of PREF_KEYS) {
    if (to[key] === from[key]) continue;
    out = out ?? { ...mine };
    out[key] = to[key];
  }
  return out ?? mine;
};

/**
 * The member's five saved switches.
 *
 * They are read from the server (GET /users/me), not from the login session, and the
 * query is tagged user:<id>, so a change made on another screen reaches this page
 * live. A view that was left open while the member hid themselves elsewhere used to
 * hold the old value and write it back the moment any other switch was saved, which
 * quietly un-hid them. Two rules close that: the switches follow the server, and Save
 * sends only the switches that differ from what the server holds, so a view that is
 * out of date can never overwrite a value it did not change.
 */
function useSettingsPrefs() {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const checkSession = useAuthStore((s) => s.checkSession);
  const userId: string | undefined = useAuthStore((s) => s.user?.id);
  const queryKey = ['user-settings', userId];

  const { data: saved, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => api.get('/users/me').then((r) => r.data.data as User),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
  });

  // What the switches show, kept in one piece with the server values they were last
  // brought up to date with, so the two can never be read out of step. When a saved
  // value changes on the server that switch takes it (server truth wins); a switch the
  // member changed but has not saved keeps their edit unless the server changed that
  // same switch.
  const [view, setView] = useState<View | null>(() => (saved ? { prefs: pickPrefs(saved), base: pickPrefs(saved) } : null));
  useEffect(() => {
    if (!saved) return;
    const next = pickPrefs(saved);
    setView((cur) => (cur ? { prefs: followServer(cur.prefs, cur.base, next), base: next } : { prefs: next, base: next }));
  }, [saved]);

  const toggle = (key: PrefKey) =>
    setView((cur) => (cur ? { ...cur, prefs: { ...cur.prefs, [key]: !cur.prefs[key] } } : cur));

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<Prefs>) => api.put('/users/me', patch),
    onSuccess: () => {
      addToast('Settings saved', 'success');
      checkSession();
      // Returned, so the mutation stays pending (Save stays busy) until the fresh values
      // are back. Without it Save came back at once, while the page still held the old
      // values, and a quick second Save was judged against them: "No changes to save"
      // for a member who had just switched something the other way.
      return qc.invalidateQueries({ queryKey });
    },
    onError: () => addToast('Failed to save settings', 'error'),
  });

  const save = () => {
    if (!view || saveMutation.isPending) return;
    // Judged against what the server holds at this moment (read now, not at the last
    // render). Where it has moved since this view last took its values, its value wins
    // and is not an edit, so only what the member changed on top of it is sent.
    const latest = qc.getQueryData<User>(queryKey);
    const server = latest ? pickPrefs(latest) : view.base;
    const mine = followServer(view.prefs, view.base, server);
    const patch: Partial<Prefs> = {};
    for (const key of PREF_KEYS) {
      if (mine[key] !== server[key]) patch[key] = mine[key];
    }
    if (Object.keys(patch).length === 0) {
      addToast('No changes to save', 'info');
      return;
    }
    saveMutation.mutate(patch);
  };

  return {
    prefs: view ? view.prefs : null,
    failed: !view && isError,
    toggle,
    save,
    saving: saveMutation.isPending,
    retry: () => { void refetch(); },
  };
}

/**
 * Stands in for the switches until the saved values arrive (or could not be read).
 * Two cards share the same read, so only ONE of them announces it (`announce`): the
 * other shows the same state quietly, with no live region and no second retry button.
 */
function PrefsPlaceholder({ rows, failed, announce, onRetry }: { rows: number; failed: boolean; announce: boolean; onRetry: () => void }) {
  if (failed) {
    if (!announce) return <p className="py-3 text-sm text-gray-600">Available once your settings load.</p>;
    return (
      <div className="flex items-center justify-between gap-4 py-3" role="alert">
        <p className="text-sm text-gray-600">We couldn&apos;t load your settings.</p>
        <Button variant="secondary" onClick={onRetry} className="flex-shrink-0 whitespace-nowrap">Try again</Button>
      </div>
    );
  }
  // The status text sits outside the divided list so it cannot add a line above row one.
  return (
    <div>
      {announce && <span className="sr-only" role="status">Loading your settings</span>}
      <div className="divide-y divide-gray-100" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <Skeleton className="h-6 w-11 flex-shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuthStore();
  const { prefs, failed, toggle, save, saving, retry } = useSettingsPrefs();

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
          {prefs ? (
            <>
              <Toggle
                enabled={prefs.notifyEmail}
                onToggle={() => toggle('notifyEmail')}
                label="Email notifications"
                description="Receive important updates via email"
              />
              <Toggle
                enabled={prefs.notifyEventReminders}
                onToggle={() => toggle('notifyEventReminders')}
                label="Event reminders"
                description="Get notified before upcoming events"
              />
              <Toggle
                enabled={prefs.notifyMatches}
                onToggle={() => toggle('notifyMatches')}
                label="Match notifications"
                description="Get notified about mutual connections"
              />
            </>
          ) : (
            <PrefsPlaceholder rows={3} failed={failed} announce onRetry={retry} />
          )}
        </div>
      </Card>

      {/* Phase J — Messaging notifications. Per-channel toggles. */}
      <MessageNotificationPrefsCard />

      {/* Privacy */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <Eye className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Privacy</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {prefs ? (
            <>
              <Toggle
                enabled={prefs.profileVisible}
                onToggle={() => toggle('profileVisible')}
                label="Show me in search and suggestions"
                description="When off, you won't appear in Find people or suggestions. Members with a link can still open your profile."
              />
              <Toggle
                enabled={prefs.inviteOptOutPublicEvents}
                onToggle={() => toggle('inviteOptOutPublicEvents')}
                label="Opt out of public event invites"
                description="Don't send me invites to public recurring events"
              />
            </>
          ) : (
            <PrefsPlaceholder rows={2} failed={failed} announce={false} onRetry={retry} />
          )}
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
        <Button onClick={save} isLoading={saving} disabled={!prefs}>Save Settings</Button>
      </div>
    </div>
  );
}
