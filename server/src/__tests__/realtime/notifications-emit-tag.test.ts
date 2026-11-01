// ─── Every path that writes a notification tells the member's bell (26 Oct 2026, H2b item 6) ────────────────
//
// A notification row is a mutation like any other: the member's screens learn of it through the entity tag
// user:<id>:notifications (E.userNotifications), which the bell's queries declare, so they can stop polling. Several
// paths inserted rows and emitted nothing, or only the older 'notification:new' socket event: the member's bell
// filled in on the next poll or reload. This pins that every file inserting into notifications also emits the tag;
// the behaviour of the paths this round changed is tested beside them.

import * as fs from 'fs';
import * as path from 'path';

const SERVICES = path.join(__dirname, '../../services');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const inserting = walk(SERVICES).filter((file) => /INSERT INTO notifications/.test(fs.readFileSync(file, 'utf8')));

describe('every service file that inserts a notification', () => {
  it('exists in a known number (a new path lands here and is checked below)', () => {
    expect(inserting.length).toBeGreaterThanOrEqual(13);
  });

  it.each(inserting.map((f) => [path.relative(SERVICES, f).replace(/\\/g, '/'), f]))('%s emits the member\'s notifications tag', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/E\.userNotifications\(/);
  });

  // H2b review M6: one emit to everyone rung carrying everyone's tag sends N tags to each of N members (a 300-member
  // circle: 300 emits of 300 tags) and tells each member who else was rung. Each member gets one emit with their own tag.
  it.each(inserting.map((f) => [path.relative(SERVICES, f).replace(/\\/g, '/'), f]))('%s never sends one member another member\'s notifications tag', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toMatch(/\.map\(\(?\s*\w+\s*\)?\s*=>\s*E\.userNotifications\(/);
  });

  // H2b review M6: a file that already emits once could gain a second insert that emits nothing, and the check above
  // would still pass. Each insert must be followed, before the file's next insert, by the tag or by a call to one of
  // the file's own functions that sends it (pod-wall's pushBells, for instance).
  it.each(inserting.map((f) => [path.relative(SERVICES, f).replace(/\\/g, '/'), f]))('%s: every insert is followed by the tag', (_rel, file) => {
    expect(insertsWithoutTheTag(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the check finds a second insert that sends nothing in a file that already sends the tag once', () => {
    const src = [
      'async function a(id: string) {',
      '  await query(`INSERT INTO notifications (user_id) VALUES ($1)`, [id]);',
      '  await emitEntities(io, [id], [E.userNotifications(id)]);',
      '}',
      'async function b(id: string) {',
      '  await query(`INSERT INTO notifications (user_id) VALUES ($1)`, [id]);',
      '}',
    ].join('\n');
    expect(insertsWithoutTheTag(src)).toEqual([6]);
  });
});

/** The line of every insert into notifications with no tag, and no call to a helper that sends it, before the next insert. */
function insertsWithoutTheTag(src: string): number[] {
  const helpers = [...src.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)]
    .map((m) => ({ name: m[1], at: m.index ?? 0 }))
    .filter((fn, i, all) => /E\.userNotifications\(/.test(src.slice(fn.at, all[i + 1]?.at ?? src.length)))
    .map((fn) => fn.name);
  const sendsTheTag = (text: string) =>
    /E\.userNotifications\(/.test(text) || helpers.some((name) => new RegExp(`\\b${name}\\(`).test(text));
  const inserts = [...src.matchAll(/INSERT INTO notifications/g)].map((m) => m.index ?? 0);
  return inserts
    .filter((at, i) => !sendsTheTag(src.slice(at, inserts[i + 1] ?? src.length)))
    .map((at) => src.slice(0, at).split('\n').length);
}
