// ─── The lifecycle steps an organiser takes from the event page (Part 2 Task 11; spec 11) ────────────────────────────
// One mutation per press, over Task 2's routes. Each step tells every open screen through session:<id> (and the lists'
// tags); the event page's query (['session', id], meta.entities [session:<id>]) is also refreshed here so the
// organiser's own chip turns at once. A permanent delete leaves the page for the Events list.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { EventLifecycleAction } from '@rsn/shared';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { LIFECYCLE_COPY, cancelledSentence } from './lifecycle-text';

export interface LifecycleStep {
  action: EventLifecycleAction;
  /** Cancel: the organiser's reason, shown to everyone told. */
  reason?: string;
  /** Delete permanently: the event's name as typed. */
  confirmTitle?: string;
}

/** Task 2's route for one step: the one way the preview client takes it (the event page and the admin events list). */
export function requestLifecycleStep(sessionId: string, step: LifecycleStep) {
  const base = `/sessions/${sessionId}`;
  switch (step.action) {
    case 'publish': return api.post(`${base}/publish`);
    case 'unpublish': return api.post(`${base}/unpublish`);
    case 'cancel': return api.post(`${base}/cancel`, step.reason?.trim() ? { reason: step.reason.trim() } : {});
    case 'archive': return api.post(`${base}/archive`);
    case 'unarchive': return api.delete(`${base}/archive`);
    case 'delete_permanently': return api.post(`${base}/delete-permanently`, { confirmTitle: step.confirmTitle ?? '' });
  }
}

function doneSentence(step: LifecycleStep, data: { notified?: number } | undefined): string | null {
  switch (step.action) {
    case 'publish': return LIFECYCLE_COPY.published;
    case 'unpublish': return LIFECYCLE_COPY.unpublished;
    case 'cancel': return cancelledSentence(data?.notified ?? 0);
    // Archived says so inline beside Restore; no toast on top of it.
    case 'archive': return null;
    case 'unarchive': return LIFECYCLE_COPY.restored;
    case 'delete_permanently': return LIFECYCLE_COPY.deleted;
  }
}

export function useEventLifecycle(sessionId: string, opts: { onDone?: (step: LifecycleStep) => void } = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);

  return useMutation({
    networkMode: 'always',
    mutationFn: (step: LifecycleStep) => requestLifecycleStep(sessionId, step).then((r) => r.data?.data as { notified?: number } | undefined),
    onSuccess: (data, step) => {
      const sentence = doneSentence(step, data);
      if (sentence) addToast(sentence, 'success');
      opts.onDone?.(step);
      if (step.action === 'delete_permanently') {
        qc.removeQueries({ queryKey: ['session', sessionId] });
        navigate('/sessions');
        return;
      }
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    // Cancel and Delete are asked in a dialog, which says a refusal at its own field; the other steps say it here.
    onError: (err, step) => {
      if (step.action === 'cancel' || step.action === 'delete_permanently') return;
      addToast(organiserSentence(err, LIFECYCLE_COPY.fallback), 'error');
    },
  });
}
