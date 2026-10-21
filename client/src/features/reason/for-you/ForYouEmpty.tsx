// client/src/features/reason/for-you/ForYouEmpty.tsx
import { Link } from 'react-router-dom';
import ReasonSheep from '../brand/ReasonSheep';

interface Props { profileIncomplete: boolean }
// Long enough words wrap inside their own box, so a narrow phone never pushes a button out of the card.
const ACTION = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-4 py-2 text-center text-[13px] font-bold [overflow-wrap:anywhere]';

// The onboarding brief's screen 8 (Shradha, 19 Oct 2026), "If there are no matches yet", word for word.
const NO_MATCHES_TITLE = "Your people aren't here yet.";
const NO_MATCHES_TEXT = "We're still finding people who match what you're looking for. Check back soon.";

export default function ForYouEmpty({ profileIncomplete }: Props) {
  if (profileIncomplete) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="thinking" className="h-[58px] w-[58px] shrink-0" />
        <div>
          <h2 id="foryou-title" tabIndex={-1} className="text-[16px] font-bold outline-none">Tell REASON a little more about you.</h2>
          <p className="mt-1 text-[13px] text-reason-muted">Finish your profile and REASON can find people with a reason to meet you.</p>
          <Link to="/onboarding" className="mt-3 inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white hover:bg-reason-red-hover">Finish my profile</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
      <ReasonSheep pose="hopeful" className="h-[58px] w-[58px] shrink-0" />
      <div className="min-w-0">
        <h2 id="foryou-title" tabIndex={-1} className="text-[16px] font-bold outline-none">{NO_MATCHES_TITLE}</h2>
        <p className="mt-1 text-[13px] text-reason-muted">{NO_MATCHES_TEXT}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/search" className={`${ACTION} bg-reason-red text-white hover:bg-reason-red-hover`}>Explore people</Link>
          {/* Opens onboarding on its first question, to change who the member wants to meet. */}
          <Link to="/onboarding?edit=q1" className={`${ACTION} border border-reason-line bg-white text-[#2d3440] hover:bg-reason-soft`}>Edit who I want to meet</Link>
        </div>
      </div>
    </div>
  );
}
