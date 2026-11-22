// client/src/features/sessions/waitlist/WaitlistCard.tsx
// Part 3 Task 8 (plan K3): the organisers' "Waiting list" card on a full event's page. The line in order (name, number,
// how they joined), each with "Let in now" (a place over the capacity the organiser set) and "Remove" (off the line);
// both ask first. It follows the server live (session:<id>:waitlist, session:<id>:participants), shows itself once the
// event is full or someone is waiting, and draws nothing for anyone the server refuses.
import { Hourglass } from 'lucide-react';
import type { WaitlistEntryCard } from '@rsn/shared';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { useWaitlistActions, useWaitlistLine } from './useWaitlist';
import { WAITLIST_COPY, notForThisViewer, showsWaitlistCard, waitlistRowLine } from './waitlist-text';

interface Props {
  sessionId: string;
  /** The server's `access.waitlist.full`: every place is taken (or promised to the people waiting). */
  full: boolean;
}

export default function WaitlistCard({ sessionId, full }: Props) {
  const line = useWaitlistLine(sessionId, true);
  const { admit, remove } = useWaitlistActions(sessionId);
  const { ask, confirmDialog } = useConfirm();

  if (line.isError && notForThisViewer(line.error)) return null;
  const rows = line.data ?? [];
  // An event with room has no line: the card waits to be needed, and never jumps in while it loads.
  if (line.isLoading && !full) return null;
  if (!line.isLoading && !line.isError && !showsWaitlistCard(full, rows.length)) return null;

  const letIn = async (row: WaitlistEntryCard) => {
    if (!(await ask({ title: WAITLIST_COPY.letInTitle(row.displayName), body: WAITLIST_COPY.letInBody, confirmLabel: WAITLIST_COPY.letIn }))) return;
    admit.mutate(row);
  };
  const takeOff = async (row: WaitlistEntryCard) => {
    if (!(await ask({ title: WAITLIST_COPY.removeTitle(row.displayName), body: WAITLIST_COPY.removeBody, confirmLabel: WAITLIST_COPY.remove, tone: 'danger' }))) return;
    remove.mutate(row);
  };
  const pending = admit.isPending || remove.isPending;

  return (
    <div id="event-waitlist" className="scroll-mt-4" data-testid="waitlist-card">
      <Card className="animate-fade-in-up">
        <h2 className="text-lg font-semibold text-[#1a1a2e] flex items-center gap-2">
          <Hourglass className="h-5 w-5 text-rsn-red" /> {WAITLIST_COPY.cardTitle}
        </h2>
        {!line.isLoading && !line.isError && rows.length > 0 && (
          <p data-testid="waitlist-count" className="text-sm text-gray-500 mt-1">{WAITLIST_COPY.count(rows.length)}</p>
        )}
        <div className="mt-3">
          {line.isLoading && <div className="h-12 rounded-xl bg-gray-100 animate-pulse" aria-busy="true" aria-label="Loading the waiting list" />}
          {line.isError && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
              <span>{WAITLIST_COPY.error}</span>
              <Button variant="ghost" className="min-h-[44px]" onClick={() => void line.refetch()}>{WAITLIST_COPY.retry}</Button>
            </div>
          )}
          {!line.isLoading && !line.isError && rows.length === 0 && (
            <p data-testid="waitlist-empty" className="text-sm text-gray-500">{WAITLIST_COPY.empty}</p>
          )}
          <ol className="space-y-3">
            {rows.map((row) => {
              const admitting = admit.isPending && admit.variables?.userId === row.userId;
              const removing = remove.isPending && remove.variables?.userId === row.userId;
              return (
                <li key={row.userId} data-testid="waitlist-row" className="flex flex-wrap items-center gap-3">
                  <Avatar src={row.avatarUrl ?? undefined} name={row.displayName} size="md" />
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="font-medium text-gray-900 [overflow-wrap:anywhere]">{row.displayName}</p>
                    <p className="text-xs text-gray-500">{waitlistRowLine(row)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      data-testid="waitlist-let-in"
                      className="min-h-[44px]"
                      disabled={pending}
                      isLoading={admitting}
                      onClick={() => void letIn(row)}
                    >
                      {WAITLIST_COPY.letIn}
                    </Button>
                    <Button
                      data-testid="waitlist-remove"
                      variant="ghost"
                      className="min-h-[44px]"
                      disabled={pending}
                      isLoading={removing}
                      onClick={() => void takeOff(row)}
                    >
                      {WAITLIST_COPY.remove}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </Card>
      {confirmDialog}
    </div>
  );
}
