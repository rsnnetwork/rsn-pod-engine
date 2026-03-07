import { useState } from 'react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useToastStore } from '@/stores/toastStore';
import { HelpCircle, MessageSquare, Mail, ChevronRight } from 'lucide-react';

const faqs = [
  { q: 'How do I join a pod?', a: 'Go to the Pods page, browse available pods, and click "Join" on one that interests you. Or create your own pod.' },
  { q: 'How does matching work?', a: 'During live events, our matching engine pairs you with other participants for 1:1 video conversations. Each round, you get a new partner.' },
  { q: 'What is the unlock system?', a: 'Invite others to RSN. Each accepted invite unlocks more pod slots. 1 invite = 1 pod, 3 invites = 3 pods.' },
  { q: 'What if someone is selling during a session?', a: 'RSN has a strict no-selling policy. Report the user and they\'ll receive a strike. Three strikes = permanent ban.' },
  { q: 'How do I become a host?', a: 'Hosts are assigned by admins. Contact support if you\'d like to host events for your community.' },
];

export default function SupportPage() {
  const { addToast } = useToastStore();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      addToast('Please fill in all fields', 'error');
      return;
    }
    setSubmitting(true);
    // Simulate submission
    await new Promise(r => setTimeout(r, 1000));
    addToast('Support ticket submitted! We\'ll get back to you soon.', 'success');
    setSubject('');
    setMessage('');
    setSubmitting(false);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-surface-100">Support</h1>
        <p className="text-surface-400 text-sm mt-1">Get help and find answers</p>
      </div>

      {/* FAQ Section */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <HelpCircle className="h-5 w-5 text-brand-400" />
          <h2 className="font-semibold text-surface-100">Frequently Asked Questions</h2>
        </div>
        <div className="divide-y divide-surface-800">
          {faqs.map((faq, i) => (
            <button
              key={i}
              onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
              className="w-full text-left py-3 group"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-surface-200 pr-4">{faq.q}</p>
                <ChevronRight className={`h-4 w-4 text-surface-600 flex-shrink-0 transition-transform ${expandedFaq === i ? 'rotate-90' : ''}`} />
              </div>
              {expandedFaq === i && (
                <p className="text-sm text-surface-400 mt-2 pr-8">{faq.a}</p>
              )}
            </button>
          ))}
        </div>
      </Card>

      {/* Contact Form */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="h-5 w-5 text-brand-400" />
          <h2 className="font-semibold text-surface-100">Contact Support</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Subject"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="What do you need help with?"
          />
          <div>
            <label className="text-sm font-medium text-surface-300 mb-1.5 block">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Describe your issue or question..."
              rows={4}
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-100 placeholder:text-surface-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 transition-colors"
            />
          </div>
          <Button type="submit" isLoading={submitting}>
            <Mail className="h-4 w-4 mr-2" /> Submit Ticket
          </Button>
        </form>
      </Card>

      {/* Contact info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-surface-500 flex-shrink-0" />
          <div>
            <p className="text-sm text-surface-300">Email us directly</p>
            <p className="text-xs text-surface-500">support@rsn.network</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
