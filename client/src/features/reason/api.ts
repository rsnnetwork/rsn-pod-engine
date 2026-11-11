// client/src/features/reason/api.ts
// Everything the REASON pages read and write. Pages import all of it from here.
import api from '@/lib/api';
import type {
  ConnectionList, EveryonePage, MatchStrength, MeetingFormat, OutcomeKey, PersonBrief, PersonResponse, PictureCrop, PictureKind,
  PictureSource, ProfileCommunities, PublicMember, PublicProfileCard, PublicProfileLinkState, RecentConnection, WorthContinuing,
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
  // Your own profile (21 Oct 2026): your card as others see it. Under one prefix, which a banner change refreshes.
  mine: ['reason', 'mine'] as const,
  myCard: ['reason', 'mine', 'card'] as const,
  // Shirley pilot S6: your profile as a member with no connection to you sees it, and your public link.
  myPreview: ['reason', 'mine', 'preview'] as const,
  myPublicLink: ['reason', 'mine', 'public-link'] as const,
  // Shirley pilot S3 (RSN 14): a profile's Communities (the spaces you may see), and your own as a member sees them.
  communities: (userId: string) => ['reason', 'communities', userId] as const,
  myCommunities: ['reason', 'mine', 'communities'] as const,
  // A public link's page, read signed out. Not under `mine`: it is anyone's page.
  publicProfile: (token: string) => ['reason', 'public-profile', token] as const,
  blockStatus: (userId: string) => ['reason', 'block-status', userId] as const,
  connections: ['reason', 'connections'] as const,
  everyone: (q: string) => ['reason', 'everyone', q] as const,
};

// A member id is one encoded segment of an address. A route parameter arrives decoded, so a crafted
// "../people/connections/recent?" would otherwise be read as another route.
const memberSegment = (userId: string) => encodeURIComponent(userId);

export const fetchForYou = () => api.get('/matches/platform').then((r) => r.data.data as ForYouPayload);
export const fetchBrief = (userId: string) => api.get(`/people/${memberSegment(userId)}/brief`).then((r) => r.data.data as PersonBrief);
export const fetchRecentConnections = () => api.get('/people/connections/recent').then((r) => r.data.data as RecentConnection[]);
// Your own card, exactly as other members are shown it.
export const fetchMyCard = () => api.get('/people/me/card').then((r) => r.data.data as PublicMember);
// Shirley pilot S6 (RSN 12): your own Human Profile exactly as a member with no connection to you is sent it.
export const fetchMyPreview = () => api.get('/people/me/preview').then((r) => r.data.data as PersonBrief);
// Shirley pilot S3 (RSN 14): a page of the circles and pods a member is in that you may see; your own, as a member with no
// connection to you sees them (the preview).
export const fetchCommunities = (userId: string, offset: number, limit: number) =>
  api.get(`/people/${memberSegment(userId)}/communities`, { params: { offset, limit } }).then((r) => r.data.data as ProfileCommunities);
export const fetchMyCommunities = (offset: number, limit: number) =>
  api.get('/people/me/communities', { params: { offset, limit } }).then((r) => r.data.data as ProfileCommunities);

// Your public profile link (D5): read it, make it (a second press keeps the same link), make a new one in its place, or
// turn it off. Each answers where the link stands now.
export const fetchPublicLink = () => api.get('/users/me/public-link').then((r) => r.data.data as PublicProfileLinkState);
export const makePublicLinkRequest = () => api.post('/users/me/public-link').then((r) => r.data.data as PublicProfileLinkState);
export const regeneratePublicLinkRequest = () =>
  api.post('/users/me/public-link/regenerate').then((r) => r.data.data as PublicProfileLinkState);
export const revokePublicLinkRequest = () => api.delete('/users/me/public-link').then((r) => r.data.data as PublicProfileLinkState);

// The page a public link opens, signed in or not. The token is one encoded segment, like a member id.
export const fetchPublicProfile = (token: string) =>
  api.get(`/public/profiles/${encodeURIComponent(token)}`).then((r) => r.data.data as PublicProfileCard);

// One page of Your connections; `before` is the page already shown's nextBefore (none for the first page).
export const fetchConnections = (before: string | null) =>
  api.get('/people/connections', { params: before ? { before } : {} }).then((r) => r.data.data as ConnectionList);

// One page of Everyone, A to Z; `cursor` is the page already shown's nextCursor (none for the first page).
export const fetchEveryone = (q: string, cursor: string | null) =>
  api.get('/people/everyone', { params: { ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) } }).then((r) => r.data.data as EveryonePage);

export const setPersonResponse = (userId: string, response: PersonResponse | null) =>
  response
    ? api.put(`/people/${memberSegment(userId)}/response`, { response })
    : api.delete(`/people/${memberSegment(userId)}/response`);

// "Already met" (10 Nov 2026): a private marker for someone met outside the platform.
export const setAlreadyMet = (userId: string, met: boolean) =>
  met ? api.put(`/people/${memberSegment(userId)}/already-met`) : api.delete(`/people/${memberSegment(userId)}/already-met`);

export const sendMeetRequest = (userId: string, note: string, format: MeetingFormat) =>
  api.post(`/matches/platform/${memberSegment(userId)}/interest`, { note, format });

export const recordOutcomeRequest = (userId: string, worthContinuing: WorthContinuing, outcomes: OutcomeKey[]) =>
  api.post(`/people/${memberSegment(userId)}/outcome`, { worthContinuing, outcomes });

// Your photo and banner (30 Oct review, T3a): the picture you chose (a data URL) with where you placed it, or only a
// new crop to place the kept picture again. The server cuts what everyone sees. The source is what the editor opens on.
export interface PictureBody { image?: string; crop: PictureCrop }
export const savePictureRequest = (kind: PictureKind, body: PictureBody) => api.put(`/users/me/${kind}`, body);
export const fetchPictureSource = (kind: PictureKind) =>
  api.get<{ data: PictureSource }>(`/users/me/${kind}/source`).then((r) => r.data.data);
export const removeBannerRequest = () => api.delete('/users/me/banner');

// The old public profile's block calls, with the id as one encoded segment like every call here. A profile you blocked
// is closed to you (the brief is a 404), so whether you are the one who blocked is asked on its own.
export const blockMember = (userId: string) => api.post(`/users/${memberSegment(userId)}/block`);
export const unblockMember = (userId: string) => api.delete(`/users/${memberSegment(userId)}/block`);
export const fetchBlockStatus = (userId: string) =>
  api.get(`/users/${memberSegment(userId)}/block-status`).then((r) => r.data.data as { hasBlocked: boolean });
