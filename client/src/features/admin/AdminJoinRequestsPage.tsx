import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, ChevronLeft, ChevronRight, CheckCircle, XCircle, Clock, ExternalLink, MessageSquare, StickyNote, Send } from 'lucide-react';
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

interface JoinRequest {
  id: string;
  fullName: string;
  email: string;
  linkedinUrl: string;
  reason: string;
  status: 'pending' | 'approved' | 'declined';
  reviewedAt: string | null;
  adminNotes: string | null;
  createdAt: string;
}

export default function AdminJoinRequestsPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [reviewModal, setReviewModal] = useState<{ request: JoinRequest; decision: 'approved' | 'declined' } | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messageModal, setMessageModal] = useState<JoinRequest | null>(null);
  const [messageText, setMessageText] = useState('');
  const [noteEdit, setNoteEdit] = useState<string | null>(null); // request ID being edited
  const [noteText, setNoteText] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-join-requests', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '20');
      if (statusFilter) params.set('status', statusFilter);
      return api.get(`/join-requests?${params.toString()}`).then(r => r.data);
    },
    enabled: isAdmin(user?.role),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, decision, reviewNotes }: { id: string; decision: string; reviewNotes: string }) =>
      api.patch(`/join-requests/${id}/review`, { decision, reviewNotes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-join-requests'] });
      addToast('Request reviewed successfully', 'success');
      setReviewModal(null);
      setReviewNotes('');
    },
    onError: () => addToast('Failed to review request', 'error'),
  });

  const bulkMutation = useMutation({
    mutationFn: ({ action }: { action: 'approve' | 'decline' }) =>
      api.post('/admin/join-requests/bulk-action', { requestIds: Array.from(selected), action }),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-join-requests'] });
      addToast(`${selected.size} request(s) ${action}d`, 'success');
      setSelected(new Set());
    },
    onError: () => addToast('Bulk action failed', 'error'),
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      api.post(`/join-requests/${id}/message`, { message }),
    onSuccess: () => {
      addToast('Message sent', 'success');
      setMessageModal(null);
      setMessageText('');
    },
    onError: () => addToast('Failed to send message', 'error'),
  });

  const saveNoteMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      api.post(`/join-requests/${id}/note`, { note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-join-requests'] });
      addToast('Note saved', 'success');
      setNoteEdit(null);
      setNoteText('');
    },
    onError: () => addToast('Failed to save note', 'error'),
  });

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (!isAdmin(user?.role)) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Admin Only</h2>
        <p className="text-gray-500 mb-4">This page is restricted to administrators.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const requests: JoinRequest[] = data?.data ?? [];
  const meta = data?.meta;
  const pendingReqs = requests.filter(r => r.status === 'pending');
  const toggleAll = () => {
    if (selected.size === pendingReqs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingReqs.map(r => r.id)));
    }
  };

  const handleReview = () => {
    if (!reviewModal) return;
    reviewMutation.mutate({
      id: reviewModal.request.id,
      decision: reviewModal.decision,
      reviewNotes,
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Join Requests</h1>
          <p className="text-gray-500 text-sm mt-1">{meta?.totalCount || 0} total requests</p>
        </div>
        <Shield className="h-8 w-8 text-red-600" />
      </div>

      {/* Filters */}
      <div className="flex gap-3 animate-fade-in-up">
        {['pending', 'approved', 'declined', ''].map(s => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
              statusFilter === s
                ? 'bg-rsn-red text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#1a1a2e] text-white rounded-xl px-4 py-3 shadow-lg animate-fade-in">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="!text-emerald-300 !text-xs" onClick={() => { if (confirm(`Approve ${selected.size} request(s)?`)) bulkMutation.mutate({ action: 'approve' }); }}>
            Bulk Approve
          </Button>
          <Button size="sm" variant="ghost" className="!text-red-300 !text-xs" onClick={() => { if (confirm(`Decline ${selected.size} request(s)?`)) bulkMutation.mutate({ action: 'decline' }); }}>
            Bulk Decline
          </Button>
          <Button size="sm" variant="ghost" className="!text-gray-300 !text-xs" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Request List */}
      {isLoading ? <PageLoader /> : (
        <div className="space-y-3 animate-fade-in-up">
          {/* Select all for pending */}
          {statusFilter === 'pending' && pendingReqs.length > 0 && (
            <label className="flex items-center gap-2 px-4 py-1 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === pendingReqs.length}
                onChange={toggleAll}
                className="h-3.5 w-3.5 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              Select all pending
            </label>
          )}
          {requests.map((r) => (
            <Card key={r.id} className={`!p-5 ${selected.has(r.id) ? 'ring-2 ring-rsn-red/30' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {r.status === 'pending' && (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red mt-0.5 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-semibold text-gray-800">{r.fullName}</p>
                      <Badge variant={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'default'}>
                        {r.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">{r.email}</p>
                    <p className="text-sm text-gray-600 line-clamp-2 mb-2">{r.reason}</p>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <a href={r.linkedinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-600">
                        <ExternalLink className="h-3 w-3" /> LinkedIn
                      </a>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {new Date(r.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    {/* Admin notes display */}
                    {r.adminNotes && noteEdit !== r.id && (
                      <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
                        <span className="font-medium">Note:</span> {r.adminNotes}
                      </div>
                    )}
                    {/* Inline note editor */}
                    {noteEdit === r.id && (
                      <div className="mt-2 flex gap-2">
                        <textarea
                          value={noteText}
                          onChange={e => setNoteText(e.target.value)}
                          rows={2}
                          placeholder="Add internal note..."
                          className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red/20 resize-none"
                        />
                        <div className="flex flex-col gap-1">
                          <Button size="sm" onClick={() => saveNoteMutation.mutate({ id: r.id, note: noteText })} isLoading={saveNoteMutation.isPending}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setNoteEdit(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2 shrink-0">
                  {r.status === 'pending' && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setReviewModal({ request: r, decision: 'approved' })}
                        className="!bg-emerald-600 hover:!bg-emerald-700"
                      >
                        <CheckCircle className="h-4 w-4 mr-1" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setReviewModal({ request: r, decision: 'declined' })}
                      >
                        <XCircle className="h-4 w-4 mr-1" /> Decline
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setMessageModal(r)}
                    >
                      <MessageSquare className="h-3.5 w-3.5 mr-1" /> Message
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setNoteEdit(r.id); setNoteText(r.adminNotes || ''); }}
                    >
                      <StickyNote className="h-3.5 w-3.5 mr-1" /> Note
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
          {requests.length === 0 && (
            <Card>
              <p className="text-gray-400 text-sm text-center py-8">No {statusFilter || ''} requests found</p>
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

      {/* Send Message Modal */}
      {messageModal && (
        <Modal
          open={!!messageModal}
          onClose={() => { setMessageModal(null); setMessageText(''); }}
          title={`Message ${messageModal.fullName}`}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Send an email to {messageModal.email}</p>
            <textarea
              value={messageText}
              onChange={e => setMessageText(e.target.value)}
              rows={4}
              placeholder="Type your message..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setMessageModal(null); setMessageText(''); }}>Cancel</Button>
              <Button
                onClick={() => sendMessageMutation.mutate({ id: messageModal.id, message: messageText })}
                isLoading={sendMessageMutation.isPending}
                disabled={!messageText.trim()}
              >
                <Send className="h-4 w-4 mr-1" /> Send
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Review Modal */}
      {reviewModal && (
        <Modal
          open={!!reviewModal}
          onClose={() => { setReviewModal(null); setReviewNotes(''); }}
          title={`${reviewModal.decision === 'approved' ? 'Approve' : 'Decline'} Request`}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {reviewModal.decision === 'approved'
                ? `Approve ${reviewModal.request.fullName}'s request to join RSN?`
                : `Decline ${reviewModal.request.fullName}'s request?`
              }
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Notes (optional)</label>
              <textarea
                value={reviewNotes}
                onChange={e => setReviewNotes(e.target.value)}
                rows={3}
                placeholder="Add review notes..."
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setReviewModal(null); setReviewNotes(''); }}>Cancel</Button>
              <Button
                onClick={handleReview}
                isLoading={reviewMutation.isPending}
                className={reviewModal.decision === 'approved' ? '!bg-emerald-600 hover:!bg-emerald-700' : '!bg-red-600 hover:!bg-red-700'}
              >
                {reviewModal.decision === 'approved' ? 'Approve' : 'Decline'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
