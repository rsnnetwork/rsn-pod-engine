// server/src/__tests__/client/f4-request-sent-everywhere.test.ts
// 10 Nov 2026 (Stefan: "if I have ALREADY asked them, why is that not shown?"). Every place a member can ask to meet
// someone shows "Request sent" from the server's own state (so it survives a reload), with "Withdraw request" beside
// it, through one hook and one button. These read the client sources, as the other client tests here do.
import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
}
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('one withdraw, used everywhere a request can be sent', () => {
  it.each([
    'features/search/SearchPage.tsx',
    'features/reason/human/HumanCard.tsx',
    'features/reason/human/MoveBar.tsx',
    'features/matches/MatchesPage.tsx',
    'features/agents/AgentDetailPage.tsx',
    'features/profile/PublicProfilePage.tsx',
  ])('%s draws the shared WithdrawRequestButton', (rel) => {
    const src = readClient(rel);
    expect(src).toContain("import WithdrawRequestButton from '@/features/messages/WithdrawRequestButton';");
    expect(src).toMatch(/<WithdrawRequestButton userId=/);
  });

  it('the hook finds the request from the person when no id is given, then posts the withdrawal', () => {
    const src = flat(readClient('features/messages/useWithdrawRequest.ts'));
    expect(src).toContain('api.get(`/pokes/with/${encodeURIComponent(userId)}`)');
    expect(src).toContain("if (!found || found.status !== 'pending' || !found.sentByMe) return 'not_waiting';");
    expect(src).toContain('await api.post(`/pokes/${encodeURIComponent(id)}/withdraw`);');
  });

  it('one press at a time: one mutation key per person, checked before mutate, and the button disabled while it runs', () => {
    const hook = flat(readClient('features/messages/useWithdrawRequest.ts'));
    expect(hook).toContain("return ['request-withdraw', userId] as const;");
    expect(hook).toContain('if (qc.isMutating({ mutationKey: withdrawRequestKey(userId) }) > 0) return;');
    const button = flat(readClient('features/messages/WithdrawRequestButton.tsx'));
    expect(button).toContain('disabled={busy}');
    expect(button).toContain('min-h-[44px]');
  });
});

describe('Find people', () => {
  const src = flat(readClient('features/search/SearchPage.tsx'));

  it('keeps no "asked" set of its own: the state is the server\'s pokeStatus', () => {
    expect(src).not.toMatch(/setAsked|useState<Set<string>>/);
    expect(src).toContain("const askedByMe = (r: Result) => r.pokeStatus === 'pending' && r.pokeSentByOwner === true;");
  });

  it('follows realtime: the results refresh on the member\'s user and invites tags', () => {
    expect(src).toContain('meta: { entities: me ? [E.user(me), E.userInvites(me)] : [] }');
    expect(src).not.toContain('realtime: skip');
  });

  it('a request sent by the member shows "Request sent" and Withdraw; one sent to them keeps "I want to meet"', () => {
    expect(src).toMatch(/askedByMe\(r\) \? \( <div className="mt-3 grid grid-cols-2 gap-2">.*Request sent.*<WithdrawRequestButton userId=\{r\.userId\} \/>/);
    // Incoming falls through to the button, as it did before (pressing it is the match).
    expect(src).toMatch(/r\.pokeStatus === 'accepted' \? \(.*\) : \( .*I want to meet/);
  });
});

describe('the cards and the bar', () => {
  it('HumanCard adds Withdraw on its own row only for the member\'s own waiting request', () => {
    const src = flat(readClient('features/reason/human/HumanCard.tsx'));
    expect(src).toContain("{action === 'requested' && <WithdrawRequestButton userId={person.userId} className=\"col-span-full\" />}");
  });

  it('MoveBar swaps Remove for Withdraw while the member\'s request waits, so three buttons still fit a phone', () => {
    const src = flat(readClient('features/reason/human/MoveBar.tsx'));
    expect(src).toContain("const requested = r.state === 'requested';");
    expect(src).toContain('{requested && <WithdrawRequestButton userId={brief.person.id} shortLabel className="min-h-[48px]" />}');
    expect(src).toContain('{!answering && !requested && (');
  });

  it('Matches and a search agent read the server state only (no local "requested" set that outlives a withdrawal)', () => {
    for (const rel of ['features/matches/MatchesPage.tsx', 'features/agents/AgentDetailPage.tsx']) {
      const src = readClient(rel);
      expect(src).not.toMatch(/setRequested|requested\.has/);
      expect(src).toContain('Request sent');
    }
  });

  it('the old profile withdraws by the request id it already has', () => {
    const src = flat(readClient('features/profile/PublicProfilePage.tsx'));
    expect(src).toContain('<WithdrawRequestButton userId={userId as string} requestId={meetingRequest.id} className="text-xs" />');
  });
});

describe('a request opened by id that was withdrawn says so', () => {
  it('the focused card names who withdrew it', () => {
    const src = flat(readClient('features/messages/MeetingRequests.tsx'));
    expect(src).toContain("if (state?.status === 'cancelled') { return { text: state.sentByMe ? 'You withdrew this meeting request.' : 'They withdrew this meeting request.' }; }");
  });
});
