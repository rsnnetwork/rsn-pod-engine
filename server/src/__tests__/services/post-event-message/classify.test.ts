import { classifyParticipant } from '../../../services/post-event-message/classify';

const END = new Date('2026-05-27T13:39:00Z');

describe('classifyParticipant', () => {
  const base = { joinedAt: new Date('2026-05-27T13:00:00Z'), leftAt: null as Date | null, roundsCompleted: 0 };

  it('stayed: rounds>=1 and present at end', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 6, leftAt: END }, END)).toBe('stayed');
  });
  it('stayed: rounds>=1 and leftAt null', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 6, leftAt: null }, END)).toBe('stayed');
  });
  it('left_early: rounds>=1 but left >120s before end', () => {
    const left = new Date('2026-05-27T13:21:00Z'); // 18 min before end
    expect(classifyParticipant({ ...base, roundsCompleted: 4, leftAt: left }, END)).toBe('left_early');
  });
  it('could_not_join: joined but 0 rounds', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 0, leftAt: END }, END)).toBe('could_not_join');
  });
  it('no_show: never joined', () => {
    expect(classifyParticipant({ joinedAt: null, leftAt: null, roundsCompleted: 0 }, END)).toBe('no_show');
  });
});
