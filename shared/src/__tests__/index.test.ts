// ─── Shared Types & Constants Tests ──────────────────────────────────────────
import {
  // Enums
  UserRole, UserStatus,
  PodType, OrchestrationMode, CommunicationMode, PodVisibility, PodStatus, PodMemberRole, PodMemberStatus,
  SessionStatus, ParticipantStatus, SegmentType,
  MatchStatus,
  InviteStatus, InviteType,
  RoomType,
  SubscriptionPlan, SubscriptionStatus,
  // Constants
  DEFAULT_SESSION_CONFIG,
  ErrorCodes,
} from '..';

// ─── User Enums ─────────────────────────────────────────────────────────────

describe('UserRole enum', () => {
  it('should have member, host, admin values', () => {
    expect(UserRole.MEMBER).toBe('member');
    expect(UserRole.HOST).toBe('host');
    expect(UserRole.ADMIN).toBe('admin');
  });

  it('should contain exactly 3 roles', () => {
    const values = Object.values(UserRole);
    expect(values).toHaveLength(3);
  });
});

describe('UserStatus enum', () => {
  it('should have correct statuses', () => {
    expect(UserStatus.ACTIVE).toBe('active');
    expect(UserStatus.SUSPENDED).toBe('suspended');
    expect(UserStatus.BANNED).toBe('banned');
    expect(UserStatus.DEACTIVATED).toBe('deactivated');
  });
});

// ─── Pod Enums ──────────────────────────────────────────────────────────────

describe('PodType enum', () => {
  it('should contain all pod types', () => {
    expect(PodType.SPEED_NETWORKING).toBe('speed_networking');
    expect(PodType.DUO).toBe('duo');
    expect(PodType.TRIO).toBe('trio');
    expect(PodType.KVARTET).toBe('kvartet');
    expect(PodType.BAND).toBe('band');
    expect(PodType.ORCHESTRA).toBe('orchestra');
    expect(PodType.CONCERT).toBe('concert');
  });

  it('should have exactly 7 pod types', () => {
    expect(Object.values(PodType)).toHaveLength(7);
  });
});

describe('OrchestrationMode enum', () => {
  it('should have timed_rounds, free_form, moderated', () => {
    expect(OrchestrationMode.TIMED_ROUNDS).toBe('timed_rounds');
    expect(OrchestrationMode.FREE_FORM).toBe('free_form');
    expect(OrchestrationMode.MODERATED).toBe('moderated');
  });
});

describe('CommunicationMode enum', () => {
  it('should have video, audio, text, hybrid', () => {
    expect(CommunicationMode.VIDEO).toBe('video');
    expect(CommunicationMode.AUDIO).toBe('audio');
    expect(CommunicationMode.TEXT).toBe('text');
    expect(CommunicationMode.HYBRID).toBe('hybrid');
  });
});

describe('PodVisibility enum', () => {
  it('should have private, invite_only, public', () => {
    expect(PodVisibility.PRIVATE).toBe('private');
    expect(PodVisibility.INVITE_ONLY).toBe('invite_only');
    expect(PodVisibility.PUBLIC).toBe('public');
  });
});

describe('PodStatus enum', () => {
  it('should have correct statuses', () => {
    expect(PodStatus.DRAFT).toBe('draft');
    expect(PodStatus.ACTIVE).toBe('active');
    expect(PodStatus.ARCHIVED).toBe('archived');
    expect(PodStatus.SUSPENDED).toBe('suspended');
  });
});

describe('PodMemberRole enum', () => {
  it('should have director, host, member', () => {
    expect(PodMemberRole.DIRECTOR).toBe('director');
    expect(PodMemberRole.HOST).toBe('host');
    expect(PodMemberRole.MEMBER).toBe('member');
  });
});

describe('PodMemberStatus enum', () => {
  it('should have correct statuses', () => {
    expect(PodMemberStatus.INVITED).toBe('invited');
    expect(PodMemberStatus.PENDING_APPROVAL).toBe('pending_approval');
    expect(PodMemberStatus.ACTIVE).toBe('active');
    expect(PodMemberStatus.REMOVED).toBe('removed');
    expect(PodMemberStatus.LEFT).toBe('left');
  });
});

// ─── Session Enums & Config ─────────────────────────────────────────────────

describe('SessionStatus enum', () => {
  it('should have all session lifecycle statuses', () => {
    expect(SessionStatus.SCHEDULED).toBe('scheduled');
    expect(SessionStatus.LOBBY_OPEN).toBe('lobby_open');
    expect(SessionStatus.ROUND_ACTIVE).toBe('round_active');
    expect(SessionStatus.ROUND_RATING).toBe('round_rating');
    expect(SessionStatus.ROUND_TRANSITION).toBe('round_transition');
    expect(SessionStatus.CLOSING_LOBBY).toBe('closing_lobby');
    expect(SessionStatus.COMPLETED).toBe('completed');
    expect(SessionStatus.CANCELLED).toBe('cancelled');
  });

  it('should have exactly 8 statuses', () => {
    expect(Object.values(SessionStatus)).toHaveLength(8);
  });
});

describe('ParticipantStatus enum', () => {
  it('should have all participant statuses', () => {
    expect(ParticipantStatus.REGISTERED).toBe('registered');
    expect(ParticipantStatus.CHECKED_IN).toBe('checked_in');
    expect(ParticipantStatus.IN_LOBBY).toBe('in_lobby');
    expect(ParticipantStatus.IN_ROUND).toBe('in_round');
    expect(ParticipantStatus.DISCONNECTED).toBe('disconnected');
    expect(ParticipantStatus.REMOVED).toBe('removed');
    expect(ParticipantStatus.LEFT).toBe('left');
    expect(ParticipantStatus.NO_SHOW).toBe('no_show');
  });
});

describe('SegmentType enum', () => {
  it('should have correct segment types', () => {
    expect(SegmentType.LOBBY_MOSAIC).toBe('lobby_mosaic');
    expect(SegmentType.TIMED_ONE_TO_ONE).toBe('timed_one_to_one');
    expect(SegmentType.CLOSING_LOBBY).toBe('closing_lobby');
    expect(SegmentType.TRANSITION).toBe('transition');
  });
});

describe('DEFAULT_SESSION_CONFIG', () => {
  it('should have correct defaults', () => {
    expect(DEFAULT_SESSION_CONFIG.numberOfRounds).toBe(5);
    expect(DEFAULT_SESSION_CONFIG.roundDurationSeconds).toBe(480);
    expect(DEFAULT_SESSION_CONFIG.lobbyDurationSeconds).toBe(480);
    expect(DEFAULT_SESSION_CONFIG.transitionDurationSeconds).toBe(30);
    expect(DEFAULT_SESSION_CONFIG.ratingWindowSeconds).toBe(30);
    expect(DEFAULT_SESSION_CONFIG.closingLobbyDurationSeconds).toBe(480);
    expect(DEFAULT_SESSION_CONFIG.noShowTimeoutSeconds).toBe(60);
    expect(DEFAULT_SESSION_CONFIG.maxParticipants).toBe(500);
  });

  it('should have all required fields', () => {
    const keys = Object.keys(DEFAULT_SESSION_CONFIG);
    expect(keys).toContain('numberOfRounds');
    expect(keys).toContain('roundDurationSeconds');
    expect(keys).toContain('lobbyDurationSeconds');
    expect(keys).toContain('transitionDurationSeconds');
    expect(keys).toContain('ratingWindowSeconds');
    expect(keys).toContain('closingLobbyDurationSeconds');
    expect(keys).toContain('noShowTimeoutSeconds');
    expect(keys).toContain('maxParticipants');
  });

  it('should all be positive numbers', () => {
    for (const [, value] of Object.entries(DEFAULT_SESSION_CONFIG)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
  });
});

// ─── Match Enums ────────────────────────────────────────────────────────────

describe('MatchStatus enum', () => {
  it('should have correct statuses', () => {
    expect(MatchStatus.SCHEDULED).toBe('scheduled');
    expect(MatchStatus.ACTIVE).toBe('active');
    expect(MatchStatus.COMPLETED).toBe('completed');
    expect(MatchStatus.NO_SHOW).toBe('no_show');
    expect(MatchStatus.REASSIGNED).toBe('reassigned');
    expect(MatchStatus.CANCELLED).toBe('cancelled');
  });
});

// ─── Invite Enums ───────────────────────────────────────────────────────────

describe('InviteStatus enum', () => {
  it('should have correct statuses', () => {
    expect(InviteStatus.PENDING).toBe('pending');
    expect(InviteStatus.ACCEPTED).toBe('accepted');
    expect(InviteStatus.EXPIRED).toBe('expired');
    expect(InviteStatus.REVOKED).toBe('revoked');
  });
});

describe('InviteType enum', () => {
  it('should have pod, session, platform', () => {
    expect(InviteType.POD).toBe('pod');
    expect(InviteType.SESSION).toBe('session');
    expect(InviteType.PLATFORM).toBe('platform');
  });
});

// ─── Video Enums ────────────────────────────────────────────────────────────

describe('RoomType enum', () => {
  it('should have lobby, one_to_one, host_control', () => {
    expect(RoomType.LOBBY).toBe('lobby');
    expect(RoomType.ONE_TO_ONE).toBe('one_to_one');
    expect(RoomType.HOST_CONTROL).toBe('host_control');
  });
});

// ─── Subscription Enums ─────────────────────────────────────────────────────

describe('SubscriptionPlan enum', () => {
  it('should have free, member, premium', () => {
    expect(SubscriptionPlan.FREE).toBe('free');
    expect(SubscriptionPlan.MEMBER).toBe('member');
    expect(SubscriptionPlan.PREMIUM).toBe('premium');
  });
});

describe('SubscriptionStatus enum', () => {
  it('should have correct statuses', () => {
    expect(SubscriptionStatus.ACTIVE).toBe('active');
    expect(SubscriptionStatus.PAST_DUE).toBe('past_due');
    expect(SubscriptionStatus.CANCELLED).toBe('cancelled');
    expect(SubscriptionStatus.TRIALING).toBe('trialing');
    expect(SubscriptionStatus.NONE).toBe('none');
  });
});

// ─── Error Codes ────────────────────────────────────────────────────────────

describe('ErrorCodes', () => {
  it('should define all auth error codes', () => {
    expect(ErrorCodes.AUTH_INVALID_TOKEN).toBe('AUTH_INVALID_TOKEN');
    expect(ErrorCodes.AUTH_TOKEN_EXPIRED).toBe('AUTH_TOKEN_EXPIRED');
    expect(ErrorCodes.AUTH_UNAUTHORIZED).toBe('AUTH_UNAUTHORIZED');
    expect(ErrorCodes.AUTH_FORBIDDEN).toBe('AUTH_FORBIDDEN');
    expect(ErrorCodes.AUTH_MAGIC_LINK_EXPIRED).toBe('AUTH_MAGIC_LINK_EXPIRED');
    expect(ErrorCodes.AUTH_MAGIC_LINK_USED).toBe('AUTH_MAGIC_LINK_USED');
  });

  it('should define all user error codes', () => {
    expect(ErrorCodes.USER_NOT_FOUND).toBe('USER_NOT_FOUND');
    expect(ErrorCodes.USER_ALREADY_EXISTS).toBe('USER_ALREADY_EXISTS');
    expect(ErrorCodes.USER_PROFILE_INCOMPLETE).toBe('USER_PROFILE_INCOMPLETE');
    expect(ErrorCodes.USER_SUSPENDED).toBe('USER_SUSPENDED');
  });

  it('should define all pod error codes', () => {
    expect(ErrorCodes.POD_NOT_FOUND).toBe('POD_NOT_FOUND');
    expect(ErrorCodes.POD_FULL).toBe('POD_FULL');
    expect(ErrorCodes.POD_NOT_ACTIVE).toBe('POD_NOT_ACTIVE');
    expect(ErrorCodes.POD_MEMBER_EXISTS).toBe('POD_MEMBER_EXISTS');
  });

  it('should define validation and rate limit codes', () => {
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCodes.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });

  it('should have a comprehensive set of error codes', () => {
    const codeCount = Object.keys(ErrorCodes).length;
    expect(codeCount).toBeGreaterThanOrEqual(20);
  });
});