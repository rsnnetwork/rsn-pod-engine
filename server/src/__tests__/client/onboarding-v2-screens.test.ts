// server/src/__tests__/client/onboarding-v2-screens.test.ts
// Onboarding version 2 on screen (Shradha's brief, 19 Oct 2026). The screens, drawn to markup from their own
// source (what the app's aliases import is a stand-in; react and lucide-react are the real thing), and pins on the
// data contract: version 2 endpoints only, For You after confirm, the LinkedIn photo only when kept.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OnboardingV2Answers } from '@rsn/shared';
import * as flow from '../../../../client/src/features/onboarding/flow';

const root = path.join(__dirname, '../../../../client');
const dir = 'src/features/onboarding';
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

function loadModule(rel: string, stand: Record<string, unknown>): Record<string, unknown> {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
  return mod.exports;
}
const draw = (component: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(component as never, props));
/** Visible text, one line per text node. */
const words = (html: string) => html.replace(/<[^>]*>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean)
  .map(s => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

// The shell as a plain frame: title, subtitle, body, footer, in that order.
const Shell = ({ title, subtitle, children, footer, progress }: {
  title?: string; subtitle?: string; children: ReactNode; footer?: ReactNode; progress?: { current: number; total: number };
}) => createElement('div', null,
  progress ? createElement('span', null, `${progress.current} of ${progress.total}`) : null,
  title ? createElement('h1', null, title) : null,
  subtitle ? createElement('p', null, subtitle) : null,
  children,
  footer ? createElement('footer', null, footer) : null);
const PlainButton = ({ children, onClick, ...rest }: { children: ReactNode; onClick?: () => void; [k: string]: unknown }) =>
  createElement('button', { type: 'button', onClick, 'aria-expanded': rest['aria-expanded'], 'aria-pressed': rest['aria-pressed'] }, children);
const ui = { '@/components/ui/Button': { Button: PlainButton } };
const footer = loadModule(`${dir}/FooterButtons.tsx`, ui);
const optionTile = loadModule(`${dir}/OptionTile.tsx`, {});
const onlyYou = loadModule(`${dir}/OnlyYou.tsx`, { './flow': flow });

const NONE: OnboardingV2Answers = {
  lookingToMeet: [], meetOther: null, hopingToFind: [], findOther: null, findSpecific: null,
  canOffer: [], offerOther: null, selfKinds: [], selfOther: null,
};

describe('screen 1, Welcome', () => {
  const html = () => draw(loadModule(`${dir}/WelcomeScreen.tsx`, { './OnboardingShell': { __esModule: true, default: Shell }, './FooterButtons': footer, './flow': flow }).default,
    { onStart: () => undefined, busy: false });

  it('says the brief\'s words, in its order, and has one button, "Let\'s go"', () => {
    expect(words(html())).toEqual([
      "Welcome to REASON. We're glad you're here.",
      'Every good connection starts with a reason.',
      'On REASON, you connect with people you want to meet, who also want to meet you, for a specific reason.',
      'Answer quick questions and we will suggest the potential mutuals for you.',
      "Let's go",
    ]);
    expect(html().match(/<button/g)).toHaveLength(1);
  });
});

describe('screen 2, "Let\'s get you started"', () => {
  // A button that shows whether it can be pressed, so the markup says which choice is waiting.
  const StateButton = ({ children, disabled, isLoading, ...rest }: { children: ReactNode; disabled?: boolean; isLoading?: boolean; [k: string]: unknown }) =>
    createElement('button', { type: 'button', disabled: disabled || isLoading, 'aria-expanded': rest['aria-expanded'] }, children);
  const screen = loadModule(`${dir}/SignupScreen.tsx`, {
    '@/components/ui/Button': { Button: StateButton }, './OnboardingShell': { __esModule: true, default: Shell },
    './LinkedinField': { __esModule: true, default: () => createElement('form', null, 'link box') }, './flow': flow,
  }).default;
  const html = (sending: 'linkedin' | 'email' | null = null) => draw(screen, {
    linkedinUrl: 'https://www.linkedin.com/in/ana', onLinkedin: async () => undefined, onEmail: () => undefined, sending,
  });
  const buttonOf = (markup: string, label: string) => markup.split('<button').find(b => b.includes(label)) ?? '';

  it('one choice at a time: while either is being sent, the other cannot be pressed', () => {
    expect(buttonOf(html(), 'Continue with LinkedIn')).not.toContain('disabled');
    expect(buttonOf(html(), 'Continue with email')).not.toContain('disabled');
    expect(buttonOf(html('linkedin'), 'Continue with email')).toContain('disabled');
    expect(buttonOf(html('email'), 'Continue with LinkedIn')).toContain('disabled');
    // The link box waits for "Continue with email" too.
    expect(read(`${dir}/SignupScreen.tsx`)).toMatch(/disabled=\{sending === 'email'\}/);
  });

  it('LinkedIn first with its line under it, then email; the link box opens only when asked', () => {
    expect(words(html())).toEqual([
      "Let's get you started",
      'Continue with LinkedIn',
      "We'll use your LinkedIn profile to fill in your details for you.",
      'Continue with email',
    ]);
    expect(html()).toContain('aria-expanded="false"');
  });

  it('prefills the box with the link they gave when they asked to join, as they would type it', () => {
    expect(read(`${dir}/SignupScreen.tsx`)).toMatch(/<LinkedinField\s+initial=\{linkedinForInput\(linkedinUrl\)\}/);
  });
});

describe('screens 3 to 6, the questions', () => {
  const step = loadModule(`${dir}/QuestionStep.tsx`, { './OptionTile': optionTile, './flow': flow }).default;
  const q = (s: 'q1' | 'q2' | 'q3' | 'q4') => flow.questionFor(s)!;
  const html = (s: 'q1' | 'q2' | 'q3' | 'q4', answers: OnboardingV2Answers, extra: Record<string, unknown> = {}) =>
    draw(step, { question: q(s), answers, onChange: () => undefined, ownWordsError: null, guessed: false, ...extra });

  it('every option is a checkbox with the brief\'s label, ticked as answered', () => {
    const markup = html('q1', { ...NONE, lookingToMeet: ['meet_investors'] });
    expect(markup.match(/role="checkbox"/g)).toHaveLength(7);
    expect(words(markup)).toEqual(flow.QUESTIONS[0].options.map(o => o.label));
    expect(markup).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*I would like to meet investors\./);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it('at three, the rest are disabled and the gentle line shows; the three chosen stay live', () => {
    const markup = html('q1', { ...NONE, lookingToMeet: ['meet_investors', 'meet_founders_owners', 'meet_specialists'] });
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(words(markup)).toContain("You've chosen three. Untick one to choose another.");
    expect(html('q1', { ...NONE, lookingToMeet: ['meet_investors'] })).not.toContain("You've chosen");
  });

  it('the options are described by the helper line, and by the limit line and the error when they show', () => {
    const described = (markup: string) => markup.match(/role="group"[^>]*aria-describedby="([^"]*)"/)?.[1].split(' ') ?? [];
    expect(described(html('q1', NONE, { hintId: 'hint' }))).toEqual(['hint']);
    const full = html('q1', { ...NONE, lookingToMeet: ['meet_investors', 'meet_founders_owners', 'meet_specialists'] }, { hintId: 'hint', listError: 'Select up to three answers.' });
    const ids = described(full);
    expect(ids[0]).toBe('hint');
    expect(ids).toHaveLength(3);
    for (const id of ids.slice(1)) expect(full).toContain(`id="${id}"`);
    expect(full).toMatch(/role="status">You&#x27;ve chosen three/);
    expect(full).toMatch(/role="alert">Select up to three answers\./);
  });

  it('an empty question\'s Continue can still be pressed and says why: "Select at least one answer."', () => {
    const footer = loadModule(`${dir}/FooterButtons.tsx`, { '@/components/ui/Button': { Button: ({ children, ...rest }: { children: ReactNode; [k: string]: unknown }) => createElement('button', rest as Record<string, unknown>, children) } }).default;
    const markup = draw(footer, { primary: { label: 'Continue', onClick: () => undefined, unready: true } });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toMatch(/ disabled=""/);
    expect(read(`${dir}/OnboardingFlow.tsx`)).toMatch(/setListError\(problemMessage\(question, problem\)\)/);
  });

  it('Q4 stops at two; Q3 has no limit at all', () => {
    expect(words(html('q4', { ...NONE, selfKinds: ['self_investor', 'self_specialist'] }))).toContain("You've chosen two. Untick one to choose another.");
    const all = html('q3', { ...NONE, canOffer: flow.QUESTIONS[2].options.map(o => o.key) as OnboardingV2Answers['canOffer'] });
    expect(all).not.toMatch(/disabled=""/);
    expect(all).not.toContain("You've chosen");
  });

  it('"Something else" opens a box of up to 120 characters, right under it, with its count and, when empty, the reason', () => {
    expect(html('q1', NONE)).not.toContain('In your own words');
    const open = html('q1', { ...NONE, lookingToMeet: ['meet_other'], meetOther: 'bakers' }, { ownWordsError: 'Tell us who you would like to meet.' });
    expect(open).toContain('In your own words');
    expect(open).toContain('maxLength="120"');
    expect(open).toContain('6/120');
    expect(open).toContain('Tell us who you would like to meet.');
    expect(open).toContain('aria-invalid="true"');
    // The box comes after the last option ("Something else") and before anything else.
    expect(open.indexOf('In your own words')).toBeGreaterThan(open.indexOf("Something else. I'd like to say it in my own words."));
  });

  it('Q2 has the optional box, its label and the brief\'s example as placeholder, up to 300 characters; no other question has it', () => {
    const q2 = html('q2', NONE);
    expect(q2).toContain('Is there anything specific you&#x27;re looking for? (optional)');
    expect(q2).toContain('placeholder="For example: &quot;I&#x27;m looking for someone who has helped small businesses expand internationally.&quot;"');
    expect(q2).toContain('maxLength="300"');
    for (const s of ['q1', 'q3', 'q4'] as const) expect(html(s, NONE)).not.toContain('anything specific');
  });

  it('Q4 says when LinkedIn picked the answer', () => {
    expect(html('q4', { ...NONE, selfKinds: ['self_founder_owner'] }, { guessed: true })).toContain('We picked this from your LinkedIn. Change it if it&#x27;s wrong.');
    expect(html('q4', { ...NONE, selfKinds: ['self_founder_owner'] })).not.toContain('We picked this');
  });

  it('the screen shows "1 of 4" to "4 of 4" in the flow, and no progress in edit mode', () => {
    const screen = loadModule(`${dir}/QuestionScreen.tsx`, { './OnboardingShell': { __esModule: true, default: Shell }, './QuestionStep': { __esModule: true, default: () => null }, './flow': flow }).default;
    const props = { answers: NONE, onChange: () => undefined, ownWordsError: null, ownWordsRef: null, guessed: false, footer: null };
    for (const x of flow.QUESTIONS) {
      expect(words(draw(screen, { ...props, question: x, showProgress: true }))).toEqual([`${x.number} of 4`, x.title, x.hint]);
      expect(words(draw(screen, { ...props, question: x, showProgress: false }))).toEqual([x.title, x.hint]);
    }
  });
});

describe('screen 7, "Your answers"', () => {
  const answers = loadModule(`${dir}/YourAnswers.tsx`, { './OnlyYou': onlyYou, './flow': flow }).default;
  const html = () => draw(answers, {
    answers: {
      ...NONE, lookingToMeet: ['meet_investors', 'meet_other'], meetOther: 'bakers', hopingToFind: ['find_funding'],
      findSpecific: 'a seed round', canOffer: ['offer_introductions'], selfKinds: [],
    },
    onEdit: () => undefined,
  });

  it('lists the four questions, numbered, each with [Edit] named for its question', () => {
    const markup = html();
    for (const x of flow.QUESTIONS) {
      expect(markup).toContain(`${x.number}. ${x.title}`);
      expect(markup).toContain(`aria-label="Edit: ${x.title}"`);
    }
    expect(markup.match(/>Edit</g)).toHaveLength(4);
  });

  it('marks Q1 and Q2 "Only you see this", and nothing else', () => {
    const rows = html().split('data-testid="answer-').slice(1);
    expect(rows.map(r => r.includes('Only you see this'))).toEqual([true, true, false, false]);
  });

  it('reads their answers back, their own words in place of "Something else", and says what is still open', () => {
    const markup = html();
    expect(markup).toContain('Investors · “bakers”');
    expect(markup).toContain('“a seed round”');
    expect(markup.split('data-testid="answer-q4"')[1]).toContain('This one still needs an answer.');
    expect(markup.split('data-testid="answer-q3"')[1].split('data-testid')[0]).not.toContain('still needs');
  });
});

describe('the data contract', () => {
  const sources = fs.readdirSync(path.join(root, dir)).filter(f => /\.(ts|tsx)$/.test(f))
    // Task 5's tour reads version 1's state on purpose: the tour columns are the same for both versions.
    .filter(f => !['HowRsnWorks.tsx', 'OnboardingTour.tsx', 'useTourState.ts', 'LinkedinPhotoOffer.tsx'].includes(f));
  const all = sources.map(f => read(`${dir}/${f}`)).join('\n');
  const hooks = read(`${dir}/useOnboardingV2.ts`);
  const flowSource = read(`${dir}/OnboardingFlow.tsx`);

  it('the flow talks to version 2 only, and never to the endpoints the live app\'s version 1 uses', () => {
    for (const p of ['/onboarding/v2/state', '/onboarding/v2/answers', '/onboarding/v2/linkedin', '/onboarding/v2/linkedin/skip', '/onboarding/v2/confirm']) {
      expect(hooks).toContain(`'${p}'`);
    }
    expect(all).not.toMatch(/'\/onboarding\/(state|answers|answers\/confirm|known|enrich|enrich\/apply|linkedin-photo)'/);
  });

  it('the state changes on the member\'s own tag, with no timer, and is read again when the socket comes back, that query only', () => {
    expect(hooks).toMatch(/meta: \{ entities: userId \? \[E\.user\(userId\)\] : \[\] \}/);
    // No polling anywhere in the flow (CLAUDE.md section 14): the lookup's end arrives as the member's tag.
    expect(all).not.toMatch(/refetchInterval|setInterval|setTimeout/);
    // A dropped socket missed what was sent meanwhile: on connect, this one query is read again, nothing else.
    expect(hooks).toMatch(/socket\.on\('connect', resync\);/);
    expect(hooks).toMatch(/socket\.off\('connect', resync\);/);
    expect(hooks).toMatch(/const resync = \(\) => \{ void qc\.invalidateQueries\(\{ queryKey: \['onboarding-v2-state'\] \}\); \};/);
    expect(hooks).not.toMatch(/invalidateQueries\(\)/);
    expect(hooks).not.toMatch(/setQueryData/);
  });

  it('confirm re-reads the session before anything navigates, so the gate does not send them straight back', () => {
    expect(hooks).toMatch(/onSuccess: async \(\) => \{\s*await checkSession\(\);\s*await refresh\(\);/);
  });

  it('finishing goes where the gate sent them from when that is a page of this app, else For You (where the tour opens); edit mode goes back where it came from', () => {
    expect(flowSource).toMatch(/navigate\(steps\.redirect, \{ replace: true \}\)/);
    expect(read(`${dir}/useFlowSteps.ts`)).toMatch(/const redirect = safeRedirect\(params\.get\('redirect'\)\);/);
    expect(flowSource).not.toMatch(/\/agents/);
    expect(read(`${dir}/useLeaveEdit.ts`)).toMatch(/navigate\(-keys\.current\.length\)/);
  });

  it('LinkedIn suggests nothing unless they chose it in this visit: not the Q4 guess, not the fields, not the photo, not its notes', () => {
    expect(flowSource).toMatch(/const linkedinOn = via === 'linkedin';/);
    expect(flowSource).toMatch(/const guess = linkedinOn \? state\.linkedin\.prefill\?\.selfGuess \?\? null : null;/);
    expect(flowSource).toMatch(/useProfileForm\(state, linkedinOn\)/);
    expect(read(`${dir}/useProfileForm.ts`)).toMatch(/const prefill = linkedinOn \? state\.linkedin\.prefill : undefined;/);
    const profile = read(`${dir}/ProfileScreen.tsx`);
    expect(profile).toMatch(/linkedinPhotoUrl=\{linkedinOn \? state\.linkedin\.prefill\?\.photoUrl \?\? null : null\}/);
    expect(profile).toMatch(/const lookingUp = linkedinOn && !!state\.profile\.linkedinUrl;/);
    // Choosing it turns it on: screen 2's LinkedIn, and screen 7's [Add LinkedIn] or corrected link.
    expect(flowSource.match(/choose\('linkedin'\)/g)).toHaveLength(2);
    expect(flowSource).toMatch(/choose\('email'\)/);
    // Remembered per member for the visit.
    expect(read(`${dir}/useSignupChoice.ts`)).toMatch(/sessionStorage\.setItem\(key, next\)/);
    expect(read(`${dir}/useSignupChoice.ts`)).toMatch(/signupChoiceKey\(memberId\)/);
  });

  it('the LinkedIn photo is asked for only when it is exactly the one shown and kept, and they have none of their own', () => {
    expect(read(`${dir}/useProfileForm.ts`)).toMatch(/const keepsLinkedinPhoto = !!keptPhoto && !profile\.avatarUrl && keptPhoto === prefill\?\.photoUrl;/);
    // Offered only after it has loaded.
    expect(read(`${dir}/PhotoField.tsx`)).toMatch(/const shown: 'own' \| 'linkedin' \| 'none' = avatarUrl \? 'own' : offered && linkedinReady \? 'linkedin' : 'none';/);
  });

  it('edit mode saves no drafts, so Cancel leaves nothing behind', () => {
    expect(flowSource).toMatch(/if \(!edit\) await keepDraft\(draftPatch\(question, answers, next\)\);/);
  });

  it('nothing a member reads says RSN; the old welcome says REASON in capitals', () => {
    const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const f of sources) expect(`${f}: ${withoutComments(read(`${dir}/${f}`))}`).not.toMatch(/\bRSN\b/);
    const modal = read(`${dir}/OnboardingWelcomeModal.tsx`);
    expect(modal).toContain('Welcome to REASON, {firstName}.');
    expect(modal).not.toMatch(/Welcome to Reason/);
  });

  it('the screen 1 to 7 copy lives in one place, flow.ts, and the screens use it rather than retyping it', () => {
    for (const [file, used] of [
      ['WelcomeScreen.tsx', ['WELCOME.title', 'WELCOME.lead', 'WELCOME.lines', 'WELCOME.button']],
      ['SignupScreen.tsx', ['SIGNUP.title', 'SIGNUP.linkedin', 'SIGNUP.linkedinLine', 'SIGNUP.email']],
      ['ProfileScreen.tsx', ['PROFILE.title', 'PROFILE.subtitle']],
      ['PhotoField.tsx', ['PROFILE.keepPhoto', 'PROFILE.newPhoto']],
      ['AddLinkedinCard.tsx', ['PROFILE.addLinkedinLine', 'PROFILE.addLinkedin', 'PROFILE.later']],
      ['OnboardingFlow.tsx', ['PROFILE.finish']],
    ] as const) {
      for (const u of used) expect(`${file}: ${read(`${dir}/${file}`).includes(u)}`).toBe(`${file}: true`);
    }
  });
});
