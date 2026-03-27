import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Badge from '@/components/ui/Badge';
import { useToastStore } from '@/stores/toastStore';
import { HelpCircle, MessageSquare, Mail, ChevronRight, Clock, CheckCircle, Loader2 } from 'lucide-react';
import api from '@/lib/api';

const faqs = [
  { q: 'How do I join a pod?', a: 'Go to the Pods page, browse available pods, and click "Join" on one that interests you. Or create your own pod.' },
  { q: 'How does matching work?', a: 'During live events, our matching engine pairs you with other participants for 1:1 video conversations. Each round, you get a new partner.' },
  { q: 'What is the unlock system?', a: 'Invite others to RSN. Each accepted invite unlocks more pod slots. 1 invite = 1 pod, 3 invites = 3 pods.' },
  { q: 'What if someone is selling during an event?', a: 'RSN has a strict no-selling policy. Report the user and they\'ll receive a strike. Three strikes = permanent ban.' },
  { q: 'How do I become a host?', a: 'Hosts are assigned by admins. Contact support if you\'d like to host events for your community.' },
];

const STATUS_BADGE: Record<string, { variant: 'warning' | 'info' | 'success' | 'default'; label: string }> = {
  open: { variant: 'warning', label: 'Open' },
  in_progress: { variant: 'info', label: 'In Progress' },
  resolved: { variant: 'success', label: 'Resolved' },
  closed: { variant: 'default', label: 'Closed' },
};

export default function SupportPage() {
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const { data: myTickets } = useQuery({
    queryKey: ['my-support-tickets'],
    queryFn: () => api.get('/admin/support-tickets/mine').then(r => r.data.data ?? []),
  });

  const submitMutation = useMutation({
    mutationFn: (body: { subject: string; message: string }) =>
      api.post('/admin/support-tickets', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-support-tickets'] });
      addToast('Support ticket submitted! We\'ll get back to you soon.', 'success');
      setSubject('');
      setMessage('');
    },
    onError: () => addToast('Failed to submit ticket. Please try again.', 'error'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      addToast('Please fill in all fields', 'error');
      return;
    }
    submitMutation.mutate({ subject: subject.trim(), message: message.trim() });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Support</h1>
        <p className="text-gray-500 text-sm mt-1">Get help and find answers</p>
      </div>

      {/* FAQ Section */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <HelpCircle className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Frequently Asked Questions</h2>
        </div>
        <div className="divide-y divide-surface-800">
          {faqs.map((faq, i) => (
            <button
              key={i}
              onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
              className="w-full text-left py-3 group"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800 pr-4">{faq.q}</p>
                <ChevronRight className={`h-4 w-4 text-gray-300 flex-shrink-0 transition-transform ${expandedFaq === i ? 'rotate-90' : ''}`} />
              </div>
              {expandedFaq === i && (
                <p className="text-sm text-gray-500 mt-2 pr-8">{faq.a}</p>
              )}
            </button>
          ))}
        </div>
      </Card>

      {/* Contact Form */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="h-5 w-5 text-rsn-red" />
          <h2 className="font-semibold text-[#1a1a2e]">Submit a Support Request</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Subject"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="What do you need help with?"
          />
          <div>
            <label className="text-sm font-medium text-gray-600 mb-1.5 block">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Describe your issue or question..."
              rows={4}
              className="w-full rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:border-[#1a1a2e] focus:outline-none focus:ring-1 focus:ring-[#1a1a2e] transition-colors"
            />
          </div>
          <Button type="submit" isLoading={submitMutation.isPending}>
            <Mail className="h-4 w-4 mr-2" /> Submit Ticket
          </Button>
        </form>
      </Card>

      {/* My Tickets */}
      {myTickets && myTickets.length > 0 && (
        <Card className="animate-fade-in-up">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="h-5 w-5 text-rsn-red" />
            <h2 className="font-semibold text-[#1a1a2e]">Your Tickets</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {myTickets.map((t: any) => {
              const badge = STATUS_BADGE[t.status] || STATUS_BADGE.open;
              return (
                <div key={t.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {t.status === 'resolved' ? (
                      <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
                    ) : t.status === 'in_progress' ? (
                      <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
                    ) : (
                      <Clock className="h-4 w-4 text-gray-400 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{t.subject}</p>
                      <p className="text-xs text-gray-400">{new Date(t.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Contact info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-gray-400 flex-shrink-0" />
          <div>
            <p className="text-sm text-gray-600">Email us directly</p>
            <p className="text-xs text-gray-400">support@rsn.network</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
