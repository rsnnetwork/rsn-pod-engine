// ─── Onboarding, version 2 ───────────────────────────────────────────────────
//
// Shradha's brief, 19 Oct 2026: Welcome, "Let's get you started", the four
// questions, "Here's how others will see you", then For You (screen 8), where
// the short tour opens on its own. The live app keeps version 1 until go-live.
//
// The step lives in the URL and the answers on the server (a draft as each
// question is left), so a refresh or a second device comes back to the same
// place. Once loaded, the member owns the answers: a refetch never overwrites
// what they are ticking.
//
// Edit mode, /onboarding?edit=q1|q2|q3|q4|profile, is for someone who has
// finished: one part, saved through confirm, then back to where they came
// from. It saves no drafts, so Cancel leaves nothing behind.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OnboardingV2Answers, OnboardingV2State, OnboardingV2Step } from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import OnboardingShell from './OnboardingShell';
import FooterButtons, { type FooterProps } from './FooterButtons';
import WelcomeScreen from './WelcomeScreen';
import SignupScreen from './SignupScreen';
import QuestionScreen from './QuestionScreen';
import ProfileScreen from './ProfileScreen';
import { useFlowSteps, useOnePress } from './useFlowSteps';
import { useLeaveEdit } from './useLeaveEdit';
import { useProfileForm } from './useProfileForm';
import { useConfirm, useConnectLinkedin, useOnboardingV2State, useSaveDraft, useSkipLinkedin } from './useOnboardingV2';
import {
  PROFILE, confirmBody, confirmProblem, draftPatch, editAction, firstIncomplete, guessedSelf,
  questionFor, questionProblem, stepAfter, stepBefore, withKeys,
  type ConfirmProblem, type DraftPatch, type Question, type QuestionStepKey,
} from './flow';

const SAVE_FAILED = "We couldn't save your answers. Please try again.";
const PHOTO_NOT_ADDED = "We couldn't add your LinkedIn photo. You can add a photo from your profile.";

export default function OnboardingFlow() {
  const { data: state, isError, refetch } = useOnboardingV2State();

  if (!state && isError) {
    return (
      <OnboardingShell
        pose="idle"
        title="We couldn't load this"
        subtitle="Check your connection and try again."
        footer={<Button onClick={() => refetch()} className="min-h-[48px] w-full sm:w-auto">Try again</Button>}
      >
        <span />
      </OnboardingShell>
    );
  }
  if (!state) {
    return (
      <OnboardingShell pose="thinking">
        <div className="flex justify-center py-8" role="status" aria-label="Loading"><Spinner /></div>
      </OnboardingShell>
    );
  }
  return <Flow state={state} />;
}

function Flow({ state }: { state: OnboardingV2State }) {
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const leave = useLeaveEdit();
  const form = useProfileForm(state);
  const { busy, once } = useOnePress();
  const saveDraft = useSaveDraft();
  const connect = useConnectLinkedin();
  const skip = useSkipLinkedin();
  const confirm = useConfirm();

  const [answers, setAnswers] = useState<OnboardingV2Answers>(() => state.answers);
  const [ownWordsError, setOwnWordsError] = useState<string | null>(null);
  // A refusal about a question itself, or a failed save, said under its options.
  const [listError, setListError] = useState<string | null>(null);
  const [selfTouched, setSelfTouched] = useState(false);
  const [guessApplied, setGuessApplied] = useState<string | null>(null);
  const ownWordsRef = useRef<HTMLInputElement>(null);
  const steps = useFlowSteps(state, answers);
  const { edit, screen } = steps;

  // Screen 6: LinkedIn's most likely answer, ticked for them to confirm or change.
  const guess = state.linkedin.prefill?.selfGuess ?? null;
  useEffect(() => {
    if (screen !== 'q4') return;
    const picked = guessedSelf(answers, guess, selfTouched);
    if (!picked) return;
    setAnswers(a => withKeys(a, questionFor('q4')!, picked));
    setGuessApplied(picked[0]);
  }, [screen, guess, selfTouched, answers]);

  const go = (step: OnboardingV2Step, from?: 'profile') => {
    setOwnWordsError(null);
    setListError(null);
    steps.go(step, from);
  };

  /** To a question that still needs something: when it is the missing words, the screen says so as it opens. */
  const goToOpen = (step: QuestionStepKey, from?: 'profile') => {
    go(step, from);
    const question = questionFor(step)!;
    if (questionProblem(question, answers) === 'own-words') setOwnWordsError(question.ownWordsMissing);
  };

  // A draft that does not land costs the member nothing: the answers are still on screen, and confirm
  // sends the whole set. So a failed save never stops them moving on.
  const keepDraft = (patch: DraftPatch) => saveDraft.mutateAsync(patch).catch(() => undefined);

  const submit = (withProfile: boolean) => {
    const profile = withProfile ? form.input() : undefined;
    if (profile === null) return;
    void once(async () => {
      try {
        const res = await confirm.mutateAsync(confirmBody(answers, profile));
        if (res.photo === 'failed' || res.photo === 'none') addToast(PHOTO_NOT_ADDED, 'info');
        if (edit) {
          addToast('Your changes are saved.', 'success');
          leave(edit);
        } else {
          navigate('/', { replace: true });
        }
      } catch (err) {
        showRefusal(confirmProblem(err, SAVE_FAILED));
      }
    });
  };

  /** A refusal from confirm, said on the thing it is about, in the server's words when they are for members. */
  const showRefusal = (problem: ConfirmProblem) => {
    if (problem.question) {
      if (problem.question !== screen) go(problem.question, screen === 'profile' ? 'profile' : undefined);
      if (problem.ownWords) setOwnWordsError(problem.message); else setListError(problem.message);
    } else if (screen === 'profile') {
      form.refuse(problem.field, problem.message);
    } else {
      setListError(problem.message);
    }
  };

  /** Whether a question can be left. When it is the missing words, says so and puts the cursor there. */
  const canLeave = (question: Question): boolean => {
    const problem = questionProblem(question, answers);
    if (problem === 'own-words') {
      setOwnWordsError(question.ownWordsMissing);
      ownWordsRef.current?.focus();
    }
    return problem === null;
  };

  const questionFooter = (question: Question): FooterProps => {
    const problem = questionProblem(question, answers);
    const blocked = problem === 'empty' || problem === 'too-many';
    /** Leave this question for `next`, keeping the draft in step (never in edit mode, where Cancel must leave nothing). */
    const leaveFor = (next: OnboardingV2Step, arrive: () => void) => () => {
      if (!canLeave(question)) return;
      void once(async () => {
        if (!edit) await keepDraft(draftPatch(question, answers, next));
        arrive();
      });
    };
    // Opened from screen 7, in the flow or in edit mode: both buttons go back there.
    if (steps.backToProfile) {
      const back = () => { setOwnWordsError(null); setListError(null); steps.backToProfileFrom(question.step); };
      return { back: { label: 'Back', onClick: back }, primary: { label: 'Continue', disabled: blocked, busy, onClick: leaveFor('profile', back) } };
    }
    if (edit) {
      const action = editAction(answers, question.step);
      return {
        back: { label: 'Cancel', onClick: () => leave(edit) },
        primary: action.kind === 'save'
          ? { label: 'Save', disabled: blocked, busy, onClick: () => { if (canLeave(question)) submit(false); } }
          : { label: 'Continue', disabled: blocked, busy, onClick: leaveFor(action.step, () => goToOpen(action.step)) },
      };
    }
    const next = stepAfter(question.step);
    return {
      back: { label: 'Back', onClick: () => go(stepBefore(question.step)) },
      primary: { label: 'Continue', disabled: blocked, busy, onClick: leaveFor(next, () => go(next)) },
    };
  };

  const finishProfile = () => {
    const missing = firstIncomplete(answers);
    if (missing) goToOpen(missing, 'profile');
    else submit(true);
  };

  if (screen === 'welcome') {
    return <WelcomeScreen key="welcome" busy={busy} onStart={() => once(async () => { await keepDraft({ step: 'signup' }); go('signup'); })} />;
  }

  if (screen === 'signup') {
    return (
      <SignupScreen
        key="signup"
        linkedinUrl={state.profile.linkedinUrl}
        emailBusy={busy}
        onLinkedin={async (url) => { await connect.mutateAsync(url); await keepDraft({ step: 'q1' }); go('q1'); }}
        onEmail={() => once(async () => {
          // "Continue with email" is only recorded on the member's stage trail; losing that costs them nothing.
          await skip.mutateAsync().catch(() => undefined);
          await keepDraft({ step: 'q1' });
          go('q1');
        })}
      />
    );
  }

  if (screen === 'profile') {
    return (
      <ProfileScreen
        key="profile"
        state={state}
        answers={answers}
        fields={form.shown}
        onField={form.setField}
        fieldError={form.fieldError}
        formError={form.formError}
        nameRef={form.nameRef}
        zone={form.zone}
        onZone={form.setZone}
        keptLinkedinPhoto={form.keptPhoto}
        onKeepLinkedinPhoto={form.setKeptPhoto}
        onEditAnswer={step => go(step, 'profile')}
        returnedFrom={steps.returnedFrom}
        onLinkedin={async (url) => { await connect.mutateAsync(url); }}
        linkedinLater={form.linkedinLater}
        onLinkedinLater={() => form.setLinkedinLater(true)}
        footer={edit
          ? <FooterButtons back={{ label: 'Cancel', onClick: () => leave(edit) }} primary={{ label: 'Save', onClick: finishProfile, busy }} />
          : <FooterButtons primary={{ label: PROFILE.finish, onClick: finishProfile, busy }} />}
      />
    );
  }

  const q = questionFor(screen)!;
  return (
    <QuestionScreen
      key={screen}
      question={q}
      answers={answers}
      onChange={next => { if (q.step === 'q4') setSelfTouched(true); setOwnWordsError(null); setListError(null); setAnswers(next); }}
      ownWordsError={ownWordsError}
      listError={listError}
      ownWordsRef={ownWordsRef}
      guessed={q.step === 'q4' && !selfTouched && !!guessApplied && answers.selfKinds.length === 1 && answers.selfKinds[0] === guessApplied}
      showProgress={!edit}
      footer={<FooterButtons {...questionFooter(q)} />}
    />
  );
}
