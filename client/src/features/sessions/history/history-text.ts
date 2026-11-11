// ─── The event's history in plain words (Part 2 Task 11; spec 11) ───────────────────────────────────────────────────
// Pure, so the client test runs it. GET /sessions/:id/audit sends each entry's action as a dotted name; the organiser
// reads a sentence ("Ana Lee published the event"), never the name. An action this page does not know yet reads as a
// change to the event.

export interface HistoryPerson { id: string; displayName: string }

/** One entry as GET /sessions/:id/audit sends it. */
export interface HistoryEntry {
  id: string;
  at: string;
  actor: HistoryPerson | null;
  automatic: boolean;
  action: string;
  round: number | null;
  scheduleVersion: number | null;
  subjects: HistoryPerson[];
  reason: string | null;
  /**
   * Which part of the event report a report.downloaded entry took out ('attendance', 'meetings', 'mutual-matches'),
   * when the server says (it stores it as the entry's `after.section`); without it the sentence names the report.
   */
  section?: string | null;
}

export const HISTORY_COPY = {
  title: 'History',
  hint: 'Who did what to this event, newest first. Only the people running it see this.',
  empty: 'Nothing has happened to this event yet.',
  error: 'The history could not be read just now.',
  older: 'Show older',
  product: 'REASON',
  automatically: 'automatically',
} as const;

const ACTIONS: Record<string, string> = {
  'event.published': 'published the event',
  'event.unpublished': 'moved the event back to draft',
  'event.started': 'started the event',
  'event.completed': 'ended the event',
  'event.cancelled': 'cancelled the event',
  'event.archived': 'archived the event',
  'event.unarchived': 'restored the event',
  'event.deleted': 'deleted the event',
  'admission.mode_changed': 'changed who gets a place',
  'admission.request_approved': 'approved a request to join',
  'admission.request_declined': 'declined a request to join',
  'admission.emails_added': 'added allowed emails',
  'admission.email_revoked': 'removed an allowed email',
  'admission.codes_generated': 'made admission codes',
  'admission.code_revoked': 'revoked an admission code',
  'admission.code_redeemed': 'used an admission code',
  'group.rules_changed': 'changed the matching groups',
  'group.assigned': "changed someone's group",
  'match.preview_generated': 'prepared the matches',
  'match.regenerated': 'made new matches',
  'match.swapped': 'swapped people between rooms',
  'match.excluded': 'left someone out of a round',
  'match.moved': 'moved someone to another room',
  'match.round_announced': 'announced the round',
  'match.round_confirmed': 'confirmed the round',
  'match.preview_cancelled': 'set the prepared matches aside',
  'match.repaired': 'repaired the matches',
  'match.override': 'overrode a group rule',
  'participant.removed': 'removed someone from the event',
  'breakout.created': 'opened a breakout room',
  'schedule.generated': 'made the schedule',
  'schedule.edited': 'edited the schedule',
  'schedule.locked': 'locked a room',
  'schedule.unlocked': 'unlocked a room',
  'schedule.published': 'published the schedule',
  'call_link.rotated': 'made a new RSN Call link',
  'report.downloaded': 'downloaded the event report',
};

/** The words for each part of the event report (Part 3 Task 9): "{actor} downloaded the {section} report". */
const REPORT_SECTIONS: Record<string, string> = {
  attendance: 'attendance',
  meetings: 'meetings',
  'mutual-matches': 'mutual matches',
};

function actionWords(entry: HistoryEntry): string {
  const section = entry.action === 'report.downloaded' && entry.section ? REPORT_SECTIONS[entry.section] : undefined;
  if (section) return `downloaded the ${section} report`;
  return ACTIONS[entry.action] ?? 'changed the event';
}

/** "Ana Lee published the event"; REASON for what the product did by itself. */
export function historySentence(entry: HistoryEntry): string {
  const who = entry.actor?.displayName || HISTORY_COPY.product;
  const what = actionWords(entry);
  const how = entry.automatic && entry.actor ? ` ${HISTORY_COPY.automatically}` : '';
  return `${who} ${what}${how}`;
}

/** The line under it: the people it was about, the round, and the reason, where there are any. */
export function historyDetail(entry: HistoryEntry): string | null {
  const parts: string[] = [];
  if (entry.subjects.length > 0) {
    const names = entry.subjects.slice(0, 5).map((s) => s.displayName);
    const more = entry.subjects.length > 5 ? ` and ${entry.subjects.length - 5} more` : '';
    parts.push(`${names.join(', ')}${more}`);
  }
  if (entry.round !== null) parts.push(`Round ${entry.round}`);
  if (entry.reason) parts.push(`Reason: ${entry.reason}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
