// ─── End event, for a super admin, on a live event (10 Nov 2026, F7, spec 10/07) ─────────────────────────────────
//
// A member's event left running could be ended by nobody but its host. A super admin now sees "End event" on the
// event's page and on the Admin Events rows while the event is live. It asks first ("End this event for everyone?"),
// sends the host's own POST /sessions/:id/host/end, is disabled while that is on its way, and lets the server's
// completed fan-out move every page (no cache is edited here). Pinned by source: these are React components.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('EndEventButton', () => {
  const src = () => read('features/sessions/EndEventButton.tsx');

  it('asks "End this event for everyone?" as a danger question, and ends only after a yes', () => {
    const s = src();
    expect(s).toContain("title: 'End this event for everyone?'");
    expect(s).toContain("tone: 'danger'");
    expect(s).toMatch(/const sure = await ask\(\{[\s\S]*?\}\);\s*if \(sure\) endEvent\.mutate\(\);/);
    expect(s).toContain('{confirmDialog}');
  });

  it('sends the host\'s end request and edits no cache', () => {
    const s = src();
    expect(s).toContain('api.post(`/sessions/${sessionId}/host/end`)');
    expect(s).not.toContain('setQueryData');
    expect(s).toContain("qc.invalidateQueries({ queryKey: ['admin-sessions'] })");
  });

  it('cannot be pressed twice: disabled while pending, and a press while pending is ignored', () => {
    const s = src();
    expect(s).toContain('disabled={endEvent.isPending}');
    expect(s).toContain('if (endEvent.isPending) return;');
  });

  it('is a 44px tap target that never wraps its label, and says "event", never "session", to the user', () => {
    const s = src();
    expect(s).toContain('min-h-[44px]');
    expect(s).toContain('whitespace-nowrap');
    const userText = [
      ...[...s.matchAll(/(?:title|body|confirmLabel|cancelLabel): '([^']*)'/g)].map(m => m[1]),
      ...[...s.matchAll(/addToast\('([^']*)'/g)].map(m => m[1]),
    ];
    expect(userText).toHaveLength(6);
    for (const t of userText) expect(t.toLowerCase()).not.toContain('session');
    expect(s).toContain("addToast('Could not end the event. Please try again.', 'error')");
  });
});

describe('where it shows', () => {
  it('the event page shows it to a super admin while the event is live, by platform role only', () => {
    const s = read('features/sessions/SessionDetailPage.tsx');
    expect(s).toContain("const mayEndForEveryone = user?.role === 'super_admin' && phase === 'live';");
    expect(s).toContain('{mayEndForEveryone && sessionId && <EndEventButton sessionId={sessionId} />}');
  });

  it('Admin Events shows it on live rows for a super admin, and the row wraps at phone width', () => {
    const s = read('features/admin/AdminSessionsPage.tsx');
    expect(s).toMatch(/\{isSuperAdmin && sessionStatusPhase\(session\.status\) === 'live' && \(\s*<EndEventButton sessionId=\{session\.id\}/);
    expect(s).toContain('<div className="flex flex-wrap items-center justify-between gap-3">');
    expect(s).toContain('<div className="flex flex-wrap items-center gap-2">');
  });
});
