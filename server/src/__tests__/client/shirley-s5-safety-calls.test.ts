// server/src/__tests__/client/shirley-s5-safety-calls.test.ts
// Shirley Palmer's walkthrough (11 Nov 2026), task S5:
//   - item 16 (safety): "Flag" read as an Outlook follow-up marker. Now "Report member", "Report message", "Report post"
//     and a separate "Block member", in words, each saying what happens before it is sent; no reason chosen for the
//     person; reporting or blocking keeps the person in the conversation, read-only once blocked.
//   - RSN 07 (presence): the call button looked disabled ("offline") while presence was loading, then came alive. Now
//     loading is unknown (no label, button works), presence is online / away / offline pushed by user:<id>:presence
//     (no polling), the inbox dot and the header read one query, and calling someone offline opens Try again / Find a
//     time / Send a message.
//   - RSN 08: leaving a call returns to the conversation, the room replaced in the history; feedback is an optional
//     sheet with "Not now".
//   - RSN 09: "Meeting booked. Calendar invitation sent by email." only when it went; "Add manually" secondary, the
//     calendar file first.
// The pure rules run here; the components are drawn with their imports stood in; the wiring is read from source.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ALREADY_REPORTED, BLOCK_MEMBER, REPORT_MEMBER, REPORT_MESSAGE, REPORT_POST, blockConsequence, blockTitle,
  blockedThreadLine, reportConsequence, reportSentLine, reportTitle,
} from '../../../../client/src/components/safety/safety-words';
import {
  awayNote, callHint, callOpensOfflineSheet, inboxDot, offlineTitle, presenceBadge, stateIn, stillOffline,
} from '../../../../client/src/features/calls/presence-words';
import {
  ADD_MANUALLY, ADD_TO_CALENDAR, bookedSentence, inviteEmailed, inviteLine,
} from '../../../../client/src/components/calendar/invite-words';
import { afterRoomPath } from '../../../../client/src/features/meetings/meeting-feedback';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const html = (el: unknown) => renderToStaticMarkup(el as never);

// ─── Item 16: words and consequences ──────────────────────────────────────────────────────────────────────────────────

describe('safety words', () => {
  it('say what each action is, in words: Report member, Report message, Report post, Block member', () => {
    expect([REPORT_MEMBER, REPORT_MESSAGE, REPORT_POST, BLOCK_MEMBER]).toEqual(['Report member', 'Report message', 'Report post', 'Block member']);
    expect(reportTitle('member', 'Bo')).toBe('Report Bo');
    expect(reportTitle('message', 'Bo')).toBe('Report this message');
    expect(reportTitle('post', 'Bo')).toBe('Report this post');
    expect(blockTitle(null)).toBe('Block this member?');
  });

  it('a report says who reviews it, what they can read, that the person is not told and nothing changes until then', () => {
    expect(reportConsequence('message', 'Bo', true)).toBe(
      "The REASON team will review this message and can read this conversation. Bo won't be told about your report, and nothing changes for them until we have looked at it.",
    );
    expect(reportConsequence('member', 'Bo', false)).toBe(
      "The REASON team will review your report. Bo won't be told about your report, and nothing changes for them until we have looked at it.",
    );
    expect(reportConsequence('post', null, false)).toMatch(/^The REASON team will review this post\. They won't be told/);
  });

  it('a block says every consequence before it is done: messages, calls, matching, posts both ways, not told, the thread stays', () => {
    const s = blockConsequence('Bo');
    for (const part of ["won't be able to message or call you", "won't be matched together", "won't see each other's posts or comments", "They aren't told", 'Your conversation stays, read-only', 'You can unblock them']) {
      expect(s).toContain(part);
    }
    expect(blockedThreadLine('Bo')).toBe("You blocked Bo. They can't message or call you. The conversation stays here, read-only.");
    expect(reportSentLine('Bo', true)).toBe('Thanks. The REASON team will review it. You also blocked Bo: they can no longer message or call you.');
    expect(ALREADY_REPORTED).toBe('You already reported this.');
  });

  it('no safety entry point anywhere still uses the Flag icon or the old words', () => {
    for (const rel of [
      'features/messages/MessagesPage.tsx', 'features/profile/PublicProfilePage.tsx', 'features/reason/human/ProfileMoreMenu.tsx',
      'features/reason/human/HumanProfilePage.tsx', 'components/ReportUserModal.tsx', 'components/wall/WallPostCard.tsx',
    ]) {
      const src = readClientSource(rel);
      expect(src).not.toMatch(/<Flag\b|[{,]\s*Flag\s*[,}]/);
      expect(src).not.toMatch(/>\s*Report this member\s*</);
      expect(src).not.toMatch(/>\s*Block this member\s*</);
    }
  });
});

describe('the report sheet', () => {
  let mutateCalls = 0;
  const load = () => loadClientModule('components/ReportUserModal.tsx', {
    '@/components/ui/Modal': { __esModule: true, default: (p: { open: boolean; title: string; children: unknown }) => (p.open ? createElement('section', { 'data-title': p.title }, p.children as never) : null) },
    '@/components/ui/Button': { __esModule: true, Button: (p: Record<string, unknown>) => createElement('button', { type: p.type as string, disabled: p.disabled as boolean, 'data-loading': p.isLoading ? 'yes' : undefined }, p.children as never) },
    '@/lib/api': { __esModule: true, default: { post: () => Promise.resolve({}) } },
    '@tanstack/react-query': { useMutation: () => ({ mutate: () => { mutateCalls += 1; }, reset: () => undefined, isPending: false, isError: false }) },
    '@/features/messages/voice/composer-drafts': { dropDraftsTo: () => undefined },
  }).default as (p: Record<string, unknown>) => unknown;

  it('reporting a message quotes it, says what happens next, chooses no reason, and keeps Send waiting for one', () => {
    const Modal = load();
    const out = html(createElement(Modal as never, {
      open: true, onClose: () => undefined, reportedId: 'u-bo', reportedDisplayName: 'Bo', conversationId: 'c-1',
      subject: { kind: 'dm_message', id: 'm-1', excerpt: 'You will regret this.' },
    }));
    expect(out).toContain('data-title="Report this message"');
    expect(out).toContain('<blockquote');
    expect(out).toContain('You will regret this.');
    expect(out).toContain(reportConsequence('message', 'Bo', true).replace(/'/g, '&#x27;'));
    // The reason select starts on the disabled "Choose a reason", and the hint says so.
    expect(out).toMatch(/<select id="report-reason"[^>]*>.*<option value="" disabled="" selected="">Choose a reason<\/option>/);
    expect(out).toContain('Choose a reason first.');
    expect(out).toMatch(/<button type="submit" disabled="">Send report<\/button>/);
    // "Also block" explains itself.
    expect(out).toContain('Also block Bo');
    expect(out).toContain(blockConsequence('Bo').replace(/'/g, '&#x27;'));
  });

  it('someone already blocked is offered no "Also block"', () => {
    const out = html(createElement(load() as never, { open: true, onClose: () => undefined, reportedId: 'u-bo', reportedDisplayName: 'Bo', alreadyBlocked: true }));
    expect(out).toContain('data-title="Report Bo"');
    expect(out).not.toContain('Also block');
  });

  it('source: a 409 is "You already reported this." (and an Also block still goes), and the sheet never leaves the conversation', () => {
    const src = readClientSource('components/ReportUserModal.tsx');
    expect(src).toContain("if ((err as FailedRequest)?.response?.status !== 409) throw err;");
    expect(src).toMatch(/already = true;\s*\}\s*\/\/[^\n]*\n[^\n]*\n\s*if \(alsoBlock\) \{/);
    expect(src).toContain("const [reason, setReason] = useState<ReportReason | ''>('');");
    expect(src).toContain("setReason('');");
    expect(src).not.toMatch(/navigate\(/);
    expect(src).toContain("...(subject ? { subject: { kind: subject.kind, id: subject.id } } : {}),");
    expect(mutateCalls).toBe(0);
  });
});

describe('the thread keeps the person in it (item 16)', () => {
  const page = () => readClientSource('features/messages/MessagesPage.tsx');

  it('blocking asks first with every consequence, then stays: no navigation away, the block status read again', () => {
    const src = page();
    const block = src.slice(src.indexOf('const blockUser = async'), src.indexOf('const unblockUser = async'));
    expect(block).toContain("await ask({ title: blockTitle(name), body: blockConsequence(name), confirmLabel: 'Block', tone: 'danger' })");
    expect(block).not.toMatch(/navigate\(/);
    expect(block).toContain("void qc.invalidateQueries({ queryKey: ['dm-block-status', userId] });");
  });

  it('the report sheet\'s Also block keeps the thread too (it used to navigate to /messages)', () => {
    const src = page();
    const modal = src.slice(src.indexOf('<ReportUserModal'), src.indexOf('/>', src.indexOf('<ReportUserModal')));
    expect(modal).toContain("onBlocked={() => { void qc.invalidateQueries({ queryKey: ['dm-block-status', headerContext.otherUserId] }); }}");
    expect(modal).not.toMatch(/navigate/);
    expect(modal).toContain('subject={reporting?.subject ?? null}');
  });

  it('a blocked thread is read-only: the banner with Unblock replaces the box, and no call, scheduler or card action is offered', () => {
    const src = page();
    expect(src).toContain('const readOnly = otherIsFormer || blockedByMe;');
    expect(src).toMatch(/\) : blockedByMe \? \(\s*<BlockedThreadBanner/);
    expect(src).toMatch(/queryKey: \['dm-block-status', otherId\],[\s\S]{0,300}meta: \{ entities: myUserId && otherId \? \[E\.userBlocks\(myUserId\), E\.userBlocks\(otherId\)\] : \[\] \}/);
    expect(src).toMatch(/\{activeConv && !readOnly && canCall && \(\s*<CallButton\s*variant="icon"/);
    expect(src).toMatch(/\{activeConv && !readOnly && !callsUnlocked && \(\s*<button\s*onClick=\{openScheduler\}/);
  });

  it('Report member, Block member and Delete conversation are labelled items in one menu at every width', () => {
    const src = page();
    expect(src).toContain('<ThreadMoreMenu dot={availabilityDot && !readOnly}>');
    expect(src).toMatch(/<ShieldAlert[^>]*\/> \{REPORT_MEMBER\}/);
    expect(src).toMatch(/<Ban[^>]*\/> \{BLOCK_MEMBER\}/);
    expect(src).toMatch(/<Ban[^>]*\/> \{UNBLOCK\}/);
    expect(src).not.toMatch(/className="relative sm:hidden"/);
  });

  it('a received message has "⋯" with Report message, quoting it; my own messages have none', () => {
    const src = page();
    expect(src).toMatch(/\{!fromMe && \(\s*<MessageMoreButton\s*onReport=\{\(\) => setReporting\(\{ subject: \{ kind: 'dm_message', id: m\.id, excerpt: replyContentOf\(m\) \} \}\)\}/);
    const bits = loadClientModule('features/messages/thread/ThreadSafety.tsx', { 'lucide-react': iconStandIns });
    const out = html(createElement(bits.MessageMoreButton as never, { onReport: () => undefined }));
    expect(out).toContain('aria-label="More actions for this message"');
    expect(out).toMatch(/after:-inset-3/); // a 46px target around the small dot
    const banner = html(createElement(bits.BlockedThreadBanner as never, { name: 'Bo', onUnblock: () => undefined, unblocking: false }));
    expect(banner).toContain(blockedThreadLine('Bo').replace(/'/g, '&#x27;'));
    expect(banner).toMatch(/<button type="button" class="min-h-\[44px\][^"]*">Unblock<\/button>/);
    expect(banner).toContain('env(safe-area-inset-bottom');
    const menu = html(createElement(bits.ThreadMoreMenu as never, { dot: false, children: () => 'items' }));
    expect(menu).toContain('aria-label="More actions"');
    expect(menu).toMatch(/h-11 min-w-\[44px\]/);
    expect(menu).toContain('<span class="hidden text-xs font-medium sm:inline">More</span>');
  });

  it('wall posts by someone else can be reported from where they are; never your own', () => {
    const card = readClientSource('components/wall/WallPostCard.tsx');
    expect(card).toContain('const mayReport = !!config.reportKind && !!userId && p.authorId !== userId;');
    expect(card).toMatch(/\{mayReport && config\.reportKind && \(\s*<ReportPostButton/);
    expect(readClientSource('features/pods/pod-wall-config.ts')).toContain("reportKind: 'pod_post',");
    expect(readClientSource('features/circles/CircleWall.tsx')).toContain("reportKind: 'circle_post',");
    const btn = readClientSource('components/wall/ReportPostButton.tsx');
    expect(btn).toContain('{REPORT_POST}');
    expect(btn).toContain('subject={{ kind, id: postId, excerpt }}');
  });
});

// ─── RSN 07: presence and the call button ─────────────────────────────────────────────────────────────────────────────

describe('presence rules', () => {
  it('loading (undefined) and unknown (null) show nothing, never "Offline", and never open the offline sheet', () => {
    for (const p of [undefined, null]) {
      expect(presenceBadge(p)).toBeNull();
      expect(inboxDot(p)).toBeNull();
      expect(callOpensOfflineSheet(p)).toBe(false);
      expect(callHint(p, 'Bo')).toBe('Video call');
    }
  });

  it('online, away and offline each have their word; only offline opens the sheet instead of ringing', () => {
    expect(presenceBadge('online')?.label).toBe('Online');
    expect(presenceBadge('away')?.label).toBe('Away');
    expect(presenceBadge('offline')?.label).toBe('Offline');
    expect(inboxDot('online')).toBe('bg-emerald-500');
    expect(inboxDot('away')).toBe('bg-amber-400');
    expect(inboxDot('offline')).toBeNull();
    expect(callOpensOfflineSheet('online')).toBe(false);
    expect(callOpensOfflineSheet('away')).toBe(false);
    expect(callOpensOfflineSheet('offline')).toBe(true);
    expect(awayNote('Bo')).toBe("Bo is away. They'll see your call when they're back.");
    expect(callHint('offline', 'Bo', 'Audio call')).toBe("Audio call: Bo isn't on REASON right now");
    expect(offlineTitle('Bo')).toBe("Bo isn't on REASON right now.");
    expect(stillOffline('Bo')).toMatch(/^Bo still isn't on REASON\./);
  });

  it('one inbox read answers the header too; an older answer with only `online` still reads', () => {
    expect(stateIn(undefined, 'u-1')).toBeUndefined();
    expect(stateIn({ online: {}, states: { 'u-1': 'away' } }, 'u-1')).toBe('away');
    expect(stateIn({ online: {}, states: {} }, 'u-1')).toBeNull();
    expect(stateIn({ online: { 'u-1': true } }, 'u-1')).toBe('online');
    expect(stateIn({ online: { 'u-1': false } }, 'u-1')).toBeNull();
    expect(stateIn({ online: {}, states: {} }, undefined)).toBeNull();
  });
});

describe('the call button', () => {
  const CallButton = () => loadClientModule('features/calls/CallButton.tsx', { 'lucide-react': iconStandIns }).default as (p: object) => unknown;

  it('is pressable when nothing is ringing, whatever presence says; an away note sits under the words', () => {
    const out = html(createElement(CallButton() as never, { variant: 'hero', onClick: () => undefined, note: awayNote('Bo') }));
    expect(out).not.toMatch(/ disabled=""/);
    expect(out).toContain('Video call');
    expect(out).toContain(awayNote('Bo').replace(/'/g, '&#x27;'));
  });

  it('the thread never disables it for presence (only while a call of mine rings), nor shows "Offline" while loading', () => {
    const src = readClientSource('features/messages/MessagesPage.tsx');
    expect(src).not.toContain('partnerOnline');
    expect(src).not.toMatch(/disabled=\{![a-zA-Z]+ \|\| calling\}/);
    expect(src.match(/disabled=\{calling\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('{activeConv && !readOnly && presenceShown && (');
  });

  it('no presence read polls; each declares the person\'s presence tag and the blocks tag', () => {
    const hooks = readClientSource('features/calls/usePresence.ts');
    expect(hooks).not.toMatch(/refetchInterval/);
    // Fix round 1 (M-4): not on user:<me>:dms, which fires on every message; keyed by the partners on screen instead.
    expect(hooks).toContain('[E.userBlocks(myUserId), ...partnerIds.map((id) => E.userPresence(id))]');
    expect(hooks).not.toContain('E.userDms(myUserId)');
    expect(hooks).toContain("['dm-inbox-presence', [...partnerIds].sort().join(',')]");
    expect(hooks).toContain('[E.userPresence(userId), E.userBlocks(myUserId)]');
    const src = readClientSource('features/messages/MessagesPage.tsx');
    expect(src).not.toMatch(/refetchInterval: 20_000/);
    expect(src).not.toMatch(/realtime: skip — presence/);
    expect(src).toContain("const inboxPresence = useInboxPresence(myUserId, inboxData?.map((c) => c.otherUserId) ?? []);");
    expect(src).toContain('const partnerPresence = stateIn(inboxPresence.data, activeConv?.otherUserId);');
    for (const f of ['client/src/realtime/entities.ts', 'server/src/realtime/entities.ts']) {
      expect(require('fs').readFileSync(require('path').join(__dirname, '../../../..', f), 'utf8')).toContain('userPresence: (userId: string) => `user:${userId}:presence`,');
    }
  });

  it('the profile\'s button follows the same rules: presence read, never disabled for it, the same offline sheet', () => {
    const src = readClientSource('features/calls/ProfileCallButton.tsx');
    expect(src).toContain('const presence = useMemberPresence(me, userId, !!brief.canCall);');
    expect(src).toContain('disabled={call.ringing}');
    expect(src).toContain('<OfflineCallSheet');
    expect(src).toContain("navigate(`/messages/new/${encodeURIComponent(userId)}${schedule ? '?schedule=1' : ''}`);");
  });

  it('pressing call while offline opens the sheet; the server refusing an offline ring opens it too; Try again reads again', () => {
    const src = readClientSource('features/calls/useCallRequest.ts');
    expect(src).toContain("if (presence && callOpensOfflineSheet(presence.state)) { setOfflineFor(k); return; }");
    expect(src).toContain("if (refusalCode(err) === 'CALL_PARTNER_OFFLINE' && presence) {");
    expect(src).toMatch(/const now = await presence\.refresh\(\);\s*if \(callOpensOfflineSheet\(now\)\) \{\s*addToast\(stillOffline\(partnerName\), 'info'\);/);
  });

  it('the offline sheet offers Try again, Find a time and Send a message, each 44px', () => {
    const Sheet = (p: { open: boolean; title: string; children: unknown; footer: unknown }) => (p.open ? createElement('div', { 'data-title': p.title }, p.children as never, p.footer as never) : null);
    const OfflineCallSheet = loadClientModule('features/calls/OfflineCallSheet.tsx', { '@/features/reason/ui/Sheet': { __esModule: true, default: Sheet } }).default;
    const out = html(createElement(OfflineCallSheet as never, {
      open: true, name: 'Bo', onClose: () => undefined, onTryAgain: () => undefined, onFindATime: () => undefined, onSendMessage: () => undefined, trying: false,
    }));
    expect(out).toContain(`data-title="${offlineTitle('Bo').replace(/'/g, '&#x27;')}"`);
    for (const label of ['Try again', 'Find a time', 'Send a message']) expect(out).toContain(`>${label}</button>`);
    expect(out.match(/min-h-\[44px\]/g)?.length).toBe(3);
    const noFind = html(createElement(OfflineCallSheet as never, {
      open: true, name: 'Bo', onClose: () => undefined, onTryAgain: () => undefined, onSendMessage: () => undefined, trying: true,
    }));
    expect(noFind).not.toContain('Find a time');
    expect(noFind).toContain('Checking…');
  });

  it('the app says when a tab goes behind (presence:away), and where it is the moment it (re)connects', () => {
    const app = readClientSource('App.tsx');
    expect(app).toMatch(/else socket\.emit\('presence:away'\);/);
    expect(app).toContain("socket.on('connect', ping);");
    expect(app).toContain("socket.off('connect', ping);");
  });
});

// ─── RSN 08: after a call ─────────────────────────────────────────────────────────────────────────────────────────────

describe('after a 1:1 call', () => {
  it('leaving always returns to the conversation; the question comes with it, never the meeting page', () => {
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: true })).toBe('/messages/c-1?feedback=m-1');
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: false })).toBe('/messages/c-1');
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: null, hadPartner: true })).toBe('/messages/c-1');
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: true })).not.toMatch(/^\/meetings\//);
  });

  it('every way out of the room replaces it in the history, so Back never re-enters the call', () => {
    const src = readClientSource('features/messages/MeetPage.tsx');
    expect(src).toContain('const leave = useCallback(() => navigate(`/messages/${conversationId}`, { replace: true }), [navigate, conversationId]);');
    expect(src).toContain(']).then(([to]) => navigate(to, { replace: true }));');
    expect(src.match(/navigate\(/g)).toHaveLength(2);
  });

  it('the thread asks over itself as an optional sheet with "Not now", once (the flag is dropped by replacing the address)', () => {
    const page = readClientSource('features/messages/MessagesPage.tsx');
    expect(page).toContain("const feedbackFor = activeId ? searchParams.get('feedback') : null;");
    expect(page).toMatch(/next\.delete\('feedback'\);\s*return next;\s*\}, \{ replace: true \}\);/);
    expect(page).toContain('{activeId && feedbackFor && <PostCallFeedback key={feedbackFor} meetingId={feedbackFor} onDone={feedbackDone} />}');
    const post = readClientSource('features/messages/thread/PostCallFeedback.tsx');
    expect(post).toContain('const due = !!meeting && feedbackCardDue(meeting, Date.now());');
    expect(post).toContain('const settled = !valid || isError || (!!meeting && !due);');
    expect(post).toContain('<MeetingFeedbackSheet open meeting={meeting} onClose={onDone} afterCall />');
    const sheet = readClientSource('features/meetings/MeetingFeedbackSheet.tsx');
    expect(sheet).toContain('{NOT_NOW}');
    expect(sheet).toContain("{afterCall ? ` ${ANSWER_LATER}` : ''}");
  });
});

// ─── RSN 09: booking clarity ──────────────────────────────────────────────────────────────────────────────────────────

describe('the booking sentence', () => {
  it('"Meeting booked. Calendar invitation sent by email." only when it went', () => {
    expect(bookedSentence('sent', false)).toBe('Meeting booked. Calendar invitation sent by email.');
    expect(bookedSentence('sent', true)).toBe('Meeting moved. Updated invitation sent by email.');
    for (const state of ['sending', 'not_sent', 'no_address', null, undefined] as const) {
      expect(bookedSentence(state, false)).not.toContain('Calendar invitation sent by email.');
    }
  });

  it('otherwise says what is true, pointing at Add manually', () => {
    expect(bookedSentence('not_sent', false, 'card')).toBe("Meeting booked. We couldn't email the calendar invitation; add it manually below.");
    expect(bookedSentence('no_address', false, 'card')).toBe('Meeting booked. We have no email address for you, so add it manually below.');
    expect(bookedSentence('sending', false)).toBe("Meeting booked. We're emailing the calendar invitation now.");
    expect(bookedSentence(null, false)).toBe('Meeting booked.');
    expect(inviteLine(null, false, 'card')).toBeNull();
    expect(inviteEmailed('sent')).toBe(true);
    expect(inviteEmailed('sending')).toBe(true);
    expect(inviteEmailed('not_sent')).toBe(false);
  });

  it('the scheduler summary, the thread card and the meeting page say it, and the old unconditional line is gone', () => {
    const summary = readClientSource('features/messages/SchedulerMeetingSummary.tsx');
    expect(summary).not.toContain('A calendar invite was emailed to you both.');
    expect(summary).toContain("const invite = inviteLine(meeting.inviteEmail, false, 'card');");
    expect(summary).toContain('emailed={emailed}');
    const card = readClientSource('features/messages/SystemMessageCard.tsx');
    expect(card).toContain("const invite = calendar ? inviteLine(calendar.inviteEmail, !!meta.movedFrom, 'card') : null;");
    expect(readClientSource('features/messages/MessagesPage.tsx')).toContain('inviteEmail: scheduling?.confirmed?.inviteEmail }');
    const page = readClientSource('features/meetings/MeetingDetailPage.tsx');
    expect(page).toContain("const invite = standing ? inviteLine(meeting.inviteEmail, false, 'card') : null;");
    expect(page).toContain('emailed={emailed}');
  });
});

describe('Add manually', () => {
  const load = () => loadClientModule('components/calendar/AddToCalendar.tsx', {
    'lucide-react': iconStandIns,
    '@/features/reason/ui/Sheet': { __esModule: true, default: () => null },
    '@/stores/toastStore': { useToastStore: () => () => undefined },
    'react-dom': { createPortal: (el: unknown) => el },
  }).default;
  const entry = { title: 'Meeting with Bo on REASON', start: new Date('2026-11-12T10:00:00Z'), end: new Date('2026-11-12T10:30:00Z'), details: 'x', location: 'https://x' };

  it('is "Add manually" once the invitation was emailed, "Add to calendar" otherwise', () => {
    const AddToCalendar = load();
    expect(html(createElement(AddToCalendar as never, { entry, file: () => Promise.resolve(''), emailed: true }))).toContain(`</svg> ${ADD_MANUALLY}</button>`);
    expect(html(createElement(AddToCalendar as never, { entry, file: () => Promise.resolve('') }))).toContain(`</svg> ${ADD_TO_CALENDAR}</button>`);
  });

  it('its menu offers the calendar file first (no sign-in), then Google and Outlook, each saying it may ask to sign in', () => {
    const src = readClientSource('components/calendar/AddToCalendar.tsx');
    const ics = src.indexOf('data-testid="calendar-ics"');
    expect(ics).toBeGreaterThan(0);
    expect(ics).toBeLessThan(src.indexOf('data-testid="calendar-google"'));
    expect(src.indexOf('data-testid="calendar-google"')).toBeLessThan(src.indexOf('data-testid="calendar-outlook"'));
  });

  it('is quiet beside Join once the invitation was emailed (no outlined button), in each place it is offered', () => {
    for (const rel of ['features/messages/SchedulerMeetingSummary.tsx', 'features/messages/SystemMessageCard.tsx']) {
      expect(readClientSource(rel)).toMatch(/className=\{emailed\s*\? 'inline-flex min-h-\[44px\] items-center gap-1\.5 rounded-lg px-2 text-sm font-medium text-emerald-700 underline-offset-2 hover:underline'/);
    }
    expect(readClientSource('features/meetings/MeetingDetailPage.tsx')).toContain("className={cn(ACTION, emailed ? 'text-[#2d3440] underline-offset-2 hover:underline' : SECONDARY)}");
  });

  it('the booking toasts read the server\'s answer for my invitation, not a fixed line', () => {
    const actions = readClientSource('features/messages/useSchedulerActions.ts');
    expect(actions).toContain('addToast(confirmedMessage((res.data?.data as Scheduling | undefined)?.confirmed?.inviteEmail, moving), \'success\');');
    expect(actions).toContain("addToast(saveMessage(outcome, zone, after.confirmed?.inviteEmail), asks ? 'info' : 'success');");
  });
});

// ─── Fix round 1 (review s5-review.md) ────────────────────────────────────────────────────────────────────────────────

describe('fix round 1: more to report, each where it is', () => {
  it('a comment on either wall: "Report comment" on someone else\'s, never your own, its kind from the wall', () => {
    const comments = readClientSource('components/wall/WallComments.tsx');
    expect(comments).toMatch(/\{config\.reportKind && userId && c\.authorId !== userId && \(\s*<ReportCommentButton kind=\{config\.reportKind\} commentId=\{c\.id\} authorId=\{c\.authorId\} authorName=\{c\.authorName\} excerpt=\{c\.content\} \/>/);
    const btn = readClientSource('components/wall/ReportCommentButton.tsx');
    expect(btn).toContain("subject={{ kind: kind === 'pod_post' ? 'pod_comment' : 'circle_comment', id: commentId, excerpt }}");
    expect(btn).toContain('{REPORT_COMMENT}');
    expect(btn).toContain('min-h-[44px]');
    expect(reportTitle('comment', 'Bo')).toBe('Report this comment');
    expect(reportConsequence('comment', 'Bo', false)).toMatch(/^The REASON team will review this comment\. Bo won't be told/);
  });

  it('a group chat: "⋯ → Report message" on others\' messages, the chat staying open', () => {
    const src = readClientSource('features/messages/GroupThread.tsx');
    expect(src).toContain('{!mine && <MessageMoreButton onReport={() => onReport(m)} />}');
    expect(src).toContain("subject={reporting ? { kind: 'group_message', id: reporting.m.id, excerpt: reporting.m.content } satisfies ReportSubject : null}");
    expect(src).not.toMatch(/navigate\(/);
  });

  it("an event's chat: \"⋯ → Report message\" on others' messages", () => {
    const src = readClientSource('features/live/ChatPanel.tsx');
    expect(src).toContain('{!isOwn && <MessageMoreButton onReport={() => setReporting(true)} />}');
    expect(src).toContain("subject={{ kind: 'event_chat_message', id: msg.id, excerpt: msg.message }}");
  });

  it('the admin queue labels every kind', () => {
    const admin = readClientSource('features/admin/AdminModerationPage.tsx');
    for (const label of ['Reported message', 'Reported group message', 'Reported event chat message', 'Reported post', 'Reported comment']) {
      expect(admin).toContain(`'${label}'`);
    }
  });
});

describe('fix round 1: a read-only thread takes no reaction and no reply', () => {
  it('the reaction trigger, the picker and Reply are not drawn, and a reaction pill does nothing', () => {
    const src = readClientSource('features/messages/MessagesPage.tsx');
    expect(src).toMatch(/\{!readOnly && \(\s*<button\s*type="button"\s*onClick=\{\(\) => setReactionPickerFor/);
    expect(src).toContain('{!readOnly && <ReplyButton onReply={() => replyTo(m, fromMe)} />}');
    expect(src).toContain('{pickerOpen && !readOnly && (');
    expect(src).toContain('onClick={() => { if (!readOnly) toggleReaction(m.id, type, mine); }}');
    // Report message stays: reporting never needs the two to be on speaking terms.
    expect(src).toMatch(/\{!fromMe && \(\s*<MessageMoreButton/);
  });
});

describe('fix round 1: a block during a call ends it for both', () => {
  it('the room closed under them sends both back to the thread with a calm sentence', () => {
    const src = readClientSource('features/messages/MeetPage.tsx');
    expect(src).toContain("export const CALL_ENDED = 'The call has ended.';");
    expect(src).toMatch(/onDisconnected=\{\(reason\) => \{[\s\S]{0,200}if \(reason === DisconnectReason\.ROOM_DELETED\) addToast\(CALL_ENDED, 'info'\);\s*leaveRoom\(\);/);
  });
});

describe('fix round 1: minors', () => {
  it('the message "⋯" menu opens below when there is no room above it in the thread', () => {
    const src = readClientSource('features/messages/thread/ThreadSafety.tsx');
    expect(src).toContain('const MENU_ROOM_PX = 72;');
    expect(src).toContain("setBelow(top - panel < MENU_ROOM_PX);");
    expect(src).toContain("${below ? 'top-full mt-1' : 'bottom-full mb-1'}");
  });

  it('a block from a profile does not promise a conversation that may not exist', () => {
    expect(blockConsequence('Bo', 'profile')).toContain('Any conversation you have stays, read-only. You can unblock them from their profile.');
    expect(blockConsequence('Bo')).toContain('Your conversation stays, read-only.');
    expect(readClientSource('components/ReportUserModal.tsx')).toContain("blockConsequence(name, conversationId ? 'thread' : 'profile')");
  });
});
