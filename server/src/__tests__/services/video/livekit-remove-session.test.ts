// ─── Taking one connection out of a LiveKit room (2 Nov 2026, leave fix round 3) ─────────────────────────────────
//
// A member who leaves a 1:1 call also asks our server to take them out of the room, so the person still in it is told
// even when the leave the browser sent never reached LiveKit. The server removes only the very connection that left
// (its participant sid): if the member has already come back in, the new connection has a new sid and stays.

import { jest } from '@jest/globals';

const mockGetParticipant = jest.fn<(room: string, identity: string) => Promise<{ sid: string }>>();
const mockRemoveParticipant = jest.fn<(room: string, identity: string) => Promise<void>>();

jest.mock('livekit-server-sdk', () => ({
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    getParticipant: mockGetParticipant,
    removeParticipant: mockRemoveParticipant,
  })),
  AccessToken: jest.fn(),
  TrackSource: { CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 },
}));

jest.mock('../../../config', () => {
  const cfg = { livekit: { host: 'wss://test.livekit.cloud', apiKey: 'test', apiSecret: 'test' } };
  return { __esModule: true, default: cfg, config: cfg };
});
jest.mock('../../../config/logger', () => ({
  __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { LiveKitProvider } from '../../../services/video/livekit.provider';

describe('LiveKitProvider.removeParticipantIfSession', () => {
  let provider: LiveKitProvider;
  beforeEach(() => {
    mockGetParticipant.mockReset();
    mockRemoveParticipant.mockReset();
    mockRemoveParticipant.mockResolvedValue(undefined);
    provider = new LiveKitProvider();
  });

  it('removes the member when the connection in the room is the one that left', async () => {
    mockGetParticipant.mockResolvedValueOnce({ sid: 'PA_left' });
    await expect(provider.removeParticipantIfSession('dm-c1', 'u-ana', 'PA_left')).resolves.toBe(true);
    expect(mockGetParticipant).toHaveBeenCalledWith('dm-c1', 'u-ana');
    expect(mockRemoveParticipant).toHaveBeenCalledWith('dm-c1', 'u-ana');
  });

  it('leaves a newer connection alone: the member has already come back in', async () => {
    mockGetParticipant.mockResolvedValueOnce({ sid: 'PA_new' });
    await expect(provider.removeParticipantIfSession('dm-c1', 'u-ana', 'PA_left')).resolves.toBe(false);
    expect(mockRemoveParticipant).not.toHaveBeenCalled();
  });

  it.each([
    ['the member is no longer in the room', Object.assign(new Error('participant not found'), { code: 'not_found' })],
    ['the room has gone', Object.assign(new Error('requested room does not exist'), { code: 5 })],
  ])('answers false when %s', async (_what, err) => {
    mockGetParticipant.mockRejectedValueOnce(err);
    await expect(provider.removeParticipantIfSession('dm-c1', 'u-ana', 'PA_left')).resolves.toBe(false);
    expect(mockRemoveParticipant).not.toHaveBeenCalled();
  });

  it('answers false when the member left on their own between the read and the removal', async () => {
    mockGetParticipant.mockResolvedValueOnce({ sid: 'PA_left' });
    mockRemoveParticipant.mockRejectedValueOnce(Object.assign(new Error('participant not found'), { code: 'not_found' }));
    await expect(provider.removeParticipantIfSession('dm-c1', 'u-ana', 'PA_left')).resolves.toBe(false);
  });

  it('passes any other failure on', async () => {
    mockGetParticipant.mockRejectedValueOnce(Object.assign(new Error('internal error'), { status: 500 }));
    await expect(provider.removeParticipantIfSession('dm-c1', 'u-ana', 'PA_left')).rejects.toThrow('internal error');
  });
});
