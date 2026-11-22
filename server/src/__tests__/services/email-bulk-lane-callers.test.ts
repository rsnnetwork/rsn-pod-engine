// ─── Every email burst runs in the bulk lane (26 Oct 2026, H2b item 7, review I1) ───────────────────────────
//
// A burst that runs outside the lane puts every one of its emails ahead of a member's single email at the provider's
// gate: a sign-in link requested during a sixty-person broadcast waited about half a minute, and its request with it.
// The bursts the server makes: the bulk invite (`sendEmailsSlowly`), the event's Remind all, and the message-everyone
// worker (each DM to someone offline sends an email). Each wraps its sends in asBulkEmail(); this pins that they do,
// because their own tests replace the email service and would not notice the wrapper going.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../../');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('the bursts the server makes run in the bulk lane', () => {
  it('the bulk invite sends each email inside asBulkEmail', () => {
    // 22 Nov 2026: through the notification email gate, which queues a member's and sends anyone else's at once.
    const src = read('services/invite/invite-candidates.service.ts');
    expect(src).toMatch(/await asBulkEmail\(\(\) => invites\.emailOrQueueInvite\(/);
  });

  it('the notification email gate and the digests send from their jobs inside asBulkEmail', () => {
    const gate = read('services/notification-email/notification-email.service.ts');
    expect(gate).toMatch(/await emailService\.asBulkEmail\(\(\) => sendItems\(member, going\)\)/);
    const digests = read('services/notification-email/notification-digest.service.ts');
    expect(digests.slice(digests.indexOf('export async function processDailyDigests'))).toMatch(/await emailService\.asBulkEmail\(async \(\) => \{/);
    expect(digests.slice(digests.indexOf('export async function processWeeklyDigests'))).toMatch(/await emailService\.asBulkEmail\(async \(\) => \{/);
  });

  it('the event\'s Remind all sends its batches inside asBulkEmail', () => {
    const src = read('routes/invites.ts');
    const remindAll = src.slice(src.indexOf("'/remind-all/:sessionId'"));
    expect(remindAll).toMatch(/await emailService\.asBulkEmail\(async \(\) => \{[\s\S]*?emailService\.sendInviteEmail\(/);
  });

  it('the message-everyone worker sends each person\'s message, and the email it may carry, inside asBulkEmail', () => {
    const src = read('services/post-event-message/post-event-message.worker.ts');
    expect(src).toMatch(/await asBulkEmail\(\(\) => broadcastDmMessage\(/);
  });

  it('the recap at an event\'s end sends every participant\'s recap and the host\'s inside asBulkEmail', () => {
    const src = read('services/orchestration/handlers/round-lifecycle.ts');
    expect(src).toMatch(/export async function sendRecapEmails\(sessionId: string\): Promise<void> \{\s*await emailService\.asBulkEmail\(\(\) => sendRecapEmailsInLane\(sessionId\)\);\s*\}/);
    expect(src).toMatch(/async function sendRecapEmailsInLane\(sessionId: string\): Promise<void> \{[\s\S]*?emailService\.sendSessionRecapEmail\([\s\S]*?emailService\.sendHostRecapEmail\(/);
  });
});
