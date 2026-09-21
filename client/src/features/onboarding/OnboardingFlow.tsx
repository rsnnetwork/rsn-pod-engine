// ─── The five steps ──────────────────────────────────────────────────────────
//
// Welcome → the questions → Confirm (Shradha's deck, 21 Sep 2026). Replaces the
// open-ended chat, which produced free text nothing could compare, and the
// confirm card that showed guessed country, company and about as if the member
// had said them.
//
// Nothing here is guessed. The only things shown that they did not choose are
// their name and photo, which the deck explicitly allows.
//
// The step lives in the URL and the answers live on the server, so a refresh,
// a second device, or the round trip out to Google for a photo all come back
// to the same place.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ONBOARDING_INTENTS, ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INDUSTRIES,
  ONBOARDING_SELF_KINDS, ONBOARDING_LIMITS,
  type OnboardingState, type OnboardingStep,
} from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import OnboardingShell from './OnboardingShell';
import QuestionStep from './QuestionStep';
import ConfirmStep from './ConfirmStep';
import type { SheepPose } from '@/components/brand/SheepAvatar';

type Answers = Partial<OnboardingState['answers']>;

/** The questions, in order. Adding one is a line here and a line in shared. */
const QUESTIONS = [
  {
    step: 'q1' as const, field: 'intent' as const, multiple: false,
    title: 'What brings you to RSN?', options: ONBOARDING_INTENTS,
  },
  {
    step: 'q2' as const, field: 'lookingToMeet' as const, multiple: true, max: ONBOARDING_LIMITS.meetMax,
    title: 'Who do you want to meet?', subtitle: `Pick up to ${ONBOARDING_LIMITS.meetMax}.`,
    limitHint: `That is ${ONBOARDING_LIMITS.meetMax}. Untick one to choose another.`,
    options: ONBOARDING_MEET,
  },
  {
    step: 'q3' as const, field: 'canOffer' as const, multiple: true,
    title: 'What can you offer?', subtitle: 'Pick as many as fit.', options: ONBOARDING_OFFERS,
  },
  {
    step: 'q4' as const, field: 'industries' as const, multiple: true,
    title: 'Which industries are you in?', options: ONBOARDING_INDUSTRIES,
  },
  {
    // Not in the deck, and the flow does not work without it: matching compares
    // what you want against what the other person IS, so a member who never
    // says which they are cannot be found by anybody.
    step: 'q5' as const, field: 'selfKinds' as const, multiple: true, max: ONBOARDING_LIMITS.selfMax,
    title: 'And which best describes you?', subtitle: `Pick up to ${ONBOARDING_LIMITS.selfMax}. This is how others find you.`,
    limitHint: `That is ${ONBOARDING_LIMITS.selfMax}. Untick one to choose another.`,
    options: ONBOARDING_SELF_KINDS,
  },
];

const ORDER: OnboardingStep[] = ['welcome', 'q1', 'q2', 'q3', 'q4', 'q5', 'confirm'];
const POSE: Record<OnboardingStep, SheepPose> = {
  welcome: 'wave', q1: 'listening', q2: 'listening', q3: 'listening',
  q4: 'listening', q5: 'listening', confirm: 'thinking',
};

export default function OnboardingFlow() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const user = useAuthStore(s => s.user);
  const checkSession = useAuthStore(s => s.checkSession);

  const [answers, setAnswers] = useState<Answers>({});
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [otherError, setOtherError] = useState<string | null>(null);

  const { data: state, isLoading, isError, refetch } = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => api.get('/onboarding/state').then(r => r.data.data as OnboardingState),
    meta: { entities: user?.id ? [E.user(user.id)] : [] },
  });

  // Seed from the server ONCE, then the member owns the form. Re-seeding on
  // every refetch would fight whatever they are typing.
  useEffect(() => {
    if (!state || seeded) return;
    setAnswers(state.answers ?? {});
    setSeeded(true);
  }, [state, seeded]);

  const redirect = params.get('redirect') || '/';
  const urlStep = params.get('step') as OnboardingStep | null;

  // The furthest step their answers can justify: deep-linking to Confirm with
  // an empty draft lands on the first thing still unanswered instead.
  const furthest = useMemo<OnboardingStep>(() => {
    if (!seeded) return 'welcome';
    for (const q of QUESTIONS) {
      const v = answers[q.field];
      const empty = q.multiple ? !(v as string[] | undefined)?.length : !v;
      if (empty) return q.step;
    }
    return 'confirm';
  }, [answers, seeded]);

  const step: OnboardingStep = (() => {
    if (!urlStep || !ORDER.includes(urlStep)) return state?.step && ORDER.includes(state.step) ? state.step : 'welcome';
    return ORDER.indexOf(urlStep) > ORDER.indexOf(furthest) ? furthest : urlStep;
  })();

  const goTo = (next: OnboardingStep) => {
    const p = new URLSearchParams(params);
    p.set('step', next);
    setParams(p); // a push, so the browser's own Back works through the flow
  };

  const saveDraft = async (patch: Record<string, unknown>) => {
    try {
      await api.put('/onboarding/answers', patch);
    } catch {
      // Losing a draft save is not worth stopping them: the answers are still
      // in the form, and confirm sends the whole set anyway.
    }
  };

  const confirmMutation = useMutation({
    mutationFn: () => api.post('/onboarding/answers/confirm', {
      intent: answers.intent,
      lookingToMeet: answers.lookingToMeet ?? [],
      canOffer: answers.canOffer ?? [],
      industries: answers.industries ?? [],
      industryOther: answers.industryOther ?? null,
      selfKinds: answers.selfKinds ?? [],
      jobTitle: answers.jobTitle ?? null,
      company: answers.company ?? null,
      about: answers.about ?? null,
    }).then(r => r.data.data as { primaryAgentId: string | null }),
    onSuccess: async (data) => {
      // The gate lives in the auth store, so it has to be refreshed here or
      // the next route bounces straight back into onboarding.
      await checkSession();
      await qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      navigate(data.primaryAgentId ? `/agents/${data.primaryAgentId}` : (redirect !== '/' ? redirect : '/agents'), { replace: true });
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Could not save your answers — try again.', 'error');
    },
  });

  if (isLoading || !seeded) {
    return (
      <OnboardingShell pose="thinking" footer={null}>
        <div className="flex justify-center py-8"><Spinner /></div>
      </OnboardingShell>
    );
  }

  if (isError) {
    return (
      <OnboardingShell
        pose="idle"
        title="We could not load this"
        subtitle="Check your connection and try again."
        footer={<Button onClick={() => refetch()}>Try again</Button>}
      >
        <span />
      </OnboardingShell>
    );
  }

  // ── Welcome. One button, exactly as the deck draws it: no skip, no side
  //    panel, and nothing pre-filled beyond the name and photo.
  if (step === 'welcome') {
    return (
      <OnboardingShell
        pose="wave"
        title="Hey - welcome to RSN."
        subtitle="We connect you with the people you actually want to meet."
        footer={<Button onClick={() => goTo('q1')} className="min-h-[48px] w-full sm:w-auto">Let's go</Button>}
      >
        <p className="text-center text-sm text-gray-600">
          Answer {QUESTIONS.length} quick questions so we know who that is.
        </p>
      </OnboardingShell>
    );
  }

  if (step === 'confirm') {
    return (
      <ConfirmStep
        answers={answers}
        onChange={setAnswers}
        onEditStep={goTo}
        onBack={() => goTo('q5')}
        onConfirm={() => confirmMutation.mutate()}
        submitting={confirmMutation.isPending}
      />
    );
  }

  // ── One of the questions.
  const q = QUESTIONS.find(x => x.step === step)!;
  const index = QUESTIONS.indexOf(q);
  const selected: string[] = q.multiple
    ? ((answers[q.field] as string[] | undefined) ?? [])
    : (answers[q.field] ? [answers[q.field] as string] : []);
  const needsOther = q.field === 'industries' && selected.includes('other');
  const canContinue = selected.length > 0 && (!needsOther || !!(answers.industryOther ?? '').trim());

  const next = async () => {
    if (!canContinue || saving) return;
    if (needsOther && !(answers.industryOther ?? '').trim()) {
      setOtherError('Tell us which industry, so people can find you in it.');
      return;
    }
    setSaving(true);
    const nextStep = ORDER[ORDER.indexOf(step) + 1];
    await saveDraft({
      [q.field]: q.multiple ? selected : selected[0],
      ...(q.field === 'industries' ? { industryOther: answers.industryOther ?? null } : {}),
      step: nextStep,
    });
    setSaving(false);
    goTo(nextStep);
  };

  return (
    <OnboardingShell
      pose={POSE[step]}
      progress={{ current: index + 1, total: QUESTIONS.length }}
      title={q.title}
      subtitle={q.subtitle}
      onBack={() => goTo(ORDER[ORDER.indexOf(step) - 1])}
      footer={
        <Button onClick={next} disabled={!canContinue || saving} className="min-h-[48px] w-full sm:w-auto">
          {saving ? 'Saving…' : index === QUESTIONS.length - 1 ? 'See my profile' : 'Continue'}
        </Button>
      }
    >
      <QuestionStep
        options={q.options}
        selected={selected}
        multiple={q.multiple}
        max={'max' in q ? q.max : undefined}
        limitHint={'limitHint' in q ? q.limitHint : undefined}
        onChange={v => setAnswers(a => ({ ...a, [q.field]: q.multiple ? v : v[0] }))}
        other={q.field === 'industries' ? {
          value: answers.industryOther ?? '',
          onChange: v => { setOtherError(null); setAnswers(a => ({ ...a, industryOther: v })); },
          placeholder: 'Manufacturing, education, property…',
          maxLength: ONBOARDING_LIMITS.otherMaxLen,
          error: otherError,
        } : undefined}
      />
    </OnboardingShell>
  );
}
