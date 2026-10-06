// client/src/features/reason/api.ts
// Everything the REASON pages read and write. Pages import all of it from here.
import api from '@/lib/api';
import type {
  MatchStrength, MeetingFormat, OutcomeKey, PersonBrief, PersonResponse,
  RecentConnection, WorthContinuing,
} from '@rsn/shared';
import type { PokeStatus } from './person';

// These live in modules with no axios or store behind them, so a test can run them (see errors.ts).
export { errorMessage } from './errors';
export { personName, stateFromPoke } from './person';

export interface ForYouMatch {
  userId: string;
  /** As the server types it: a member can have no name. Pages show it through personName(). */
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: string | null;
  company: string | null;
  industry: string | null;
  reason: string;
  theyCanBring: string | null;
  saved: boolean;
  strength: MatchStrength;
  pokeStatus: PokeStatus;
  pokeSentByOwner: boolean | null;
}

export interface ForYouPayload {
  matches: ForYouMatch[];
  profileIncomplete: boolean;
  youAreLookingFor: string | null;
  nextEvent: { id: string; title: string; scheduledAt: string } | null;
}

export const reasonKeys = {
  all: ['reason'] as const,
  forYou: ['reason', 'for-you'] as const,
  brief: (userId: string) => ['reason', 'brief', userId] as const,
  recent: ['reason', 'recent-connections'] as const,
};

// A member id is one encoded segment of an address. A route parameter arrives decoded, so a crafted
// "../people/connections/recent?" would otherwise be read as another route.
const memberSegment = (userId: string) => encodeURIComponent(userId);

export const fetchForYou = () => api.get('/matches/platform').then((r) => r.data.data as ForYouPayload);
export const fetchBrief = (userId: string) => api.get(`/people/${memberSegment(userId)}/brief`).then((r) => r.data.data as PersonBrief);
export const fetchRecentConnections = () => api.get('/people/connections/recent').then((r) => r.data.data as RecentConnection[]);

export const setPersonResponse = (userId: string, response: PersonResponse | null) =>
  response
    ? api.put(`/people/${memberSegment(userId)}/response`, { response })
    : api.delete(`/people/${memberSegment(userId)}/response`);

export const sendMeetRequest = (userId: string, note: string, format: MeetingFormat) =>
  api.post(`/matches/platform/${memberSegment(userId)}/interest`, { note, format });

export const recordOutcomeRequest = (userId: string, worthContinuing: WorthContinuing, outcomes: OutcomeKey[]) =>
  api.post(`/people/${memberSegment(userId)}/outcome`, { worthContinuing, outcomes });
