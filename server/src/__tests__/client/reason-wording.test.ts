// server/src/__tests__/client/reason-wording.test.ts
//
// The product is REASON. A person must never read "RSN" on a screen (19 Oct feedback: the preview still said RSN in
// a dozen places, one page at a time).
//
// This reads every client source file and fails on any string, template, attribute or piece of JSX text that holds
// the word RSN in capitals. What nobody reads is not counted: comments, identifiers (HowRsnWorks), and the lower-case
// names of files, classes, storage keys and addresses (rsn-red, rsn_access, @rsn/shared, rsn.network). The client has no
// test runner of its own, so, like its neighbours in this folder, this reads the source.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '../../../../client/src');
const RSN = /\bRSN\b/;

// Files excused from the rule while another task rewrote them. The 19 Oct batch has landed, so none is excused now.
// An entry whose files no longer say RSN fails the test below, so none can outlive its reason and quietly excuse a
// file that has since been cleaned. A name ending in "/" is a folder, anything else is one file; both are relative
// to client/src.
const ALLOWED: string[] = [];

/** Where `source` writes RSN as text a person could read, as "line N: the words". Comments are not part of the tree. */
function rsnInReadableText(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // A string (a plain one, a JSX attribute's, one inside a type), each part of a template, and the text between JSX tags.
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text : undefined;
    if (text !== undefined && RSN.test(text)) {
      found.push(`line ${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${text.trim().replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

// Every .ts and .tsx file of the app. Tests and type declarations are not the app, and a folder whose name starts
// with __test is scratch space that a suite running beside this one may make and remove while this one lists it.
const sourcesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => !e.name.startsWith('__test'))
  .flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(e.name) ? [full] : [];
  });

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
const covers = (entry: string, rel: string) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry);

describe('REASON, never RSN, in anything a person reads (19 Oct feedback)', () => {
  const files = sourcesUnder(SRC);
  const says = new Map<string, string[]>();
  for (const file of files) {
    const hits = rsnInReadableText(file, fs.readFileSync(file, 'utf8'));
    if (hits.length) says.set(relative(file), hits);
  }

  it('looks at the whole app, so an empty walk cannot pass for nothing', () => {
    expect(files.length).toBeGreaterThan(150);
    const names = files.map(relative);
    for (const known of ['App.tsx', 'features/reason/brand/ReasonMark.tsx', 'features/auth/LoginPage.tsx', 'features/support/SupportPage.tsx', 'lib/api.ts']) {
      expect(names).toContain(known);
    }
  });

  it('says REASON on every screen, apart from the files on the temporary list below', () => {
    const offenders = [...says].filter(([rel]) => !ALLOWED.some((a) => covers(a, rel))).map(([rel, hits]) => `${rel}\n    ${hits.join('\n    ')}`);
    expect(offenders).toEqual([]);
  });

  it('keeps nothing on the temporary list that no longer needs to be there (remove an entry when its files are clean)', () => {
    const stale = ALLOWED.filter((entry) => ![...says.keys()].some((rel) => covers(entry, rel)));
    expect(stale).toEqual([]);
  });
});

// What the client asked each screen to say (19 Oct). The scan above only proves RSN is gone; these prove the new words
// are there, so deleting a sentence is as visible as spelling it the old way. Working-tree files are CRLF on Windows.
describe('the words the client asked for, screen by screen (19 Oct feedback)', () => {
  const source = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const SUSPENDED = 'This account is suspended. Please contact the REASON team if you think this is a mistake.';

  it('sign-in: the REASON lockup about 44px tall, "REASON is invite-only", and the suspended sentence with the REASON team', () => {
    const login = source('features/auth/LoginPage.tsx');
    expect(login).toMatch(/<img src="\/reason-logo\.png" alt="REASON" width=\{204\} height=\{44\} className="h-11 w-auto mx-auto mb-6" \/>/);
    expect(login).not.toContain('/rsn-logo.png');
    expect(login).toContain("REASON is invite-only. Apply and we&apos;ll review your request.");
    expect(login).toContain(`USER_SUSPENDED: '${SUSPENDED}'`);
    expect(source('features/auth/VerifyPage.tsx')).toContain(`message: '${SUSPENDED}'`);
  });

  it('the lockup is the file that was made for it: 1056x228, so 204x44 is its shape', () => {
    const file = fs.readFileSync(path.join(SRC, '../public/reason-logo.png'));
    const size = { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
    expect(size).toEqual({ width: 1056, height: 228 });
    expect(Math.abs(size.width / size.height / (204 / 44) - 1)).toBeLessThan(0.01);
  });

  it('invites: the platform is called REASON, in a pending invite, in the list of invite types and on the page that accepts one', () => {
    const invites = source('features/invites/InvitesPage.tsx');
    expect(invites).toContain("inv.podName || inv.sessionTitle || 'REASON';");
    expect(invites).toContain('<option value="platform">Platform Invite (new to REASON)</option>');
    expect(invites).not.toContain('someone new to REASON');
    expect(source('features/invites/InviteAcceptPage.tsx')).toContain("invite?.type === 'circle' ? 'a circle' : 'REASON';");
  });

  // A closed <select> cuts what does not fit, and the product's name is the end of this label. Measured in a browser (Inter 14px) in
  // the Invite Type select on a 360px phone: 242px of room for the text. "Platform Invite (new to REASON)" is 214.8px and shows whole
  // in Chromium and in WebKit; the longer "Platform Invite (someone new to REASON)" is 279.8px and showed as "...new to RE" in
  // Chromium and "...new to" in WebKit. Characters are a crude measure of width, but they stop the label growing back without a
  // layout test: no option may be longer than the 31 characters that were measured to fit.
  it('the invite type options are short enough to show whole on a 360px phone (none longer than the label measured to fit)', () => {
    const select = source('features/invites/InvitesPage.tsx').match(/<label[^>]*>Invite Type<\/label>\s*<select[\s\S]*?<\/select>/)?.[0] ?? '';
    const labels = [...select.matchAll(/<option value="[^"]+">([^<]+)<\/option>/g)].map((m) => m[1]);
    // The scan found the select and its options, so an empty match cannot pass for nothing.
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(labels).toContain('Platform Invite (new to REASON)');
    for (const label of labels) expect({ label, fits: label.length <= 31 }).toEqual({ label, fits: true });
  });

  // The product is written REASON in capitals, never "Reason" (a pod of the type "Reason" and the Reason field of a report
  // are something else, so this cannot be a scan: the places that name the product are pinned one by one).
  it('Find people: "Nobody on REASON matches" the words searched for', () => {
    expect(source('features/search/SearchPage.tsx')).toContain('Nobody on REASON matches “{term}”.');
  });

  it('plans: Settings and Billing offer "Get started with REASON basics" and "Unlock the full REASON experience"', () => {
    for (const page of ['features/settings/SettingsPage.tsx', 'features/billing/BillingPage.tsx']) {
      const plans = source(page);
      expect(plans).toContain("description: 'Get started with REASON basics',");
      expect(plans).toContain("description: 'Unlock the full REASON experience',");
    }
  });

  it('event setup, Matches, Meet and the admin email list: "anywhere on REASON", "Join the next event", "Connected on REASON", "invited to REASON"', () => {
    // The matching rule moved into the event forms' shared fields (C7, 26 Oct 2026), the words unchanged.
    expect(source('features/sessions/EventFormatFields.tsx')).toContain('If two people have ever met before anywhere on REASON, they will never be matched again.');
    expect(source('features/matches/MatchesPage.tsx')).toContain('<p className="font-medium text-gray-900">Join the next event</p>');
    expect(source('features/messages/MeetPage.tsx')).toContain('<p className="text-[11px] text-white/50">Connected on REASON</p>');
    expect(source('features/admin/AdminEmailPage.tsx')).toContain("description: 'Sent when a new user is invited to REASON' },");
  });

  it('Support: the card "How REASON works" and the two answers that named the product', () => {
    const support = source('features/support/SupportPage.tsx');
    expect(support).toContain('<h2 className="font-semibold text-[#1a1a2e]">How REASON works</h2>');
    expect(support).toContain("a: 'Invite others to REASON. Each accepted invite unlocks more pod slots.");
    expect(support).toContain("a: 'REASON has a strict no-selling policy.");
  });

  it('a calendar file is saved as reason-meeting.ics, from the thread and from the scheduler (lower case, so the scan above cannot see it)', () => {
    for (const page of ['features/messages/MessagesPage.tsx', 'features/messages/useSchedulerActions.ts']) {
      const downloads = source(page);
      expect(downloads).toContain("a.download = 'reason-meeting.ics';");
      expect(downloads).not.toContain('rsn-meeting.ics');
    }
  });
});

describe('the scan itself: a guard that cannot fail guards nothing', () => {
  const scan = (code: string) => rsnInReadableText('probe.tsx', code).map((hit) => hit.replace(/^line \d+: /, ''));

  it('finds RSN in JSX text, in an attribute, in plain strings, in every part of a template and in a string inside an expression', () => {
    expect(scan('const A = () => <p>Join RSN today</p>;')).toEqual(['Join RSN today']);
    expect(scan('const A = () => <img alt="RSN" />;')).toEqual(['RSN']);
    expect(scan("const a = 'the RSN team'; const b = \"RSN\";")).toEqual(['the RSN team', 'RSN']);
    expect(scan('const a = `RSN, ${x}`;')).toEqual(['RSN,']);
    expect(scan('const a = `${x} and ${y}, RSN`;')).toEqual([', RSN']);
    expect(scan('const a = `${x} RSN ${y}`;')).toEqual(['RSN']);
    expect(scan("const A = () => <p title={cond ? 'RSN' : 'other'} />;")).toEqual(['RSN']);
    expect(scan("const A = () => <p>{'Welcome to RSN'}</p>;")).toEqual(['Welcome to RSN']);
  });

  it('reports the line it is on', () => {
    expect(rsnInReadableText('probe.ts', "const a = 1;\nconst b = 2;\nconst c = 'RSN';\n")).toEqual(['line 3: RSN']);
  });

  it('leaves comments, identifiers, lower-case names, addresses and storage keys alone', () => {
    expect(scan('// the RSN logo\nconst a = 1;')).toEqual([]);
    expect(scan('/* RSN */ const a = 1; /** RSN */ function f() {}')).toEqual([]);
    expect(scan('const A = () => <div>{/* RSN logo */}</div>;')).toEqual([]);
    expect(scan('const HowRsnWorks = 1; const RSN_KEY = 2; function RSN() {}')).toEqual([]);
    expect(scan("const a = ['rsn-red', 'rsn_access', '@rsn/shared', 'https://app.rsn.network', 'support@rsn.network', 'rsn-meeting.ics'];")).toEqual([]);
    expect(scan('const A = () => <p className="text-rsn-red">REASON</p>;')).toEqual([]);
  });

  it('counts the word only whole and in capitals, the way the feedback wrote it', () => {
    expect(scan("const a = 'RSNs'; const b = 'Rsn'; const c = 'RSN_KEY'; const d = 'xRSN';")).toEqual([]);
    expect(scan("const a = \"RSN's\"; const b = 'RSN-CLIENT';")).toEqual(["RSN's", 'RSN-CLIENT']);
  });

  it('reads .ts as well as .tsx', () => {
    expect(rsnInReadableText('probe.ts', "export const label = 'Join RSN';")).toEqual(['line 1: Join RSN']);
  });
});
