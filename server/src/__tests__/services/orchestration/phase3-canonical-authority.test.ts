// server/src/__tests__/services/orchestration/phase3-canonical-authority.test.ts
import { SessionStatus } from '@rsn/shared';
const store = new Map<string,string>();
const fakeRedis = {
  get: jest.fn(async (k:string)=>store.get(k)??null),
  setex: jest.fn(async (k:string,_t:number,v:string)=>{store.set(k,v);return 'OK';}),
};
let handle:any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => handle }));
import { writeCanonical, readCanonical, updateCanonicalParticipant, updateCanonicalSessionStatus, CanonicalSessionState } from '../../../services/orchestration/state/canonical-state';

const base: CanonicalSessionState = { sessionId:'s3', status:SessionStatus.ROUND_ACTIVE, currentRound:1, seq:1, hostUserId:'h', timer:null, participants:{ u1:{role:'participant',connState:'connected',location:{type:'main'},lastSeenAt:1,userSeq:1} } };
beforeEach(()=>{ store.clear(); handle=fakeRedis; jest.clearAllMocks(); });

describe('Phase 3 — canonical mutators', () => {
  it('updateCanonicalParticipant patches one participant and bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u1',{ location:{type:'breakout',roomId:'r1',matchId:'m1'}, connState:'connected' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.location).toEqual({type:'breakout',roomId:'r1',matchId:'m1'});
    expect(doc!.seq).toBe(2);
  });
  it('updateCanonicalParticipant inserts a not-yet-present participant', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u2',{ connState:'connected', location:{type:'main'}, role:'participant' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u2.connState).toBe('connected');
  });
  it('updateCanonicalSessionStatus sets status + bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalSessionStatus('s3', SessionStatus.ROUND_RATING);
    expect((await readCanonical('s3'))!.status).toBe(SessionStatus.ROUND_RATING);
  });
  it('no-ops when the doc does not exist yet (shadow projection will create it)', async () => {
    await expect(updateCanonicalParticipant('nope','u1',{connState:'left'})).resolves.toBeUndefined();
  });
});
