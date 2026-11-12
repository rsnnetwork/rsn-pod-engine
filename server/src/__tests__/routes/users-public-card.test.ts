// ─── GET /users/:id and /users/connected — two cards (9 Sep 2026) ────────────
// Another member gets the PUBLIC card only; the owner and admins get the full
// profile. The invite search never hands emails to normal members.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() reads the caller's status and account kind; every caller here is an active member.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/avatar.service', () => ({
  __esModule: true,
  getAvatarBlob: jest.fn(),
  captureAvatar: jest.fn(),
}));
jest.mock('../../services/user/user-search.service', () => ({
  __esModule: true,
  searchMembers: jest.fn(),
}));
jest.mock('../../services/invite/connected-users', () => ({
  __esModule: true,
  searchConnectedUsers: jest.fn(),
}));
jest.mock('../../services/identity/identity.service', () => ({
  __esModule: true,
  getUsers: jest.fn(),
  getUserById: jest.fn(),
  updateUser: jest.fn(),
}));
const mockAreBlocked = jest.fn().mockResolvedValue(false);
jest.mock('../../services/block/block.service', () => ({
  __esModule: true,
  areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
}));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutPodEntities: jest.fn().mockResolvedValue(undefined),
  fanoutCommunitiesOf: jest.fn().mockResolvedValue(undefined),
}));

import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as identityService from '../../services/identity/identity.service';
import { searchConnectedUsers } from '../../services/invite/connected-users';
import { NotFoundError } from '../../middleware/errors';
import { fanoutCommunitiesOf } from '../../realtime/fanout';

const app = express();
app.use(express.json());
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, type: 'access' }, JWT_SECRET, { expiresIn: '1h' });

const subject = {
  id: '5ab1ec70-0000-4000-8000-00000000005b',
  email: 'subject@example.com',
  phone: '+1',
  displayName: 'Bart Q',
  firstName: 'Bart',
  lastName: 'Q',
  avatarUrl: null,
  bio: 'About me',
  company: 'QF Labs',
  jobTitle: 'Principal Engineer',
  industry: 'Software',
  location: 'Copenhagen',
  linkedinUrl: null,
  interests: ['sailing'],
  reasonsToConnect: ['cofounder'],
  languages: ['en'],
  timezone: 'Europe/Copenhagen',
  expertiseText: 'distributed systems',
  whatICareAbout: 'climate',
  whatICanHelpWith: 'architecture',
  whoIWantToMeet: 'founders who need a technical partner',
  whyIWantToMeet: 'to join a team',
  myIntent: 'become CTO',
  professionalRole: ['Engineer'],
  currentState: null,
  careerStage: null,
  goals: ['cto'],
  meetingPreferences: [],
  matchingNotes: 'summary',
  invitedByUserId: null,
  role: 'member',
  status: 'active',
  profileComplete: true,
  emailVerified: true,
  notifyEmail: true,
  notifyEventReminders: true,
  notifyMatches: true,
  profileVisible: true,
  inviteOptOutPublicEvents: false,
  onboardingStatus: 'completed',
  lastActiveAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const PRIVATE = ['email', 'phone', 'interests', 'reasonsToConnect', 'whatICareAbout', 'whoIWantToMeet',
  'whyIWantToMeet', 'myIntent', 'goals', 'matchingNotes', 'notifyEmail', 'profileVisible', 'onboardingStatus'];

beforeEach(() => {
  jest.clearAllMocks();
  mockAreBlocked.mockResolvedValue(false);
  (identityService.getUserById as jest.Mock).mockResolvedValue(subject);
});

describe('GET /users/:id', () => {
  it('another member sees the public card only', async () => {
    const res = await request(app).get('/users/5ab1ec70-0000-4000-8000-00000000005b').set('Authorization', `Bearer ${token('u-viewer')}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.displayName).toBe('Bart Q');
    expect(d.bio).toBe('About me');
    expect(d.expertiseText).toBe('distributed systems');
    expect(d.whatICanHelpWith).toBe('architecture');
    expect(d.location).toBe('Copenhagen');
    for (const k of PRIVATE) expect(d).not.toHaveProperty(k);
  });

  it('the owner sees the full profile', async () => {
    const res = await request(app).get('/users/5ab1ec70-0000-4000-8000-00000000005b').set('Authorization', `Bearer ${token('5ab1ec70-0000-4000-8000-00000000005b')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.whoIWantToMeet).toBe('founders who need a technical partner');
    expect(res.body.data.interests).toEqual(['sailing']);
    expect(res.body.data.email).toBe('subject@example.com');
  });

  it('an admin sees the full profile', async () => {
    const res = await request(app).get('/users/5ab1ec70-0000-4000-8000-00000000005b').set('Authorization', `Bearer ${token('u-admin', 'admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.myIntent).toBe('become CTO');
    expect(res.body.data.reasonsToConnect).toEqual(['cofounder']);
  });
});

describe('GET /users/connected', () => {
  it('a normal member gets people they met without their emails', async () => {
    (searchConnectedUsers as jest.Mock).mockResolvedValue([
      { id: 'u-met', display_name: 'Met Person', email: 'met@example.com', company: 'Co', job_title: 'CEO', industry: 'X', avatar_url: null },
    ]);
    const res = await request(app).get('/users/connected?q=met').set('Authorization', `Bearer ${token('u-viewer')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 'u-met', displayName: 'Met Person', company: 'Co', jobTitle: 'CEO', industry: 'X', avatarUrl: null },
    ]);
  });

  it('an admin still gets emails (they invite anyone by address)', async () => {
    (identityService.getUsers as jest.Mock).mockResolvedValue({
      users: [{ id: 'u-any', displayName: 'Any', email: 'any@example.com', company: null, jobTitle: null, industry: null, avatarUrl: null }],
      total: 1,
    });
    const res = await request(app).get('/users/connected?q=any').set('Authorization', `Bearer ${token('u-admin', 'admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].email).toBe('any@example.com');
  });

  // Fix round 2: an admin can invite anyone, but the search listed people blocked either way with them (a member's own
  // search never did). Only active accounts, and nobody blocked either way with the admin who is asking.
  it('an admin\'s search leaves out only active accounts and anyone blocked either way with that admin: the service is told who is asking', async () => {
    (identityService.getUsers as jest.Mock).mockResolvedValue({ users: [], total: 0 });
    const res = await request(app).get('/users/connected?q=any&limit=7').set('Authorization', `Bearer ${token('u-admin', 'admin')}`);
    expect(res.status).toBe(200);
    expect(identityService.getUsers).toHaveBeenCalledWith({ search: 'any', pageSize: 7, status: 'active', notBlockedWith: 'u-admin' });
  });
});

// Shirley pilot S6: GET /users/:id respects a block in either direction, with the very 404 an unknown id gets, so the
// answer tells nobody that a block stands, nor that the account exists.
describe('GET /users/:id and blocks', () => {
  const SUBJECT = '5ab1ec70-0000-4000-8000-00000000005b';
  const UNKNOWN = '5ab1ec70-0000-4000-8000-0000000000ff';
  const get = (id: string, sub: string, role = 'member') =>
    request(app).get(`/users/${id}`).set('Authorization', `Bearer ${token(sub, role)}`);

  it('a block either way answers exactly what an unknown id answers, and reads nothing of the profile', async () => {
    (identityService.getUserById as jest.Mock).mockImplementation((id: string) => (id === SUBJECT
      ? Promise.resolve(subject)
      : Promise.reject(new NotFoundError('User', id))));
    const unknown = await get(UNKNOWN, 'u-viewer');
    expect(unknown.status).toBe(404);

    mockAreBlocked.mockResolvedValue(true);
    (identityService.getUserById as jest.Mock).mockClear();
    const blocked = await get(SUBJECT, 'u-viewer');
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual(unknown.body);
    expect(mockAreBlocked).toHaveBeenCalledWith('u-viewer', SUBJECT);
    expect(identityService.getUserById).not.toHaveBeenCalled();
  });

  it('holds for an admin as well (blocks always win; the admin inspector is the moderation view)', async () => {
    mockAreBlocked.mockResolvedValue(true);
    expect((await get(SUBJECT, 'u-admin', 'admin')).status).toBe(404);
  });

  it('never stops the owner reading their own profile', async () => {
    mockAreBlocked.mockResolvedValue(true);
    const res = await get(SUBJECT, SUBJECT);
    expect(res.status).toBe(200);
    expect(mockAreBlocked).not.toHaveBeenCalled();
  });

  it('with no block, another member still gets the public card', async () => {
    const res = await get(SUBJECT, 'u-viewer');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('email');
  });
});

// Shirley pilot S6 (RSN 13): LinkedIn is saved in the one stored form, https://www.linkedin.com/in/<name>.
describe('PUT /users/me and LinkedIn', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/users/me').set('Authorization', `Bearer ${token('u-viewer')}`).send(body);
  beforeEach(() => (identityService.updateUser as jest.Mock).mockResolvedValue(subject));

  it.each([
    ['http://linkedin.com/in/shirley-palmer', 'https://www.linkedin.com/in/shirley-palmer'],
    ['linkedin.com/in/shirley-palmer/', 'https://www.linkedin.com/in/shirley-palmer'],
    ['www.linkedin.com/in/shirley-palmer?utm_source=share', 'https://www.linkedin.com/in/shirley-palmer'],
    ['https://uk.linkedin.com/in/shirley-palmer', 'https://www.linkedin.com/in/shirley-palmer'],
    ['https://www.linkedin.com/in/shirley-palmer', 'https://www.linkedin.com/in/shirley-palmer'],
  ])('%s is saved as %s', async (typed, stored) => {
    const res = await put({ linkedinUrl: typed });
    expect(res.status).toBe(200);
    expect(identityService.updateUser).toHaveBeenCalledWith('u-viewer', expect.objectContaining({ linkedinUrl: stored }));
  });

  it.each([[''], [null]])('%p clears it as before', async (blank) => {
    expect((await put({ linkedinUrl: blank })).status).toBe(200);
    expect(identityService.updateUser).toHaveBeenCalledWith('u-viewer', expect.objectContaining({ linkedinUrl: blank }));
  });

  it.each([['https://evil.example/in/shirley'], ['https://www.linkedin.com/company/acme'], ['javascript:alert(1)']])(
    "%s is refused in the form's own sentence and nothing is saved", async (typed) => {
      const res = await put({ linkedinUrl: typed });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
      expect(identityService.updateUser).not.toHaveBeenCalled();
    },
  );

  it('a save that does not mention LinkedIn leaves it alone', async () => {
    expect((await put({ bio: 'Hi' })).status).toBe(200);
    expect((identityService.updateUser as jest.Mock).mock.calls[0][1]).not.toHaveProperty('linkedinUrl');
  });
});

// Shirley pilot S3 (RSN 14): "Show my communities on my profile" is one of the member's own switches. It, or "Show me in
// search", changes what their profile's Communities section lists, so the people they share a space with are told.
describe('PUT /users/me and showCommunities', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/users/me').set('Authorization', `Bearer ${token('u-viewer')}`).send(body);
  beforeEach(() => {
    (identityService.updateUser as jest.Mock).mockReset().mockResolvedValue(subject);
    (fanoutCommunitiesOf as jest.Mock).mockClear();
  });

  it.each([[false], [true]])('%p is saved and the people who share a space are told', async (on) => {
    expect((await put({ showCommunities: on })).status).toBe(200);
    expect(identityService.updateUser).toHaveBeenCalledWith('u-viewer', { showCommunities: on });
    expect(fanoutCommunitiesOf).toHaveBeenCalledWith('u-viewer');
  });

  it('hiding from search tells them too', async () => {
    expect((await put({ profileVisible: false })).status).toBe(200);
    expect(fanoutCommunitiesOf).toHaveBeenCalledWith('u-viewer');
  });

  it('a save of anything else does not', async () => {
    expect((await put({ bio: 'Hi' })).status).toBe(200);
    expect(fanoutCommunitiesOf).not.toHaveBeenCalled();
  });

  it.each([['yes'], [1], [null]])('%p is not a switch: 400, nothing saved', async (bad) => {
    expect((await put({ showCommunities: bad })).status).toBe(400);
    expect(identityService.updateUser).not.toHaveBeenCalled();
    expect(fanoutCommunitiesOf).not.toHaveBeenCalled();
  });
});
