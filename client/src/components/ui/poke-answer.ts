// ─── What a meeting-request notification in the bell shows ──────────────────────────────────────────
//
// The server's list tells the bell where each request stands (`pokeStatus`, and `requestState` which is null
// when the request has been withdrawn). A request nobody can answer any more (a closed account, a block, a
// withdrawal) reads "No longer available", never "Declined" and never a pair of buttons that fail.

export interface PokeNotification {
  type: string;
  link?: string;
  pokeStatus?: 'accepted' | 'declined' | 'gone' | null;
  /** Absent on a notification that just arrived over the socket; null once the server found no request. */
  requestState?: { status: string } | null;
}

export interface PokeAnswerView {
  actions: boolean;
  label: { text: string; tone: 'accepted' | 'quiet' } | null;
}

const POKE_LINK = /^\/messages\?poke=[0-9a-fA-F-]{36}$/;
const NONE: PokeAnswerView = { actions: false, label: null };
const GONE: PokeAnswerView = { actions: false, label: { text: 'No longer available', tone: 'quiet' } };

export function pokeAnswerView(n: PokeNotification): PokeAnswerView {
  if (n.type !== 'poke') return NONE;
  if (n.pokeStatus === 'accepted') return { actions: false, label: { text: 'Accepted', tone: 'accepted' } };
  if (n.pokeStatus === 'declined') return { actions: false, label: { text: 'Declined', tone: 'quiet' } };
  if (n.pokeStatus === 'gone') return GONE;
  if (!n.link || !POKE_LINK.test(n.link)) return NONE;
  if (n.requestState === null || n.requestState?.status === 'withdrawn' || n.requestState?.status === 'gone') return GONE;
  return { actions: true, label: null };
}
