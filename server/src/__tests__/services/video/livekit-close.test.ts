import { jest } from '@jest/globals';

const mockDeleteRoom = jest.fn<() => Promise<void>>();
const mockCreateRoom = jest.fn<(opts: any) => Promise<any>>();
const mockListParticipants = jest.fn<(room: string) => Promise<any[]>>();
const mockUpdateParticipant = jest.fn<(...a: any[]) => Promise<void>>();

jest.mock('livekit-server-sdk', () => ({
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    deleteRoom: mockDeleteRoom,
    createRoom: mockCreateRoom,
    listParticipants: mockListParticipants,
    updateParticipant: mockUpdateParticipant,
  })),
  AccessToken: jest.fn(),
  TrackSource: { CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 },
}));

jest.mock('../../../config', () => {
  const cfg = {
    livekit: { host: 'wss://test.livekit.cloud', apiKey: 'test', apiSecret: 'test' },
  };
  return {
    __esModule: true,
    default: cfg,
    config: cfg,
  };
});

describe('LiveKitProvider.closeRoom', () => {
  let provider: any;
  let logger: any;

  beforeEach(async () => {
    jest.resetModules();
    mockDeleteRoom.mockReset();
    mockCreateRoom.mockReset();

    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    jest.doMock('../../../config/logger', () => ({ __esModule: true, default: logger }));

    const mod = await import('../../../services/video/livekit.provider');
    provider = new mod.LiveKitProvider();
  });

  it('treats "requested room does not exist" as already-deleted (debug, no throw)', async () => {
    const err: any = new Error('requested room does not exist');
    err.code = 5;
    mockDeleteRoom.mockRejectedValueOnce(err);

    await expect(provider.closeRoom('match-abc-r1-xyz')).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'match-abc-r1-xyz' }),
      expect.stringContaining('already deleted')
    );
  });

  it('treats "not found" (legacy string) as already-deleted', async () => {
    mockDeleteRoom.mockRejectedValueOnce(new Error('room not found'));
    await expect(provider.closeRoom('test-room')).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still throws on real errors (e.g. permission denied)', async () => {
    mockDeleteRoom.mockRejectedValueOnce(new Error('permission denied'));
    await expect(provider.closeRoom('test-room')).rejects.toThrow('permission denied');
    expect(logger.error).toHaveBeenCalled();
  });
});

// 21 Sep 2026: the reconciliation sweep asks every lobby it still holds who is
// in it, every 15 seconds. LiveKit deletes a room as soon as it empties, and
// says so as "requested room does not exist" with code 'not_found' / HTTP 404 —
// none of which the old substring check ('not found', with a space) matched. So
// an empty lobby threw instead of reading as empty, and two events that ended
// days earlier wrote four error lines every fifteen seconds for four days,
// burying every real 500 in the log.
describe('LiveKitProvider.listParticipants — a room that has gone is an empty room', () => {
  let provider: any;
  let logger: any;

  beforeEach(async () => {
    jest.resetModules();
    mockListParticipants.mockReset();
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    jest.doMock('../../../config/logger', () => ({ __esModule: true, default: logger }));
    const mod = await import('../../../services/video/livekit.provider');
    provider = new mod.LiveKitProvider();
  });

  const gone = [
    ['the exact production error', Object.assign(new Error('requested room does not exist'), { code: 'not_found', status: 404 })],
    ['Twirp NotFound by numeric code', Object.assign(new Error('twirp error'), { code: 5 })],
    ['a bare 404', Object.assign(new Error('nope'), { status: 404 })],
    ['the legacy string', new Error('room not found')],
  ] as const;

  for (const [what, err] of gone) {
    it(`reads ${what} as nobody in the room, without logging an error`, async () => {
      mockListParticipants.mockRejectedValueOnce(err);
      await expect(provider.listParticipants('lobby-5c8b3075')).resolves.toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    });
  }

  it('still throws when LiveKit is genuinely unwell', async () => {
    mockListParticipants.mockRejectedValueOnce(Object.assign(new Error('internal'), { status: 500 }));
    await expect(provider.listParticipants('lobby-x')).rejects.toThrow('internal');
    expect(logger.error).toHaveBeenCalled();
  });

  it('mutes without throwing when the participant, or their room, has gone', async () => {
    jest.resetModules();
    mockUpdateParticipant.mockReset();
    mockUpdateParticipant.mockRejectedValueOnce(
      Object.assign(new Error('requested room does not exist'), { code: 'not_found', status: 404 }),
    );
    jest.doMock('../../../config/logger', () => ({ __esModule: true, default: logger }));
    const mod = await import('../../../services/video/livekit.provider');
    const p = new mod.LiveKitProvider();
    await expect(p.setParticipantCanPublishAudio('lobby-x', 'u-1', false)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps a real roster through untouched', async () => {
    mockListParticipants.mockResolvedValueOnce([
      { identity: 'u-1', joinedAt: 1_700_000_000, state: 1 },
      { identity: 'u-2', joinedAt: 1_700_000_050, state: 2 },
    ]);
    const roster = await provider.listParticipants('lobby-x');
    expect(roster).toEqual([
      { userId: 'u-1', roomId: 'lobby-x', joinedAt: new Date(1_700_000_000_000), isConnected: true },
      { userId: 'u-2', roomId: 'lobby-x', joinedAt: new Date(1_700_000_050_000), isConnected: false },
    ]);
  });
});

describe('LiveKitProvider.createRoom emptyTimeout', () => {
  let provider: any;

  beforeEach(async () => {
    jest.resetModules();
    mockDeleteRoom.mockReset();
    mockCreateRoom.mockReset();
    mockCreateRoom.mockResolvedValue({ name: 'r', sid: 's', emptyTimeout: 300, maxParticipants: 50 });
    jest.doMock('../../../config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

    const mod = await import('../../../services/video/livekit.provider');
    provider = new mod.LiveKitProvider();
  });

  it('pins emptyTimeout to 300 seconds on createRoom (default)', async () => {
    const { RoomType } = await import('../../../services/video/video.interface');
    await provider.createRoom('test-room-id', RoomType.ONE_TO_ONE, 'session-abc');
    expect(mockCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-room-id', emptyTimeout: 300 })
    );
  });

  it('respects explicit emptyTimeoutSeconds override', async () => {
    const { RoomType } = await import('../../../services/video/video.interface');
    await provider.createRoom('test-room-id', RoomType.ONE_TO_ONE, 'session-abc', 120);
    expect(mockCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ emptyTimeout: 120 })
    );
  });
});

describe('video.service wrappers default emptyTimeout', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDeleteRoom.mockReset();
    mockCreateRoom.mockReset();
    mockCreateRoom.mockResolvedValue({ name: 'r', sid: 's', emptyTimeout: 3600, maxParticipants: 500 });
    jest.doMock('../../../config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  });

  it('createLobbyRoom defaults emptyTimeout to 3600 seconds (60 min)', async () => {
    const { createLobbyRoom, setVideoProvider } = await import('../../../services/video/video.service');
    const { LiveKitProvider } = await import('../../../services/video/livekit.provider');
    setVideoProvider(new LiveKitProvider());
    await createLobbyRoom('sess-abc');
    expect(mockCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'lobby-sess-abc', emptyTimeout: 3600 })
    );
  });

  it('createMatchRoom defaults emptyTimeout to 300 seconds (5 min)', async () => {
    mockCreateRoom.mockResolvedValue({ name: 'r', sid: 's', emptyTimeout: 300, maxParticipants: 2 });
    const { createMatchRoom, setVideoProvider } = await import('../../../services/video/video.service');
    const { LiveKitProvider } = await import('../../../services/video/livekit.provider');
    setVideoProvider(new LiveKitProvider());
    await createMatchRoom('sess-abc', 1, 'xyz');
    expect(mockCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'match-sess-abc-r1-xyz', emptyTimeout: 300 })
    );
  });

  it('createLobbyRoom respects explicit override', async () => {
    const { createLobbyRoom, setVideoProvider } = await import('../../../services/video/video.service');
    const { LiveKitProvider } = await import('../../../services/video/livekit.provider');
    setVideoProvider(new LiveKitProvider());
    await createLobbyRoom('sess-abc', 1800);
    expect(mockCreateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ emptyTimeout: 1800 })
    );
  });
});
