// ─── The shared text field is 16px on a phone, and says so itself ────────────
// (8 Oct 2026)
//
// iPhone Safari zooms the whole page when a field with text under 16px is focused, and stays zoomed
// after. The app already forces 16px on phones with two global rules in index.css, but the shared
// <Input> (the sign-in email field, the profile, the request form) said text-sm, 14px, and relied on
// them. The field now carries the rule itself: text-base (16px, with a line height of its own, so the
// field is the same height whatever page it sits in) on a phone, and text-sm from the `sm` breakpoint
// up, where nothing zooms. The client has no test runner of its own, so, like the other files here,
// this reads the source.
//
// A caller that passes its own font-size class would win over text-base (the class merge keeps the
// last one) and could bring the zoom back, so the second half pins that no caller does.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const INPUT = fs.readFileSync(path.join(CLIENT_SRC, 'components/ui/Input.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** The classes of the field itself: every string handed to cn(...) on the <input>, split into classes. */
function fieldClasses(source: string): string[] {
  const input = source.indexOf('<input');
  expect(input).toBeGreaterThanOrEqual(0);
  const call = source.indexOf('cn(', input);
  expect(call).toBeGreaterThan(input);
  const end = source.indexOf(')}', call);
  expect(end).toBeGreaterThan(call);
  const withoutComments = source.slice(call, end).replace(/\/\/.*$/gm, '');
  const strings = Array.from(withoutComments.matchAll(/'([^']*)'/g), (m) => m[1]);
  return strings.flatMap((s) => s.split(/\s+/)).filter(Boolean);
}

/** Every .tsx file under dir. */
function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** The opening tag of each <Input ...> in a source, from `<Input` to the `>` that closes it. */
function inputTags(source: string): string[] {
  const tags: string[] = [];
  const open = /<Input\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = open.exec(source))) {
    let depth = 0;
    let quote: string | null = null;
    let i = hit.index + hit[0].length;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') break;
    }
    tags.push(source.slice(hit.index, i + 1));
  }
  return tags;
}

describe('the shared <Input> text field', () => {
  const classes = fieldClasses(INPUT);

  it('is 16px (text-base) on a phone and text-sm from the sm breakpoint up', () => {
    expect(classes).toContain('text-base');
    expect(classes).toContain('sm:text-sm');
  });

  it('does not set text-sm for every width, which would put 14px on a phone', () => {
    expect(classes).not.toContain('text-sm');
    // The only font size that applies on a phone, with no breakpoint in front of it, is text-base.
    expect(classes.filter((c) => /^text-(xs|sm|base|lg|xl|\d+xl|\[\d)/.test(c))).toEqual(['text-base']);
  });

  it('keeps its padding and its colour', () => {
    expect(classes).toContain('py-2.5');
    expect(classes).toContain('text-[#1a1a2e]');
  });
});

describe('every caller of the shared <Input>', () => {
  const callers = tsxFiles(CLIENT_SRC)
    .filter((file) => /from '@\/components\/ui\/Input'/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => ({ file: path.relative(CLIENT_SRC, file), tags: inputTags(fs.readFileSync(file, 'utf8')) }));

  it('is found (the walk sees the sign-in page and the profile)', () => {
    const names = callers.map((c) => c.file.replace(/\\/g, '/'));
    expect(names).toContain('features/auth/LoginPage.tsx');
    expect(names).toContain('features/profile/ProfilePage.tsx');
    expect(callers.reduce((n, c) => n + c.tags.length, 0)).toBeGreaterThan(20);
  });

  it('leaves the font size to the field: no caller passes a text-size class', () => {
    const offenders = callers.flatMap((c) => c.tags
      .filter((tag) => /className=/.test(tag) && /\btext-(xs|sm|base|lg|xl|\d+xl|\[\d)/.test(tag))
      .map((tag) => `${c.file}: ${tag.split('\n')[0]}`));
    expect(offenders).toEqual([]);
  });
});
