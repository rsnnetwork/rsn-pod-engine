// server/src/__tests__/client/p3-reauth.test.ts
//
// "Confirm it's you" on screen (10 Nov 2026 spec, section 11; Part 3 Task 7, the screens for Task 2). Before a member
// changes their sign-in email or closes their account, and before an admin grants or removes an admin role, a code goes
// to their current address; the code typed gives a short proof (a reauth token) that the change carries in its JSON body.
//
// The pure rules run here (which routes, the proof in the body, when the dialog opens and the change is sent again, the
// words); the dialogs are run with loadClientModule where what they draw first matters (the close flow asks before any
// code, every button is 44px); the wiring is pinned by source, as its neighbours in this folder do. The headed walk is
// e2e/tests/p3-reauth-settings.spec.ts.

import * as path from 'path';
import * as fs from 'fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { touchesAdminRole } from '@rsn/shared';
import {
  FRESH_CODE, FRESH_EMAIL_CODE, REAUTH_API, REAUTH_WORDS, ReauthCancelled, askSentence, codeFailure, emailChangedToast,
  isReauthCancelled, newEmailCodeSentence, proofSpentBy, reauthScopeRequired, requestFailure, sendWithReauth, sentSentence,
  withProof,
} from '../../../../client/src/features/settings/reauth';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const read = readClientSource;
const SERVER = path.join(__dirname, '../..');
const readServer = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');

const DIALOGS = [
  'features/settings/ReauthDialog.tsx',
  'features/settings/ChangeEmailDialog.tsx',
  'features/settings/CloseAccountDialog.tsx',
];
const NEW_FILES = [...DIALOGS, 'features/settings/useReauth.ts', 'features/settings/reauth.ts'];
const TOUCHED = [...NEW_FILES, 'features/settings/SettingsPage.tsx', 'features/admin/AdminUsersPage.tsx', 'features/admin/users/UsersBulkBar.tsx'];

/** A refused request as axios hands it over. */
const refused = (status: number, error: Record<string, unknown>) => ({ response: { status, data: { success: false, error } } });
const REAUTH_REQUIRED = (scope: string) => refused(403, {
  code: 'REAUTH_REQUIRED', message: "Confirm it's you first. We'll email you a code.", details: { scope },
});

// ─── The routes ───────────────────────────────────────────────────────────────

describe('the dialogs call only the Task 2 routes', () => {
  it('names exactly the five routes, and the server serves each of them', () => {
    expect(REAUTH_API).toEqual({
      code: '/auth/reauth/code',
      verify: '/auth/reauth/verify',
      emailCode: '/users/me/email/code',
      emailVerify: '/users/me/email/verify',
      close: '/users/me/close',
    });
    const auth = readServer('routes/auth.ts');
    expect(auth).toContain("'/reauth/code',");
    expect(auth).toContain("'/reauth/verify',");
    const account = readServer('routes/account-security.ts');
    for (const route of ["'/email/code',", "'/email/verify',", "'/close',"]) expect(account).toContain(route);
    expect(readServer('index.ts')).toContain("app.use('/api/users/me', accountSecurityRoutes);");
  });

  it('every request the three dialogs make goes to one of those routes, by name', () => {
    for (const file of NEW_FILES) {
      const calls = [...read(file).matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*([^,)]+)/g)];
      for (const [, , target] of calls) expect(`${file}: ${target.trim()}`).toMatch(/: REAUTH_API\.(code|verify|emailCode|emailVerify|close)$/);
    }
    expect(read('features/settings/ReauthDialog.tsx')).toContain('api.post(REAUTH_API.code, { scope })');
    expect(read('features/settings/ReauthDialog.tsx')).toContain('api.post(REAUTH_API.verify, { scope, code })');
    expect(read('features/settings/ChangeEmailDialog.tsx')).toContain('api.post(REAUTH_API.emailVerify, { code })');
  });
});

// ─── The proof in the body ────────────────────────────────────────────────────

describe('the reauth token travels in the JSON body', () => {
  it('withProof adds reauthToken to the body when there is one, and nothing when there is none', () => {
    expect(withProof({ role: 'admin' }, 'tok')).toEqual({ role: 'admin', reauthToken: 'tok' });
    expect(withProof({ role: 'host' }, undefined)).toEqual({ role: 'host' });
    expect(withProof({}, null)).toEqual({});
  });

  it('each change puts its proof in its body, never in a header', () => {
    expect(read('features/settings/ChangeEmailDialog.tsx')).toContain('api.post(REAUTH_API.emailCode, withProof({ newEmail }, reauthToken))');
    expect(read('features/settings/CloseAccountDialog.tsx')).toContain('api.post(REAUTH_API.close, withProof({}, reauthToken))');
    expect(read('features/admin/AdminUsersPage.tsx')).toContain('api.put(`/users/${target.id}/role`, withProof({ role }, reauthToken))');
    expect(read('features/admin/users/UsersBulkBar.tsx'))
      .toContain("api.post('/admin/users/bulk-action', withProof({ userIds: selected, action, value: role }, reauthToken))");
    for (const file of TOUCHED) {
      expect(read(file)).not.toMatch(/headers\s*:/);
      expect(read(file)).not.toMatch(/x-reauth/i);
    }
  });
});

// ─── When the dialog opens, and the change is sent again ─────────────────────

describe('sendWithReauth', () => {
  it('asks first when the change is known to need a proof, and sends the change once, with it', async () => {
    const order: string[] = [];
    const result = await sendWithReauth({
      scope: 'admin_role',
      askFirst: true,
      ask: async (scope) => { order.push(`ask ${scope}`); return 'proof-1'; },
      send: async (token) => { order.push(`send ${token}`); return 'done'; },
    });
    expect(result).toBe('done');
    expect(order).toEqual(['ask admin_role', 'send proof-1']);
  });

  it('opens the dialog when the server answers REAUTH_REQUIRED for this scope, then sends the change again with the token', async () => {
    const sent: Array<string | undefined> = [];
    const asked: string[] = [];
    const result = await sendWithReauth({
      scope: 'admin_role',
      askFirst: false,
      ask: async (scope) => { asked.push(scope); return 'proof-2'; },
      send: async (token) => {
        sent.push(token);
        if (!token) throw REAUTH_REQUIRED('admin_role');
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(asked).toEqual(['admin_role']);
    expect(sent).toEqual([undefined, 'proof-2']);
  });

  it('a closed dialog sends nothing more and throws ReauthCancelled, which the screens say nothing about', async () => {
    let sends = 0;
    const err = await sendWithReauth({
      scope: 'admin_role', askFirst: true, ask: async () => null, send: async () => { sends += 1; },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthCancelled);
    expect(isReauthCancelled(err)).toBe(true);
    expect(sends).toBe(0);
    expect(read('features/admin/AdminUsersPage.tsx')).toContain("onError: (err) => { if (!isReauthCancelled(err)) addToast(failureText(err), 'error'); },");
    expect(read('features/admin/users/UsersBulkBar.tsx')).toContain("onError: (err) => { if (!isReauthCancelled(err)) addToast(failureText(err), 'error'); },");
  });

  it('any other refusal, or a proof of another kind asked for, is thrown as it is, without a dialog', async () => {
    for (const failure of [refused(403, { code: 'FORBIDDEN', message: 'Only a super admin can grant or remove an admin role.' }), REAUTH_REQUIRED('close_account')]) {
      let asked = 0;
      const err = await sendWithReauth({
        scope: 'admin_role', askFirst: false, ask: async () => { asked += 1; return 'x'; }, send: async () => { throw failure; },
      }).catch((e: unknown) => e);
      expect(err).toBe(failure);
      expect(asked).toBe(0);
    }
  });

  it('sends again only once: a second REAUTH_REQUIRED is the answer', async () => {
    let sends = 0;
    const err = await sendWithReauth({
      scope: 'admin_role', askFirst: false, ask: async () => 'p', send: async () => { sends += 1; throw REAUTH_REQUIRED('admin_role'); },
    }).catch((e: unknown) => e);
    expect(reauthScopeRequired(err)).toBe('admin_role');
    expect(sends).toBe(2);
  });

  it('reads the scope from error.details.scope (the ApiError shape), and nothing else', () => {
    expect(reauthScopeRequired(REAUTH_REQUIRED('change_email'))).toBe('change_email');
    expect(reauthScopeRequired(refused(403, { code: 'REAUTH_REQUIRED', scope: 'admin_role' }))).toBeNull();
    expect(reauthScopeRequired(REAUTH_REQUIRED('everything'))).toBeNull();
    expect(reauthScopeRequired(refused(403, { code: 'FORBIDDEN' }))).toBeNull();
    expect(reauthScopeRequired(new Error('Network Error'))).toBeNull();
  });
});

describe('the admin role path opens ReauthDialog', () => {
  it('a change to or from admin or super_admin is known to need the proof; one between member tiers is not', () => {
    expect(touchesAdminRole(['member'], 'admin')).toBe(true);
    expect(touchesAdminRole(['admin'], 'member')).toBe(true);
    expect(touchesAdminRole(['member'], 'host')).toBe(false);
  });

  it('the row menu asks first for an admin role change, and on REAUTH_REQUIRED, and draws the dialog', () => {
    const page = read('features/admin/AdminUsersPage.tsx');
    expect(page).toContain("reauth.withReauth('admin_role', touchesAdminRole([target.role], role), (reauthToken) =>");
    expect(page).toContain('const reauth = useReauth();');
    expect(page).toContain('<ReauthDialog {...reauth.dialog} />');
    // The hook runs before the admin check returns, as every hook on the page does.
    expect(page.indexOf('const reauth = useReauth();')).toBeLessThan(page.indexOf('if (!admin) {'));
  });

  it('the bulk bar asks first for a change to an admin role, and on REAUTH_REQUIRED (an admin among those selected)', () => {
    const bar = read('features/admin/users/UsersBulkBar.tsx');
    expect(bar).toContain("reauth.withReauth('admin_role', action === 'change_role' && touchesAdminRole([], role), (reauthToken) =>");
    expect(bar).toContain('<ReauthDialog {...reauth.dialog} />');
  });

  it('useReauth hands the dialog its answer through sendWithReauth', () => {
    const hook = read('features/settings/useReauth.ts');
    expect(hook).toContain('sendWithReauth({ scope: wanted, askFirst, ask, send })');
    expect(hook).toContain('onConfirmed: (token) => settle(token),');
    expect(hook).toContain('onCancel: () => settle(null),');
  });
});

// ─── The dialogs, drawn ───────────────────────────────────────────────────────

/** A sheet drawn in place (the real one portals to <body>, which a static render has not got). */
const sheetStandIn = ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) =>
  createElement('section', { 'data-sheet': title }, createElement('h2', null, title), children, footer);

function standIns(calls: string[]) {
  const record = (url: string) => { calls.push(url); return Promise.resolve({ data: { data: {} } }); };
  const member = { user: { id: 'm1', email: 'ana@example.com', accountKind: 'member' }, logout: async () => undefined, setTokensAndLoad: async () => undefined };
  return {
    '@/lib/api': { __esModule: true, default: { post: record, put: record, get: record, delete: record } },
    '@/features/reason/ui/Sheet': { __esModule: true, default: sheetStandIn },
    '@/stores/authStore': { useAuthStore: (pick: (s: unknown) => unknown) => pick(member) },
    '@/stores/toastStore': { useToastStore: (pick: (s: unknown) => unknown) => pick({ addToast: () => undefined }) },
    '@tanstack/react-query': { useMutation: () => ({ isPending: false, isError: false, mutate: () => undefined, error: null }) },
    'react-router-dom': { useNavigate: () => () => undefined },
    'lucide-react': iconStandIns,
    '@/features/auth/SignInCodeEntry': { __esModule: true, default: () => createElement('div', { 'data-code-entry': '' }) },
  };
}

/** Every <button> in the markup, with its class. */
const buttonsOf = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);

describe('ReauthDialog', () => {
  it('says where the code goes and offers "Send code" first; the code field comes only after', () => {
    const calls: string[] = [];
    const mod = loadClientModule('features/settings/ReauthDialog.tsx', standIns(calls));
    const html = renderToStaticMarkup(createElement(mod.default as never, { open: true, scope: 'close_account', onConfirmed: () => undefined, onCancel: () => undefined }));
    expect(html).toContain('data-sheet="Confirm it&#x27;s you"');
    expect(html).toContain('To keep your account safe we&#x27;ll send a code to ana@example.com.');
    expect(html).toContain('>Send code</button>');
    expect(html).not.toContain('data-code-entry');
    expect(calls).toEqual([]);
    const buttons = buttonsOf(html);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) expect(b).toContain('min-h-[44px]');
  });

  it('draws nothing while closed', () => {
    const mod = loadClientModule('features/settings/ReauthDialog.tsx', standIns([]));
    expect(renderToStaticMarkup(createElement(mod.default as never, { open: false, scope: 'admin_role', onConfirmed: () => undefined, onCancel: () => undefined }))).toBe('');
  });

  it('checks the code through SignInCodeEntry\'s verify prop and hands the token to the change that asked', () => {
    const dialog = read('features/settings/ReauthDialog.tsx');
    expect(dialog).toContain("import SignInCodeEntry from '@/features/auth/SignInCodeEntry';");
    expect(dialog).toContain('verify={verify}');
    expect(dialog).toContain('token.current = data.data.reauthToken as string;');
    expect(dialog).toContain('onSignedIn={() => { if (token.current) onConfirmed(token.current); }}');
  });
});

describe('CloseAccountDialog', () => {
  it('asks "Close your account?" first, destructive, and asks for no code until the member says yes', () => {
    const calls: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const mod = loadClientModule('features/settings/CloseAccountDialog.tsx', {
      ...standIns(calls),
      '@/components/ui/ConfirmDialog': {
        __esModule: true,
        default: (props: Record<string, unknown>) => {
          seen.push(props);
          return createElement('div', { 'data-confirm': props.tone }, `${props.title} ${props.body} ${props.confirmLabel}`);
        },
      },
      './ReauthDialog': { __esModule: true, default: () => createElement('div', { 'data-reauth': '' }) },
    });
    const html = renderToStaticMarkup(createElement(mod.default as never, { open: true, onClose: () => undefined }));
    expect(html).toContain("Close your account? You&#x27;ll be signed out everywhere and removed from your pods and events. To come back you&#x27;ll need to apply again. Close my account");
    expect(html).toContain('data-confirm="danger"');
    expect(html).not.toContain('data-reauth');
    expect(calls).toEqual([]);
    expect(seen[0]).toMatchObject({ title: 'Close your account?', confirmLabel: 'Close my account', tone: 'danger' });
  });

  it('reaches "Confirm it\'s you" only from the yes, closes with the proof, then signs out to /', () => {
    const flow = read('features/settings/CloseAccountDialog.tsx');
    expect(flow).toContain("const [step, setStep] = useState<Step>('ask');");
    expect(flow).toContain("onConfirm={() => setStep('reauth')}");
    expect(flow).toContain('scope="close_account"');
    const success = flow.slice(flow.indexOf('onSuccess: async () => {'), flow.indexOf('onError:'));
    expect(success.indexOf('await logout();')).toBeGreaterThan(-1);
    expect(success.indexOf("navigate('/', { replace: true });")).toBeGreaterThan(success.indexOf('await logout();'));
  });
});

describe('ChangeEmailDialog', () => {
  it('starts with "Confirm it\'s you" for change_email, before any address is asked', () => {
    const scopes: unknown[] = [];
    const mod = loadClientModule('features/settings/ChangeEmailDialog.tsx', {
      ...standIns([]),
      './ReauthDialog': {
        __esModule: true,
        DIALOG_BUTTON: 'min-h-[44px]',
        default: (props: { scope: string }) => { scopes.push(props.scope); return createElement('div', { 'data-reauth': props.scope }); },
      },
      'react-hook-form': {
        useForm: () => ({ formState: { errors: {} }, register: () => ({}), handleSubmit: () => () => undefined, setError: () => undefined }),
      },
    });
    const html = renderToStaticMarkup(createElement(mod.default as never, { open: true, onClose: () => undefined }));
    expect(html).toBe('<div data-reauth="change_email"></div>');
    expect(scopes).toEqual(['change_email']);
  });

  it('asks for the new address with react-hook-form and Zod, sends its code, and installs the new token pair through the auth store', () => {
    const flow = read('features/settings/ChangeEmailDialog.tsx');
    expect(flow).toContain('useForm<NewEmail>({ resolver: formResolver(newEmailSchema)');
    expect(flow).toContain('{REAUTH_WORDS.newEmailLabel}');
    expect(flow).toContain('{newEmailCodeSentence(sentTo)}');
    expect(flow).toContain('await setTokensAndLoad(data.data.accessToken as string, data.data.refreshToken as string);');
    expect(flow).toContain("addToast(emailChangedToast(sentTo), 'success')");
    // The store's install path is the one every sign-in uses: one atomic write of the pair, then the session read again.
    const store = read('stores/authStore.ts');
    const from = store.indexOf('setTokensAndLoad: async');
    const install = store.slice(from, store.indexOf('adoptStoredTokens: () =>', from));
    expect(from).toBeGreaterThan(-1);
    expect(install).toContain('installTokens(accessToken, refreshToken);');
    expect(install).toContain('await get().checkSession();');
  });

  it('a refused address that spent the proof asks for a new one; REAUTH_REQUIRED goes back to the confirm step', () => {
    expect(proofSpentBy(refused(409, { code: 'EMAIL_IN_USE', message: 'That email is already used by another account.' }))).toBe(true);
    expect(proofSpentBy(refused(400, { code: 'INVALID_INPUT', message: "That's already your email." }))).toBe(true);
    expect(proofSpentBy(refused(400, { code: 'VALIDATION_ERROR', message: 'Enter a valid email address.' }))).toBe(false);
    expect(proofSpentBy(refused(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes asked for.' }))).toBe(false);
    expect(proofSpentBy(new Error('Network Error'))).toBe(false);
    const flow = read('features/settings/ChangeEmailDialog.tsx');
    expect(flow).toContain("if (reauthScopeRequired(err)) {\n        setProof(null);\n        setWaiting(newEmail);\n        setStep('reauth');");
    expect(flow).toContain("form.setError('newEmail', { message: requestFailure(err) });");
  });
});

// ─── Settings > Account ───────────────────────────────────────────────────────

describe('the Account card', () => {
  const page = read('features/settings/SettingsPage.tsx');
  const card = page.slice(page.indexOf('function AccountCard()'), page.indexOf('export default function SettingsPage()'));

  it('offers Change email and Close account to members only, never to an event guest', () => {
    expect(card).toContain('const member = !!user && !isEventGuest(user);');
    expect(card).toMatch(/\{member && \(\s*<button[\s\S]*?\{REAUTH_WORDS\.changeEmail\}/);
    expect(card).toMatch(/\{member && \(\s*<div[\s\S]*?\{REAUTH_WORDS\.closeAccount\}[\s\S]*?\{REAUTH_WORDS\.closeAccount\}/);
    expect(card).toContain("<ChangeEmailDialog open={open === 'email'} onClose={() => setOpen(null)} />");
    expect(card).toContain("<CloseAccountDialog open={open === 'close'} onClose={() => setOpen(null)} />");
  });

  it('shows the session\'s address, which follows the change without a reload', () => {
    expect(card).toContain('data-testid="settings-account-email">{user?.email}</p>');
    expect(card).toContain('const user = useAuthStore((s) => s.user);');
  });

  it('its buttons are 44px', () => {
    expect(page).toMatch(/const ACCOUNT_BUTTON = '[^']*min-h-\[44px\]/);
    const buttons = card.split('<button').slice(1);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.slice(0, b.indexOf('</button>'))).toContain('ACCOUNT_BUTTON');
  });
});

// ─── Across the new screens ───────────────────────────────────────────────────

describe('every new dialog', () => {
  it('never writes the query cache by hand', () => {
    for (const file of TOUCHED) expect(read(file)).not.toContain('setQueryData');
  });

  it('has 44px buttons', () => {
    expect(read('features/settings/ReauthDialog.tsx')).toMatch(/export const DIALOG_BUTTON = '[^']*min-h-\[44px\]/);
    for (const file of DIALOGS) {
      for (const chunk of read(file).split('<button').slice(1)) {
        const button = chunk.slice(0, chunk.indexOf('</button>'));
        expect(`${file}: ${/min-h-\[44px\]|DIALOG_BUTTON/.test(button)}`).toBe(`${file}: true`);
      }
    }
  });

  it('is drawn in a sheet that portals to <body> and keeps focus inside, or in ConfirmDialog, which is one', () => {
    const sheet = read('features/reason/ui/Sheet.tsx');
    expect(sheet).toContain('document.body,');
    expect(sheet).toContain('createPortal(');
    expect(sheet).toContain("if (e.key !== 'Tab') return;");
    expect(read('components/ui/ConfirmDialog.tsx')).toContain("import Sheet from '@/features/reason/ui/Sheet';");
    for (const file of DIALOGS) expect(read(file)).toMatch(/import (Sheet|ConfirmDialog|ReauthDialog)\b/);
    expect(read('features/settings/ReauthDialog.tsx')).toContain("import Sheet from '@/features/reason/ui/Sheet';");
    expect(read('features/settings/ChangeEmailDialog.tsx')).toContain("import Sheet from '@/features/reason/ui/Sheet';");
  });
});

// ─── The words ────────────────────────────────────────────────────────────────

describe('the words', () => {
  it('are the brief\'s, word for word', () => {
    expect(REAUTH_WORDS.title).toBe("Confirm it's you");
    expect(askSentence('ana@example.com')).toBe("To keep your account safe we'll send a code to ana@example.com.");
    expect(REAUTH_WORDS.send).toBe('Send code');
    expect(REAUTH_WORDS.newEmailLabel).toBe('New email address');
    expect(newEmailCodeSentence('new@example.com')).toBe('We sent a code to new@example.com. Type it to finish.');
    expect(emailChangedToast('new@example.com')).toBe('Your sign-in email is now new@example.com.');
    expect(REAUTH_WORDS.closeTitle).toBe('Close your account?');
    expect(REAUTH_WORDS.closeBody).toBe("You'll be signed out everywhere and removed from your pods and events. To come back you'll need to apply again.");
    expect(REAUTH_WORDS.closeConfirm).toBe('Close my account');
    expect(sentSentence('ana@example.com')).toBe("We sent a code to ana@example.com. Type it to confirm it's you.");
  });

  it('a refused code says why and how to get a new one, never a code or "Network Error"', () => {
    expect(codeFailure(refused(400, { code: 'AUTH_SIGN_IN_CODE_WRONG', details: { attemptsLeft: 1 } }), FRESH_CODE)).toBe('That code is not right. You can try 1 more time.');
    expect(codeFailure(refused(400, { code: 'AUTH_SIGN_IN_LOCKED' }), FRESH_CODE)).toBe('That code was entered wrongly too many times, so it no longer works. Send a new code.');
    expect(codeFailure(refused(400, { code: 'AUTH_SIGN_IN_CODE_EXPIRED' }), FRESH_EMAIL_CODE)).toBe('This code has expired. Choose "Use a different email" to start again.');
    expect(codeFailure(refused(409, { code: 'EMAIL_IN_USE' }), FRESH_EMAIL_CODE)).toBe('That email is already used by another account.');
    expect(codeFailure(new Error('Network Error'), FRESH_CODE)).toBe('Connection lost. Please check your connection and try again.');
    expect(codeFailure(refused(500, { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }), FRESH_CODE)).toBe('We could not check that code. Please try again.');
  });

  it('a refused request says the server\'s sentence, or a plain one for a 500 or no connection', () => {
    expect(requestFailure(refused(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many codes asked for. Please wait 15 minutes, then try again.' })))
      .toBe('Too many codes asked for. Please wait 15 minutes, then try again.');
    expect(requestFailure(refused(500, { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }))).toBe('That did not go through. Please try again.');
    expect(requestFailure(new Error('Network Error'))).toBe('Connection lost. Please check your connection and try again.');
  });

  it('say "event", never "session", on screen', () => {
    for (const file of NEW_FILES) {
      const text = read(file).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
      const strings = [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      for (const s of strings) if (/ /.test(s)) expect(s).not.toMatch(/\bsession\b/i);
    }
  });
});
