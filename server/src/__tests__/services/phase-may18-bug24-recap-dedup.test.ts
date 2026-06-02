// Bug 24 (18 May Ali) — recap "Mutual Matches" section must show one
// row per unique partner. Pre-fix a pair who met in 2 rounds rendered
// as 2 rows; with the fallback ladder or "Another Round" workflow this
// produced confusing duplicate entries for the same person.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Bug 24 — Recap mutualConnections deduped + meetCount surfaced', () => {
  const ratingSrc = readServer('services/rating/rating.service.ts');
  const recapSrc = readClient('features/sessions/RecapPage.tsx');

  it('rating.service.getPeopleMet has a dedupeByUser helper that aggregates meetCount', () => {
    const fnIdx = ratingSrc.indexOf('const dedupeByUser');
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = ratingSrc.slice(fnIdx, fnIdx + 2000);
    expect(fn).toMatch(/byUser\s*=\s*new Map/);
    expect(fn).toMatch(/meetCount:\s*1/);
    expect(fn).toMatch(/existing\.meetCount\s*\+=\s*1/);
    // Best-of-both for quality + mutual flags so the single row isn't
    // worse than either of the duplicates.
    expect(fn).toMatch(/r\.qualityScore[\s\S]{0,80}>\s*\(existing\.qualityScore/);
    expect(fn).toMatch(/r\.mutualMeetAgain[\s\S]{0,40}existing\.mutualMeetAgain\s*=\s*true/);
  });

  it('mutualConnections passes through dedupeByUser before being returned', () => {
    // The returned mutualConnections must be the deduped variant, not
    // the raw filter over connections.
    expect(ratingSrc).toMatch(
      /dedupedMutual\s*=\s*dedupeByUser\(\s*connections\.filter\(c\s*=>\s*mutualPartnerIds\.has\(c\.userId\)/,
    );
    expect(ratingSrc).toMatch(/mutualConnections:\s*dedupedMutual/);
  });

  it('Connection interface on the client declares optional meetCount', () => {
    const ifaceIdx = recapSrc.indexOf('interface Connection {');
    expect(ifaceIdx).toBeGreaterThan(-1);
    const iface = recapSrc.slice(ifaceIdx, ifaceIdx + 800);
    expect(iface).toMatch(/meetCount\?:\s*number/);
  });

  it('Mutual Matches row renders a "Met N times" badge when meetCount > 1', () => {
    expect(recapSrc).toMatch(
      /\(c\.meetCount\s*\?\?\s*1\)\s*>\s*1[\s\S]{0,300}Met\s+\{c\.meetCount\}\s+times/,
    );
  });
});
