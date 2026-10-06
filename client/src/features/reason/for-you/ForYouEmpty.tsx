// client/src/features/reason/for-you/ForYouEmpty.tsx
import { Link } from 'react-router-dom';
import ReasonSheep from '../brand/ReasonSheep';

interface Props { profileIncomplete: boolean; nextEvent: { id: string; title: string } | null }
// An event title can be long or one unbroken word: it wraps inside its own box.
const ACTION = 'flex min-h-[48px] items-center rounded-xl border border-reason-line px-3.5 py-2 text-[14px] font-bold [overflow-wrap:anywhere]';

export default function ForYouEmpty({ profileIncomplete, nextEvent }: Props) {
  if (profileIncomplete) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="thinking" className="h-[58px] w-[58px] shrink-0" />
        <div>
          <h2 id="foryou-title" className="text-[16px] font-bold">Tell REASON a little more about you.</h2>
          <p className="mt-1 text-[13px] text-reason-muted">Finish your profile and REASON can find people with a reason to meet you.</p>
          <Link to="/onboarding" className="mt-3 inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white hover:bg-reason-red-hover">Finish my profile</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="hopeful" className="h-[58px] w-[58px] shrink-0" />
        <div>
          <h2 id="foryou-title" className="text-[16px] font-bold">No one new to suggest right now.</h2>
          <p className="mt-1 text-[13px] text-reason-muted">New people join all the time. Here is what you can do meanwhile.</p>
        </div>
      </div>
      <Link to={nextEvent ? `/sessions/${nextEvent.id}` : '/sessions'} className={ACTION}>{nextEvent ? `Join ${nextEvent.title}` : 'See upcoming events'}</Link>
      <Link to="/invites" className={ACTION}>Invite people you would like here</Link>
      <Link to="/matches" className={ACTION}>Browse a wider circle of people</Link>
    </div>
  );
}
