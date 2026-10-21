import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Mail, ToggleLeft, ToggleRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

const EMAIL_TYPE_LABELS: Record<string, { label: string; description: string }> = {
  magic_link:             { label: 'Magic Link Login', description: 'Sent when a user requests a login link' },
  invite_pod:             { label: 'Pod Invite', description: 'Sent when a user is invited to a pod' },
  invite_session:         { label: 'Event Invite', description: 'Sent when a user is invited to an event' },
  invite_platform:        { label: 'Platform Invite', description: 'Sent when a new user is invited to REASON' },
  recap:                  { label: 'Event Recap', description: 'Sent after an event is completed with match results' },
  join_request_approved:  { label: 'Join Request Approved', description: 'Sent when a join request is approved by admin' },
  join_request_declined:  { label: 'Join Request Declined', description: 'Sent when a join request is declined' },
};

export default function AdminEmailPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: configs, isLoading } = useQuery({
    queryKey: ['admin-email-config'],
    queryFn: () => api.get('/admin/email-config').then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.put(`/admin/email-config/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-email-config'] });
      addToast('Email config updated', 'success');
    },
    onError: () => addToast('Failed to update', 'error'),
  });

  if (!isAdmin(user?.role)) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Admin Only</h2>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Email Controls</h1>
          <p className="text-gray-500 text-sm mt-1">Toggle automated emails and preview their purpose</p>
        </div>
        <Mail className="h-8 w-8 text-rsn-red" />
      </div>

      {isLoading ? <PageLoader /> : (
        <div className="space-y-3 animate-fade-in-up">
          {(configs || []).map((c: any) => {
            const meta = EMAIL_TYPE_LABELS[c.emailType] || { label: c.emailType, description: '' };
            return (
              <Card key={c.id} className="!p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${c.enabled ? 'bg-emerald-50' : 'bg-gray-100'}`}>
                      <Mail className={`h-5 w-5 ${c.enabled ? 'text-emerald-500' : 'text-gray-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-800">{meta.label}</p>
                        <Badge variant={c.enabled ? 'success' : 'default'}>{c.enabled ? 'Active' : 'Disabled'}</Badge>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{meta.description}</p>
                      {c.subject && <p className="text-xs text-gray-500 mt-1">Subject: "{c.subject}"</p>}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleMutation.mutate({ id: c.id, enabled: !c.enabled })}
                    className="p-2 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
                    title={c.enabled ? 'Disable' : 'Enable'}
                  >
                    {c.enabled
                      ? <ToggleRight className="h-8 w-8 text-emerald-500" />
                      : <ToggleLeft className="h-8 w-8 text-gray-300" />
                    }
                  </button>
                </div>
              </Card>
            );
          })}
          {(!configs || configs.length === 0) && (
            <Card><p className="text-gray-400 text-sm text-center py-8">No email configurations found. Run migration 020 first.</p></Card>
          )}
        </div>
      )}

      <Card className="!p-4 bg-gray-50 border-gray-200">
        <p className="text-xs text-gray-500">
          Disabling an email type will prevent the system from sending that email automatically.
          Magic Link Login should generally stay enabled — disabling it will block login for all users.
        </p>
      </Card>
    </div>
  );
}
