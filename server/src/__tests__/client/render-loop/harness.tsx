// The render-loop harness (C7 fix round 1, 26 Oct 2026), bundled by c7-forms-render-loop.test.ts with esbuild and run
// in Chromium: it mounts the REAL Schedule an Event page, Create a Pod (and Duplicate), Edit Pod and Edit Event, with
// react-hook-form, React Query, the router and every effect live; only the API and the auth store are stood in. Every
// React commit under the root is counted (window.__commits), so a render loop, loud or quiet, shows up as a number
// that keeps growing while nobody touches the page. Adapted from the C7 reviewer's harness.
import { Profiler, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import CreateSessionPage from '@/features/sessions/CreateSessionPage';
import CreatePodModal from '@/features/pods/CreatePodModal';
import EditPodModal from '@/features/pods/EditPodModal';
import EditEventModal from '@/features/sessions/EditEventModal';

interface Scenario {
  form: 'create-event' | 'create-pod' | 'duplicate-pod' | 'edit-pod' | 'edit-event';
  role: 'member' | 'admin';
  /** create-event: the pod in ?podId=, or none. */
  podId?: string;
  /** edit-event: a speed-networking event or a video meeting. */
  event?: 'rounds' | 'meeting';
  /** How many times the parent renders again after mounting, each time with fresh props, as a refetch gives. */
  ticks: number;
  strict: boolean;
}

const w = window as unknown as { __commits: number; __scenario: Scenario };
const scenario = w.__scenario;
w.__commits = 0;
useAuthStore.setState({ user: { id: 'u1', role: scenario.role, firstName: 'Dee' } });

/** A parent that renders again `count` times, 30ms apart, then stops. */
function useTicks(count: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= count) return undefined;
    const t = setTimeout(() => setN((x) => x + 1), 30);
    return () => clearTimeout(t);
  }, [n, count]);
  return n;
}

const EVENTS = {
  rounds: {
    id: 'S1', podId: 'P2', title: 'Founders mixer', description: 'Old event', scheduledAt: '2026-11-05T15:30:00.000Z', format: 'speed_networking',
    config: { numberOfRounds: 4, roundDurationSeconds: 420, maxParticipants: 300, timerVisibility: 'always_visible', matchingPolicy: 'platform_wide', eventType: 'speed_networking' },
  },
  meeting: {
    id: 'S2', podId: 'P1', title: 'Board catch-up', description: 'Monthly', scheduledAt: '2026-11-08T09:00:00.000Z', format: 'video_meeting',
    config: { durationMinutes: 45, maxParticipants: 20, eventType: 'video_meeting' },
  },
};

function Host() {
  useTicks(scenario.ticks);
  const noop = () => {};
  // Fresh objects on every render, as PodDetailPage's duplicate values and a refetched event page give.
  if (scenario.form === 'create-pod' || scenario.form === 'duplicate-pod') {
    const initialValues = scenario.form === 'duplicate-pod'
      ? { name: 'Test (copy)', podType: 'reason', orchestrationMode: 'timed_rounds', communicationMode: 'audio', visibility: 'invite_only', maxMembers: 12 }
      : undefined;
    return <CreatePodModal open onClose={noop} initialValues={initialValues} />;
  }
  if (scenario.form === 'edit-pod') {
    const pod = { id: 'P1', name: 'Old reason', description: null, podType: 'reason', orchestrationMode: 'timed_rounds', communicationMode: 'video', visibility: 'private', maxMembers: 12, rules: 'Be kind', allowMemberInvites: false };
    return <EditPodModal open onClose={noop} pod={pod} />;
  }
  const session = JSON.parse(JSON.stringify(EVENTS[scenario.event ?? 'rounds']));
  return <EditEventModal open onClose={noop} session={session} podType={scenario.event === 'meeting' ? 'reason' as never : 'speed_networking' as never} isAdmin={scenario.role === 'admin'} />;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const start = scenario.form === 'create-event' ? `/sessions/new${scenario.podId ? `?podId=${scenario.podId}` : ''}` : '/';

function App() {
  return (
    <Profiler id="root" onRender={() => { w.__commits += 1; }}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[start]}>
          <Routes>
            <Route path="/sessions/new" element={<CreateSessionPage />} />
            <Route path="/" element={<Host />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Profiler>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(scenario.strict ? <StrictMode><App /></StrictMode> : <App />);
