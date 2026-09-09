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
  query: jest.fn(),
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
}));

import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as identityService from '../../services/identity/identity.service';
import { searchConnectedUsers } from '../../services/invite/connected-users';

const app = express();
app.use(express.json());
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, type: 'access' }, JWT_SECRET, { expiresIn: '1h' });

const subject = {
  id: 'u-subject',
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
  (identityService.getUserById as jest.Mock).mockResolvedValue(subject);
});

describe('GET /users/:id', () => {
  it('another member sees the public card only', async () => {
    const res = await request(app).get('/users/u-subject').set('Authorization', `Bearer ${token('u-viewer')}`);
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
    const res = await request(app).get('/users/u-subject').set('Authorization', `Bearer ${token('u-subject')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.whoIWantToMeet).toBe('founders who need a technical partner');
    expect(res.body.data.interests).toEqual(['sailing']);
    expect(res.body.data.email).toBe('subject@example.com');
  });

  it('an admin sees the full profile', async () => {
    const res = await request(app).get('/users/u-subject').set('Authorization', `Bearer ${token('u-admin', 'admin')}`);
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
});
