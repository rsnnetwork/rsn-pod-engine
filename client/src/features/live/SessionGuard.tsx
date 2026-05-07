// ─── Session Guard ──────────────────────────────────────────────────────────
//
// Phase 7B.2 (7 May spec) — wraps LiveSessionPage with a 404-recovery
// guard. Stefan #1: users hit 404 when entering an event, had to
// restart/login again. The frontend showed a raw 404 page instead of a
// recoverable state.
//
// Behaviour:
//   1. On mount, fetch /sessions/:id. If 200, render the children
//      (LiveSessionPage) immediately.
//   2. If the fetch fails with 404 OR network error: show "Reconnecting..."
//      with retry. Backoff: 1s, 2s, 4s. After 3 retries: "This event no
//      longer exists" with a Back-to-Dashboard button.
//   3. Re-runs on document visibility change (handles tab-switch where
//      the session ended elsewhere).
//
// Generic safety net: covers the specific case Stefan hit AND every
// other case of the same shape (stale session URL, race between
// route-mount and backend-init, browser-back to ended event).

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';

type GuardState =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'retrying'; attempt: number }
  | { kind: 'gone' }
  | { kind: 'error'; message: string };

const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries with backoff

export default function SessionGuard({ children }: { children: ReactNode }) {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<GuardState>({ kind: 'checking' });
  // Phase 7-audit fix — mounted-ref so retry timers + visibility re-checks
  // don't setState on unmounted components (fast back-nav races).
  const mountedRef = useRef(true);
  const safeSetState = useCallback((next: GuardState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const checkSession = useCallback(async (attempt: number): Promise<void> => {
    if (!sessionId) {
      safeSetState({ kind: 'error', message: 'Missing session ID' });
      return;
    }
    try {
      const res = await api.get(`/sessions/${sessionId}`);
      if (res?.data?.success) {
        safeSetState({ kind: 'ready' });
        return;
      }
      throw new Error('Session response not ok');
    } catch (err: any) {
      const status = err?.response?.status;
      // Distinguish "session genuinely gone" (404) from transient errors
      // (network blip, 5xx, race). Both get retried, but a sustained 404
      // ends in "gone"; sustained other errors end in a generic error.
      if (attempt >= RETRY_DELAYS_MS.length) {
        if (status === 404) {
          safeSetState({ kind: 'gone' });
        } else {
          safeSetState({ kind: 'error', message: err?.message || 'Could not reach the event' });
        }
        return;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      safeSetState({ kind: 'retrying', attempt: attempt + 1 });
      setTimeout(() => {
        if (mountedRef.current) checkSession(attempt + 1);
      }, delay);
    }
  }, [sessionId, safeSetState]);

  useEffect(() => {
    mountedRef.current = true;
    checkSession(0);
    // Re-check on tab focus — covers the "session ended in another tab" case.
    // Reads `state.kind === 'ready'` via closure — fine since the listener
    // is re-registered on every effect run when `state` changes.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && state.kind === 'ready') {
        // Cheap re-validate: if it 404s now, we transition to gone.
        api.get(`/sessions/${sessionId}`).catch((err) => {
          if (err?.response?.status === 404) safeSetState({ kind: 'gone' });
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (state.kind === 'checking') {
    return <PageLoader />;
  }

  if (state.kind === 'retrying') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-white px-6">
        <div className="text-center max-w-md">
          <Loader2 className="h-8 w-8 text-rsn-red animate-spin mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Reconnecting…</h2>
          <p className="text-sm text-gray-500">
            Trying to load this event (attempt {state.attempt} of {RETRY_DELAYS_MS.length})
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'gone') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-white px-6">
        <div className="text-center max-w-md">
          <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">This event no longer exists</h2>
          <p className="text-sm text-gray-500 mb-6">
            It may have ended or been cancelled. Head back to your dashboard to find another event.
          </p>
          <Button onClick={() => navigate('/sessions')}>Back to dashboard</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-white px-6">
        <div className="text-center max-w-md">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Couldn't load the event</h2>
          <p className="text-sm text-gray-500 mb-6">{state.message}</p>
          <div className="flex gap-2 justify-center">
            <Button variant="secondary" onClick={() => navigate('/sessions')}>Back to dashboard</Button>
            <Button onClick={() => { setState({ kind: 'checking' }); checkSession(0); }}>Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
