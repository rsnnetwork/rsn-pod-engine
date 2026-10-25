import { classifyParticipant } from '../../../services/post-event-message/classify';

const END = new Date('2026-05-27T13:39:00Z');

describe('classifyParticipant', () => {
  const base = {
    joinedAt: new Date('2026-05-27T13:00:00Z'),
    leftAt: null as Date | null,
    roundsCompleted: 0,
    eventHadMatches: true,
  };

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
    expect(classifyParticipant({ ...base, joinedAt: null, leftAt: null, roundsCompleted: 0 }, END)).toBe('no_show');
  });
});

// A video meeting has no rounds and so no matches. Counting rounds there put every attendee in
// "could_not_join" and told them they "weren't able to get into the conversations" (25 Oct, Claus's event).
// When the event never had a match, the only thing worth asking is whether the person was there.
describe('classifyParticipant: an event with no matches is judged by who was there, never by rounds', () => {
  const noMatches = {
    joinedAt: new Date('2026-05-27T13:00:00Z'),
    leftAt: null as Date | null,
    roundsCompleted: 0,
    eventHadMatches: false,
  };

  it('stayed: joined and was there at the end, with zero rounds', () => {
    expect(classifyParticipant({ ...noMatches, leftAt: END }, END)).toBe('stayed');
    expect(classifyParticipant({ ...noMatches, leftAt: null }, END)).toBe('stayed');
  });

  it('left_early: joined and went more than 120s before the end, with zero rounds', () => {
    const left = new Date('2026-05-27T13:21:00Z');
    expect(classifyParticipant({ ...noMatches, leftAt: left }, END)).toBe('left_early');
  });

  it('stayed: went within the 120s grace of the end', () => {
    const left = new Date('2026-05-27T13:37:30Z');
    expect(classifyParticipant({ ...noMatches, leftAt: left }, END)).toBe('stayed');
  });

  it('no_show: never joined', () => {
    expect(classifyParticipant({ ...noMatches, joinedAt: null }, END)).toBe('no_show');
  });

  it('never says could_not_join, whatever the combination', () => {
    const joined = [new Date('2026-05-27T13:00:00Z'), null];
    const left = [null, END, new Date('2026-05-27T13:10:00Z')];
    const rounds = [0, 1, 6];
    for (const joinedAt of joined) {
      for (const leftAt of left) {
        for (const roundsCompleted of rounds) {
          expect(classifyParticipant({ joinedAt, leftAt, roundsCompleted, eventHadMatches: false }, END))
            .not.toBe('could_not_join');
        }
      }
    }
  });

  it('does not change what a speed-networking event with matches says: still could_not_join for zero rounds', () => {
    expect(classifyParticipant({ ...noMatches, eventHadMatches: true, leftAt: END }, END)).toBe('could_not_join');
  });
});
