// server/src/__tests__/client/reason-m1-scroll-memory.test.ts
// CON-01 (Stefan and Claus, 25 Oct 2026): Back must return to the exact place. The shell's page area (<main>) is what
// scrolls, and it used to go to the top on every path change, Back included. scroll-memory.ts holds the rules (pure, no
// React or DOM), useMainScrollMemory.ts wires them to the page area, and this file runs the rules and pins the wiring.
import * as fs from 'fs';
import * as path from 'path';
import {
  OwnScrolls, REMEMBER_LIMIT, RESTORE_WAIT_MS, STORAGE_KEY, ScrollMemory, loadedAsSameEntry, placeScroll, scrollActionFor,
  type Frames, type ScrollArea, type ScrollStore,
} from '../../../../client/src/features/reason/shell/scroll-memory';

const clientFile = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

/** A sessionStorage that keeps its text in a map. */
class FakeStore implements ScrollStore {
  readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe('what the page area does when the shell shows a new location', () => {
  const at = (over: Partial<Parameters<typeof scrollActionFor>[0]>) => scrollActionFor({
    navigation: 'PUSH', previousPathname: '/', pathname: '/connections', saved: null, ...over,
  });

  it('Back or Forward to a place the member had scrolled puts the page where it was', () => {
    expect(at({ navigation: 'POP', saved: 640 })).toEqual({ kind: 'restore', top: 640 });
    // Even when the saved place is the top: the same answer as any other place, nothing special about 0.
    expect(at({ navigation: 'POP', saved: 0 })).toEqual({ kind: 'restore', top: 0 });
  });

  it('the place wins over the path: Back to the page the shell is already on restores it too', () => {
    expect(at({ navigation: 'POP', previousPathname: '/matches', pathname: '/matches', saved: 300 })).toEqual({ kind: 'restore', top: 300 });
  });

  it('opening a different page starts at its top, by link, button or redirect', () => {
    expect(at({ navigation: 'PUSH' })).toEqual({ kind: 'top' });
    expect(at({ navigation: 'REPLACE' })).toEqual({ kind: 'top' });
    // Even when a place was saved for that address: only Back and Forward use it.
    expect(at({ navigation: 'PUSH', saved: 900 })).toEqual({ kind: 'top' });
  });

  it('Back to a place nothing was saved for is a page like any other: its top, unless it is the same page', () => {
    expect(at({ navigation: 'POP', saved: null })).toEqual({ kind: 'top' });
    expect(at({ navigation: 'POP', previousPathname: '/matches', pathname: '/matches', saved: null })).toEqual({ kind: 'keep' });
  });

  it('a change of ?tab=, ?q= or ?view= is the same page: the member stays where they are', () => {
    expect(at({ navigation: 'PUSH', previousPathname: '/matches', pathname: '/matches' })).toEqual({ kind: 'keep' });
    expect(at({ navigation: 'REPLACE', previousPathname: '/search', pathname: '/search' })).toEqual({ kind: 'keep' });
  });

  it('the shell\'s first location in this tab, or after a profile (the profile is outside the shell), is a new page to it', () => {
    expect(at({ navigation: 'PUSH', previousPathname: null })).toEqual({ kind: 'top' });
    expect(at({ navigation: 'POP', previousPathname: null, saved: null })).toEqual({ kind: 'top' });
    expect(at({ navigation: 'POP', previousPathname: null, saved: 1200 })).toEqual({ kind: 'restore', top: 1200 });
  });
});

describe('the places the page area was scrolled to, kept by history entry', () => {
  it('gives back the place saved for an entry and its address, and nothing for another entry or another address', () => {
    const memory = new ScrollMemory(null);
    memory.remember('k1', '/', 640);
    memory.remember('k2', '/connections?x=1', 80);
    expect(memory.recall('k1', '/')).toBe(640);
    expect(memory.recall('k2', '/connections?x=1')).toBe(80);
    expect(memory.recall('k3', '/')).toBeNull();
    // The first entry of a tab is always called "default", so two addresses can share a key: the address decides.
    expect(memory.recall('k1', '/matches')).toBeNull();
    expect(memory.recall('k2', '/connections')).toBeNull();
  });

  it('keeps the latest place for an entry, whole pixels only, and refuses a place that is not a place', () => {
    const memory = new ScrollMemory(null);
    memory.remember('k', '/', 100);
    memory.remember('k', '/', 412.6);
    expect(memory.recall('k', '/')).toBe(413);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) memory.remember('k', '/', bad);
    expect(memory.recall('k', '/')).toBe(413);
  });

  it('holds the most recent places only, so a long session cannot grow it without end', () => {
    const memory = new ScrollMemory(null);
    for (let i = 0; i < REMEMBER_LIMIT + 5; i++) memory.remember(`k${i}`, '/', i + 1);
    expect(memory.recall('k0', '/')).toBeNull();
    expect(memory.recall('k4', '/')).toBeNull();
    expect(memory.recall('k5', '/')).toBe(6);
    expect(memory.recall(`k${REMEMBER_LIMIT + 4}`, '/')).toBe(REMEMBER_LIMIT + 5);
  });

  it('an entry scrolled again counts as the newest, so the page the member is on is the last to go', () => {
    const memory = new ScrollMemory(null, 3);
    memory.remember('a', '/', 1);
    memory.remember('b', '/', 2);
    memory.remember('c', '/', 3);
    memory.remember('a', '/', 11);
    memory.remember('d', '/', 4);
    expect(memory.recall('b', '/')).toBeNull();
    expect(memory.recall('a', '/')).toBe(11);
  });

  it('survives a reload and a page the browser throws away (sessionStorage), and the shell coming back from a profile', () => {
    const store = new FakeStore();
    const first = new ScrollMemory(store);
    first.remember('k1', '/', 640);
    first.remember('k2', '/connections', 80);
    first.save();
    expect(store.data.has(STORAGE_KEY)).toBe(true);
    const later = new ScrollMemory(store);
    expect(later.recall('k1', '/')).toBe(640);
    expect(later.recall('k2', '/connections')).toBe(80);
  });

  it('reads nothing from storage it does not recognise, and keeps what is good in storage it partly does', () => {
    const store = new FakeStore();
    for (const junk of ['not json', '{}', '"text"', 'null', '[1,2,3]', '[["k","/",-5]]', '[["k","/","x"]]', '[["k",7,10]]']) {
      store.data.set(STORAGE_KEY, junk);
      expect(new ScrollMemory(store).recall('k', '/')).toBeNull();
    }
    store.data.set(STORAGE_KEY, JSON.stringify([['bad', '/', -1], ['ok', '/', 50], ['worse', 5, 5]]));
    const memory = new ScrollMemory(store);
    expect(memory.recall('ok', '/')).toBe(50);
    expect(memory.recall('bad', '/')).toBeNull();
  });

  it('forgets an entry on request, and writes the rest', () => {
    const store = new FakeStore();
    const memory = new ScrollMemory(store);
    memory.remember('default', '/', 900);
    memory.remember('k2', '/matches', 40);
    memory.forget('default');
    memory.forget('never-saved');
    memory.save();
    expect(memory.recall('default', '/')).toBeNull();
    const later = new ScrollMemory(store);
    expect(later.recall('default', '/')).toBeNull();
    expect(later.recall('k2', '/matches')).toBe(40);
  });

  it('a page loaded as something new starts at its top: only a reload, or Back into the document, is the entry it was', () => {
    expect(loadedAsSameEntry('reload')).toBe(true);
    expect(loadedAsSameEntry('back_forward')).toBe(true);
    // A URL typed in, a link, a bookmark, a pre-rendered page, and a browser that does not say.
    for (const type of ['navigate', 'prerender', '', undefined]) expect(loadedAsSameEntry(type)).toBe(false);
    // And the hook's file acts on it once, when the document loads, for the entry every tab starts with.
    const src = clientFile('features/reason/shell/useMainScrollMemory.ts');
    expect(src).toMatch(/if \(!loadedAsSameEntry\(loaded\?\.type\)\) \{\s*mainScroll\.forget\('default'\);\s*mainScroll\.save\(\);\s*\}/);
  });

  it('works with no storage at all (private mode, a blocked frame), and when storage refuses a write', () => {
    const memory = new ScrollMemory(null);
    memory.remember('k', '/', 5);
    expect(() => memory.save()).not.toThrow();
    expect(memory.recall('k', '/')).toBe(5);
    const full: ScrollStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    const refusing = new ScrollMemory(full);
    refusing.remember('k', '/', 7);
    expect(() => refusing.save()).not.toThrow();
    expect(refusing.recall('k', '/')).toBe(7);
  });
});

/** A page area whose height the test controls, and a clock and frame loop it steps by hand. */
function stage(content: number, view = 600) {
  const area = {
    scrollHeight: content,
    clientHeight: view,
    placed: [] as number[],
    scrollTo(o: { top: number; left: number; behavior: 'instant' }) { area.placed.push(o.top); },
  };
  let time = 0;
  let nextId = 1;
  const waiting = new Map<number, () => void>();
  const frames: Frames = {
    now: () => time,
    request: (cb) => { const id = nextId++; waiting.set(id, cb); return id; },
    cancel: (id) => { waiting.delete(id); },
  };
  /** One frame later: `ms` pass and whatever asked for a frame runs. */
  const frame = (ms = 16) => { time += ms; const due = [...waiting.entries()]; waiting.clear(); due.forEach(([, cb]) => cb()); };
  return { area: area as ScrollArea & { placed: number[] }, frames, frame, waiting };
}

describe('putting the page area back where it was, when the page may still be on its way', () => {
  it('a page already tall enough is placed at once, before the first frame is drawn, and nothing is left waiting', () => {
    const s = stage(2000);
    const ended: string[] = [];
    placeScroll(s.area, 640, s.frames, (how) => { ended.push(how); });
    expect(s.area.placed).toEqual([640]);
    expect(ended).toEqual(['placed']);
    expect(s.waiting.size).toBe(0);
  });

  it('a page still loading is tried again on every frame, and placed the frame it is tall enough', () => {
    const s = stage(700);
    const ended: string[] = [];
    placeScroll(s.area, 640, s.frames, (how) => { ended.push(how); });
    expect(s.area.placed).toEqual([]);
    expect(ended).toEqual([]);
    s.frame();
    s.frame();
    expect(s.area.placed).toEqual([]);
    s.area.scrollHeight = 1400;
    s.frame();
    expect(s.area.placed).toEqual([640]);
    expect(ended).toEqual(['placed']);
    expect(s.waiting.size).toBe(0);
  });

  it('a page that never gets tall enough is placed as far as it goes once the wait is over, and never later', () => {
    const s = stage(700);
    const ended: string[] = [];
    placeScroll(s.area, 5000, s.frames, (how) => { ended.push(how); });
    for (let t = 0; t < RESTORE_WAIT_MS - 100; t += 100) s.frame(100);
    expect(s.area.placed).toEqual([]);
    s.frame(300);
    expect(s.area.placed).toEqual([5000]);
    // Told that it gave up, so that the page area is left alone until the member touches it.
    expect(ended).toEqual(['gave-up']);
    s.frame(100);
    expect(s.area.placed).toEqual([5000]);
  });

  it('the member scrolling first stops it: the page is not moved under their finger, and it is told it is over once', () => {
    const s = stage(700);
    const ended: string[] = [];
    const stop = placeScroll(s.area, 640, s.frames, (how) => { ended.push(how); });
    s.frame();
    stop();
    stop();
    s.area.scrollHeight = 5000;
    s.frame();
    expect(s.area.placed).toEqual([]);
    expect(ended).toEqual(['stopped']);
    expect(s.waiting.size).toBe(0);
  });

  it('stopping after it has finished changes nothing', () => {
    const s = stage(2000);
    const ended: string[] = [];
    const stop = placeScroll(s.area, 100, s.frames, (how) => { ended.push(how); });
    stop();
    expect(s.area.placed).toEqual([100]);
    expect(ended).toEqual(['placed']);
  });
});

describe('a move made by this code is not the member scrolling', () => {
  it('the scroll event that follows a move arrives within a frame or two; after two frames a scroll is the member\'s again', () => {
    const s = stage(2000);
    const own = new OwnScrolls(s.frames);
    expect(own.active).toBe(false);
    own.mark();
    expect(own.active).toBe(true);
    s.frame();
    expect(own.active).toBe(true);
    s.frame();
    expect(own.active).toBe(false);
    expect(s.waiting.size).toBe(0);
  });

  it('a second move before the first has run out starts the two frames again, and leaves nothing waiting twice', () => {
    const s = stage(2000);
    const own = new OwnScrolls(s.frames);
    own.mark();
    s.frame();
    own.mark();
    s.frame();
    expect(own.active).toBe(true);
    s.frame();
    expect(own.active).toBe(false);
    expect(s.waiting.size).toBe(0);
  });

  it('a restore that gives up on a page that stayed short leaves the place alone: its own move, and what the page does as it fills, are not the member scrolling; the member\'s next touch is', () => {
    // What the hook does, with its parts: the listener records the area's place unless a restore is waiting, a restore gave up and
    // the member has not touched the page since, or the move was ours.
    const memory = new ScrollMemory(null);
    memory.remember('k', '/', 1200);
    const s = stage(700);
    const own = new OwnScrolls(s.frames);
    let settling = true;
    let waitingForMember = false;
    const onScroll = (top: number) => { if (!settling && !waitingForMember && !own.active) memory.remember('k', '/', top); };
    const onMemberInput = () => { waitingForMember = false; };
    const mover: ScrollArea = {
      get scrollHeight() { return s.area.scrollHeight; },
      get clientHeight() { return s.area.clientHeight; },
      scrollTo: (options) => { own.mark(); s.area.scrollTo(options); },
    };
    placeScroll(mover, 1200, s.frames, (how) => { settling = false; waitingForMember = how === 'gave-up'; });
    for (let t = 0; t < RESTORE_WAIT_MS - 100; t += 100) s.frame(100);
    s.frame(300);
    // It gave up: the area was told to go to 1200, and the browser clamped it to what the page has.
    expect(s.area.placed).toEqual([1200]);
    expect(settling).toBe(false);
    onScroll(2);
    expect(memory.recall('k', '/')).toBe(1200);
    // The list arrives much later, long after the two frames a move of ours is allowed, and the browser sets the area to the top
    // (WebKit did: it was the place the next Back landed on).
    for (let i = 0; i < 20; i++) s.frame(200);
    expect(own.active).toBe(false);
    onScroll(0);
    expect(memory.recall('k', '/')).toBe(1200);
    // The member touches the page, and what they scroll to is recorded.
    onMemberInput();
    onScroll(80);
    expect(memory.recall('k', '/')).toBe(80);
  });

  it('a restore that reached its place, or that the member ended, does not leave the page waiting for the member', () => {
    for (const [content, stopFirst] of [[2000, false], [700, true]] as const) {
      const s = stage(content);
      let waitingForMember = true;
      const stop = placeScroll(s.area, 640, s.frames, (how) => { waitingForMember = how === 'gave-up'; });
      if (stopFirst) stop();
      expect({ content, stopFirst, waitingForMember }).toEqual({ content, stopFirst, waitingForMember: false });
    }
  });
});

describe('the shell uses it', () => {
  const shell = clientFile('features/reason/shell/ReasonShell.tsx');
  const hook = clientFile('features/reason/shell/useMainScrollMemory.ts');

  it('<main> keeps its place through useMainScrollMemory(main), and the unconditional jump to the top is gone', () => {
    expect(shell).toMatch(/import useMainScrollMemory from '\.\/useMainScrollMemory';/);
    expect(shell).toMatch(/useMainScrollMemory\(main\);/);
    expect(shell).not.toMatch(/scrollTo\(\{ top: 0/);
    expect(shell).not.toMatch(/useLayoutEffect/);
  });

  it('the hook keys the place by history entry and address, records on scroll, and places before paint on every new location', () => {
    expect(hook).toMatch(/useNavigationType\(\)/);
    expect(hook).toMatch(/useLocation\(\)/);
    expect(hook).toMatch(/useLayoutEffect\(/);
    expect(hook).toMatch(/addEventListener\('scroll'/);
    expect(hook).toMatch(/mainScroll\.recall\(key, address\)/);
    expect(hook).toMatch(/mainScroll\.remember\(/);
    expect(hook).toMatch(/placeScroll\(/);
    // The app scrolls smoothly (index.css), and a smooth restore would be seen travelling.
    expect(clientFile('features/reason/shell/scroll-memory.ts')).toMatch(/behavior: 'instant'/);
  });

  it('what the page area does on its own while it is being placed (a short page clamping it to the top) is not the member scrolling', () => {
    expect(hook).toMatch(/settling\.current/);
    // Only the member stops it, and only by touching the page area.
    for (const input of ['wheel', 'touchstart', 'keydown', 'pointerdown']) expect(hook).toContain(`'${input}'`);
  });

  it('every move the hook makes marks itself as its own, and the scroll listener skips a scroll that is one', () => {
    expect(hook).toMatch(/const ours = useRef\(new OwnScrolls\(FRAMES\)\);/);
    expect(hook).toMatch(/scrollTo: \(options\) => \{\s*ours\.current\.mark\(\);\s*area\.scrollTo\(options\);\s*\}/);
    expect(hook).toMatch(/if \(settling\.current \|\| waitingForMember\.current \|\| ours\.current\.active\) return;/);
    // A restore that gave up waits for the member; the member's touch, anywhere in the page, ends the wait and any restore still going.
    expect(hook).toMatch(/waitingForMember\.current = how === 'gave-up';/);
    expect(hook).toMatch(/const onMemberInput = \(\) => \{\s*waitingForMember\.current = false;\s*stopRestore\.current\(\);\s*\};/);
    expect(hook).toMatch(/document\.addEventListener\(event, onMemberInput, \{ capture: true, passive: true \}\)/);
    // The restore and the jump to a new page's top both go through it: the one scrollTo of the area is inside it.
    expect(hook).toMatch(/placeScroll\(mover, action\.top, FRAMES, release\)/);
    expect(hook).toMatch(/mover\.scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/);
    expect(hook.match(/area\.scrollTo\(/g)).toHaveLength(1);
  });

  it('scroll-memory.ts is pure: no global or DOM word in its code, and nothing runs when it is loaded (the memory and the load check are in the hook\'s file)', () => {
    const code = clientFile('features/reason/shell/scroll-memory.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(window|document|globalThis|performance|sessionStorage|localStorage|requestAnimationFrame)\b/);
    // No statement at the top level but declarations: no instance made, no if.
    expect(code).not.toMatch(/^(?:export )?(?:const|let|var) \w+ = new /m);
    expect(code).not.toMatch(/^if \(/m);
    expect(code).not.toMatch(/mainScroll/);
    expect(hook).toMatch(/const mainScroll = new ScrollMemory\(sessionStore\(\)\);/);
  });

  it('the places are saved when the page is hidden or left, not only on a timer', () => {
    expect(hook).toMatch(/'pagehide'/);
    expect(hook).toMatch(/'visibilitychange'/);
  });
});
