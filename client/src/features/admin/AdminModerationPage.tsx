import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, AlertTriangle, CheckCircle, MessageSquare } from 'lucide-react';
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
import { E } from '@/realtime/entities';

type ViolationStatus = 'open' | 'resolved' | 'dismissed' | 'actioned' | '';

interface AdminMessage { id: string; fromUserId: string; content: string | null; attachmentUrl: string | null; createdAt: string }

export default function AdminModerationPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ViolationStatus>('open');
  const [resolveModal, setResolveModal] = useState<any | null>(null);
  const [resolveAction, setResolveAction] = useState<string>('dismiss');
  const [adminNotes, setAdminNotes] = useState('');
  // The conversation behind a chat-originated report, viewed inline (audited server-side).
  const [chatModal, setChatModal] = useState<any | null>(null);

  const { data: violations, isLoading } = useQuery({
    queryKey: ['admin-violations', statusFilter],
    queryFn: () => api.get(`/admin/violations?status=${statusFilter}`).then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
    meta: { entities: [E.adminViolations] },
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, action, adminNotes, source }: { id: string; action: string; adminNotes: string; source?: string }) =>
      api.post(`/admin/violations/${id}/resolve`, { action, adminNotes, source }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-violations'] });
      addToast('Report resolved', 'success');
      setResolveModal(null);
      setAdminNotes('');
    },
    onError: () => addToast('Failed to resolve', 'error'),
  });

  // Messages behind a report that came from a chat — an on-demand, audited
  // moderation read opened in a modal; a point-in-time snapshot is what a
  // reviewer wants.
  // realtime: skip — audited, on-demand moderation snapshot, not a live view.
  const { data: chatMessages, isLoading: chatLoading } = useQuery({
    queryKey: ['admin-report-chat', chatModal?.conversationId],
    queryFn: () => api.get(`/admin/conversations/${chatModal.conversationId}/messages`).then(r => r.data.data as AdminMessage[]),
    enabled: !!chatModal?.conversationId,
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
        {(['open', 'resolved', 'actioned', 'dismissed', ''] as ViolationStatus[]).map(s => (
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
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                    <p className="text-sm font-semibold text-gray-800">Report against {v.reportedName || v.reportedEmail}</p>
                    <Badge variant={v.status === 'open' ? 'warning' : (v.status === 'actioned' || v.status === 'resolved') ? 'brand' : 'default'}>
                      {v.status}
                    </Badge>
                    {v.source === 'report' && <Badge variant="default">member report</Badge>}
                  </div>
                  <p className="text-sm text-gray-600 mb-1">{v.reason}</p>
                  {v.details && <p className="text-xs text-gray-400 mb-2">{v.details}</p>}
                  <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400">
                    <span>Reported by: {v.reporterName || 'System'}</span>
                    <span>{new Date(v.createdAt).toLocaleDateString()}</span>
                    {v.resolverName && <span>Resolved by: {v.resolverName}</span>}
                  </div>
                  {v.conversationId && (
                    <button
                      onClick={() => setChatModal(v)}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-rsn-red hover:underline"
                    >
                      <MessageSquare className="h-3.5 w-3.5" /> View the conversation
                    </button>
                  )}
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
                onClick={() => resolveMutation.mutate({ id: resolveModal.id, action: resolveAction, adminNotes, source: resolveModal.source })}
                isLoading={resolveMutation.isPending}
                className={resolveAction === 'ban' ? '!bg-red-600' : resolveAction === 'suspend' ? '!bg-amber-600' : ''}
              >
                {resolveAction === 'dismiss' ? 'Dismiss' : resolveAction === 'warn' ? 'Warn' : resolveAction === 'suspend' ? 'Suspend' : 'Ban'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {chatModal && (
        <Modal open={!!chatModal} onClose={() => setChatModal(null)} title={`Conversation — ${chatModal.reportedName || 'reported member'}`}>
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              Reviewing this conversation is recorded in the audit log. Messages are shown oldest first.
            </p>
            {chatLoading ? (
              <div className="py-8"><PageLoader /></div>
            ) : (chatMessages && chatMessages.length > 0) ? (
              <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded-xl bg-gray-50 p-3">
                {chatMessages.map((m) => {
                  const fromReported = m.fromUserId === chatModal.reportedUserId;
                  return (
                    <div key={m.id} className={`flex ${fromReported ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${fromReported ? 'bg-white text-gray-800 border border-gray-200' : 'bg-rsn-red text-white'}`}>
                        <p className="mb-0.5 text-[10px] uppercase tracking-wide opacity-60">
                          {fromReported ? (chatModal.reportedName || 'Reported') : (chatModal.reporterName || 'Reporter')}
                        </p>
                        {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
                        {m.attachmentUrl && (
                          <a href={m.attachmentUrl} target="_blank" rel="noopener noreferrer" className="underline">attachment</a>
                        )}
                        <p className="mt-0.5 text-[10px] opacity-50">{new Date(m.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-gray-400">No messages in this conversation.</p>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setChatModal(null)}>Close</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
