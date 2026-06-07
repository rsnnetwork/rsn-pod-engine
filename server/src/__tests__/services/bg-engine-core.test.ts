// Behavioral tests for the event-scoped BG engine CORE (pure logic, no livekit
// imports — same pattern as bg-frame-health.test.ts). The core guarantees that
// killed the 2026-06-07 prod findings:
//   • applies are SERIALIZED and latest-wins (no orphaned double pipelines)
//   • UI state always reconciles to the pipeline's ACTUAL outcome, even when an
//     op finishes long after the user clicked (the bg_timeout divergence bug)
//   • a genuinely hung op hard-fails through one watchdog instead of silently
//     abandoning a still-attaching processor
//   • device profile picks adaptive fps (Zoom-style) per device class
import {
  createApplyQueue,
  pickBgProfile,
  type ApplyExecutor,
} from '../../../../client/src/lib/bgEngineCore';
import type { BgPreference } from '../../../../client/src/lib/bgPreference';

const PREF_BLUR: BgPreference = { mode: 'blur' };
const PREF_OFFICE: BgPreference = { mode: 'image', imageUrl: '/backgrounds/office.jpg' };
const PREF_NATURE: BgPreference = { mode: 'image', imageUrl: '/backgrounds/nature.jpg' };
const PREF_OFF: BgPreference = { mode: 'disabled' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Instrumented executor: records ops, controllable latency/failure per op. */
function makeExecutor(opts: { buildMs?: number; switchMs?: number } = {}) {
  const ops: string[] = [];
  let pipeline = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let failNext: 'build' | 'switch' | null = null;
  let hangNext: 'build' | 'switch' | null = null;
  const exec: ApplyExecutor = {
    hasPipeline: () => pipeline,
    dropPipeline: () => { pipeline = false; ops.push('drop'); },
    build: async (pref) => {
      ops.push(`build:${pref.mode === 'image' ? pref.imageUrl : pref.mode}`);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hangNext === 'build') { hangNext = null; await sleep(500); } // hangs well past the test watchdog
        await sleep(opts.buildMs ?? 5);
        if (failNext === 'build') { failNext = null; throw new Error('build_failed'); }
        pipeline = true;
      } finally { inFlight--; }
    },
    switchTo: async (pref) => {
      ops.push(`switch:${pref.mode === 'image' ? pref.imageUrl : pref.mode}`);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hangNext === 'switch') { hangNext = null; await sleep(500); }
        await sleep(opts.switchMs ?? 2);
        if (failNext === 'switch') { failNext = null; throw new Error('switch_failed'); }
      } finally { inFlight--; }
    },
  };
  return {
    exec, ops,
    getMaxInFlight: () => maxInFlight,
    setPipeline: (v: boolean) => { pipeline = v; },
    failNextOp: (k: 'build' | 'switch') => { failNext = k; },
    hangNextOp: (k: 'build' | 'switch') => { hangNext = k; },
  };
}

describe('pickBgProfile (adaptive quality table)', () => {
  it('full-power desktop gets 15fps', () => {
    expect(pickBgProfile({ isMobile: false, cores: 8, deviceMemoryGB: 16, modernApi: true }))
      .toEqual({ maxFps: 15, reducedFps: 10 });
  });
  it('weak desktop steps to 12fps', () => {
    expect(pickBgProfile({ isMobile: false, cores: 4, deviceMemoryGB: 8, modernApi: true }).maxFps).toBe(12);
    expect(pickBgProfile({ isMobile: false, cores: 8, deviceMemoryGB: 4, modernApi: true }).maxFps).toBe(12);
  });
  it('mobile gets 10fps', () => {
    expect(pickBgProfile({ isMobile: true, cores: 8, deviceMemoryGB: 6, modernApi: true }))
      .toEqual({ maxFps: 10, reducedFps: 7 });
  });
  it('fallback path (no modern API, e.g. Safari) gets the lightest profile', () => {
    expect(pickBgProfile({ isMobile: false, cores: 12, deviceMemoryGB: 16, modernApi: false }))
      .toEqual({ maxFps: 8, reducedFps: 5 });
  });
});

describe('createApplyQueue — serialization + reconcile-to-outcome', () => {
  it('first enabled apply builds the pipeline and lands', async () => {
    const m = makeExecutor();
    const q = createApplyQueue(m.exec, {});
    const res = await q.request(PREF_BLUR);
    expect(res).toBe('applied');
    expect(m.ops).toEqual(['build:blur']);
    expect(q.state().currentPref).toEqual(PREF_BLUR);
    expect(q.state().applying).toBe(false);
  });

  it('apply with a live pipeline uses switchTo, never a rebuild', async () => {
    const m = makeExecutor();
    m.setPipeline(true);
    const q = createApplyQueue(m.exec, {});
    await q.request(PREF_OFFICE);
    expect(m.ops).toEqual(['switch:/backgrounds/office.jpg']);
  });

  it('"None" with a live pipeline switches to passthrough and KEEPS the pipeline warm', async () => {
    const m = makeExecutor();
    const q = createApplyQueue(m.exec, {});
    await q.request(PREF_BLUR);   // builds the pipeline
    await q.request(PREF_OFF);    // user turns BG off mid-event
    expect(m.ops).toEqual(['build:blur', 'switch:disabled']);
    expect(m.exec.hasPipeline()).toBe(true); // no destroy — re-enable stays instant
    expect(q.state().currentPref).toEqual(PREF_OFF);
    // ...and re-enable is a switch, not a rebuild
    await q.request(PREF_OFFICE);
    expect(m.ops[2]).toBe('switch:/backgrounds/office.jpg');
  });

  it('"None" with no pipeline resolves instantly without touching the executor', async () => {
    const m = makeExecutor();
    const q = createApplyQueue(m.exec, {});
    const res = await q.request(PREF_OFF);
    expect(res).toBe('applied');
    expect(m.ops).toEqual([]);
  });

  it('rapid clicks during a slow build: latest wins, intermediates superseded, ops never overlap', async () => {
    const m = makeExecutor({ buildMs: 40 });
    const q = createApplyQueue(m.exec, {});
    const p1 = q.request(PREF_BLUR);     // starts the slow build
    await sleep(5);
    const p2 = q.request(PREF_OFFICE);   // queued
    const p3 = q.request(PREF_NATURE);   // supersedes p2
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('applied');          // blur DID land (it built the pipeline)
    expect(r2).toBe('superseded');       // office never executed
    expect(r3).toBe('applied');          // nature is the final state
    expect(m.ops).toEqual(['build:blur', 'switch:/backgrounds/nature.jpg']);
    expect(q.state().currentPref).toEqual(PREF_NATURE);
    expect(m.getMaxInFlight()).toBe(1);  // serialization invariant
  });

  it('a slow op that finishes after the user moved on still reconciles to the LAST desired pref', async () => {
    const m = makeExecutor({ buildMs: 50 });
    const q = createApplyQueue(m.exec, {});
    const p1 = q.request(PREF_OFFICE);
    await sleep(10);
    const p2 = q.request(PREF_OFF); // user gave up mid-build → must end disabled
    await Promise.all([p1, p2]);
    expect(q.state().currentPref).toEqual(PREF_OFF);
    expect(m.ops).toEqual(['build:/backgrounds/office.jpg', 'switch:disabled']);
  });

  it('executor failure rolls desired back to current and reports failed', async () => {
    const m = makeExecutor();
    const onError = jest.fn();
    const q = createApplyQueue(m.exec, { onError });
    m.failNextOp('build');
    const res = await q.request(PREF_BLUR);
    expect(res).toBe('failed');
    expect(q.state().currentPref).toEqual(PREF_OFF);
    expect(q.state().desiredPref).toEqual(PREF_OFF); // no zombie "wanted" state
    expect(q.state().applying).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('a hung op trips the watchdog exactly once: hard-fail, pipeline dropped, queue stays usable', async () => {
    const m = makeExecutor();
    const onHardFail = jest.fn();
    const q = createApplyQueue(m.exec, { onHardFail }, { watchdogMs: 30 });
    m.hangNextOp('build');
    const res = await q.request(PREF_BLUR);
    expect(res).toBe('failed');
    expect(onHardFail).toHaveBeenCalledTimes(1);
    expect(m.ops).toContain('drop'); // shell told to dispose the wedged pipeline
    // queue recovers: a later apply builds fresh
    const res2 = await q.request(PREF_OFFICE);
    expect(res2).toBe('applied');
    expect(q.state().currentPref).toEqual(PREF_OFFICE);
  });

  it('prewarm builds a passthrough pipeline so the first real apply is an instant switch', async () => {
    const m = makeExecutor();
    const q = createApplyQueue(m.exec, {});
    await q.prewarm(); // panel opened — build while the user is still choosing
    expect(m.ops).toEqual(['build:disabled']);
    expect(q.state().currentPref).toEqual(PREF_OFF); // visually nothing changed
    await q.request(PREF_OFFICE);
    expect(m.ops[1]).toBe('switch:/backgrounds/office.jpg'); // not a build
  });

  it('prewarm is a no-op when a pipeline exists or an op is running', async () => {
    const m = makeExecutor({ buildMs: 30 });
    const q = createApplyQueue(m.exec, {});
    const p = q.request(PREF_BLUR);
    await q.prewarm();            // mid-build → must not double-build
    await p;
    await q.prewarm();            // pipeline live → no-op
    expect(m.ops).toEqual(['build:blur']);
    expect(m.getMaxInFlight()).toBe(1);
  });

  it('notePipelineLost resets current so the same pref re-applies with a fresh build', async () => {
    const m = makeExecutor();
    const q = createApplyQueue(m.exec, {});
    await q.request(PREF_BLUR);
    // shell disposed the pipeline outside the queue (track died / self-heal)
    m.setPipeline(false);
    q.notePipelineLost();
    expect(q.state().currentPref).toEqual(PREF_OFF); // reality: raw camera
    const res = await q.request(PREF_BLUR);          // same pref must NOT no-op
    expect(res).toBe('applied');
    expect(m.ops).toEqual(['build:blur', 'build:blur']);
  });

  it('re-applying the current pref is a no-op', async () => {
    const m = makeExecutor();
    m.setPipeline(true);
    const q = createApplyQueue(m.exec, {});
    await q.request(PREF_BLUR);
    m.ops.length = 0;
    const res = await q.request(PREF_BLUR);
    expect(res).toBe('applied');
    expect(m.ops).toEqual([]);
  });

  it('notifies state changes (applying flag) around ops', async () => {
    const m = makeExecutor({ buildMs: 20 });
    const seen: boolean[] = [];
    const q = createApplyQueue(m.exec, { onStateChange: (s) => seen.push(s.applying) });
    await q.request(PREF_BLUR);
    expect(seen).toContain(true);               // applying was visible to the UI
    expect(seen[seen.length - 1]).toBe(false);  // and ended cleared
  });
});
