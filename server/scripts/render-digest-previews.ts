// Render the notification round-up, "Yesterday on REASON" and "Your week on REASON" with sample content, to HTML files
// a person can open (22 Nov 2026). It only builds: nothing is sent, no database, no provider.
//   cd server && npx ts-node --transpile-only scripts/render-digest-previews.ts <output dir>
// Writes notification-roundup.html, daily-digest.html and weekly-digest.html (and each email's plain text and subject
// beside it as .txt) into the directory given, which must already exist.

import * as fs from 'fs';
import * as path from 'path';
import {
  buildDailyDigestEmail, buildNotificationRoundupEmail, buildWeeklyDigestEmail,
} from '../src/services/email/email.service';
import { sectionsOf, summaryLine, weeklySuggestions, type OutboxItem, type WeeklyFacts } from '../src/services/notification-email/notification-email.rules';

const APP = 'https://app.rsn.network';
const outDir = process.argv[2];
if (!outDir || !fs.existsSync(outDir)) {
  console.error('Usage: render-digest-previews.ts <an existing output directory>');
  process.exit(2);
}

const at = new Date('2026-11-23T09:00:00Z');
const item = (kind: OutboxItem['kind'], minutes: number, payload: unknown): OutboxItem => ({
  id: `${kind}-${minutes}`, sourceId: `${kind}-${minutes}`, actorId: null, kind, payload,
  createdAt: new Date(at.getTime() + minutes * 60_000), sendAfter: new Date(at.getTime() + (minutes + 10) * 60_000),
} as OutboxItem);

const items: OutboxItem[] = [
  item('direct_message', 0, { senderName: 'Anna Lindqvist', snippet: 'Great to meet you at the breakfast. Are you free for a call on Thursday?', conversationId: 'c-anna' }),
  item('meeting_request', 2, { senderName: 'Bilal Rahman', note: 'I saw you are building in climate tech. I run a fund that backs early teams, and would love 20 minutes.', reasonLine: null }),
  item('direct_message', 4, { senderName: 'Anna Lindqvist', snippet: 'Thursday 10:00 works for me, or Friday after lunch.', conversationId: 'c-anna' }),
  item('direct_message', 6, { senderName: 'Claus Petersen', snippet: 'Sharing the deck I mentioned.', conversationId: 'c-claus' }),
];
const daily: OutboxItem[] = [
  ...items,
  item('meeting_accepted', 8, { accepterName: 'Dana Osei', conversationId: 'c-dana' }),
  item('invite', 9, { inviterId: 'u-stefan', inviterName: 'Stefan Avivson', inviteType: 'session', targetName: 'Founders Breakfast, Copenhagen', code: 'ABC123', podId: null, sessionId: 's-1', circleId: null }),
];

const write = (name: string, built: { subject: string; html: string; text: string }) => {
  fs.writeFileSync(path.join(outDir, `${name}.html`), built.html);
  fs.writeFileSync(path.join(outDir, `${name}.txt`), `Subject: ${built.subject}\n\n${built.text}\n`);
  console.log(`${name}.html  (${built.subject})`);
};

const roundup = sectionsOf(items, APP);
write('notification-roundup', buildNotificationRoundupEmail({
  recipientName: 'Shradha', summary: summaryLine(roundup.counts), settingsUrl: `${APP}/settings`, ...roundup.sections,
}));

const held = sectionsOf(daily, APP);
write('daily-digest', buildDailyDigestEmail({
  recipientName: 'Shradha', summary: summaryLine(held.counts), dailyMax: 3, settingsUrl: `${APP}/settings`, ...held.sections,
}));

const facts: WeeklyFacts = {
  waitingForYou: [{ userId: 'u-bilal', name: 'Bilal Rahman' }, { userId: 'u-eva', name: 'Eva Nordin' }, { userId: 'u-finn', name: 'Finn Larsen' }, { userId: 'u-gita', name: 'Gita Rao' }],
  sentUnanswered: 3,
  newConnections: [{ userId: 'u-dana', name: 'Dana Osei', conversationId: 'c-dana' }],
  unreadMessages: 5,
  oldestUnreadFrom: { name: 'Anna Lindqvist', conversationId: 'c-anna' },
  upcomingEvents: [
    { id: 's-1', title: 'Founders Breakfast, Copenhagen', when: 'Thu 26 Nov 2026, 08:30 CET', going: false },
    { id: 's-2', title: 'Climate Investors Speed Networking', when: 'Tue 1 Dec 2026, 18:00 CET', going: true },
  ],
  newMembers: 14,
  newCircles: [{ id: 'c-1', name: 'Nordic Climate Founders' }],
  people: [
    { userId: 'u-hana', name: 'Hana Sato', line: 'Go-to-market for B2B SaaS in the Nordics' },
    { userId: 'u-ivan', name: 'Ivan Petrov', line: 'Angel investor, pre-seed climate and energy' },
    { userId: 'u-jo', name: 'Jo Mensah', line: 'Hiring and building first engineering teams' },
  ],
  profileIncomplete: true,
};
const shown = facts.waitingForYou.slice(0, 3);
write('weekly-digest', buildWeeklyDigestEmail({
  recipientName: 'Shradha',
  waitingForYou: shown.map((w) => ({ name: w.name, url: `${APP}/people/${w.userId}` })),
  waitingForYouMore: facts.waitingForYou.length - shown.length,
  sentUnanswered: facts.sentUnanswered,
  newConnections: facts.newConnections.map((c) => ({ name: c.name, url: `${APP}/messages/${c.conversationId}` })),
  unreadMessages: facts.unreadMessages,
  messagesUrl: `${APP}/messages`,
  upcomingEvents: facts.upcomingEvents.map((e) => ({ title: e.title, when: e.when, url: `${APP}/sessions/${e.id}` })),
  newMembers: facts.newMembers,
  newCircles: facts.newCircles.map((c) => ({ name: c.name, url: `${APP}/circles/${c.id}` })),
  people: facts.people.map((p) => ({ name: p.name, line: p.line, url: `${APP}/people/${p.userId}` })),
  suggestions: weeklySuggestions(facts, APP),
  settingsUrl: `${APP}/settings`,
  unsubscribeUrl: 'https://api.rsn.network/api/email/unsubscribe/weekly?token=sample',
}));
