// server/src/__tests__/client/reason-m1-sheets.test.ts
// Task B5: the Meet sheet and the "What happened?" sheet. Like the other client tests here it reads
// source, so it pins what a reader of the code cannot see is deliberate and a refactor could undo with
// no type error: when the form resets, where the cap comes from, the double-press guard, and who the
// request belongs to. The behaviour itself was proven in a real browser (see the task report).
import * as fs from 'fs';
import * as path from 'path';

const clientRoot = path.join(__dirname, '../../../../client');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const readClient = (rel: string) => fs.readFileSync(path.join(clientRoot, rel), 'utf8').replace(/\r\n/g, '\n');
// A sheet's source on one line, so a pattern does not depend on how the code is wrapped.
const flat = (sheet: string) => readClient(`src/features/reason/human/${sheet}.tsx`).replace(/\s+/g, ' ');

const SHEETS = ['MeetSheet', 'OutcomeSheet'];

describe('REASON sheets: the props the two pages mount them with', () => {
  it('are unchanged: { person: { userId, displayName } | null, onClose }, default export', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toContain('interface Props { person: { userId: string; displayName: string } | null; onClose: () => void }');
      expect(src).toContain(`export default function ${sheet}({ person, onClose }: Props)`);
    }
  });
});

describe('REASON sheets: typing survives the parent re-rendering', () => {
  // The Human Profile passes `meetOpen ? { userId, displayName } : null`, a NEW object on every render,
  // and re-renders on every refetch. A reset keyed on the object would put the default text back over
  // what the member is typing.
  it('the form resets when the sheet opens for a person, keyed on their id and never on the object', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toContain('const personId = person?.userId ?? null;');
      expect(src).toContain('const [formFor, setFormFor] = useState(personId);');
      expect(src).toContain('if (formFor !== personId) { setFormFor(personId);');
      // Nothing is keyed on the `person` object: not a dependency list, not a comparison.
      expect(src).not.toMatch(/\}, \[[^\]]*\bperson\b[^\]]*\]\)/);
      expect(src).not.toMatch(/\b(?:formFor|prev\w*) !== person\b/);
    }
    // Closing is not opening: the fields are put back only for an id (the closed sheet is not drawn).
    expect(flat('MeetSheet')).toContain('if (personId) { setNote(DEFAULT_NOTE); setFormat(DEFAULT_FORMAT); setError(null); }');
    expect(flat('OutcomeSheet')).toContain('if (personId) { setWorth(null); setPicked([]); setError(null); }');
  });

  // A reset made in an effect happens after the first render, so a reopened sheet is drawn once with the
  // previous answers before it is corrected (a MutationObserver sees it in Chromium and WebKit).
  it('the reset is made while rendering, not in an effect, so a reopened sheet never shows the last answers', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).not.toContain('useLayoutEffect');
      // The one effect there is only keeps a ref (pinned below); none of them touches the fields.
      for (const effect of src.matchAll(/useEffect\(\(\) => \{(.*?)\}, \[[^\]]*\]\);/g)) {
        expect(effect[1]).not.toMatch(/\bset\w+\(/);
      }
    }
  });
});

describe('REASON Meet sheet: the note and its cap', () => {
  it('the cap is MEET_NOTE_MAX from shared (the route reads the same number), never a 300 of its own', () => {
    const src = flat('MeetSheet');
    expect(src).toMatch(/import \{[^}]*\bMEET_NOTE_MAX\b[^}]*\} from '@rsn\/shared'/);
    expect(src).not.toMatch(/\b300\b/);
    expect(src).toContain('const over = length > MEET_NOTE_MAX;');
    expect(src).toContain('const invalid = length === 0 || over;');
    expect(src).toContain('{length} / {MEET_NOTE_MAX}');
  });

  it('counts what the server counts: the trimmed string, which is also what is sent', () => {
    const src = flat('MeetSheet');
    expect(src).toContain('const length = note.trim().length;');
    expect(src).toContain('note: note.trim()');
  });
});

describe('REASON sheets: one request per press', () => {
  // isPending only turns the button off a moment AFTER the press, so a double tap would send twice. For
  // the Meet sheet the server would answer the second with a 409; for outcomes it would store a second
  // row (they are a history).
  it('a ref is taken before the request starts, checked first, and given back when the request settles', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toContain('const inFlight = useRef(false);');
      expect(src).toMatch(/if \([^)]*inFlight\.current[^)]*\) return;/);
      expect(src).toMatch(/inFlight\.current = true;[^}]*\.mutate\(/);
      expect(src).toContain('onSettled: () => { inFlight.current = false; }');
      expect(src).not.toMatch(/if \([^)]*isPending[^)]*\) return;/);
    }
  });
});

describe('REASON sheets: the request belongs to the person it was made for', () => {
  // The parent sets `person` to null when the sheet closes. A request still in flight then settles with
  // no person to read: `person!` in onSuccess threw there.
  it('the person travels through the mutation variables; nothing the request does reads the person prop', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).not.toContain('person!');
      const start = src.indexOf('useMutation({');
      const end = src.indexOf('onError:');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const mutationFnAndOnSuccess = src.slice(start, end);
      expect(mutationFnAndOnSuccess).not.toMatch(/\bperson\b/);
      expect(mutationFnAndOnSuccess).toMatch(/\$\{\w+\.displayName\}/);
    }
  });
});

describe('REASON sheets: a failure keeps what the member entered', () => {
  it('the error is shown in a role=alert line, never closes the sheet, and clears on a retry', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toMatch(/onError: \(err, r\) => \{ const message = errorMessage\(err, '[^']+'\); if \(shownFor\.current === r\.userId\) setError\(message\); else addToast\(message, 'error'\); \}/);
      expect(src).toContain('<p role="alert"');
      // onError says nothing about closing or resetting.
      const onError = src.slice(src.indexOf('onError:'), src.indexOf('});', src.indexOf('onError:')));
      expect(onError).not.toMatch(/onClose|setNote|setFormat|setWorth|setPicked/);
      // A retry starts from a clean line.
      expect(src).toContain('inFlight.current = true; setError(null);');
    }
  });

  it('the error clears as soon as the member edits any field', () => {
    const meet = flat('MeetSheet');
    expect(meet).toContain('onChange={(e) => { setNote(e.target.value); setError(null); }}');
    expect(meet).toContain('onChange={(e) => { setFormat(e.target.value as MeetingFormat); setError(null); }}');
    const outcome = flat('OutcomeSheet');
    expect(outcome).toContain('const choose = (key: WorthContinuing) => { setWorth(key); setError(null); };');
    expect(outcome).toMatch(/const toggle = \(key: OutcomeKey\) => \{[^}]*setError\(null\); \};/);
  });
});

describe('REASON sheets: after a success', () => {
  it('a success toast names the person, the REASON data is refreshed, and the sheet closes', () => {
    expect(flat('MeetSheet')).toContain("addToast(`Meeting request sent to ${r.displayName}`, 'success');");
    expect(flat('OutcomeSheet')).toContain("addToast(`Saved what happened with ${r.displayName}`, 'success');");
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toMatch(/qc\.invalidateQueries\(\{ queryKey: reasonKeys\.all \}\); if \(shownFor\.current === r\.userId\) onClose\(\); \}/);
    }
  });
});

describe('REASON sheets: a request that settles after the sheet has moved on', () => {
  // Without this, a request that failed after the member closed the sheet said so nowhere, and the first
  // person's late success closed a sheet opened for someone else. The sheet knows who it is open for now;
  // a request settling for anyone else reports in a toast and leaves the sheet alone.
  it('the sheet remembers who it is open for, and only a request for that person touches the sheet', () => {
    for (const sheet of SHEETS) {
      const src = flat(sheet);
      expect(src).toContain('const shownFor = useRef(personId);');
      expect(src).toContain('useEffect(() => { shownFor.current = personId; }, [personId]);');
      expect(src).toContain('if (shownFor.current === r.userId) onClose();');
      expect(src).toContain('if (shownFor.current === r.userId) setError(message); else addToast(message, \'error\');');
    }
  });
});

describe('REASON sheets: the names the end-to-end spec and the Foundation give them', () => {
  it('the Meet sheet offers the shared formats by their keys and a button named Send request', () => {
    const src = flat('MeetSheet');
    expect(src).toContain('MEETING_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)');
    expect(src).toContain("'Send request'");
    expect(src).toContain('Why now?');
    expect(src).toContain('Preferred format');
  });

  it('the outcome sheet has Yes, Maybe, No, one chip per shared outcome label, and a button named Save outcome', () => {
    const src = flat('OutcomeSheet');
    for (const label of ['Yes', 'Maybe', 'No']) expect(src).toContain(`label: '${label}'`);
    expect(src).toContain('OUTCOME_KEYS.map((k) =>');
    expect(src).toContain('OUTCOME_LABELS[k]');
    expect(src).toContain("'Save outcome'");
    expect(src).toContain('Worth continuing?');
    expect(src).toContain('What came from the conversation?');
  });

  it('user-facing words say event, never session', () => {
    for (const sheet of SHEETS) expect(flat(sheet)).not.toMatch(/session/i);
  });
});

// Contrast is computed from the real tokens, so a palette change that fails AA fails here.
const reasonTokens = (() => {
  const block = readClient('tailwind.config.js').match(/reason:\s*\{([^}]*)\}/)?.[1] ?? '';
  const tokens: Record<string, string> = {};
  for (const m of block.matchAll(/['"]?([a-z-]+)['"]?:\s*'(#[0-9a-fA-F]{6})'/g)) tokens[m[1]] = m[2];
  return tokens;
})();
const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

describe('REASON sheets: text passes WCAG AA (4.5:1)', () => {
  it('a selected chip is dark red on pink: the brand red on that pink is only 4.15:1', () => {
    const { red, 'red-hover': redHover, pink } = reasonTokens;
    expect(contrast(red, pink)).toBeLessThan(4.5);
    expect(contrast(redHover, pink)).toBeGreaterThanOrEqual(4.5);
    const src = flat('OutcomeSheet');
    expect(src).toContain('border-reason-red bg-reason-pink text-reason-red-hover');
    expect(src).not.toMatch(/bg-reason-pink text-reason-red(?![-\w])/);
  });

  it('the other text the sheets use passes too: muted and red on white, white on the red button', () => {
    const { muted, red } = reasonTokens;
    expect(contrast(muted, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(red, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('REASON sheets on phones', () => {
  it('the note and the format are 16px so iOS does not zoom, and the controls keep a 44px floor', () => {
    const meet = flat('MeetSheet');
    expect(meet.match(/text-\[16px\][^"]*md:text-\[14px\]/g)).toHaveLength(2);
    expect(meet.match(/min-h-\[44px\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(flat('OutcomeSheet').match(/min-h-\[44px\]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
