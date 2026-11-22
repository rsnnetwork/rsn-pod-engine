// ─── Pods inside pods: who is told (22 Nov 2026, realtime/fanout-nesting.ts) ─────────────────────────────────────
//
// A pod made inside, put inside or taken out, or a main pod's members-only choice: each named pod's people get
// pod:<id>, pod:<id>:inner-pods and their own user:<id>:pods. A change to a pod itself: its main pod's people get the
// main pod's inner-pods tag, and each pod inside it its own tag. Without a socket server nothing is read, and a failure
// never reaches the caller (the change is saved before anyone is told).

const mockEmit = jest.fn().mockResolvedValue(undefined);
let mockIo: unknown = {};
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => mockIo,
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import { fanoutNestingChange, fanoutPodRelatives, readPodRelatives } from '../../realtime/fanout-nesting';

const audiences: Record<string, string[]> = { main: ['dir', 'ana'], child: ['ben'], in1: ['cara'], in2: [] };
let relatives: { parent_pod_id: string | null; inner_ids: string[] } | null;

beforeEach(() => {
  mockEmit.mockClear();
  mockIo = {};
  relatives = null;
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/FROM pod_members WHERE pod_id = \$1 AND status NOT IN/.test(String(sql).replace(/\s+/g, ' '))) {
      return { rows: (audiences[String(params[0])] ?? []).map((user_id) => ({ user_id })) };
    }
    if (/SELECT p\.parent_pod_id/.test(String(sql))) return { rows: relatives ? [relatives] : [] };
    throw new Error(`unmodelled: ${sql}`);
  });
});

describe('fanoutNestingChange', () => {
  it('tells each named pod\'s people the pod, its pods inside and their own pods list, once per pod', async () => {
    await fanoutNestingChange(['main', 'child', null, 'main']);
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledWith(mockIo, ['dir', 'ana'], expect.arrayContaining([
      'pod:main', 'pod:main:members', 'pod:main:invites', 'pod:main:inner-pods', 'user:dir:pods', 'user:ana:pods',
    ]));
    expect(mockEmit).toHaveBeenCalledWith(mockIo, ['ben'], expect.arrayContaining(['pod:child', 'pod:child:inner-pods', 'user:ben:pods']));
  });

  it('reads nothing without a socket server', async () => {
    mockIo = null;
    await fanoutNestingChange(['main']);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('fanoutPodRelatives', () => {
  it('tells the main pod\'s people its pods inside, and each pod inside a main pod its own tag', async () => {
    relatives = { parent_pod_id: 'main', inner_ids: [] };
    await fanoutPodRelatives('child');
    expect(mockEmit).toHaveBeenCalledWith(mockIo, ['dir', 'ana'], expect.arrayContaining(['pod:main:inner-pods']));
    mockEmit.mockClear();
    relatives = { parent_pod_id: null, inner_ids: ['in1', 'in2'] };
    await fanoutPodRelatives('main');
    expect(mockEmit).toHaveBeenCalledWith(mockIo, ['cara'], expect.arrayContaining(['pod:in1', 'user:cara:pods']));
  });

  it('a pod that stands alone and holds none tells nobody more', async () => {
    relatives = { parent_pod_id: null, inner_ids: [] };
    await fanoutPodRelatives('alone');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(fanoutPodRelatives('main')).resolves.toBeUndefined();
    await expect(fanoutNestingChange(['main'])).resolves.toBeUndefined();
  });

  it('readPodRelatives reads the main pod and the pods inside in one bounded statement', async () => {
    relatives = { parent_pod_id: 'main', inner_ids: ['in1'] };
    expect(await readPodRelatives('child')).toEqual({ parentId: 'main', innerIds: ['in1'] });
    relatives = null;
    expect(await readPodRelatives('gone')).toEqual({ parentId: null, innerIds: [] });
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/LIMIT 500/);
  });
});
