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
    draw(step, { question: q(s), answers, onChange: () => undefined, ownWordsError: null, fromLinkedin: [], ...extra });
  /** Every answer of a question ticked at once. */
  const everyAnswer = (s: 'q1' | 'q2' | 'q3' | 'q4') => flow.withKeys(NONE, q(s), q(s).options.map(o => o.key));

  it('every option is a checkbox with the brief\'s label, ticked as answered', () => {
    const markup = html('q1', { ...NONE, lookingToMeet: ['meet_investors'] });
    expect(markup.match(/role="checkbox"/g)).toHaveLength(flow.QUESTIONS[0].options.length);
    expect(words(markup)).toEqual(flow.QUESTIONS[0].options.map(o => o.label));
    expect(markup).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*I would like to meet investors\./);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  // 25 Oct review (ONB-01): at three the rest used to grey out ("You've chosen three. Untick one to choose another.").
  it('no question has a limit: with every answer ticked nothing is greyed out and there is no line about a limit', () => {
    for (const s of ['q1', 'q2', 'q3', 'q4'] as const) {
      const markup = html(s, everyAnswer(s));
      expect({ s, ticked: markup.match(/aria-checked="true"/g)?.length }).toEqual({ s, ticked: q(s).options.length });
      expect({ s, greyedOut: /disabled/.test(markup) }).toEqual({ s, greyedOut: false });
      expect({ s, limitLine: /You&#x27;ve chosen|Untick one|Select up to/.test(markup) }).toEqual({ s, limitLine: false });
      expect({ s, status: markup.includes('role="status"') }).toEqual({ s, status: false });
    }
  });

  it('five ticked on each question leave every other answer live, and every tile can be pressed', () => {
    for (const s of ['q1', 'q2', 'q3', 'q4'] as const) {
      const five = q(s).options.filter(o => o.key !== q(s).ownWordsKey).slice(0, 5).map(o => o.key);
      const markup = html(s, flow.withKeys(NONE, q(s), five));
      expect({ s, ticked: markup.match(/aria-checked="true"/g)?.length, open: markup.match(/aria-checked="false"/g)?.length })
        .toEqual({ s, ticked: 5, open: q(s).options.length - 5 });
      expect({ s, greyedOut: /disabled/.test(markup) }).toEqual({ s, greyedOut: false });
    }
  });

  it('the options are described by the helper line, and by the error when it shows', () => {
    const described = (markup: string) => markup.match(/role="group"[^>]*aria-describedby="([^"]*)"/)?.[1].split(' ') ?? [];
    expect(described(html('q1', NONE, { hintId: 'hint' }))).toEqual(['hint']);
    const full = html('q1', { ...NONE, lookingToMeet: ['meet_investors', 'meet_founders_owners', 'meet_specialists', 'meet_hiring', 'meet_managers_leaders'] },
      { hintId: 'hint', listError: 'Select at least one answer.' });
    const ids = described(full);
    expect(ids[0]).toBe('hint');
    expect(ids).toHaveLength(2);
    for (const id of ids.slice(1)) expect(full).toContain(`id="${id}"`);
    expect(full).toMatch(/role="alert">Select at least one answer\./);
  });

  it('an empty question\'s Continue can still be pressed and says why: "Select at least one answer."', () => {
    const footer = loadModule(`${dir}/FooterButtons.tsx`, { '@/components/ui/Button': { Button: ({ children, ...rest }: { children: ReactNode; [k: string]: unknown }) => createElement('button', rest as Record<string, unknown>, children) } }).default;
    const markup = draw(footer, { primary: { label: 'Continue', onClick: () => undefined, unready: true } });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toMatch(/ disabled=""/);
    expect(read(`${dir}/OnboardingFlow.tsx`)).toMatch(/setListError\(problemMessage\(question, problem\)\)/);
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

  // 25 Oct review (ONB-03): LinkedIn can pick several answers. The line is above the options, and each picked tile says so.
  describe('Q4 says when LinkedIn picked the answers', () => {
    const picked = ['self_founder_owner', 'self_investor'];
    const founderAndInvestor = { ...NONE, selfKinds: picked as OnboardingV2Answers['selfKinds'] };
    /** The tile's own markup, from its opening button to the next. */
    const tileOf = (markup: string, label: string) => markup.split('<button').find(b => b.includes(`>${label}<`)) ?? '';
    const attr = (tile: string, name: string) => tile.match(new RegExp(`${name}="([^"]*)"`))?.[1];

    it('the plural line above the options, once, when LinkedIn picked something that is still what is ticked', () => {
      const markup = html('q4', founderAndInvestor, { fromLinkedin: picked });
      expect(markup).toContain('We picked these from your LinkedIn. Change them if they&#x27;re wrong.');
      expect(markup.match(/We picked these/g)).toHaveLength(1);
      expect(markup).toMatch(/role="status">We picked these/);
      expect(markup.indexOf('We picked these')).toBeLessThan(markup.indexOf('<button'));
      for (const quiet of [html('q4', founderAndInvestor), html('q4', founderAndInvestor, { fromLinkedin: [] })]) {
        expect(quiet).not.toContain('We picked');
        expect(quiet).not.toContain('From LinkedIn');
      }
    });

    it('each picked tile says "From LinkedIn", linked to its tile; the tiles nobody picked say nothing', () => {
      const markup = html('q4', founderAndInvestor, { fromLinkedin: picked });
      expect(markup.match(/From LinkedIn/g)).toHaveLength(2);
      for (const key of picked) {
        const option = flow.QUESTIONS[3].options.find(o => o.key === key)!;
        const tile = tileOf(markup, option.label);
        const note = attr(tile, 'aria-describedby');
        expect({ key, described: !!note }).toEqual({ key, described: true });
        expect(markup).toMatch(new RegExp(`id="${note}"[^>]*>From LinkedIn<`));
        expect(attr(tile, 'aria-checked')).toBe('true');
      }
      const quiet = tileOf(markup, flow.QUESTIONS[3].options.find(o => o.key === 'self_employee')!.label);
      expect(attr(quiet, 'aria-describedby')).toBeUndefined();
      expect(quiet).not.toContain('From LinkedIn');
    });

    it('a tile is still named by its answer alone: the note describes it, it is not part of its name', () => {
      const markup = html('q4', founderAndInvestor, { fromLinkedin: picked });
      const label = flow.QUESTIONS[3].options.find(o => o.key === 'self_founder_owner')!.label;
      const tile = tileOf(markup, label);
      const name = attr(tile, 'aria-labelledby');
      expect(name).toBeTruthy();
      expect(markup).toMatch(new RegExp(`id="${name}"[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
      expect(name).not.toBe(attr(tile, 'aria-describedby'));
    });
  });

  it('the screen shows "1 of 4" to "4 of 4" in the flow, and no progress in edit mode', () => {
    const screen = loadModule(`${dir}/QuestionScreen.tsx`, { './OnboardingShell': { __esModule: true, default: Shell }, './QuestionStep': { __esModule: true, default: () => null }, './flow': flow }).default;
    const props = { answers: NONE, onChange: () => undefined, ownWordsError: null, ownWordsRef: null, fromLinkedin: [], footer: null };
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
    expect(flowSource).toMatch(/navigate\(steps\.redirect, \{ replace: true, state: LANDED \}\)/);
    expect(read(`${dir}/useFlowSteps.ts`)).toMatch(/const redirect = safeRedirect\(params\.get\('redirect'\)\);/);
    expect(flowSource).not.toMatch(/\/agents/);
    expect(read(`${dir}/useLeaveEdit.ts`)).toMatch(/navigate\(-keys\.current\.length\)/);
  });

  // Fix round 1 (M-7): when the save opens the tour, its success toast sat over the tour's Skip on a phone. The tour, and
  // the changed page under it, say it was saved; every other edit-mode save still says so.
  it('edit mode says "Your changes are saved." only when the save does not open the tour', () => {
    expect(flowSource).toMatch(/if \(!tourOpensAfterConfirm\(state\.tour\)\) addToast\('Your changes are saved\.', 'success'\);\s*leave\(edit\);/);
    expect(flowSource.match(/Your changes are saved\./g)).toHaveLength(1);
  });

  // Final review (C1): the tour opens over the page the flow put them on, and must leave them there.
  it('every way the flow leaves says where it put the member: LANDED on a page it opens, a mark before it goes back through the history', () => {
    const leave = read(`${dir}/useLeaveEdit.ts`);
    expect(leave).toMatch(/markReturned\(memberId\);\s*navigate\(-keys\.current\.length\);/);
    expect(leave).toMatch(/navigate\(editFallback\(target\), \{ replace: true, state: LANDED \}\);/);
    // Every navigate in the flow and in edit mode's way out is one of those.
    expect(flowSource.match(/\bnavigate\(/g)).toHaveLength(1);
    expect(leave.match(/\bnavigate\(/g)).toHaveLength(2);
  });

  it('LinkedIn suggests nothing unless they chose it (in this visit, or as the server recorded it): not the Q4 guesses, not the fields, not the photo, not its notes', () => {
    expect(flowSource).toMatch(/const linkedinOn = via === 'linkedin';/);
    expect(flowSource).toMatch(/const guesses = linkedinOn \? state\.linkedin\.prefill\?\.selfGuesses : undefined;/);
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

  // 25 Oct review (ONB-03): another tab or device has no sessionStorage, so it asks the server how they chose last.
  it('this tab\'s choice comes first and the server\'s linkedin.chosen follows it, so the suggestions survive another tab or device', () => {
    const hook = read(`${dir}/useSignupChoice.ts`);
    expect(hook).toMatch(/export function useSignupChoice\(onServer: SignupChoice \| null\)/);
    expect(hook).toMatch(/return \[signupChoiceOf\(choice, onServer\), choose\];/);
    expect(flowSource).toMatch(/useSignupChoice\(state\.linkedin\.chosen\)/);
  });

  // 25 Oct review (ONB-01): the shared maxima are 20 so that the old build compiled; nothing on a screen reads them.
  it('no screen reads a maximum, a limit line or a refusal for "too many": the ceiling of 20 is the server\'s alone', () => {
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const everything = fs.readdirSync(path.join(root, dir)).filter(f => /\.(ts|tsx)$/.test(f)).map(f => `${f}\n${code(read(`${dir}/${f}`))}`).join('\n');
    expect(everything).not.toMatch(/\bmeetMax\b|\bfindMax\b|\bselfMax\b|limitHint|atLimit|too-many|Untick one/);
  });

  // Final review (C2): emptying a stored role, company or industry clears it, so what is stored is what decides.
  it('screen 7 sends its fields against what the profile holds, so a stored field they emptied is cleared', () => {
    expect(read(`${dir}/useProfileForm.ts`)).toMatch(/return profileInput\(fields, profile, isRealZone\(zone\) \? zone : null, keepsLinkedinPhoto\);/);
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
