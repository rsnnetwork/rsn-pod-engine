// ─── Declining a request to join an event asks first (final fix wave X1, 2 Nov 2026) ─────────────────────────────
//
// A decline is final: the server answers EVENT_REQUEST_DECLINED to any later ask from that person, and Approve only
// takes a pending request. Decline sat right beside Approve on a phone, so one mis-tap refused a real person for good
// (CLAUDE.md §12: destructive actions ask first). It now asks through the page's ConfirmDialog (useConfirm); Approve
// does not ask. Pinned by its source: the card is a React component.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
const card = () => fs.readFileSync(path.join(CLIENT, 'features/sessions/EventJoinRequestsCard.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('Decline on the Requests card', () => {
  it('asks in plain words that say it is final, with Decline as the danger button', () => {
    const src = card();
    expect(src).toContain("declineTitle: (name: string) => `Decline ${name}?`,");
    expect(src).toContain("declineBody: 'They will not get a place at this event, and they cannot ask again.',");
    expect(src).toMatch(/await ask\(\{ title: REQUESTS_COPY\.declineTitle\(name\), body: REQUESTS_COPY\.declineBody, confirmLabel: REQUESTS_COPY\.decline, tone: 'danger' \}\)/);
  });

  it('sends the decline only after a yes, and Approve still goes at once', () => {
    const src = card();
    expect(src).toMatch(/const decline = async \(row: RequestRow\) => \{[\s\S]*?if \(!\(await ask\([\s\S]*?\)\)\) return;\s*answer\.mutate\(\{ row, verb: 'decline' \}\);/);
    expect(src).toMatch(/onClick=\{\(\) => void decline\(row\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => answer\.mutate\(\{ row, verb: 'approve' \}\)\}/);
  });

  it('asks in the page, through the shared hook, and draws its dialog once', () => {
    const src = card();
    expect(src).toMatch(/import \{ useConfirm \} from '@\/hooks\/useConfirm';/);
    expect(src).toMatch(/const \{ ask, confirmDialog \} = useConfirm\(\);/);
    expect(src.match(/\{confirmDialog\}/g)).toHaveLength(1);
  });
});
