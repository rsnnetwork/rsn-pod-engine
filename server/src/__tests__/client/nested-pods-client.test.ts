// ─── Pods inside pods on the pod pages (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────────
//
// An inner pod says "Part of <main pod>" (a link) or "Part of a private pod"; a main pod lists "Pods inside" with
// "Create a pod inside", "Put one of your pods inside", "Take out" (asked first) and the members-only switch for its
// director; Join is replaced by "Join <main pod> first" while the main pod keeps the viewer out; the pods list says
// "in <main pod>". The pure parts (nested-pods-view.ts) are run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import {
  NESTED_COPY, NESTED_TOAST, isMainPodGate, joinGateLine, listNote, mayTakeOutHere, membersOnlyHint, membersOnlyLabel,
  nestedPodActions, partOfLine, readRefusal, refusalSentence, takeOutQuestion,
} from '../../../../client/src/features/pods/nested-pods-view';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const axiosError = (error: Record<string, unknown>) => ({ response: { data: { error } } });

describe('the words', () => {
  it('names the main pod where it may, and never invents a name for a hidden one', () => {
    expect(partOfLine('Founders')).toBe('Part of Founders');
    expect(NESTED_COPY.hiddenParent).toBe('Part of a private pod');
    expect(joinGateLine('Founders')).toBe('Join Founders first. Its pods are for its members.');
    expect(joinGateLine(null)).toBe("This pod is for the members of the pod it is part of. Ask that pod's director for an invitation.");
    expect(listNote(null, null)).toBeNull();
    expect(listNote('m1', 'Founders')).toBe('in Founders');
    expect(listNote('m1', null)).toBe('in a private pod');
  });

  it('the setting reads in the main pod\'s own name and says nobody is taken out', () => {
    expect(membersOnlyLabel('Founders')).toBe('People must be members of Founders to join its pods');
    expect(membersOnlyHint(true)).toMatch(/Nobody already in its pods is taken out\./);
    expect(membersOnlyHint(false)).toMatch(/^Off:/);
  });

  it('asks before taking a pod out and says what stays', () => {
    expect(takeOutQuestion('Design', 'Founders')).toEqual({
      title: 'Take Design out of Founders?',
      body: 'It stands on its own again. It keeps its members, settings, discussion and events.',
    });
    expect(takeOutQuestion('Design', null).title).toBe('Take Design out of the pod it is in?');
  });

  it('says what each change did', () => {
    expect(NESTED_TOAST.madeInside('Design', 'Founders')).toBe('Design is made inside Founders.');
    expect(NESTED_TOAST.putInside('Design', 'Founders')).toBe('Design is now inside Founders.');
    expect(NESTED_TOAST.takenOut('Design')).toBe('Design stands on its own now.');
    expect(NESTED_TOAST.setting(true, 'Founders')).toBe('Only members of Founders can join its pods now.');
  });
});

describe('who is offered what', () => {
  const director = { directsPod: true, platformAdmin: false };
  const member = { directsPod: false, platformAdmin: false };
  it('a main pod\'s director gets the section, both ways to add a pod and the switch, even with none inside yet', () => {
    expect(nestedPodActions({ mayHoldPods: true, innerPodCount: 0, status: 'active' }, director))
      .toEqual({ showSection: true, createInside: true, putInside: true, setMembersOnly: true });
    expect(nestedPodActions({ mayHoldPods: true, innerPodCount: 0, status: 'active' }, { directsPod: false, platformAdmin: true }).createInside).toBe(true);
  });

  it('anyone else sees the section only when there are pods inside to see, and changes nothing', () => {
    expect(nestedPodActions({ mayHoldPods: true, innerPodCount: 0, status: 'active' }, member).showSection).toBe(false);
    expect(nestedPodActions({ mayHoldPods: true, innerPodCount: 2, status: 'active' }, member))
      .toEqual({ showSection: true, createInside: false, putInside: false, setMembersOnly: false });
  });

  it('a pod inside another never shows the section (one level only); an archived main pod takes no new pods', () => {
    expect(nestedPodActions({ mayHoldPods: false, innerPodCount: 0, status: 'active' }, director).showSection).toBe(false);
    expect(nestedPodActions({ mayHoldPods: true, innerPodCount: 1, status: 'archived' }, director))
      .toMatchObject({ showSection: true, createInside: false, putInside: false });
  });

  it('the pod\'s own director (or an admin) may take it out from its own page', () => {
    expect(mayTakeOutHere({ parentPod: { id: 'm', name: 'M' } }, director)).toBe(true);
    expect(mayTakeOutHere({ parentPodHidden: true }, director)).toBe(true);
    expect(mayTakeOutHere({ parentPod: { id: 'm', name: 'M' } }, member)).toBe(false);
    expect(mayTakeOutHere({ parentPod: null }, director)).toBe(false);
  });
});

describe('reading the server\'s refusal', () => {
  it('knows the main pod gate by its code, and keeps the main pod it names', () => {
    const err = axiosError({ code: 'MAIN_POD_MEMBERS_ONLY', message: 'Join Founders first. Its pods are for its members.', details: { mainPod: { id: 'm1', name: 'Founders' } } });
    expect(isMainPodGate(err)).toBe(true);
    expect(readRefusal(err).mainPod).toEqual({ id: 'm1', name: 'Founders' });
    expect(refusalSentence(err)).toBe('Join Founders first. Its pods are for its members.');
    expect(isMainPodGate(axiosError({ code: 'AUTH_FORBIDDEN', message: 'x' }))).toBe(false);
    expect(refusalSentence(new Error('Network Error'))).toBe(NESTED_COPY.fallbackError);
  });
});

describe('the wiring', () => {
  const detail = read('features/pods/PodDetailPage.tsx');
  const section = read('features/pods/PodInnerPodsSection.tsx');
  const hooks = read('features/pods/useNestedPods.ts');
  const parentLine = read('features/pods/PodParentLine.tsx');
  const move = read('features/pods/MovePodSheet.tsx');
  const toggle = read('features/pods/InnerPodsMembersOnlySwitch.tsx');
  const create = read('features/pods/CreatePodModal.tsx');
  const list = read('features/pods/PodsPage.tsx');

  it('every read declares the tags the server sends', () => {
    expect(hooks).toMatch(/queryKey: \['pod-inner-pods', podId\][\s\S]*?meta: \{ entities: \[E\.podInnerPods\(podId\), E\.pod\(podId\)\] \}/);
    expect(hooks).toMatch(/queryKey: \['pod-inner-pod-candidates', podId\][\s\S]*?meta: \{ entities: \[E\.podInnerPods\(podId\), E\.pod\(podId\), \.\.\.\(me \? \[E\.userPods\(me\)\] : \[\]\)\] \}/);
  });

  it('the changes go to the routes the server has', () => {
    expect(hooks).toContain('api.delete(`/pods/${pod.id}/parent`)');
    expect(hooks).toContain('api.put(`/pods/${pod.id}/parent`, { parentPodId: main.id })');
    expect(hooks).toContain('api.put(`/pods/${main.id}/inner-pods-setting`, { innerPodsMembersOnly: on })');
    expect(create).toMatch(/if \(parent\) return \{ \.\.\.podBody\(values\), parentPodId: parent\.id \};/);
    expect(create).toMatch(/parent \? `New pod inside \$\{parent\.name\}`/);
  });

  it('the pod page shows where it sits, the pods inside, and the gate where Join would be', () => {
    expect(detail).toContain('<PodParentLine pod={pod} directsPod={isPodDirector} platformAdmin={isAdminUser} />');
    expect(detail).toContain('<PodInnerPodsSection pod={pod} directsPod={isPodDirector} platformAdmin={isAdminUser} />');
    expect(detail).toMatch(/\{pod\.joinNeedsMainPod \? \(\n\s*<PodMainPodGate mainPod=\{pod\.parentPod \?\? null\} \/>\n\s*\) : pod\.visibility === 'public' \|\| isAdminUser \? \(/);
    // A refused join re-reads the pod, so a choice made since the page was read shows the gate.
    expect(detail.match(/if \(isMainPodGate\(err\)\) qc\.invalidateQueries\(\{ queryKey: \['pod', podId\] \}\);/g)).toHaveLength(2);
  });

  it('every control a smoke reaches has its test id', () => {
    for (const id of ['pod-inner-pods', 'pod-inner-create', 'pod-inner-put', 'pod-inner-empty', 'pod-inner-row-${item.id}', 'pod-inner-takeout-${item.id}']) {
      expect(section).toContain(id.includes('$') ? `data-testid={\`${id}\`}` : `data-testid="${id}"`);
    }
    expect(parentLine).toContain('data-testid="pod-parent-line"');
    expect(parentLine).toContain('data-testid="pod-parent-link"');
    expect(parentLine).toContain('data-testid="pod-parent-takeout"');
    expect(move).toContain('data-testid="pod-move-sheet"');
    expect(move).toContain('data-testid="pod-move-empty"');
    expect(move).toContain('data-testid={`pod-move-pick-${pod.id}`}');
    expect(toggle).toContain('data-testid="pod-inner-members-only"');
    expect(read('features/pods/PodMainPodGate.tsx')).toContain('data-testid="pod-main-gate"');
    expect(list).toContain('data-testid={`pod-list-inside-${pod.id}`}');
  });

  it('take out asks first; the switch and the buttons are 44px targets; long names wrap at 360px', () => {
    expect(section).toMatch(/await ask\(\{ \.\.\.q, confirmLabel: NESTED_COPY\.takeOut, tone: 'danger' \}\)/);
    expect(parentLine).toMatch(/await ask\(\{ \.\.\.takeOutQuestion\(pod\.name, mainName\), confirmLabel: NESTED_COPY\.takeOut, tone: 'danger' \}\)/);
    expect(toggle).toMatch(/role="switch"/);
    expect(toggle).toMatch(/min-h-\[44px\] min-w-\[44px\]/);
    expect(section).toMatch(/min-h-\[44px\] min-w-0 flex-1/);
    for (const src of [section, parentLine, move, toggle]) expect(src).toContain('break-words');
  });

  it('each new screen has its loading, empty and error states', () => {
    for (const src of [section, move]) {
      expect(src).toMatch(/<Skeleton/);
      expect(src).toMatch(/isError/);
      expect(src).toMatch(/refetch\(\)/);
    }
    expect(section).toContain('NESTED_COPY.emptyForDirector');
    expect(move).toContain('NESTED_COPY.pickerEmpty');
  });
});
