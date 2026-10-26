// Share a circle post into another circle the member belongs to, with a note. The circle wall's Share menu opens
// this; the pod wall has no sharing (pod content stays in the pod).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { wallErrorSentence } from '@/components/wall/wall-logic';
import type { WallPost } from '@/components/wall/wall-types';

interface CircleOption { id: string; name: string; isMember: boolean }

export default function ShareToCircle({ post, currentCircleId, onDone }: { post: WallPost; currentCircleId: string; onDone: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [clientId] = useState(() => crypto.randomUUID());

  // realtime: skip — a one-off picker; the circle list changes rarely and refetches on focus
  const { data: circles, isLoading } = useQuery<CircleOption[]>({
    queryKey: ['circles', 'share-picker'],
    queryFn: () => api.get('/circles').then(r => (r.data.data ?? []) as CircleOption[]),
    staleTime: 60_000,
  });
  const options = (circles ?? []).filter(c => c.isMember && c.id !== currentCircleId);

  const share = async () => {
    if (!target || sending) return;
    setSending(true);
    try {
      await api.post(`/circles/posts/${post.id}/share`, { circleId: target, clientId, content: note.trim() });
      const name = options.find(c => c.id === target)?.name || 'the circle';
      addToast(`Shared to ${name}.`, 'success');
      onDone();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not share.'), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3 space-y-2" data-testid={`share-form-${post.id}`}>
      {isLoading ? <Spinner /> : options.length === 0 ? (
        <p className="text-xs text-gray-500">You are not in any other circle yet.</p>
      ) : (
        <>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-400">Share to</label>
          <select
            value={target} onChange={e => setTarget(e.target.value)}
            aria-label="Circle to share to"
            className="w-full min-h-[44px] rounded-lg border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
          >
            <option value="">Choose a circle…</option>
            {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <textarea
            value={note} onChange={e => setNote(e.target.value)}
            placeholder="Say something about it (optional)"
            maxLength={2000} rows={2}
            aria-label="Your note"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30 resize-none"
          />
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} className="min-h-[44px]">Cancel</Button>
        {options.length > 0 && (
          <Button size="sm" onClick={share} disabled={!target || sending} className="min-h-[44px]" data-testid={`share-submit-${post.id}`}>
            <Share2 className="h-3.5 w-3.5 mr-1.5" /> {sending ? 'Sharing…' : 'Share'}
          </Button>
        )}
      </div>
    </div>
  );
}
