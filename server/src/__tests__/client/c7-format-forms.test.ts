// server/src/__tests__/client/c7-format-forms.test.ts
// The pod and event forms follow the shared definition (C7, 26 Oct 2026): the wiring and markup, pinned by reading
// the source (the client has no test runner of its own). Their rules are EXECUTED in pod-type-form.test.ts and
// event-format-form.test.ts.
//
// 25 Oct walkthrough: a Reason pod defaulted to Timed Rounds and a Video meeting showed round settings; the title's
// "Required" sat far above the button on a phone, and inviting hid behind a 36px icon.
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the pod forms take the pod type from the shared table', () => {
  const create = read('features/pods/CreatePodModal.tsx');
  const edit = read('features/pods/EditPodModal.tsx');
  const body = read('features/pods/PodFormFields.tsx');
  const fields = read('features/pods/PodTypeFields.tsx');
  const page = read('features/pods/PodDetailPage.tsx');

  it('Create a Pod has no orchestration default of its own: no literal timed_rounds, the starting values come from pod-type-form', () => {
    for (const src of [create, body, fields]) expect(src).not.toMatch(/['"]timed_rounds['"]/);
    expect(create).toMatch(/newPodValues\(/);
  });

  it('Create, Duplicate and Edit draw one set of fields (PodFormFields), whose type and orchestration are PodTypeFields', () => {
    for (const src of [create, edit]) expect(src).toMatch(/<PodFormFields/);
    expect(body).toMatch(/<PodTypeFields/);
  });

  it('both forms are react-hook-form forms; Edit Pod no longer keeps the pod in useState', () => {
    for (const src of [create, edit]) expect(src).toMatch(/useForm<PodFormValues>/);
    expect(edit).toMatch(/editPodValues\(/);
    expect(page).toMatch(/<EditPodModal/);
    expect(page).not.toMatch(/setEditForm|useState<EditForm>/);
  });

  it('communication is never asked: no select registers it, and no audio/text/hybrid options are drawn', () => {
    for (const src of [create, edit, body, fields]) {
      expect(src).not.toMatch(/register\(['"]communicationMode['"]\)/);
      expect(src).not.toMatch(/value="audio"/);
    }
  });

  it('a type change goes through changeType, its notices and the edit note are drawn under the control', () => {
    expect(fields).toMatch(/orchestrationChoice\(/);
    expect(fields).toMatch(/notices\.map/);
    expect(fields).toMatch(/TYPE_CHANGE_NOTE/);
    expect(body).toMatch(/changeType\(/);
  });

  it('Max members carries the size hint ("Up to 12 recommended" for a Reason pod), and two selects stack below 640px', () => {
    expect(body).toMatch(/sizeHint\(/);
    expect(body).toMatch(/grid grid-cols-1 gap-4 sm:grid-cols-2/);
  });

  it('a refusal lands at the field or beside the button, never as a bare "Failed to create pod" toast', () => {
    expect(create).not.toMatch(/Failed to create pod/);
    expect(edit).not.toMatch(/Failed to update pod/);
    for (const src of [create, edit]) {
      expect(src).toMatch(/podProblems\(/);
      expect(src).toMatch(/<FormSummary/);
    }
  });

  it('the sheets keep their submit in the sticky footer', () => {
    for (const src of [create, edit]) expect(src).toMatch(/<Sheet[\s\S]{0,400}footer=/);
  });
});

describe('Schedule an Event follows the event type', () => {
  const page = read('features/sessions/CreateSessionPage.tsx');
  const fields = read('features/sessions/EventFormatFields.tsx');

  it('the event types are the pod\'s, from the table: no hard-coded EVENT_TYPES list, no description stuck on speed networking', () => {
    expect(page).not.toMatch(/EVENT_TYPES/);
    expect(page).toMatch(/offeredFormats\(/);
    expect(page).toMatch(/<EventTypePicker/);
    expect(page).toMatch(/<EventFormatFields/);
  });

  it('round settings are drawn only for a rounds event; a meeting draws its length', () => {
    expect(fields).toMatch(/liveKindOf\(format\) === 'rounds'/);
    expect(fields).toMatch(/lengthOptions\(/);
  });

  it('arriving from a pod (?podId=) the pod is a read-only header from GET /pods/:id, told of changes to the pod', () => {
    expect(page).toMatch(/params\.get\('podId'\)/);
    const podQuery = page.slice(page.indexOf("queryKey: ['pod', fromPodId]"));
    expect(podQuery).toMatch(/meta:\s*\{\s*entities:[\s\S]{0,120}E\.pod\(fromPodId\)/);
    expect(page).toMatch(/In \{fixedPod\.name\}/);
  });

  it('the title is filled in, required in these words, and capped at the server\'s 300 characters', () => {
    expect(page).toMatch(/titleProblem\(/);
    expect(page).toMatch(/maxLength=\{TITLE_MAX\}/);
    expect(page).toMatch(/autoTitle\(/);
  });

  it('the browser does not judge the form (noValidate): every problem is said at its field, with the summary beside the sticky submit', () => {
    expect(page).toMatch(/<form ref=\{formRef\} onSubmit=[\s\S]{0,120}noValidate/);
    expect(page).toMatch(/<FormSummary/);
    // Just above the phone's bottom bar; 12px above the foot of the window and its safe area from 721px. Sticky offsets
    // are measured inside <main>'s bottom padding (96px plus the safe area on a phone, 40px from 721px), hence negative.
    expect(page).toMatch(/sticky bottom-\[-24px\]/);
    expect(page).toMatch(/min-\[721px\]:bottom-\[calc\(env\(safe-area-inset-bottom\)_-_28px\)\]/);
    expect(page).toMatch(/shouldFocusError: false/);
    expect(page).toMatch(/scrollIntoView\(\{ block: 'center' \}\)/);
  });

  it('a refusal is mapped to its field (both shapes, eventProblems), never shown as a raw toast', () => {
    expect(page).toMatch(/eventProblems\(/);
    expect(page).not.toMatch(/addToast\(msg, 'error'\)/);
  });

  it('after "Schedule Event" the event opens with ?invite=1 (the invite picker opens there)', () => {
    expect(page).toMatch(/navigate\(`\/sessions\/\$\{[^}]+\}\?invite=1`\)/);
  });

  it('one templates endpoint, asked only for admins (the template is an admin pick)', () => {
    expect(page).not.toMatch(/['"]\/matching-templates['"]/);
    expect(page).toMatch(/queryKey: \['admin-templates'\]/);
    expect(page).toMatch(/enabled: isAdmin/);
  });
});

describe('the event page', () => {
  const page = read('features/sessions/SessionDetailPage.tsx');
  const edit = read('features/sessions/EditEventModal.tsx');

  it('the edit form uses the same EventFormatFields and the same type picker, and sends the type', () => {
    expect(page).toMatch(/<EditEventModal/);
    expect(edit).toMatch(/<EventFormatFields/);
    expect(edit).toMatch(/<EventTypePicker/);
    expect(edit).toMatch(/eventChanges\(/);
    expect(edit).toMatch(/eventProblems\(/);
  });

  it('no call to the /matching-templates route that does not exist; the edit form asks /admin/templates, for admins', () => {
    expect(page).not.toMatch(/\/matching-templates/);
    expect(edit).not.toMatch(/\/matching-templates/);
    expect(edit).toMatch(/queryKey: \['admin-templates'\]/);
    expect(edit).toMatch(/enabled: isAdmin/);
  });

  it('the facts under the title follow the type (no "rounds" on a video meeting)', () => {
    expect(page).toMatch(/eventFactsLine\(/);
    expect(page).toMatch(/eventFacts\(/);
    expect(page).not.toMatch(/session\.config\?\.numberOfRounds \|\| 5/);
  });

  it('"Invite people" is a labelled button at least 44px tall, its words shown on a phone too', () => {
    const at = page.indexOf('Invite people');
    expect(at).toBeGreaterThan(-1);
    const button = page.slice(page.lastIndexOf('<button', at), at);
    expect(button).toMatch(/min-h-\[44px\]/);
    expect(page).not.toMatch(/<span className="hidden sm:inline">Invite<\/span>/);
  });

  it('the other host buttons are 44px tap targets as well', () => {
    expect(page).not.toMatch(/className="h-9 px-3/);
  });
});
