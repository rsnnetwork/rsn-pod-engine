// 22 Nov 2026 prod smoke: after a director removed someone, a plain member's list lost the row live but the
// "Members (n)" heading (read from the pod's own memberCount) stayed one too high. The pod query must follow member
// changes as well as the pod itself.
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/pods/PodDetailPage.tsx'), 'utf8');

describe('pod page: the pod itself refreshes on member changes', () => {
  it("the ['pod', podId] query declares pod:<id> and pod:<id>:members", () => {
    const start = src.indexOf("queryKey: ['pod', podId]");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    const block = src.slice(start, end);
    expect(block).toMatch(/meta: \{ entities: podId \? \[E\.pod\(podId\), E\.podMembers\(podId\)\] : \[\] \}/);
  });

  it('a refused member-counts read counts as none, so a demoted host falls back to the live memberCount', () => {
    expect(src).toMatch(/const podMemberCounts = memberCountsRead\.isError \? undefined : memberCountsRead\.data;/);
    expect(src).toMatch(/const memberTotal = podMemberCounts\s*\n?\s*\?[\s\S]{0,200}: pod\.memberCount \?\? activeMembers\.length;/);
  });
});
