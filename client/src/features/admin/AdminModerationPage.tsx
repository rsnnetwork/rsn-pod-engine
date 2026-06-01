import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, AlertTriangle, CheckCircle } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import Modal from '@/components/ui/Modal';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

type ViolationStatus = 'open' | 'reviewed' | 'dismissed' | 'actioned' | '';

export default function AdminModerationPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ViolationStatus>('open');
  const [resolveModal, setResolveModal] = useState<any | null>(null);
  const [resolveAction, setResolveAction] = useState<string>('dismiss');
  const [adminNotes, setAdminNotes] = useState('');

  const { data: violations, isLoading } = useQuery({
    queryKey: ['admin-violations', statusFilter],
    queryFn: () => api.get(`/admin/violations?status=${statusFilter}`).then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, action, adminNotes }: { id: string; action: string; adminNotes: string }) =>
      api.post(`/admin/violations/${id}/resolve`, { action, adminNotes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-violations'] });
      addToast('Violation resolved', 'success');
      setResolveModal(null);
      setAdminNotes('');
    },
    onError: () => addToast('Failed to resolve', 'error'),
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
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Moderation Queue</h1>
          <p className="text-gray-500 text-sm mt-1">Review reported users and take action</p>
        </div>
        <Shield className="h-8 w-8 text-rsn-red" />
      </div>

      <div className="flex gap-2 animate-fade-in-up">
        {(['open', 'actioned', 'dismissed', ''] as ViolationStatus[]).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
              statusFilter === s ? 'bg-rsn-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {isLoading ? <PageLoader /> : (
        <div className="space-y-3 animate-fade-in-up">
          {(violations || []).map((v: any) => (
            <Card key={v.id} className="!p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                    <p className="text-sm font-semibold text-gray-800">Report against {v.reportedName || v.reportedEmail}</p>
                    <Badge variant={v.status === 'open' ? 'warning' : v.status === 'actioned' ? 'brand' : 'default'}>
                      {v.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-gray-600 mb-1">{v.reason}</p>
                  {v.details && <p className="text-xs text-gray-400 mb-2">{v.details}</p>}
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>Reported by: {v.reporterName || 'System'}</span>
                    <span>{new Date(v.createdAt).toLocaleDateString()}</span>
                    {v.resolverName && <span>Resolved by: {v.resolverName}</span>}
                  </div>
                  {v.adminNotes && (
                    <p className="text-xs text-gray-500 mt-2 bg-gray-50 rounded-lg p-2">Admin notes: {v.adminNotes}</p>
                  )}
                </div>
                {v.status === 'open' && (
                  <Button size="sm" onClick={() => { setResolveModal(v); setResolveAction('dismiss'); setAdminNotes(''); }}>
                    Review
                  </Button>
                )}
              </div>
            </Card>
          ))}
          {(!violations || violations.length === 0) && (
            <Card>
              <div className="text-center py-8 text-gray-400 text-sm">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 text-emerald-300" />
                No {statusFilter || ''} reports
              </div>
            </Card>
          )}
        </div>
      )}

      {resolveModal && (
        <Modal open={!!resolveModal} onClose={() => setResolveModal(null)} title="Resolve Report">
          <div className="space-y-4">
            <p className="text-sm text-gray-600">Report against <strong>{resolveModal.reportedName}</strong>: {resolveModal.reason}</p>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Action</label>
              <select
                value={resolveAction}
                onChange={e => setResolveAction(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
              >
                <option value="dismiss">Dismiss (no action)</option>
                <option value="warn">Warn user</option>
                <option value="suspend">Suspend user</option>
                <option value="ban">Ban user</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Admin Notes</label>
              <textarea
                value={adminNotes}
                onChange={e => setAdminNotes(e.target.value)}
                rows={3}
                placeholder="Notes about your decision..."
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setResolveModal(null)}>Cancel</Button>
              <Button
                onClick={() => resolveMutation.mutate({ id: resolveModal.id, action: resolveAction, adminNotes })}
                isLoading={resolveMutation.isPending}
                className={resolveAction === 'ban' ? '!bg-red-600' : resolveAction === 'suspend' ? '!bg-amber-600' : ''}
              >
                {resolveAction === 'dismiss' ? 'Dismiss' : resolveAction === 'warn' ? 'Warn' : resolveAction === 'suspend' ? 'Suspend' : 'Ban'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
