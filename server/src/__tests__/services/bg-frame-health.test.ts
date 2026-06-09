// Behavioral unit test for the background-effects degrade ladder. The logic
// lives in the client but is import-free, so the server jest suite can run it
// directly (the client has no test runner of its own). See
// client/src/lib/bgFrameHealth.ts for why the effect must self-disable.
import {
  evaluateFrameHealth,
  createFrameHealthMonitor,
  BG_HEALTH_WINDOW,
  BG_FRAME_BUDGET_MS,
  BG_WATCHDOG_MS,
  BG_WARMUP_FRAMES,
} from '../../../../client/src/lib/bgFrameHealth';

// All monitor scenarios must first get past the warmup grace (the first frames
// are ignored). Feed benign warmup frames before exercising the real behaviour.
const warmup = (mon: (s: { processingTimeMs: number }) => void) => {
  for (let i = 0; i < BG_WARMUP_FRAMES; i++) mon({ processingTimeMs: 5 });
};

describe('evaluateFrameHealth (pure ladder)', () => {
  it('stays ok while breach ratio is within budget', () => {
    expect(evaluateFrameHealth(0, { reduced: false })).toBe('ok');
    expect(evaluateFrameHealth(0.3, { reduced: false })).toBe('ok'); // boundary inclusive
    expect(evaluateFrameHealth(0.3, { reduced: true })).toBe('ok');
  });

  it('steps down (reduce) on first sustained breach, then disables if still bad', () => {
    expect(evaluateFrameHealth(0.5, { reduced: false })).toBe('reduce');
    expect(evaluateFrameHealth(0.5, { reduced: true })).toBe('disable');
  });
});

describe('createFrameHealthMonitor', () => {
  const feed = (mon: (s: { processingTimeMs: number }) => void, ms: number, n: number) => {
    for (let i = 0; i < n; i++) mon({ processingTimeMs: ms });
  };

  it('does nothing while frames are within budget', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    warmup(mon);
    feed(mon, BG_FRAME_BUDGET_MS - 10, BG_HEALTH_WINDOW * 3);
    expect(onReduce).not.toHaveBeenCalled();
    expect(onDisable).not.toHaveBeenCalled();
  });

  it('ignores slow warmup frames (cold start must not disable the effect)', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    // Every warmup frame is catastrophically slow (model load / shader compile)...
    for (let i = 0; i < BG_WARMUP_FRAMES; i++) mon({ processingTimeMs: BG_WATCHDOG_MS + 200 });
    // ...then it settles fast. Nothing should have fired.
    feed(mon, 12, BG_HEALTH_WINDOW * 2);
    expect(onReduce).not.toHaveBeenCalled();
    expect(onDisable).not.toHaveBeenCalled();
  });

  it('reduces once on a sustained breach, then disables on a second sustained breach', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    warmup(mon);

    // First full window of over-budget frames → one reduce, no disable yet.
    feed(mon, BG_FRAME_BUDGET_MS + 30, BG_HEALTH_WINDOW);
    expect(onReduce).toHaveBeenCalledTimes(1);
    expect(onDisable).not.toHaveBeenCalled();

    // Second full window still over budget → disable, and reduce never re-fires.
    feed(mon, BG_FRAME_BUDGET_MS + 30, BG_HEALTH_WINDOW);
    expect(onDisable).toHaveBeenCalledTimes(1);
    expect(onReduce).toHaveBeenCalledTimes(1);
  });

  it('ignores brief spikes below the breach ratio', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    warmup(mon);
    // 20% of frames over budget (< 30% threshold) → no action.
    for (let i = 0; i < BG_HEALTH_WINDOW * 2; i++) {
      mon({ processingTimeMs: i % 5 === 0 ? BG_FRAME_BUDGET_MS + 40 : 10 });
    }
    expect(onReduce).not.toHaveBeenCalled();
    expect(onDisable).not.toHaveBeenCalled();
  });

  it('after warmup, TWO consecutive catastrophic frames disable immediately, skipping reduce', () => {
    // 2026-06-09: changed from one frame to two-in-a-row so a single mobile
    // jank spike (GC pause / tab wake) doesn't nuke the background. The render
    // loop already drops frames, so the never-freeze guarantee still holds.
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    warmup(mon);
    mon({ processingTimeMs: BG_WATCHDOG_MS + 50 });
    expect(onDisable).not.toHaveBeenCalled(); // one spike is tolerated
    mon({ processingTimeMs: BG_WATCHDOG_MS + 50 });
    expect(onDisable).toHaveBeenCalledTimes(1); // two in a row kills it
    expect(onReduce).not.toHaveBeenCalled();
  });

  it('a lone catastrophic frame followed by a healthy one does NOT disable', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable, budgetMs: 100 });
    warmup(mon);
    mon({ processingTimeMs: 400 });  // spike
    mon({ processingTimeMs: 30 });   // recovers — resets the catastrophic counter
    mon({ processingTimeMs: 400 });  // another lone spike
    expect(onDisable).not.toHaveBeenCalled();
  });

  it('is inert after disabling (handlers fire at most once)', () => {
    const onReduce = jest.fn();
    const onDisable = jest.fn();
    const mon = createFrameHealthMonitor({ onReduce, onDisable });
    warmup(mon);
    mon({ processingTimeMs: BG_WATCHDOG_MS + 50 });
    feed(mon, BG_WATCHDOG_MS + 50, 100);
    expect(onDisable).toHaveBeenCalledTimes(1);
  });
});
