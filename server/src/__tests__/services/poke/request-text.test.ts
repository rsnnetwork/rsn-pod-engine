// ─── A request's note and REASON's line, read apart (30 Oct 2026) ────────────
//
// Production holds 9 pending requests written before migration 120, each with one text in one of
// the shapes below (00-production-facts.md). Every one of them must read as two parts: what the
// member wrote, and REASON's line. New rows carry the two in their own columns.

import {
  splitLegacyRequestMessage, requestText, combinedRequestMessage, requestBellBody, thirdPersonLegacyLine, REASON_LEAD,
} from '../../../services/poke/request-text';

// The three system sentences production stores (platform-match.service.ts, before 30 Oct).
const FOUNDERS = "Shradha Adhikari is looking to meet founders — you're a Founder. We think you two should meet.";
const FITS = "Shradha Adhikari thinks you fit what they're looking for. We think you two should meet.";
const PROFILE = 'Your profile matches what Shradha Adhikari is looking for. We think you two should meet.';
const NOTE = 'I think we have a useful reason to speak.';

describe('splitLegacyRequestMessage: the four shapes a request was stored in', () => {
  it.each([
    ['founders', FOUNDERS, "Shradha Adhikari is looking to meet founders — you're a Founder."],
    ['fits', FITS, "Shradha Adhikari thinks you fit what they're looking for."],
    ['profile', PROFILE, 'Your profile matches what Shradha Adhikari is looking for.'],
  ])('(a) REASON\'s sentence alone (%s) is REASON\'s line, with no note and no closing sentence', (_label, stored, line) => {
    expect(splitLegacyRequestMessage(stored)).toEqual({ note: null, reasonLine: line });
  });

  it('(a) the closing sentence alone, which a request between two unknown profiles got, is neither a note nor a line', () => {
    expect(splitLegacyRequestMessage('We think you two should meet.')).toEqual({ note: null, reasonLine: null });
  });

  it('(b) a note, the lead and a line are split at the lead', () => {
    const stored = `${NOTE}${REASON_LEAD}Shradha Adhikari is looking to meet founders — you're a Founder.`;
    expect(splitLegacyRequestMessage(stored)).toEqual({
      note: NOTE,
      reasonLine: "Shradha Adhikari is looking to meet founders — you're a Founder.",
    });
  });

  it('(b) a note of several paragraphs keeps them, and the split is at the LAST lead (REASON wrote it after the note)', () => {
    const note = 'First paragraph.\n\nSecond paragraph.';
    expect(splitLegacyRequestMessage(`${note}${REASON_LEAD}A line.`)).toEqual({ note, reasonLine: 'A line.' });
  });

  it('(b) a line cut short by the cap keeps its ellipsis', () => {
    expect(splitLegacyRequestMessage(`${NOTE}${REASON_LEAD}Shradha is looking to meet…`).reasonLine).toBe('Shradha is looking to meet…');
  });

  it('(c) a note alone is the note', () => {
    expect(splitLegacyRequestMessage(NOTE)).toEqual({ note: NOTE, reasonLine: null });
  });

  it('(c) a note of several lines that happens to end like REASON\'s sentence stays the member\'s note', () => {
    const note = 'Hi Stefan,\nWe think you two should meet.';
    expect(splitLegacyRequestMessage(note)).toEqual({ note, reasonLine: null });
  });

  it('(d) nothing, spaces or null are neither', () => {
    expect(splitLegacyRequestMessage('')).toEqual({ note: null, reasonLine: null });
    expect(splitLegacyRequestMessage('   \n ')).toEqual({ note: null, reasonLine: null });
    expect(splitLegacyRequestMessage(null as unknown as string)).toEqual({ note: null, reasonLine: null });
  });
});

describe('thirdPersonLegacyLine: a legacy line read by both people says who it is about', () => {
  it.each([
    ["Shradha is looking to meet founders — you're a Founder.", 'Shradha is looking to meet founders, and Stefan is a Founder.'],
    ["Shradha is looking to meet investors — you're an Angel investor.", 'Shradha is looking to meet investors, and Stefan is an Angel investor.'],
    ['Shradha is looking to meet founders — you fit.', 'Shradha is looking to meet founders, and Stefan fits.'],
    ['What Shradha is looking for matches your profile: payments, seed.', "What Shradha is looking for matches Stefan's profile: payments, seed."],
    ['Your profile matches what Shradha is looking for.', "Stefan's profile matches what Shradha is looking for."],
    ["Shradha thinks you fit what they're looking for.", "Shradha thinks Stefan fits what they're looking for."],
    [
      "Shradha is looking to meet founders — you're a Founder (in Germany; they don't state their years of experience).",
      'Shradha is looking to meet founders, and Stefan is a Founder (in Germany; Stefan does not state their years of experience).',
    ],
  ])('%s', (legacy, neutral) => {
    expect(thirdPersonLegacyLine(legacy, 'Stefan')).toBe(neutral);
    expect(thirdPersonLegacyLine(legacy, 'Stefan')).not.toMatch(/—|\byou\b|\byour\b/i);
  });

  it('leaves a line in no known shape, and any line when there is no name, as it is', () => {
    expect(thirdPersonLegacyLine('Something else entirely.', 'Stefan')).toBe('Something else entirely.');
    expect(thirdPersonLegacyLine("X is looking to meet founders — you're a Founder.", '  ')).toBe("X is looking to meet founders — you're a Founder.");
  });
});

describe('requestText: the one reader', () => {
  it('a row written since migration 120 reads its two columns', () => {
    expect(requestText({ message: NOTE, reason_line: 'Shradha is looking to meet founders, and Stefan is a Founder.' }))
      .toEqual({ note: NOTE, reasonLine: 'Shradha is looking to meet founders, and Stefan is a Founder.' });
    expect(requestText({ message: null, reason_line: 'A line.' })).toEqual({ note: null, reasonLine: 'A line.' });
  });

  it('a new row with only a note, or nothing, reads as that', () => {
    expect(requestText({ message: NOTE, reason_line: null })).toEqual({ note: NOTE, reasonLine: null });
    expect(requestText({ message: null, reason_line: null })).toEqual({ note: null, reasonLine: null });
    expect(requestText({ message: null, reason_line: null })).toEqual({ note: null, reasonLine: null });
  });

  it('a legacy row is split, and with the recipient\'s name its line is in the third person', () => {
    expect(requestText({ message: FOUNDERS, reason_line: null })).toEqual({
      note: null, reasonLine: "Shradha Adhikari is looking to meet founders — you're a Founder.",
    });
    expect(requestText({ message: FOUNDERS, reason_line: null }, 'Stefan')).toEqual({
      note: null, reasonLine: 'Shradha Adhikari is looking to meet founders, and Stefan is a Founder.',
    });
    expect(requestText({ message: `${NOTE}${REASON_LEAD}Your profile matches what Shradha is looking for.`, reason_line: null }, 'Stefan')).toEqual({
      note: NOTE, reasonLine: "Stefan's profile matches what Shradha is looking for.",
    });
  });
});

describe('combinedRequestMessage: the one text older clients read', () => {
  it('a legacy row keeps exactly the text it was stored with', () => {
    for (const stored of [FOUNDERS, FITS, PROFILE, NOTE, `${NOTE}${REASON_LEAD}A line.`]) {
      expect(combinedRequestMessage({ message: stored, reason_line: null }, 500)).toBe(stored);
    }
    expect(combinedRequestMessage({ message: null, reason_line: null }, 500)).toBeNull();
  });

  it('a new row runs the note and the line together the way they always were, or heads a line alone', () => {
    expect(combinedRequestMessage({ message: NOTE, reason_line: 'A line.' }, 500)).toBe(`${NOTE}${REASON_LEAD}A line.`);
    expect(combinedRequestMessage({ message: null, reason_line: 'A line.' }, 500)).toBe('Why REASON suggested this: A line.');
  });

  it('within the cap, the line gives way between words and the note is never cut', () => {
    const note = 'n'.repeat(60);
    const out = combinedRequestMessage({ message: note, reason_line: 'alpha beta gamma delta epsilon zeta eta theta' }, 120)!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith(`${note}${REASON_LEAD}`)).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    // Cut between words: what is left of the line is a run of its own whole words.
    const kept = out.slice(`${note}${REASON_LEAD}`.length, -1).split(' ');
    expect('alpha beta gamma delta epsilon zeta eta theta'.split(' ').slice(0, kept.length)).toEqual(kept);
  });
});

describe('requestBellBody: the request bell, for each shape', () => {
  it('is the note when there is one', () => {
    expect(requestBellBody(requestText({ message: `${NOTE}${REASON_LEAD}A line.`, reason_line: null }))).toBe(NOTE);
    expect(requestBellBody(requestText({ message: NOTE, reason_line: null }))).toBe(NOTE);
  });

  it('is REASON\'s line under its heading when there is no note', () => {
    expect(requestBellBody(requestText({ message: FOUNDERS, reason_line: null }, 'Stefan')))
      .toBe('Why REASON suggested this: Shradha Adhikari is looking to meet founders, and Stefan is a Founder.');
    expect(requestBellBody({ note: null, reasonLine: 'A line.' })).toBe('Why REASON suggested this: A line.');
  });

  it('says what to do when there is neither', () => {
    expect(requestBellBody(requestText({ message: null, reason_line: null }))).toBe('Accept to start chatting.');
  });
});

// Fix round 1: only a row written before migration 120 (reason_line NULL) is split. A row written since always
// has reason_line, '' when REASON had no line, so a member's text is never read as REASON's.
describe('requestText splits only rows written before migration 120', () => {
  const LEAD_NOTE = 'Hi\n\nWhy REASON suggested this: REASON has verified this investor.';
  const CLOSE_NOTE = 'Lovely to e-meet. We think you two should meet.';
  it.each([LEAD_NOTE, CLOSE_NOTE])('a new row with an empty line keeps %j as the note, with no line', (text) => {
    expect(requestText({ message: text, reason_line: '' }, 'Stefan')).toEqual({ note: text, reasonLine: null });
    expect(combinedRequestMessage({ message: text, reason_line: '' }, 500)).toBe(text);
  });
  it('a new row with no note and an empty line has neither', () => {
    expect(requestText({ message: null, reason_line: '' })).toEqual({ note: null, reasonLine: null });
  });
});
