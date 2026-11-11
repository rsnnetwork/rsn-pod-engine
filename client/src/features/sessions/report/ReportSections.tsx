// ─── The report page's three sections (Part 3 Task 9): attendance, rounds, mutual matches ───────────────────────────
// Stacked cards, never a wide table, so a 360px phone reads every row without sideways scrolling. Counts and names
// only: the report carries no score a named person gave or received, so none can be drawn here.
import { useState } from 'react';
import type { EventReport, EventReportPerson } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { EmptyRow, OrganiserCard } from '../organiser-ui';
import {
  ATTENDANCE_FILTERS, OUTCOME_WORDS, REPORT_COPY, filterCounts, filterPeople, mutualLine, nameLookup, organiserRows,
  personBadges, personCounts, presenceLine, roundCards, type AttendanceFilter,
} from './report-text';

const CHIP = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors';

/** One person as a stacked card. An organiser's card has no outcome or counts: they ran the event, not attended it. */
function PersonRow({ person: p, zone, testId }: { person: EventReportPerson; zone: string; testId: string }) {
  const presence = presenceLine(p, zone);
  const organiser = p.role !== 'participant';
  return (
    <li data-testid={testId} className="min-w-0 rounded-xl border border-gray-200 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-medium text-[#1a1a2e] [overflow-wrap:anywhere]">{p.displayName}</span>
        {personBadges(p).map((b) => (
          <span key={b} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{b}</span>
        ))}
      </div>
      {p.email && <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{p.email}</p>}
      {!organiser && <p className="mt-1 text-sm text-gray-700">{OUTCOME_WORDS[p.outcome]}</p>}
      {presence && <p className="text-xs text-gray-500">{presence}</p>}
      {p.groups.length > 0 && <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{p.groups.join(', ')}</p>}
      {!organiser && <p className="text-xs text-gray-500">{personCounts(p)}</p>}
    </li>
  );
}

export function AttendanceSection({ report }: { report: EventReport }) {
  const [filter, setFilter] = useState<AttendanceFilter>('all');
  const counts = filterCounts(report.people);
  const shown = filterPeople(report.people, filter);
  const organisers = filter === 'all' ? organiserRows(report.people) : [];
  const zone = report.event.timezone;

  // Nobody registered: the sentence alone, no filter and no list (the host's own row is not an attendance).
  if (report.summary.registered === 0) {
    return (
      <OrganiserCard testId="report-attendance" title={REPORT_COPY.attendance}>
        <EmptyRow testId="report-attendance-empty">{REPORT_COPY.emptyPeople}</EmptyRow>
      </OrganiserCard>
    );
  }

  return (
    <OrganiserCard testId="report-attendance" title={REPORT_COPY.attendance}>
      <div role="group" aria-label="Show" data-testid="report-attendance-filter" className="mb-3 flex flex-wrap gap-2">
        {ATTENDANCE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(CHIP, filter === f.key ? 'border-[#1a1a2e] bg-[#1a1a2e] text-white' : 'border-gray-300 bg-white text-[#1a1a2e] hover:bg-gray-50')}
          >
            {f.label} <span className={filter === f.key ? 'text-white/80' : 'text-gray-500'}>{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <EmptyRow>{REPORT_COPY.emptyFilter}</EmptyRow>}
      <ul className="space-y-2">
        {shown.map((p) => <PersonRow key={p.userId} person={p} zone={zone} testId="report-person" />)}
      </ul>
      {organisers.length > 0 && (
        <div data-testid="report-organisers" className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-600">{REPORT_COPY.runningTheEvent}</h3>
          <ul className="space-y-2">
            {organisers.map((p) => <PersonRow key={p.userId} person={p} zone={zone} testId="report-organiser" />)}
          </ul>
        </div>
      )}
    </OrganiserCard>
  );
}

export function RoundsSection({ report }: { report: EventReport }) {
  const cards = roundCards(report);
  return (
    <OrganiserCard testId="report-rounds" title={REPORT_COPY.rounds}>
      {report.summary.meetings === 0 && <EmptyRow testId="report-rounds-empty">{REPORT_COPY.emptyMeetings}</EmptyRow>}
      <div className="space-y-3">
        {cards.map((card) => (
          <section key={card.round} data-testid="report-round" className="min-w-0 rounded-xl border border-gray-200 px-3 py-3">
            <h3 className="font-semibold text-[#1a1a2e]">Round {card.round}</h3>
            <p className="text-xs text-gray-500">{card.counts}</p>
            {card.figures && <p className="text-xs text-gray-500">{card.figures}</p>}
            <ul className="mt-2 space-y-1.5">
              {card.rooms.map((room) => (
                <li key={room.key} className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 [overflow-wrap:anywhere]">
                  {room.text}
                  {room.notes.length > 0 && <span className="block text-xs text-gray-500">{room.notes.join(' · ')}</span>}
                </li>
              ))}
              {card.byes.map((bye, i) => (
                <li key={`bye-${i}`} className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-sm text-gray-500 [overflow-wrap:anywhere]">{bye}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </OrganiserCard>
  );
}

export function MutualSection({ report }: { report: EventReport }) {
  const nameOf = nameLookup(report.people);
  return (
    <OrganiserCard testId="report-mutual" title={REPORT_COPY.mutual}>
      {report.mutualMatches.length === 0
        ? <EmptyRow testId="report-mutual-empty">{REPORT_COPY.emptyMutual}</EmptyRow>
        : (
          <ul className="space-y-1.5">
            {report.mutualMatches.map((pair) => (
              <li key={pair.userIds.join('|')} data-testid="report-mutual-pair" className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 [overflow-wrap:anywhere]">
                {mutualLine(pair, nameOf)}
              </li>
            ))}
          </ul>
        )}
    </OrganiserCard>
  );
}
