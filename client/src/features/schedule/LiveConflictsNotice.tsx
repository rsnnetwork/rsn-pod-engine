// Rounds the live event changed while the draft had its own changes there (Part 2 Task 9, `board.liveConflicts`): a
// late joiner, a leaver, or a round the host confirmed differently. The server kept the draft's own seating and flagged
// the round; the organiser checks it and publishes, which makes the draft the plan the live event follows and clears
// the flags (a publish of a draft equal to the latest version settles them too). Shown above the board, every round
// named in the server's own words, each with a way to it.
import { RadioTower, Send } from 'lucide-react';
import type { PublishPreviewItem } from '@rsn/shared';
import ConflictList from './ConflictList';
import type { BoardConflict } from './board-model';

interface Props {
  conflicts: PublishPreviewItem[];
  onShow: (conflict: BoardConflict) => void;
  onPublish: () => void;
}

export const LIVE_CONFLICTS_TITLE = 'The live event changed rounds you have edited';
export const LIVE_CONFLICTS_HELP = 'Your draft kept its own seating there. Check each round, then publish: the version you publish becomes the plan the live event follows, and these flags clear.';

export default function LiveConflictsNotice({ conflicts, onShow, onPublish }: Props) {
  if (conflicts.length === 0) return null;
  const items: BoardConflict[] = conflicts.map((c) => ({ round: c.round, room: c.room, tone: 'problem', text: c.message }));
  return (
    <section data-testid="board-live-conflicts" aria-label={LIVE_CONFLICTS_TITLE} className="flex flex-col gap-2 rounded-2xl border-2 border-red-300 bg-white p-3 sm:p-4">
      <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-red-800">
        <RadioTower className="h-4 w-4 shrink-0" aria-hidden="true" /> {LIVE_CONFLICTS_TITLE}
      </h2>
      <p className="text-[14px] text-[#3d4a55]">{LIVE_CONFLICTS_HELP}</p>
      <ConflictList title="Flagged by the live event" conflicts={items} onShow={onShow} showRound />
      <button
        type="button"
        onClick={onPublish}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 self-start rounded-xl bg-red-700 px-4 text-[14px] font-bold text-white hover:bg-red-800"
      >
        <Send className="h-4 w-4" aria-hidden="true" /> Review and publish
      </button>
    </section>
  );
}
