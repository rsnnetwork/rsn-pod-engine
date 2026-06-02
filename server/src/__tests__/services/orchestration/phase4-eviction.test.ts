// ─── Phase 4 — server-side eviction tests ────────────────────────────────────
import { setVideoProvider, evictFromRoom } from '../../../services/video/video.service';

describe('Phase 4 — evictFromRoom', () => {
  const calls: Array<[string,string]> = [];
  beforeEach(() => {
    calls.length = 0;
    setVideoProvider({
      createRoom: async()=>({} as any), closeRoom: async()=>{},
      issueJoinToken: async()=>({ token:'t', livekitUrl:'u', roomId:'r' } as any),
      moveParticipant: async()=>{}, listParticipants: async()=>[], roomExists: async()=>true,
      setParticipantCanPublishAudio: async()=>{},
      removeParticipant: async(roomId:string, userId:string)=>{ calls.push([roomId,userId]); },
    } as any);
  });

  it('calls provider.removeParticipant(roomId, userId)', async () => {
    await evictFromRoom('u1', 'lobby-s1');
    expect(calls).toEqual([['lobby-s1','u1']]);
  });

  it('swallows provider errors (best-effort)', async () => {
    setVideoProvider({ removeParticipant: async()=>{ throw new Error('gone'); } } as any);
    await expect(evictFromRoom('u1','r1')).resolves.toBeUndefined();
  });
});
