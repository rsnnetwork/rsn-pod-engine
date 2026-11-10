// ─── Part 2 Task 11 (10 Nov 2026 spec): the organiser's settings on the event page ──────────────────────────────────
// Lifecycle (draft/publish, cancel with notice, archive/restore, delete for good), the RSN Call link, admission (mode,
// allowed emails with CSV import, one-time codes), matching groups with per-round rules and the capacity notice, and
// the event's history. The pure modules are run here; the components are pinned by reading their source: which tags
// each query follows, that only the server's allowedActions render, that the destructive steps ask first, that the
// delete confirm waits for the typed name, the once-only sentence, 44px buttons and no fixed width over 360px.

import * as fs from 'fs';
import * as path from 'path';
import { GROUP_PRESETS, type EventGroupRules } from '@rsn/shared';
import {
  LIFECYCLE_COPY, cancelledSentence, shownActions, titleMatches,
} from '../../../../client/src/features/sessions/lifecycle/lifecycle-text';
import {
  ADMISSION_COPY, ADMISSION_EMAILS_PER_CALL, ADMISSION_MODE_LABELS, CSV_MAX_BYTES, addedSentence, codesCsv, codesFileName, codesText,
  csvHasTooManyRows, modeUsesLists, splitPastedEmails,
} from '../../../../client/src/features/sessions/admission/admission-text';
import {
  FALLBACK_OPTIONS, PRESET_OPTIONS, RULE_MODE_OPTIONS, capacityLines, droppedGroupsWithPeople, formIssues, formValuesOf,
  groupFormResolver, keyFromLabel, keyedGroups, messageAt, pairOptions, presetOf, presetValues, ruleLine, rulesOfForm,
} from '../../../../client/src/features/sessions/groups/group-form';
import { historyDetail, historySentence, type HistoryEntry } from '../../../../client/src/features/sessions/history/history-text';
import { notForThisViewer, organiserSentence } from '../../../../client/src/features/sessions/organiser-errors';
import { isEventLifecycleChip, lifecycleLabel } from '../../../../client/src/features/sessions/statusConfig';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const FILES = {
  lifecycle: 'features/sessions/lifecycle/EventLifecycleActions.tsx',
  useLifecycle: 'features/sessions/lifecycle/useEventLifecycle.ts',
  cancelDialog: 'features/sessions/lifecycle/CancelEventDialog.tsx',
  deleteDialog: 'features/sessions/lifecycle/DeleteEventDialog.tsx',
  callLinkCard: 'features/sessions/CallLinkCard.tsx',
  callLink: 'features/sessions/call-link.ts',
  admissionCard: 'features/sessions/admission/EventAdmissionCard.tsx',
  emailsPanel: 'features/sessions/admission/AdmissionEmailsPanel.tsx',
  emailList: 'features/sessions/admission/AdmissionEmailList.tsx',
  codesPanel: 'features/sessions/admission/AdmissionCodesPanel.tsx',
  codeList: 'features/sessions/admission/AdmissionCodeList.tsx',
  useAdmission: 'features/sessions/admission/useAdmission.ts',
  groupsCard: 'features/sessions/groups/EventGroupsCard.tsx',
  groupsSheet: 'features/sessions/groups/GroupsEditorSheet.tsx',
  rulesEditor: 'features/sessions/groups/RoundRulesEditor.tsx',
  capacity: 'features/sessions/groups/CapacityNotice.tsx',
  participantGroup: 'features/sessions/groups/ParticipantGroupControl.tsx',
  useGroups: 'features/sessions/groups/useEventGroups.ts',
  history: 'features/sessions/history/EventHistoryPanel.tsx',
  settings: 'features/sessions/OrganiserSettings.tsx',
  ui: 'features/sessions/organiser-ui.tsx',
} as const;
const src = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)])) as Record<keyof typeof FILES, string>;
const detail = read('features/sessions/SessionDetailPage.tsx');
const create = read('features/sessions/CreateSessionPage.tsx');
const statusConfig = read('features/sessions/statusConfig.ts');

/** The source of the first call `name(` … up to its matching close paren. */
function callAt(text: string, from: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', from); i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}
const queriesIn = (text: string) => [...text.matchAll(/use(?:Infinite)?Query(?:<[^(]*>)?\(\{/g)].map((m) => callAt(text, m.index!));

describe('every new query follows the tags the brief names', () => {
  it('lifecycle: the page\'s event query follows session:<id>, and every step refreshes it', () => {
    expect(detail).toMatch(/queryKey: \['session', sessionId\][\s\S]{0,400}meta: \{ entities: sessionId \? \[E\.session\(sessionId\)\] : \[\] \}/);
    expect(src.useLifecycle).toMatch(/qc\.invalidateQueries\(\{ queryKey: \['session', sessionId\] \}\)/);
  });

  it('admission: overview, emails and codes follow session:<id>:admission (and the participants, whose places move the counts)', () => {
    const queries = queriesIn(src.useAdmission);
    expect(queries).toHaveLength(3);
    expect(src.useAdmission).toMatch(/const admissionEntities = \(sessionId: string\) => \[E\.sessionAdmission\(sessionId\), E\.sessionParticipants\(sessionId\)\];/);
    for (const q of queries) expect(q).toMatch(/meta: \{ entities: admissionEntities\(sessionId\) \}/);
  });

  it('groups follow session:<id>:groups; history session:<id>:audit; the call link session:<id>', () => {
    const [groups] = queriesIn(src.useGroups);
    expect(groups).toMatch(/meta: \{ entities: \[E\.sessionGroups\(sessionId\), E\.sessionParticipants\(sessionId\)\] \}/);
    const [history] = queriesIn(src.history);
    expect(history).toMatch(/meta: \{ entities: \[E\.sessionAudit\(sessionId\)\] \}/);
    const [link] = queriesIn(src.callLink);
    // Task 6's rotate tells the organisers session:<id>:call-link and session:<id> (fanoutCallLink); the card follows both.
    expect(link).toMatch(/meta: \{ entities: \[E\.session\(sessionId\), E\.sessionCallLink\(sessionId\)\] \}/);
  });

  it('no other file of the section reads the server without a tag', () => {
    for (const [name, text] of Object.entries(src)) {
      for (const q of queriesIn(text)) expect({ name, ok: /meta: \{ entities: / .test(q) }).toEqual({ name, ok: true });
    }
  });
});

describe('lifecycle: only the server\'s allowedActions render, the destructive ones ask first', () => {
  it('shownActions keeps the server\'s steps, in a fixed order, and drops what it does not know', () => {
    expect(shownActions(['delete_permanently', 'cancel', 'publish'])).toEqual(['publish', 'cancel', 'delete_permanently']);
    expect(shownActions(['unarchive', 'drop_tables', 42])).toEqual(['unarchive']);
    expect(shownActions(undefined)).toEqual([]);
    expect(shownActions([])).toEqual([]);
  });

  it('the component maps exactly shownActions(allowedActions), never its own rule', () => {
    expect(src.lifecycle).toMatch(/const actions = shownActions\(allowedActions\);/);
    expect(src.lifecycle).toMatch(/\{actions\.map\(\(action\) =>/);
    expect(src.lifecycle).not.toMatch(/allowedLifecycleActions|eventAllowedActions\(|isSuperAdmin|role ===/);
    expect(src.settings).toMatch(/allowedActions=\{event\.allowedActions\}/);
  });

  it('Cancel event and Delete permanently open their dialogs; the reversible steps act at once', () => {
    expect(src.lifecycle).toMatch(/if \(action === 'cancel' \|\| action === 'delete_permanently'\) \{\s*setAsking\(action\);\s*return;\s*\}/);
    expect(src.lifecycle).toMatch(/<CancelEventDialog\s+open=\{asking === 'cancel'\}/);
    expect(src.lifecycle).toMatch(/<DeleteEventDialog\s+open=\{asking === 'delete_permanently'\}/);
    // Both dialogs are Sheets, which portal to <body>.
    expect(src.cancelDialog).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(src.deleteDialog).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(read('features/reason/ui/Sheet.tsx')).toMatch(/createPortal\([\s\S]*document\.body/);
  });

  it('the copy is the brief\'s, word for word', () => {
    expect(LIFECYCLE_COPY).toMatchObject({
      publish: 'Publish', unpublish: 'Move back to draft', cancel: 'Cancel event', archive: 'Archive', unarchive: 'Restore',
      deletePermanently: 'Delete permanently', archivedInline: 'Archived.',
      cancelTitle: 'Cancel this event?', cancelBody: 'Everyone registered gets an email and a notification.',
      reasonLabel: 'Reason (they will see it)',
      deleteBody: "This permanently deletes the event and its meetings. Type the event's name to confirm.",
    });
    expect(['draft', 'published', 'registration_open', 'live', 'completed', 'archived', 'cancelled'].map((l) => lifecycleLabel(l as never)))
      .toEqual(['Draft', 'Published', 'Registration open', 'Live', 'Ended', 'Archived', 'Cancelled']);
    expect(isEventLifecycleChip('draft')).toBe(true);
    expect(isEventLifecycleChip('scheduled')).toBe(false);
    expect(statusConfig).toMatch(/import type \{ EventLifecycle \} from '@rsn\/shared';/);
  });

  it('archive has no dialog and reads "Archived." beside Restore', () => {
    expect(src.lifecycle).toMatch(/\{archived && actions\.includes\('unarchive'\) && \(/);
    expect(src.useLifecycle).toMatch(/case 'archive': return null;/);
    expect(src.useLifecycle).toMatch(/case 'unarchive': return api\.delete\(`\$\{base\}\/archive`\);/);
  });

  it('the delete confirm stays disabled until the typed name is the event\'s (trimmed, any case, as the server compares)', () => {
    expect(src.deleteDialog).toMatch(/const matches = titleMatches\(typed, title\);/);
    expect(src.deleteDialog).toMatch(/disabled=\{busy \|\| !matches\}/);
    expect(titleMatches('', 'Spring mixer')).toBe(false);
    expect(titleMatches('Spring', 'Spring mixer')).toBe(false);
    expect(titleMatches('  spring MIXER ', 'Spring mixer')).toBe(true);
    expect(titleMatches('   ', '   ')).toBe(false);
  });

  it('cancel sends the reason only when there is one; delete sends the typed name; the routes are Task 2\'s', () => {
    expect(src.useLifecycle).toMatch(/case 'cancel': return api\.post\(`\$\{base\}\/cancel`, step\.reason\?\.trim\(\) \? \{ reason: step\.reason\.trim\(\) \} : \{\}\);/);
    expect(src.useLifecycle).toMatch(/case 'delete_permanently': return api\.post\(`\$\{base\}\/delete-permanently`, \{ confirmTitle: step\.confirmTitle \?\? '' \}\);/);
    expect(src.useLifecycle).toMatch(/navigate\('\/sessions'\)/);
    expect(cancelledSentence(0)).toBe('Event cancelled.');
    expect(cancelledSentence(1)).toBe('Event cancelled. 1 person was told.');
    expect(cancelledSentence(12)).toBe('Event cancelled. 12 people were told.');
  });
});

describe('the event page', () => {
  it('no longer offers the legacy soft delete (DELETE /sessions/:id); the organiser section and history are there', () => {
    expect(detail).not.toMatch(/api\.delete\(`\/sessions\/\$\{sessionId\}`\)/);
    expect(detail).not.toMatch(/deleteMutation/);
    expect(detail).toMatch(/<OrganiserSettings/);
    expect(detail).toMatch(/\{mayRunEvent && sessionId && <EventHistoryPanel sessionId=\{sessionId\} \/>\}/);
  });

  it('a draft takes no invites, no Go Live and no calendar entry', () => {
    expect(detail).toMatch(/const isDraft = session\?\.lifecycle === 'draft';/);
    expect(detail).toMatch(/&& \(phase === 'pre' \|\| phase === 'live'\) && !isDraft;/);
    expect(detail).toMatch(/sessionStatusPhase\(session\.status\) === 'pre' && !isDraft && \(/);
    expect(detail).toMatch(/session\.status === 'scheduled' && session\.scheduledAt && !isDraft && \(/);
  });

  it('the participant list shows each person\'s group, with Change group before the event', () => {
    expect(detail).toMatch(/<ParticipantGroupControl/);
    expect(detail).toMatch(/mine=\{groupsData\.members\[p\.userId\] \?\? \[\]\}/);
    expect(detail).toMatch(/canChange=\{phase === 'pre' && !isCohostOrHost\(p\)\}/);
    expect(src.participantGroup).toMatch(/api|useSetParticipantGroups/);
    expect(read('features/sessions/groups/useEventGroups.ts')).toMatch(/api\.put\(`\/sessions\/\$\{sessionId\}\/participants\/\$\{userId\}\/groups`, \{ groupKeys \}\)/);
  });

  it('Save as draft sends publication \'draft\'; Schedule Event sends the body it always did', () => {
    expect(create).toMatch(/const saveDraft = ev\.onSubmit\(\(values\) => create\.mutate\(\{ \.\.\.eventBody\(values, \{ isAdmin \}\), visibility, \.\.\.\(circle \? \{ circleId: circle\.id \} : \{\}\), publication: 'draft' \}\)\);/);
    expect(create).toMatch(/const submit = ev\.onSubmit\(\(values\) => create\.mutate\(\{ \.\.\.eventBody\(values, \{ isAdmin \}\), visibility, \.\.\.\(circle \? \{ circleId: circle\.id \} : \{\}\) \}\)\);/);
    expect(create).toMatch(/>\s*Save as draft\s*</);
    // A draft opens on its page without the invite sheet (it takes no invites); a scheduled event as before.
    expect(create).toMatch(/if \(draft\) return navigate\(`\/sessions\/\$\{id\}`\);\s*navigate\(`\/sessions\/\$\{id\}\?invite=1`\);/);
    expect(create).toContain("const DRAFT_SAVED = 'Draft saved. Only the people running it can see it until you publish it.';");
  });
});

describe('the RSN Call link', () => {
  it('reads Task 6\'s organiser routes through one module, and draws nothing for anyone they refuse', () => {
    expect(src.callLink).toMatch(/api\.get\(`\/sessions\/\$\{sessionId\}\/call-link`\)/);
    expect(src.callLink).toMatch(/api\.post\(`\/sessions\/\$\{sessionId\}\/call-link\/rotate`\)/);
    expect(src.callLinkCard).toMatch(/if \(link\.isError && notForThisViewer\(link\.error\)\) return null;/);
    expect(src.callLinkCard).not.toMatch(/api\./);
    // Controller ruling (11 Nov): always this site's origin and the shared callLinkPath (CALL_LINK_BASE_PATH), never the
    // server's url (built from CLIENT_URL, production's app, which has no call-link page until this client ships there).
    expect(src.callLink).toMatch(/import \{ callLinkPath \} from '@rsn\/shared';/);
    expect(src.callLink).toMatch(/return `\$\{origin\}\$\{callLinkPath\(link\.code\)\}`;/);
    expect(src.callLink).not.toMatch(/link\.url/);
    expect(src.callLinkCard).toMatch(/callLinkAddress\(link\.data, window\.location\.origin\)/);
  });

  it('matches Task 6\'s organiser route on main: { code, path, url } from the shared path, and rotate tells the organisers', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/session/call-link.service.ts'), 'utf8');
    expect(service).toMatch(/Promise<\{ code: string; path: string; url: string \}>/);
    expect(service).toMatch(/return \{ code, path: callLinkPath\(code\), url: `\$\{config\.clientUrl\}\$\{callLinkPath\(code\)\}` \};/);
    expect(service).toMatch(/emitEntities\(io, organisers, \[E\.sessionCallLink\(sessionId\), E\.session\(sessionId\)\]\)/);
    const routes = fs.readFileSync(path.join(__dirname, '../../routes/call-links.ts'), 'utf8');
    expect(routes).toMatch(/sessionCallLinkRoutes\.get\('\/:id\/call-link'/);
    expect(routes).toMatch(/sessionCallLinkRoutes\.post\('\/:id\/call-link\/rotate'/);
    expect(historySentence({
      id: '1', at: '', actor: { id: 'h', displayName: 'Ana' }, automatic: false, action: 'call_link.rotated',
      round: null, scheduleVersion: null, subjects: [], reason: null,
    })).toBe('Ana made a new RSN Call link');
  });

  it('says "RSN Call link", Copy link, and asks before Make a new link', () => {
    expect(src.callLinkCard).toContain("title: 'RSN Call link'");
    expect(src.callLinkCard).toContain("copy: 'Copy link'");
    expect(src.callLinkCard).toContain("rotate: 'Make a new link'");
    expect(src.callLinkCard).toContain("rotateBody: 'The old link stops working at once.'");
    expect(src.callLinkCard).toMatch(/if \(!\(await ask\(\{ title: CALL_LINK_COPY\.rotateTitle, body: CALL_LINK_COPY\.rotateBody/);
  });
});

describe('admission', () => {
  it('offers the three modes in the brief\'s words', () => {
    expect(ADMISSION_MODE_LABELS).toEqual({
      open: 'Open: anyone with the link',
      approval: 'Approval: you approve each person',
      restricted: 'Invitation only: allowed emails or admission codes',
    });
    expect(modeUsesLists('restricted')).toBe(true);
    expect(modeUsesLists('approval')).toBe(true);
    expect(modeUsesLists('open')).toBe(false);
    expect(modeUsesLists(null)).toBe(false);
    expect(src.admissionCard).toMatch(/api|useSetAdmissionMode/);
    expect(src.admissionCard).toMatch(/resolver: formResolver\(modeSchema\)/);
  });

  it('splits pasted addresses with string steps: commas, new lines, names around them, repeats counted', () => {
    expect(splitPastedEmails('a@x.com, b@x.com\nA@X.com')).toEqual({ emails: ['a@x.com', 'b@x.com'], repeats: 1 });
    expect(splitPastedEmails('Ana Lee <ana@example.com>; "ben@example.com"\t(cy@example.com)')).toEqual({
      emails: ['ana@example.com', 'ben@example.com', 'cy@example.com'], repeats: 0,
    });
    expect(splitPastedEmails('Ana<ana@example.com>')).toEqual({ emails: ['ana@example.com'], repeats: 0 });
    expect(splitPastedEmails('no addresses here')).toEqual({ emails: [], repeats: 0 });
    // Upload-sized text: a 256 KB paste is split in one pass, no regex over it.
    const big = Array.from({ length: 12_000 }, (_, i) => `person${i}@example.com`).join(',\n');
    expect(big.length).toBeGreaterThan(CSV_MAX_BYTES);
    expect(splitPastedEmails(big).emails).toHaveLength(12_000);
    const fn = read('features/sessions/admission/admission-text.ts');
    const body = fn.slice(fn.indexOf('export function splitPastedEmails'), fn.indexOf('const WRAPPERS'));
    expect(body).not.toMatch(/\.split\(\/|\.match\(|\.replace\(\/|new RegExp/);
  });

  it('says what an import did: "2 added, 1 already listed"', () => {
    expect(addedSentence({ added: 2, alreadyListed: 0, restored: 0, invalid: [] }, 1)).toBe('2 added, 1 already listed.');
    expect(addedSentence({ added: 0, alreadyListed: 3, restored: 1, invalid: [] })).toBe('0 added, 3 already listed, 1 back on the list.');
    expect(addedSentence({ added: 1, alreadyListed: 0, restored: 0, invalid: ['Row 4', 'nope', 'x@', 'y@'] }))
      .toBe('1 added. Not an email address: Row 4, nope, x@ and 1 more.');
  });

  it('reads a CSV with FileReader, 256 KB at most, and says so in the brief\'s words', () => {
    expect(CSV_MAX_BYTES).toBe(256 * 1024);
    expect(ADMISSION_COPY.csvTooBig).toBe('That file is too big. Split it into files under 256 KB.');
    expect(src.emailsPanel).toMatch(/if \(file\.size > CSV_MAX_BYTES\) return Promise\.reject\(new Error\(ADMISSION_COPY\.csvTooBig\)\);/);
    expect(src.emailsPanel).toMatch(/new FileReader\(\)/);
    expect(src.emailsPanel).toMatch(/add\.mutate\(\{ csv, source: 'csv' \}/);
    expect(src.emailsPanel).toMatch(/add\.mutate\(\{ emails, source: 'paste' \}/);
  });

  it('every list has loading, empty and error states, with the brief\'s empty sentence', () => {
    expect(ADMISSION_COPY.emailsEmpty).toBe('No allowed emails yet. Paste addresses or import a CSV.');
    for (const list of [src.emailList, src.codeList, src.history]) {
      expect(list).toMatch(/<LoadingRows /);
      expect(list).toMatch(/<ErrorRow /);
      expect(list).toMatch(/<EmptyRow /);
    }
    expect(src.groupsCard).toMatch(/<LoadingRows /);
    expect(src.groupsCard).toMatch(/<ErrorRow /);
    expect(src.groupsCard).toMatch(/<EmptyRow /);
  });

  it('shows freshly made codes once, with the once-only sentence, Download CSV and Copy all', () => {
    expect(ADMISSION_COPY.onceOnly).toBe('These codes are shown only now. Download or copy them before you leave.');
    expect(ADMISSION_COPY.downloadCsv).toBe('Download CSV');
    expect(ADMISSION_COPY.copyAll).toBe('Copy all');
    expect(src.codesPanel).toMatch(/\{made && \([\s\S]*\{ADMISSION_COPY\.onceOnly\}[\s\S]*\{ADMISSION_COPY\.downloadCsv\}[\s\S]*ADMISSION_COPY\.copyAll/);
    // The list never shows a code, only its last four symbols.
    expect(src.codeList).toMatch(/•••• •••• \{row\.last4\}/);
    expect(src.codeList).not.toMatch(/row\.code\b/);
  });

  it('builds the codes file and the clipboard text', () => {
    const codes = [{ id: '1', code: 'AAAA-BBBB-CCCC' }, { id: '2', code: 'DDDD-EEEE-FFFF' }];
    expect(codesCsv(codes, 'For "speakers", day 1')).toBe('code,label\nAAAA-BBBB-CCCC,"For ""speakers"", day 1"\nDDDD-EEEE-FFFF,"For ""speakers"", day 1"\n');
    expect(codesCsv(codes, null)).toBe('code,label\nAAAA-BBBB-CCCC,\nDDDD-EEEE-FFFF,\n');
    expect(codesText(codes)).toBe('AAAA-BBBB-CCCC\nDDDD-EEEE-FFFF');
    expect(codesFileName('Spring Mixer: Founders & Funders!')).toBe('spring-mixer-founders-funders-admission-codes.csv');
    expect(codesFileName('!!!')).toBe('event-admission-codes.csv');
  });

  it('removing an address and revoking a code ask first', () => {
    expect(src.emailList).toMatch(/if \(!\(await ask\(\{ title: ADMISSION_COPY\.removeTitle\(email\)/);
    expect(src.codeList).toMatch(/if \(!\(await ask\(\{ title: ADMISSION_COPY\.revokeTitle/);
  });
});

describe('matching groups', () => {
  const founders = (rounds = 3): EventGroupRules => ({ ...presetValues('founders_funders', rounds), groups: [...GROUP_PRESETS.founders_funders.groups] });

  it('offers the presets, the per-range rules and the fallback in the brief\'s words', () => {
    expect(PRESET_OPTIONS.map((p) => p.label)).toEqual(['Founders and funders', 'Teachers and pupils', 'Employers and candidates', 'Mentors and mentees', 'Custom']);
    expect(RULE_MODE_OPTIONS.map((o) => o.label)).toEqual(['Everyone can meet', 'Only different groups meet', 'Choose pairs']);
    expect(FALLBACK_OPTIONS.map((o) => o.label)).toEqual(['Leave people unmatched', 'Let them meet their own group']);
    expect(src.rulesEditor).toContain('{GROUPS_COPY.fallbackLegend}');
    expect(read('features/sessions/groups/group-form.ts')).toContain("fallbackLegend: 'When groups are uneven:'");
    expect(src.groupsCard).toMatch(/testId="event-groups-card"\s+title=\{GROUPS_COPY\.title\}/);
    expect(read('features/sessions/groups/group-form.ts')).toContain("title: 'Matching groups'");
  });

  it('a preset gives its groups and every round across groups; saved rules read back as their preset', () => {
    const v = presetValues('founders_funders', 5);
    expect(v.groups).toEqual([{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }]);
    expect(v.rounds).toEqual([{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }]);
    expect(presetOf(rulesOfForm(v))).toBe('founders_funders');
    expect(presetOf({ groups: [{ key: 'a', label: 'A' }] })).toBe('custom');
    expect(formValuesOf(null, 4).preset).toBe('founders_funders');
    expect(formValuesOf(rulesOfForm(presetValues('mentors_mentees', 4)), 4).preset).toBe('mentors_mentees');
  });

  it('a new group is keyed from its name, never clashing; a saved group keeps its key when renamed', () => {
    expect(keyFromLabel('Senior Engineers!', new Set())).toBe('senior_engineers');
    expect(keyFromLabel('Founders', new Set(['founders']))).toBe('founders_2');
    expect(keyFromLabel('***', new Set())).toBe('group');
    expect(keyedGroups([{ key: 'founder', label: 'Builders ' }, { key: '', label: 'Angels' }, { key: '', label: 'Angels' }]))
      .toEqual([{ key: 'founder', label: 'Builders' }, { key: 'angels', label: 'Angels' }, { key: 'angels_2', label: 'Angels' }]);
  });

  it('checks the form with the shared validator, each problem at its own field', async () => {
    const values = { ...presetValues('custom', 3), groups: [{ key: '', label: 'Hosts' }, { key: '', label: '' }] };
    values.rounds = [
      { fromRound: 1, toRound: 2, mode: 'custom', allowedPairs: [] },
      { fromRound: 2, toRound: 3, mode: 'open', allowedPairs: [] },
    ];
    const issues = formIssues(values, 3);
    expect(issues['groups.1.label']).toMatch(/Give the group a name/);
    expect(issues['rounds.0.allowedPairs']).toBe('Choose at least one pair of groups who may meet.');
    expect(issues['rounds.1']).toBe('Rounds 2 to 3 overlap rounds 1 to 2.');
    const result = await groupFormResolver(3)(values, undefined, { fields: {}, shouldUseNativeValidation: false } as never);
    expect(messageAt(result.errors, 'groups.1.label')).toMatch(/Give the group a name/);
    expect(messageAt(result.errors, 'rounds.0.allowedPairs')).toBe('Choose at least one pair of groups who may meet.');
    expect(messageAt(result.errors, 'rounds.1')).toBe('Rounds 2 to 3 overlap rounds 1 to 2.');
    const fine = await groupFormResolver(3)(presetValues('founders_funders', 3), undefined, { fields: {}, shouldUseNativeValidation: false } as never);
    expect(fine.errors).toEqual({});
  });

  it('pairs name every two groups and each with itself; custom rules keep only pairs of groups still there', () => {
    const groups = [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }];
    expect(pairOptions(groups)).toEqual([
      { key: 'founder|founder', label: 'Founders with each other' },
      { key: 'founder|funder', label: 'Founders with Funders' },
      { key: 'funder|funder', label: 'Funders with each other' },
    ]);
    const rules = rulesOfForm({ ...presetValues('founders_funders', 3), rounds: [{ fromRound: 1, toRound: 3, mode: 'custom', allowedPairs: ['founder|funder', 'mentor|funder'] }] });
    expect(rules.rounds[0].allowedPairs).toEqual(['founder|funder']);
    expect(ruleLine(rules.rounds[0], groups)).toBe('Rounds 1 to 3: Founders with Funders');
    expect(ruleLine({ fromRound: 2, toRound: 2, mode: 'open', allowedPairs: [] }, groups)).toBe('Round 2: Everyone can meet');
  });

  it('the capacity notice says the shared sentence: 5 founders and 2 funders over rounds 1 to 3', () => {
    const rules = { ...founders(3), rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group' as const, allowedPairs: [] }] };
    const lines = capacityLines(rules, { founder: 5, funder: 2 }, 0, 3);
    expect(lines).toHaveLength(1);
    expect(lines[0].rounds).toBe('Rounds 1 to 3');
    expect(lines[0].sentence).toMatch(/^In each round at most 2 founder and funder meetings are possible, so 3 founders wait\./);
  });

  it('25 founders and 8 funders: 17 wait; an open round says nothing; even groups say nothing', () => {
    const rules = { ...founders(5), rounds: [{ fromRound: 1, toRound: 2, mode: 'cross_group' as const, allowedPairs: [] }] };
    const lines = capacityLines(rules, { founder: 25, funder: 8 }, 0, 5);
    expect(lines).toEqual([{ rounds: 'Rounds 1 to 2', sentence: expect.stringMatching(/at most 8 founder and funder meetings are possible, so 17 founders wait/) }]);
    expect(capacityLines(rules, { founder: 4, funder: 4 }, 0, 5)).toEqual([]);
    expect(capacityLines({ ...rules, groups: [] }, {}, 0, 5)).toEqual([]);
  });

  it('the capacity notice shows wherever groups or rules are edited: the card and the form', () => {
    expect(src.groupsCard).toMatch(/<CapacityNotice rules=\{rules\} counts=\{counts\} ungrouped=\{ungrouped\} numberOfRounds=\{numberOfRounds\} \/>/);
    expect(src.groupsSheet).toMatch(/<CapacityNotice rules=\{draft\} counts=\{counts\} ungrouped=\{ungrouped\} numberOfRounds=\{numberOfRounds\} \/>/);
    expect(src.capacity).toMatch(/capacityLines\(rules, counts, ungrouped, numberOfRounds\)/);
  });

  it('saving groups that leave out a group with people in it asks first; Remove groups asks first', () => {
    const before = founders(3);
    expect(droppedGroupsWithPeople(before, rulesOfForm(presetValues('mentors_mentees', 3)), { founder: 2, funder: 0 })).toEqual(['Founders']);
    expect(droppedGroupsWithPeople(before, before, { founder: 2 })).toEqual([]);
    expect(droppedGroupsWithPeople(null, before, {})).toEqual([]);
    expect(src.groupsSheet).toMatch(/if \(dropped\.length > 0 && !\(await ask\(/);
    expect(src.groupsCard).toMatch(/if \(!rules \|\| !\(await ask\(\{ title: GROUPS_COPY\.removeTitle/);
  });
});

describe('history', () => {
  const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
    id: '1', at: '2026-11-11T10:00:00.000Z', actor: { id: 'h', displayName: 'Ana Host' }, automatic: false,
    action: 'event.published', round: null, scheduleVersion: null, subjects: [], reason: null, ...over,
  });

  it('reads each entry as a sentence with the person\'s name, never the action\'s code', () => {
    expect(historySentence(entry({}))).toBe('Ana Host published the event');
    expect(historySentence(entry({ action: 'admission.mode_changed' }))).toBe('Ana Host changed who gets a place');
    expect(historySentence(entry({ action: 'event.cancelled' }))).toBe('Ana Host cancelled the event');
    expect(historySentence(entry({ actor: null, automatic: true, action: 'match.repaired' }))).toBe('REASON repaired the matches');
    expect(historySentence(entry({ action: 'something.new' }))).toBe('Ana Host changed the event');
    expect(historyDetail(entry({ action: 'event.cancelled', reason: 'The venue closed.' }))).toBe('Reason: The venue closed.');
    expect(historyDetail(entry({ round: 2, subjects: [{ id: 'a', displayName: 'Bo' }] }))).toBe('Bo · Round 2');
    expect(historyDetail(entry({}))).toBeNull();
  });
});

describe('errors', () => {
  it('says the server\'s organiser sentence when it is fit to show, else the fallback; a 403/404 read draws nothing', () => {
    const refused = (status: number, message: string, details?: unknown) => ({ response: { status, data: { error: { message, details } } } });
    expect(organiserSentence(refused(409, "Admission can't change while the event is live."), 'x')).toBe("Admission can't change while the event is live.");
    expect(organiserSentence(refused(400, 'Validation failed', { confirmTitle: ["Type the event's name to delete it."] }), 'x')).toBe("Type the event's name to delete it.");
    expect(organiserSentence(refused(404, 'Session with id 6f1c2a90-1111-4111-8111-111111111111 not found'), 'Try again.')).toBe('Try again.');
    expect(organiserSentence(refused(500, 'boom'), 'Try again.')).toBe('Try again.');
    expect(organiserSentence(refused(429, 'Too many'), 'x')).toBe('Slow down a moment, then try again.');
    expect(organiserSentence({ isAxiosError: true }, 'x')).toBe('Connection lost. Check your internet and try again.');
    expect(notForThisViewer(refused(403, 'no'))).toBe(true);
    expect(notForThisViewer(refused(404, 'no'))).toBe(true);
    expect(notForThisViewer(refused(500, 'no'))).toBe(false);
  });
});

describe('phones: 44px buttons and nothing wider than 360px', () => {
  const all = { ...src, detail, create };
  const CONSTANTS = ['QUIET_BUTTON', 'PRIMARY_BUTTON', 'DANGER_BUTTON', 'SOLID_DANGER_BUTTON'];

  it('the shared button looks are 44px, and every lifecycle button wears one of them', () => {
    const look = src.lifecycle.slice(src.lifecycle.indexOf('const LOOK'), src.lifecycle.indexOf('};', src.lifecycle.indexOf('const LOOK')));
    expect(look.match(/: (\w+),/g)?.map((m) => m.slice(2, -1)).every((c) => CONSTANTS.includes(c))).toBe(true);
    expect(src.ui).toMatch(/const BUTTON = 'inline-flex min-h-\[44px\] min-w-\[44px\]/);
    expect(src.ui).toMatch(/export const FIELD = 'w-full min-w-0 min-h-\[44px\]/);
  });

  it('every <button> in the section is 44px tall (its own class or a shared look)', () => {
    for (const [name, text] of Object.entries(src)) {
      let at = text.indexOf('<button');
      while (at !== -1) {
        const tag = text.slice(at, text.indexOf('className=', at) + 300);
        const cls = tag.slice(tag.indexOf('className='));
        // A class of its own with min-h-[44px], or an expression made only of the shared looks (LOOK maps to them).
        const expr = cls.startsWith('className={') ? cls.slice('className={'.length, cls.indexOf('}', 'className={'.length + 1)) : '';
        const looks = expr.match(/\b[A-Z][A-Z_]+\b/g) ?? [];
        const own = cls.startsWith('className="') ? cls.slice(0, cls.indexOf('"', 'className="'.length)) : expr;
        const ok = own.includes('min-h-[44px]') || expr === 'LOOK[action]'
          || (looks.length > 0 && looks.every((c) => CONSTANTS.includes(c)));
        expect({ name, tag: tag.slice(0, 160), ok }).toEqual({ name, tag: tag.slice(0, 160), ok: true });
        at = text.indexOf('<button', at + 1);
      }
    }
  });

  it('no fixed width over 360px without a max-width', () => {
    for (const [name, text] of Object.entries(all)) {
      for (const line of text.split('\n')) {
        for (const m of line.matchAll(/(?:^|[\s"'`:])((?:min-)?w-(?:\[(\d+)px\]|(\d+)))(?=[\s"'`])/g)) {
          const px = m[2] ? Number(m[2]) : Number(m[3]) * 4;
          if (px > 360) expect({ name, line: line.trim(), hasMax: /max-w-/.test(line) }).toEqual({ name, line: line.trim(), hasMax: true });
        }
      }
    }
  });
});

// ─── Fix round 1 (review of 748618c1..f2cf3370) ─────────────────────────────────────────────────────────────────────

describe('fix round 1', () => {
  const admin = read('features/admin/AdminSessionsPage.tsx');
  const allClient = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('__test') ? [] : allClient(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });

  it('the groups card is the #groups anchor Task 13\'s board links to, and scrolls itself into view once loaded', () => {
    expect(src.groupsCard).toContain("export const GROUPS_ANCHOR = 'groups';");
    expect(src.groupsCard).toMatch(/<OrganiserCard\s+id=\{GROUPS_ANCHOR\}/);
    expect(src.ui).toMatch(/<div id=\{id\} className="min-w-0 scroll-mt-24">/);
    // The browser's own jump happens before the card has data, so the card scrolls once it has.
    expect(src.groupsCard).toMatch(/const \{ hash \} = useLocation\(\);/);
    expect(src.groupsCard).toMatch(/if \(hash !== GROUPS_ANCHOR_HASH \|\| !loaded \|\| scrolledFor\.current === sessionId\) return;/);
    expect(src.groupsCard).toMatch(/document\.getElementById\(GROUPS_ANCHOR\)\?\.scrollIntoView\(/);
    // The hook runs before the card's early returns (the rules of hooks).
    expect(src.groupsCard.indexOf('useEffect(() => {')).toBeLessThan(src.groupsCard.indexOf('if (view.isError && notForThisViewer'));
  });

  it('fresh codes nobody downloaded or copied are not thrown away without asking', () => {
    expect(src.codesPanel).toMatch(/const \[kept, setKept\] = useState\(false\);/);
    expect(src.codesPanel).toMatch(/if \(!made \|\| kept\) return true;/);
    // A second batch asks first, and so does "I have saved them".
    expect(src.codesPanel).toMatch(/const submit = form\.handleSubmit\(async \(\{ count, label \}\) => \{\s*if \(!\(await mayDiscard\('replace'\)\)\) return;/);
    expect(src.codesPanel).toMatch(/onClick=\{async \(\) => \{ if \(await mayDiscard\('close'\)\) setMade\(null\); \}\}/);
    // Download and a successful copy count as kept.
    expect(src.codesPanel).toMatch(/download\(codesCsv\(made\.codes, made\.label\), codesFileName\(title\)\); setKept\(true\);/);
    expect(src.codesPanel).toMatch(/setCopied\(true\);\s*setKept\(true\);/);
    expect(src.codesPanel).toMatch(/\{confirmDialog\}/);
    expect(ADMISSION_COPY.unsavedBody).toMatch(/can never be shown again/);
  });

  it('one cancel path: the admin events list cancels through Task 2\'s step with a reason, and nothing calls the legacy DELETE', () => {
    expect(admin).toMatch(/requestLifecycleStep\(sessionId, \{ action: 'cancel', reason \}\)/);
    expect(admin).toMatch(/<CancelEventDialog/);
    expect(admin).toMatch(/\{sessionStatusPhase\(session\.status\) === 'pre' && \(/);
    expect(src.useLifecycle).toMatch(/export function requestLifecycleStep\(sessionId: string, step: LifecycleStep\)/);
    const legacy = allClient(CLIENT_SRC).filter((f) => /api\.delete\(`\/sessions\/\$\{[\w.?!]+\}`\)/.test(fs.readFileSync(f, 'utf8')));
    expect(legacy.map((f) => path.relative(CLIENT_SRC, f))).toEqual([]);
  });

  it('a paste or a CSV over the server\'s 2,000 addresses a call is refused on the page, in words', () => {
    expect(ADMISSION_EMAILS_PER_CALL).toBe(2000);
    expect(ADMISSION_COPY.tooManyPasted(2500)).toBe('That is 2,500 addresses. Add at most 2,000 at a time: split the list and add the rest next.');
    expect(src.emailsPanel).toMatch(/if \(emails\.length > ADMISSION_EMAILS_PER_CALL\) \{\s*form\.setError\('text', \{ type: 'validate', message: ADMISSION_COPY\.tooManyPasted\(emails\.length\) \}\);/);
    expect(src.emailsPanel).toMatch(/if \(csvHasTooManyRows\(csv\)\) \{\s*setOutcome\(\{ tone: 'problem', text: ADMISSION_COPY\.tooManyRows \}\);/);
    const rows = (n: number, header = true) => `${header ? 'email\n' : ''}${Array.from({ length: n }, (_, i) => `p${i}@example.com`).join('\r\n')}\n\n , \n`;
    expect(csvHasTooManyRows(rows(2000))).toBe(false);
    expect(csvHasTooManyRows(rows(2001, false))).toBe(false);
    expect(csvHasTooManyRows(rows(2001))).toBe(true);
    expect(csvHasTooManyRows('')).toBe(false);
    const fn = read('features/sessions/admission/admission-text.ts');
    const body = fn.slice(fn.indexOf('export function csvHasTooManyRows'), fn.indexOf('/** The largest CSV'));
    expect(body).not.toMatch(/\.split\(|\.match\(|\.replace\(|new RegExp/);
  });

  it('"Use the usual rules again" says plainly what it does', () => {
    expect(ADMISSION_COPY.clearBody).toBe('This turns the admission mode off. Who gets a place then follows only the event\'s "Who can join" setting, as it stands now. The allowed emails and codes stay on the list but no longer give anyone a place. Everyone who already has a place keeps it.');
    expect(src.admissionCard).toMatch(/confirmLabel: ADMISSION_COPY\.clearConfirm \}/);
    expect(ADMISSION_COPY.clearConfirm).toBe('Turn admission off');
  });

  it('minors: the chip guard ignores prototype names; the groups form uses the server\'s default rounds', () => {
    expect(isEventLifecycleChip('toString')).toBe(false);
    expect(isEventLifecycleChip('constructor')).toBe(false);
    expect(isEventLifecycleChip('archived')).toBe(true);
    expect(src.settings).toMatch(/Number\(event\.config\?\.numberOfRounds\) \|\| DEFAULT_SESSION_CONFIG\.numberOfRounds/);
  });
});
