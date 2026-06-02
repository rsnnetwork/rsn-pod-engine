// server/src/__tests__/services/orchestration/phase5-state-snapshot.test.ts
import { SessionStatus } from '@rsn/shared';
const store = new Map<string,string>();
const fakeRedis = { get: jest.fn(async (k:string)=>store.get(k)??null), setex: jest.fn(async (k:string,_t:number,v:string)=>{store.set(k,v);return 'OK';}) };
let handle:any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => handle }));
import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import { buildStateSnapshot } from '../../../services/orchestration/state/state-snapshot';
import { activeSessions } from '../../../services/orchestration/state/session-state';

beforeEach(()=>{ store.clear(); handle=fakeRedis; activeSessions.delete('s5'); });

describe('Phase 5 — buildStateSnapshot', () => {
  it('projects canonical participants into a versioned, client-facing snapshot', async () => {
    await writeCanonical({ sessionId:'s5', status:SessionStatus.ROUND_ACTIVE, currentRound:2, seq:7, hostUserId:'h',
      timer:null, participants:{
        u1:{role:'participant',connState:'connected',location:{type:'breakout',roomId:'r1',matchId:'m1'},lastSeenAt:1,userSeq:7},
        u2:{role:'participant',connState:'disconnected',location:{type:'main'},lastSeenAt:1,userSeq:7},
      }});
    const snap = await buildStateSnapshot('s5');
    expect(snap!.seq).toBe(7);
    expect(snap!.status).toBe(SessionStatus.ROUND_ACTIVE);
    const byId = Object.fromEntries(snap!.participants.map((p: any)=>[p.userId,p]));
    expect(byId.u1.state).toBe('in_room');         // breakout
    expect(byId.u2.state).toBe('disconnected');    // not present
  });

  it('returns null when no canonical doc exists', async () => {
    expect(await buildStateSnapshot('nope')).toBeNull();
  });
});

import * as fs from 'fs'; import * as path from 'path';
describe('Phase 5 — wiring', () => {
  it('emitHostDashboard co-emits the snapshot', () => {
    const src = fs.readFileSync(path.join(__dirname,'../../../services/orchestration/handlers/matching-flow.ts'),'utf8');
    expect(src).toMatch(/emitStateSnapshot\(io,\s*sessionId\)/);
  });
  it('session:resync is registered', () => {
    const src = fs.readFileSync(path.join(__dirname,'../../../services/orchestration/orchestration.service.ts'),'utf8');
    expect(src).toMatch(/session:resync/);
  });
});
