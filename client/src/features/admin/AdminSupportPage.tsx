import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Headphones, ChevronLeft, ChevronRight, Clock, User } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const STATUS_BADGE: Record<string, { variant: 'warning' | 'info' | 'success' | 'default'; label: string }> = {
  open: { variant: 'warning', label: 'Open' },
  in_progress: { variant: 'info', label: 'In Progress' },
  resolved: { variant: 'success', label: 'Resolved' },
  closed: { variant: 'default', label: 'Closed' },
};

export default function AdminSupportPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('open');
  const [selectedTicket, setSelectedTicket] = useState<any | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [newStatus, setNewStatus] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-support-tickets', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      if (statusFilter) params.set('status', statusFilter);
      return api.get(`/admin/support-tickets?${params.toString()}`).then(r => r.data);
    },
    enabled: isAdmin(user?.role),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string; adminNotes?: string }) =>
      api.patch(`/admin/support-tickets/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-support-tickets'] });
      addToast('Ticket updated', 'success');
      setSelectedTicket(null);
    },
    onError: () => addToast('Failed to update ticket', 'error'),
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

  const tickets = data?.data ?? [];
  const meta = data?.meta;

  const openTicket = (ticket: any) => {
    setSelectedTicket(ticket);
    setAdminNotes(ticket.adminNotes || '');
    setNewStatus(ticket.status);
  };

  const handleUpdate = () => {
    if (!selectedTicket) return;
    const body: any = {};
    if (newStatus !== selectedTicket.status) body.status = newStatus;
    if (adminNotes !== (selectedTicket.adminNotes || '')) body.adminNotes = adminNotes;
    if (Object.keys(body).length === 0) {
      setSelectedTicket(null);
      return;
    }
    updateMutation.mutate({ id: selectedTicket.id, ...body });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Support Tickets</h1>
          <p className="text-gray-500 text-sm mt-1">{meta?.totalCount || 0} total tickets</p>
        </div>
        <Headphones className="h-8 w-8 text-rsn-red" />
      </div>

      {/* Filters */}
      <div className="flex gap-3 animate-fade-in-up">
        {STATUS_OPTIONS.map(s => (
          <button
            key={s.value}
            onClick={() => { setStatusFilter(s.value); setPage(1); }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
              statusFilter === s.value
                ? 'bg-rsn-red text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Ticket List */}
      {isLoading ? <PageLoader /> : (
        <div className="space-y-3 animate-fade-in-up">
          {tickets.map((t: any) => {
            const badge = STATUS_BADGE[t.status] || STATUS_BADGE.open;
            return (
              <Card
                key={t.id}
                className="!p-5 cursor-pointer hover:border-gray-300 transition-colors"
                onClick={() => openTicket(t)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <Avatar src={t.userAvatarUrl} name={t.userName || t.userEmail || 'User'} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-semibold text-gray-800 truncate">{t.subject}</p>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      <p className="text-xs text-gray-400 mb-1">{t.userName || 'User'} · {t.userEmail}</p>
                      <p className="text-sm text-gray-600 line-clamp-2">{t.message}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {new Date(t.createdAt).toLocaleDateString()}
                        </span>
                        {t.assignedToName && (
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" /> {t.assignedToName}
                          </span>
                        )}
                      </div>
                      {t.adminNotes && (
                        <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
                          <span className="font-medium">Admin note:</span> {t.adminNotes}
                        </div>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-1" />
                </div>
              </Card>
            );
          })}
          {tickets.length === 0 && (
            <Card>
              <p className="text-gray-400 text-sm text-center py-8">No {statusFilter || ''} tickets found</p>
            </Card>
          )}
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!meta.hasPrev} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="ghost" size="sm" disabled={!meta.hasNext} onClick={() => setPage(p => p + 1)}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Ticket Detail Panel */}
      {selectedTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedTicket(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 p-6 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-[#1a1a2e]">{selectedTicket.subject}</h3>
                <p className="text-xs text-gray-400 mt-1">
                  {selectedTicket.userName} · {selectedTicket.userEmail} · {new Date(selectedTicket.createdAt).toLocaleString()}
                </p>
              </div>
              <Badge variant={STATUS_BADGE[selectedTicket.status]?.variant || 'default'}>
                {STATUS_BADGE[selectedTicket.status]?.label || selectedTicket.status}
              </Badge>
            </div>

            <div className="bg-gray-50 rounded-xl p-4 mb-4">
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{selectedTicket.message}</p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-600 mb-1.5 block">Status</label>
                <select
                  value={newStatus}
                  onChange={e => setNewStatus(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-rsn-red/20"
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-600 mb-1.5 block">Admin Notes</label>
                <textarea
                  value={adminNotes}
                  onChange={e => setAdminNotes(e.target.value)}
                  rows={3}
                  placeholder="Add internal notes..."
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red/20 resize-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setSelectedTicket(null)}>Cancel</Button>
                <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>Save Changes</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
