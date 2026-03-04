-- ─── RSN Phase 1 Database Schema ─────────────────────────────────────────────
-- Migration: 001_initial_schema
-- Covers: users, pods, pod_members, sessions, session_participants,
--         matches, ratings, encounter_history, invites,
--         user_subscriptions, user_entitlements, magic_links, refresh_tokens

-- ═════════════════════════════════════════════════════════════════════════════
-- Extensions
-- ═════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═════════════════════════════════════════════════════════════════════════════
-- ENUM Types
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TYPE user_role AS ENUM ('member', 'host', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned', 'deactivated');

CREATE TYPE pod_type AS ENUM ('speed_networking', 'duo', 'trio', 'kvartet', 'band', 'orchestra', 'concert');
CREATE TYPE orchestration_mode AS ENUM ('timed_rounds', 'free_form', 'moderated');
CREATE TYPE communication_mode AS ENUM ('video', 'audio', 'text', 'hybrid');
CREATE TYPE pod_visibility AS ENUM ('private', 'invite_only', 'public');
CREATE TYPE pod_status AS ENUM ('draft', 'active', 'archived', 'suspended');
CREATE TYPE pod_member_role AS ENUM ('director', 'host', 'member');
CREATE TYPE pod_member_status AS ENUM ('invited', 'pending_approval', 'active', 'removed', 'left');

CREATE TYPE session_status AS ENUM (
  'scheduled', 'lobby_open', 'round_active', 'round_rating',
  'round_transition', 'closing_lobby', 'completed', 'cancelled'
);
CREATE TYPE participant_status AS ENUM (
  'registered', 'checked_in', 'in_lobby', 'in_round',
  'disconnected', 'removed', 'left', 'no_show'
);

CREATE TYPE match_status AS ENUM ('scheduled', 'active', 'completed', 'no_show', 'reassigned', 'cancelled');

CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE invite_type AS ENUM ('pod', 'session', 'platform');

CREATE TYPE subscription_plan AS ENUM ('free', 'member', 'premium');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing', 'none');

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. USERS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) NOT NULL UNIQUE,
  display_name    VARCHAR(100) NOT NULL,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  avatar_url      TEXT,
  bio             TEXT,
  company         VARCHAR(200),
  job_title       VARCHAR(200),
  industry        VARCHAR(100),
  location        VARCHAR(200),
  linkedin_url    TEXT,
  interests       TEXT[] DEFAULT '{}',
  reasons_to_connect TEXT[] DEFAULT '{}',
  languages       TEXT[] DEFAULT '{}'::TEXT[],
  timezone        VARCHAR(50),
  role            user_role NOT NULL DEFAULT 'member',
  status          user_status NOT NULL DEFAULT 'active',
  profile_complete BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. MAGIC LINKS (Authentication)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE magic_links (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) NOT NULL,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_magic_links_token ON magic_links(token_hash);
CREATE INDEX idx_magic_links_email ON magic_links(email);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. REFRESH TOKENS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token_hash);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. PODS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE pods (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(200) NOT NULL,
  description         TEXT,
  pod_type            pod_type NOT NULL DEFAULT 'speed_networking',
  orchestration_mode  orchestration_mode NOT NULL DEFAULT 'timed_rounds',
  communication_mode  communication_mode NOT NULL DEFAULT 'video',
  visibility          pod_visibility NOT NULL DEFAULT 'invite_only',
  status              pod_status NOT NULL DEFAULT 'draft',
  max_members         INTEGER,
  rules               TEXT,
  config              JSONB NOT NULL DEFAULT '{}',
  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pods_type ON pods(pod_type);
CREATE INDEX idx_pods_status ON pods(status);
CREATE INDEX idx_pods_created_by ON pods(created_by);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. POD MEMBERS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE pod_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pod_id    UUID NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      pod_member_role NOT NULL DEFAULT 'member',
  status    pod_member_status NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at   TIMESTAMPTZ,
  UNIQUE(pod_id, user_id)
);

CREATE INDEX idx_pod_members_pod ON pod_members(pod_id);
CREATE INDEX idx_pod_members_user ON pod_members(user_id);
CREATE INDEX idx_pod_members_status ON pod_members(status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. SESSIONS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pod_id          UUID NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  title           VARCHAR(300) NOT NULL,
  description     TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  status          session_status NOT NULL DEFAULT 'scheduled',
  current_round   INTEGER NOT NULL DEFAULT 0,
  config          JSONB NOT NULL DEFAULT '{
    "numberOfRounds": 5,
    "roundDurationSeconds": 480,
    "lobbyDurationSeconds": 480,
    "transitionDurationSeconds": 30,
    "ratingWindowSeconds": 30,
    "closingLobbyDurationSeconds": 480,
    "noShowTimeoutSeconds": 60,
    "maxParticipants": 500
  }',
  host_user_id    UUID NOT NULL REFERENCES users(id),
  lobby_room_id   VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_pod ON sessions(pod_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_scheduled ON sessions(scheduled_at);
CREATE INDEX idx_sessions_host ON sessions(host_user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. SESSION PARTICIPANTS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE session_participants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          participant_status NOT NULL DEFAULT 'registered',
  joined_at       TIMESTAMPTZ,
  left_at         TIMESTAMPTZ,
  current_room_id VARCHAR(200),
  is_no_show      BOOLEAN NOT NULL DEFAULT FALSE,
  rounds_completed INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX idx_session_participants_session ON session_participants(session_id);
CREATE INDEX idx_session_participants_user ON session_participants(user_id);
CREATE INDEX idx_session_participants_status ON session_participants(status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. MATCHES
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE matches (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number      INTEGER NOT NULL,
  participant_a_id  UUID NOT NULL REFERENCES users(id),
  participant_b_id  UUID NOT NULL REFERENCES users(id),
  room_id           VARCHAR(200),
  status            match_status NOT NULL DEFAULT 'scheduled',
  score             DECIMAL(10,4),
  reason_tags       TEXT[] DEFAULT '{}',
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_match_per_round UNIQUE(session_id, round_number, participant_a_id),
  CONSTRAINT no_self_match CHECK (participant_a_id != participant_b_id)
);

CREATE INDEX idx_matches_session ON matches(session_id);
CREATE INDEX idx_matches_round ON matches(session_id, round_number);
CREATE INDEX idx_matches_participant_a ON matches(participant_a_id);
CREATE INDEX idx_matches_participant_b ON matches(participant_b_id);
CREATE INDEX idx_matches_status ON matches(status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. RATINGS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE ratings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  from_user_id    UUID NOT NULL REFERENCES users(id),
  to_user_id      UUID NOT NULL REFERENCES users(id),
  quality_score   INTEGER NOT NULL CHECK (quality_score >= 1 AND quality_score <= 5),
  meet_again      BOOLEAN NOT NULL DEFAULT FALSE,
  feedback        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(match_id, from_user_id)
);

CREATE INDEX idx_ratings_match ON ratings(match_id);
CREATE INDEX idx_ratings_from ON ratings(from_user_id);
CREATE INDEX idx_ratings_to ON ratings(to_user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. ENCOUNTER HISTORY
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE encounter_history (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a_id         UUID NOT NULL REFERENCES users(id),
  user_b_id         UUID NOT NULL REFERENCES users(id),
  times_met         INTEGER NOT NULL DEFAULT 1,
  last_met_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_session_id   UUID REFERENCES sessions(id),
  last_quality_score INTEGER,
  last_meet_again_a BOOLEAN,
  last_meet_again_b BOOLEAN,
  mutual_meet_again BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ordered_user_ids CHECK (user_a_id < user_b_id),
  UNIQUE(user_a_id, user_b_id)
);

CREATE INDEX idx_encounter_user_a ON encounter_history(user_a_id);
CREATE INDEX idx_encounter_user_b ON encounter_history(user_b_id);
CREATE INDEX idx_encounter_mutual ON encounter_history(mutual_meet_again) WHERE mutual_meet_again = TRUE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 11. INVITES
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE invites (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code              VARCHAR(20) NOT NULL UNIQUE,
  type              invite_type NOT NULL DEFAULT 'platform',
  inviter_id        UUID NOT NULL REFERENCES users(id),
  invitee_email     VARCHAR(255),
  pod_id            UUID REFERENCES pods(id),
  session_id        UUID REFERENCES sessions(id),
  status            invite_status NOT NULL DEFAULT 'pending',
  max_uses          INTEGER NOT NULL DEFAULT 1,
  use_count         INTEGER NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id),
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_code ON invites(code);
CREATE INDEX idx_invites_inviter ON invites(inviter_id);
CREATE INDEX idx_invites_status ON invites(status);
CREATE INDEX idx_invites_email ON invites(invitee_email);

-- ═════════════════════════════════════════════════════════════════════════════
-- 12. USER SUBSCRIPTIONS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE user_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan                    subscription_plan NOT NULL DEFAULT 'free',
  status                  subscription_status NOT NULL DEFAULT 'none',
  stripe_customer_id      VARCHAR(100),
  stripe_subscription_id  VARCHAR(100),
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_subs_user ON user_subscriptions(user_id);
CREATE INDEX idx_user_subs_stripe ON user_subscriptions(stripe_customer_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 13. USER ENTITLEMENTS
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE user_entitlements (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  max_pods_owned          INTEGER NOT NULL DEFAULT 1,
  max_sessions_per_month  INTEGER NOT NULL DEFAULT 5,
  max_invites_per_day     INTEGER NOT NULL DEFAULT 10,
  can_host_sessions       BOOLEAN NOT NULL DEFAULT FALSE,
  can_create_pods         BOOLEAN NOT NULL DEFAULT FALSE,
  access_level            VARCHAR(50) NOT NULL DEFAULT 'basic',
  overrides               JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_entitlements_user ON user_entitlements(user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 14. AUDIT LOG
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   UUID,
  details     JSONB DEFAULT '{}',
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ═════════════════════════════════════════════════════════════════════════════
-- Updated_at trigger function
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_pods_updated_at BEFORE UPDATE ON pods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_encounter_history_updated_at BEFORE UPDATE ON encounter_history FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_invites_updated_at BEFORE UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_subscriptions_updated_at BEFORE UPDATE ON user_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_entitlements_updated_at BEFORE UPDATE ON user_entitlements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
