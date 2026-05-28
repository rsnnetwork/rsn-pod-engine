import * as dm from '../../../services/dm/dm.service';

describe('sendBroadcastMessage', () => {
  it('is exported and takes (from, to, content)', () => {
    expect(typeof dm.sendBroadcastMessage).toBe('function');
    expect(dm.sendBroadcastMessage.length).toBeGreaterThanOrEqual(3);
  });
});
