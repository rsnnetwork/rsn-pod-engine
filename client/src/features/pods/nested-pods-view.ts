// ─── Pods inside pods: the words and the rules a pod's page reads (Stefan, 22 Nov 2026) ────────────────────────────
//
// Circle (RSN admins) > main pod > the pods inside it > events. One level only: a main pod holds pods, a pod inside one
// holds none. The server decides every rule (nested-pods.service.ts, pod-parent-gate.ts) and refuses anyway; this file
// only says what the page offers and in which words. Pure (no React, axios or store), so the server's jest runs it:
// server/src/__tests__/client/nested-pods-client.test.ts.

/** What GET /pods/:id says about where the pod sits (PodNesting in @rsn/shared). */
export interface PodNestingView {
  parentPod?: { id: string; name: string } | null;
  parentPodHidden?: boolean;
  innerPodCount?: number;
  joinNeedsMainPod?: boolean;
  mayHoldPods?: boolean;
  innerPodsMembersOnly?: boolean;
  status?: string;
}

export const NESTED_COPY = {
  sectionTitle: 'Pods inside',
  createInside: 'Create a pod inside',
  putInside: 'Put one of your pods inside',
  takeOut: 'Take out',
  empty: 'No pods inside this one yet.',
  emptyForDirector: 'No pods inside this one yet. Create one, or put one of your pods inside.',
  loadFailed: 'We could not load the pods inside just now.',
  tryAgain: 'Try again',
  hiddenParent: 'Part of a private pod',
  pickerTitle: 'Put one of your pods inside',
  pickerEmpty: 'None of your pods can go inside right now. A pod you direct can, when it is not archived, not inside another pod and holds no pods of its own.',
  pickerFailed: 'We could not load your pods just now.',
  pickerAction: 'Put inside',
  fallbackError: 'That did not work just now. Try again in a moment.',
} as const;

/** The line on a pod inside a main pod. */
export function partOfLine(mainName: string): string {
  return `Part of ${mainName}`;
}

/** The members-only setting, in the main pod's own name. */
export function membersOnlyLabel(mainName: string): string {
  return `People must be members of ${mainName} to join its pods`;
}

/** The line under the setting: what it does, and that nobody is taken out. */
export function membersOnlyHint(on: boolean): string {
  return on
    ? 'On: someone who is not a member is asked to join this pod first. Nobody already in its pods is taken out.'
    : 'Off: anyone can join its pods the way each pod allows.';
}

/** What a pod page says where Join would be, when the main pod keeps the viewer out. */
export function joinGateLine(mainName: string | null): string {
  return mainName
    ? `Join ${mainName} first. Its pods are for its members.`
    : "This pod is for the members of the pod it is part of. Ask that pod's director for an invitation.";
}

/** The note on an inner pod's row in the pods list. */
export function listNote(parentPodId: string | null | undefined, parentPodName: string | null | undefined): string | null {
  if (!parentPodId) return null;
  return parentPodName ? `in ${parentPodName}` : 'in a private pod';
}

/** The question asked before a pod is taken out of its main pod. */
export function takeOutQuestion(podName: string, mainName: string | null): { title: string; body: string } {
  return {
    title: mainName ? `Take ${podName} out of ${mainName}?` : `Take ${podName} out of the pod it is in?`,
    body: 'It stands on its own again. It keeps its members, settings, discussion and events.',
  };
}

/** The toasts after each change. */
export const NESTED_TOAST = {
  madeInside: (podName: string, mainName: string) => `${podName} is made inside ${mainName}.`,
  putInside: (podName: string, mainName: string) => `${podName} is now inside ${mainName}.`,
  takenOut: (podName: string) => `${podName} stands on its own now.`,
  setting: (on: boolean, mainName: string) => (on
    ? `Only members of ${mainName} can join its pods now.`
    : `Anyone can join the pods of ${mainName} the way each pod allows.`),
} as const;

/** Who on this page may do what with the pods inside it (the server checks each again). */
export function nestedPodActions(pod: PodNestingView, viewer: { directsPod: boolean; platformAdmin: boolean }) {
  const runs = viewer.directsPod || viewer.platformAdmin;
  const holds = pod.mayHoldPods !== false && pod.status !== 'archived';
  return {
    /** The "Pods inside" section shows: there are some to see, or the viewer may add some. */
    showSection: pod.mayHoldPods !== false && ((pod.innerPodCount ?? 0) > 0 || (runs && holds)),
    createInside: runs && holds,
    putInside: runs && holds,
    setMembersOnly: runs && pod.mayHoldPods !== false,
  };
}

/** Whether the viewer may take this pod (on its own page) out of its main pod. */
export function mayTakeOutHere(pod: PodNestingView, viewer: { directsPod: boolean; platformAdmin: boolean }): boolean {
  return !!(pod.parentPod || pod.parentPodHidden) && (viewer.directsPod || viewer.platformAdmin);
}

/** The server's refusal, read from an axios error: its code, its sentence, and the main pod it names (when it may). */
export interface ApiRefusal { code: string | null; message: string | null; mainPod: { id: string; name: string } | null }

export function readRefusal(err: unknown): ApiRefusal {
  const data = (err as { response?: { data?: { error?: { code?: unknown; message?: unknown; details?: unknown } } } })?.response?.data?.error;
  const details = data?.details as { mainPod?: { id?: unknown; name?: unknown } } | undefined;
  const main = details?.mainPod;
  return {
    code: typeof data?.code === 'string' ? data.code : null,
    message: typeof data?.message === 'string' && data.message ? data.message : null,
    mainPod: main && typeof main.id === 'string' && typeof main.name === 'string' ? { id: main.id, name: main.name } : null,
  };
}

/** The join refusal the main pod's members-only choice gives (MAIN_POD_MEMBERS_ONLY). */
export function isMainPodGate(err: unknown): boolean {
  return readRefusal(err).code === 'MAIN_POD_MEMBERS_ONLY';
}

/** A refusal's sentence, or the fallback. */
export function refusalSentence(err: unknown, fallback: string = NESTED_COPY.fallbackError): string {
  return readRefusal(err).message ?? fallback;
}
