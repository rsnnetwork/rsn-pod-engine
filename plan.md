# RSN Master Plan (Expanded)

Project: RSN Pod Engine
Primary Stack Decision: PERN (PostgreSQL, Express.js, React, Node.js) + LiveKit

---

## 0) Current Status

### Milestone 1 — COMPLETE ✅
All M1 deliverables are done:
- Monorepo workspace (shared, server, client)
- PostgreSQL schema + migrations (001_initial_schema.sql)
- All core backend services: identity, pod, session, matching, orchestration, video, invite, rating
- REST API routes: auth, users, pods, sessions, invites, ratings, host
- Middleware: JWT auth, RBAC, validation (Zod), rate limiting, error handling, audit
- Socket.IO real-time with JWT auth
- 136 backend tests passing across 13 suites
- Shared types package (@rsn/shared)

### Milestone 2 — IN PROGRESS 🔄
Completed so far:
- ✅ Matching engine v1 (weighted scoring, constraints, no-duplicate pairings, odd-participant handling)
- ✅ Orchestration service (state machine, timer logic, round management)
- ✅ Video abstraction layer (IVideoProvider interface + LiveKit + Mock provider for dev)
- ✅ React frontend (Vite + React 18 + TypeScript + Tailwind CSS + Zustand + TanStack Query)
  - Auth: magic link login + verify pages (dev mode shows clickable link)
  - Home dashboard with stats + upcoming sessions + pod overview
  - Pods: list, create, detail with members
  - Sessions: list, create, detail, join
  - Invites: list, create, accept via link
  - Live session: lobby, video room, rating prompt, session complete, host controls
  - Host dashboard
  - Profile editing with tag management
  - Design system: dark theme, glassmorphism, brand colors, responsive layout
- ✅ Dev auth bypass (magic link URL returned in API response in dev mode)

Remaining for M2:
- ⬜ LiveKit integration testing (requires LiveKit server)
- ⬜ End-to-end internal simulation with real matching
- ⬜ Host controls via Socket.IO (start/pause/end/broadcast)
- ⬜ Encounter history updates after sessions
- ⬜ Reconnection handling
- ✅ Pod reactivation (archive→active) with UI
- ✅ Pod list shows member + session counts
- ✅ Invite copy/share UX
- ✅ Dashboard label accuracy fixes

### Important Design Decisions (March 8, 2026)
- **Pod deletion = soft archive**: Pods are never hard-deleted. "Delete" sets status='archived'. Sessions/data preserved. Directors can reactivate.
- **Invite flow**: Invites are **optional** for registration. Users can sign up freely. Invite codes can be used to track referrals and onboard specific users, but are not required. When used: User creates invite → gets shareable link → manually shares with recipient → recipient navigates to link → signs in → accepts. No system email delivery yet.
- **Matching quality depends on profile data**: The matching engine uses interests, reasons, industry, company, languages. Without profile data, matches are random. Profile completion should be strongly encouraged or gated before session entry.
- **Session creation permission**: Only `director` and `host` pod members can create sessions. Regular `member` cannot. Host is auto-registered as a participant when creating a session.
- **Pod visibility**: All active pods are visible to all authenticated users via the "Browse All" tab. Users can self-join any active pod. "My Pods" filters show only pods where user is an active member. Creating a pod auto-adds creator as director.
- **Session visibility**: All sessions are visible to all authenticated users, not just pod members. Any user can register for any open session.
- **All progress.md updates are automatic**: Never require user to ask for progress updates — they happen after every code change.

---

## 1) Product Direction and Architecture Principle

RSN is a Pod-first connection operating system.
Raw Speed Networking is the first Pod type running on top of the Pod Engine.

### Core principle
- Build engine first, event preset second.
- Protect intentional connection quality (signal over noise).
- Store durable relationship memory (encounter history).
- Keep pod orchestration, matching, and video concerns separate.

### Why PERN over MERN
- Requirements are strongly relational (constraints, joins, histories, reports, role models).
- PostgreSQL fits matching, encounter history, anti-duplication rules, and analytics.
- Node/Express/React keeps implementation fully JavaScript/TypeScript end-to-end.

---

## 2) System Architecture (Full)

```text
┌──────────────────────────────────────────────────────────────────────┐
│                             CLIENT LAYER                             │
│  React App (Member UI) | Host Console | Admin Console | LiveKit UI │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ HTTPS + WebSocket
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                              API LAYER                               │
│  Express REST API + Socket Gateway + Auth + RBAC + Rate Limiting    │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           SERVICE LAYER                              │
│  Identity | Pod | Session | Matching | Orchestration | Invite |     │
│  Rating | Encounter | Governance | Entitlements | Notifications      │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       VIDEO ABSTRACTION LAYER                        │
│                IVideoProvider -> LiveKitProvider                     │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           PERSISTENCE LAYER                          │
│     PostgreSQL | Redis | Email Provider | Stripe | Object Storage    │
└──────────────────────────────────────────────────────────────────────┘
```

### Layer responsibilities
- Client Layer: participant, host, and admin experiences.
- API Layer: routing, validation, authn/authz, transport.
- Service Layer: domain logic and business rules.
- Video Abstraction Layer: provider-independent room operations.
- Persistence Layer: durable storage, cache, queue support.

---

## 3) Domain Model (Consolidated)

### Phase 1 Core Entities
- users
- pods
- pod_members
- sessions
- session_participants
- matches
- ratings
- encounter_history
- invites
- user_subscriptions
- user_entitlements

### Core relationships
```text
users 1--* pod_members *--1 pods
pods 1--* sessions
sessions 1--* session_participants *--1 users
sessions 1--* matches
matches 1--* ratings *--1 users
users *--* encounter_history (self relation)
users 1--* invites
users 1--1 user_subscriptions
users 1--1 user_entitlements
```

### Extensibility entities (Phase 2+)
- user_onboarding
- user_activity_log
- user_badges
- badge_definitions
- pod_join_requests
- pod_chat_messages
- pod_meetings
- violation_reports
- user_strikes
- user_consents
- social_shares
- masterclasses
- masterclass_questions

---

## 4) Phase 1 Definition of Done

Phase 1 is complete when:
1. A Pod type "Raw Speed Networking" can be created.
2. A session can be created inside that pod.
3. Users can join through invite flow.
4. Matching generates valid round schedules without duplicate in-session pairings.
5. Live routing works: Lobby -> 1:1 -> Lobby through all rounds.
6. Ratings are stored after each round.
7. Mutual meet-again connections are generated.
8. Recap email is sent after event completion.
9. A live event runs successfully with 300+ participants.

---

## 5) Milestone-Based Delivery Plan

## Milestone 1
Goal: Foundation + architecture confirmation + core data model + project setup.

### Deliverables
- Workspace structure: client, server, shared contracts.
- Core schema and migration baseline.
- Authentication baseline and role baseline.
- Architecture sign-off for pod engine boundaries.

### Build tasks
- Establish backend services:
  - identity-service
  - pod-service
  - session-service
  - matching-service (interface + stub)
  - orchestration-service (state skeleton)
  - video-provider interface
- Create core tables and indexes.
- Define initial API contracts for auth, users, pods, sessions, invites.

### Exit criteria
- Pod and session creation works through API.
- Participant registration records persist correctly.
- Architecture and schema are validated against requirement documents.

---

## Milestone 2
Goal: Pod Engine functional in internal simulation.

### Deliverables
- Matching engine v1 operational.
- Real-time orchestration operational.
- Video routing operational via abstraction layer.
- End-to-end internal simulation completed.

### Build tasks
- Matching engine v1:
  - weighted scoring by configurable attributes
  - hard constraints support
  - no duplicate pairings within session
  - global multi-round optimization
  - odd participant handling
  - schedule generation target under 30s for 300 participants
- Orchestration engine:
  - session states: scheduled, lobby, active rounds, transition, closing, completed
  - server-authoritative timers
  - automatic routing events
  - reconnection handling
  - no-show detection and reassignment path (<=60s target)
- Video layer:
  - LiveKit provider implementation behind interface
  - dynamic room create/destroy
  - lobby mosaic + 1:1 rooms
- Host controls:
  - start/pause/end
  - attendance and round monitor
  - broadcast messages
  - participant removal
  - manual reassignment
- Ratings and memory:
  - 1-5 quality score
  - meet-again flag
  - encounter history updates

### Exit criteria
- Internal simulation runs full flow from lobby to completion.
- Ratings and encounter history persist correctly.
- Host controls can steer the session without manual links.

---

## Milestone 3
Goal: Live event execution with production stability.

### Deliverables
- Live event with 300+ users.
- 5 full rounds completed.
- Recap and connection outputs delivered.
- Stable operations baseline.

### Build tasks
- Production hardening:
  - error tracking
  - structured logs
  - rate limiting and bot protection
  - audit logs
- Performance verification:
  - matching under 30s
  - transition latency under 2s
  - reconnect behavior validated
- Post-event outputs:
  - people met list
  - mutual meet-again highlights
  - export: schedule, attendance, ratings, no-shows
  - recap email pipeline

### Exit criteria
- Live run results documented.
- KPI snapshot and incident notes captured.
- Next backlog ready.

---

## 6) Execution Flows and Diagrams

### 6.1 Member journey flow
```text
Invite Link
  -> Landing Page (reason, rules, format)
  -> Sign Up / Log In
  -> Profile Completion (required fields)
  -> Session Join
  -> Lobby Mosaic
  -> Auto-route to 1:1 Room
  -> Round Timer + Conversation
  -> Return to Lobby
  -> Rating Prompt
  -> Repeat for all rounds
  -> Closing Lobby
  -> Post-event Recap + People Met
```

### 6.2 Real-time orchestration flow
```text
Host Start -> Session State: LOBBY
Timer Expiry -> Generate/Load Round Pairings
Broadcast Assignments -> Route users to match rooms
Round Timer End -> Return all to lobby
Open rating window -> Persist ratings
Transition timer -> Next round
Final round done -> Closing lobby -> Session complete
```

### 6.3 Session state machine
```text
SCHEDULED
  -> LOBBY_OPEN
  -> ROUND_ACTIVE(n)
  -> ROUND_RATING(n)
  -> ROUND_TRANSITION(n)
  -> ROUND_ACTIVE(n+1) ...
  -> CLOSING_LOBBY
  -> COMPLETED

Error paths:
ROUND_ACTIVE -> REASSIGNMENT_PENDING -> ROUND_ACTIVE
Any state -> RECOVERY_MODE -> previous active state
```

### 6.4 No-show handling flow
```text
Round starts
  -> Presence check window
  -> Missing participant detected
  -> Try reassignment pool
     -> success: create replacement pair
     -> fail: notify waiting participant + flag no_show
  -> Host override available at all times
```

---

## 7) Matching Engine Design

### Inputs
- session participants
- profile attributes
- encounter history
- pod/session matching config
- exclusion rules

### Core requirements
- avoid duplicate pairings in a session
- support hard constraints
- weighted scoring with configurable criteria
- optimize across all rounds
- handle odd participant counts
- generate schedule under 30s for 300 participants

### Engine architecture
```text
IMatchingEngine
  -> validateInput()
  -> buildCandidateGraph()
  -> scorePairs(weights, features)
  -> applyConstraints()
  -> optimizeRounds()
  -> emitSchedule()
```

### Output model
- round number
- participant A / B
- confidence / score metadata
- reason tags (optional)

---

## 8) Video Integration Strategy

### Abstraction-first
- never couple orchestration directly to provider SDK calls
- use `IVideoProvider` interface
- LiveKit implementation as current provider

### Provider contract
- createRoom(roomId, type)
- closeRoom(roomId)
- issueJoinToken(userId, roomId)
- moveParticipant(userId, fromRoom, toRoom)
- listParticipants(roomId)

### Room model
- one lobby room per session
- one 1:1 room per active match
- optional host control room/channel

---

## 9) API Surface (Phase 1 Baseline)

### Auth
- POST /auth/magic-link
- POST /auth/verify
- POST /auth/logout
- GET /auth/session

### Users
- GET /users/me
- PUT /users/me
- GET /users/:id

### Pods and Sessions
- POST /pods
- GET /pods
- GET /pods/:id
- PUT /pods/:id
- POST /pods/:id/sessions
- GET /sessions/:id
- POST /sessions/:id/register
- DELETE /sessions/:id/register

### Invites
- POST /invites
- GET /invites
- GET /invites/:code
- POST /invites/:code/accept

### Host Controls
- POST /sessions/:id/host/start
- POST /sessions/:id/host/pause
- POST /sessions/:id/host/resume
- POST /sessions/:id/host/end
- POST /sessions/:id/host/broadcast
- POST /sessions/:id/host/reassign

### Post-event
- GET /sessions/:id/people-met
- GET /sessions/:id/export

---

## 10) Security and Governance Baseline

### Security controls
- invite token validation
- RBAC on all protected routes
- rate limiting and abuse throttles
- audit logs for host/admin actions
- bot protection at auth and invite endpoints

### Governance controls
- participant removal during live session
- no-show and behavior flags
- event-level moderation trail

---

## 11) Performance and Reliability Targets

- matching generation under 30 seconds for 300 participants
- transition routing under 2 seconds target
- support 500 concurrent participants across active runtime
- reconnection recovery during rounds and transitions

### Reliability strategy
- retry-safe orchestration commands
- idempotent host actions
- event-driven logs for replay/debugging
- graceful degradation when no-show reassignment fails

---

## 12) Testing and Validation Strategy

### Validation layers
- unit tests: matching scoring and constraints
- integration tests: orchestration + provider abstraction
- simulation tests: full session lifecycle
- load tests: concurrency, transitions, reconnect patterns

### Acceptance checks
- no duplicate in-session pairings
- ratings persisted each round
- encounter history updated after round closure
- exports and recap generation complete after session end

---

## 13) Phase 1 Functional Scope (Must-Have)

### Identity and access
- email-based authentication
- required profile attributes
- role-based access control

### Pod/session execution
- pod type: SPEED_NETWORKING
- configurable round and segment values
- session participant statuses and attendance

### Matching
- configurable weighted criteria
- constraints and exclusions
- duplicate avoidance
- odd count handling

### Real-time orchestration
- lobby -> 1:1 -> lobby repeated flow
- timer-driven transitions
- reconnection and late-join handling

### Feedback and memory
- round-level rating and meet-again signal
- persistent encounter history

### Host/admin baseline
- attendance view
- round controls
- moderation controls
- broadcasting

### Communications and billing readiness
- invite links with status tracking
- recap email
- subscription and entitlement model present for gating

---

## 14) Phase 2 Scope (After First Live Success)

- Three-I onboarding (Intention, Invitation, Impact)
- Reason Score and trust scaling
- expanded invite mechanics and anti-spam controls
- pod lifecycle states and director role
- pod meetings + ICS/calendar flow
- governance and strike system
- subscription tier enforcement and conversion rules
- badge/status system
- admin analytics suite

---

## 15) Phase 3+ Scope (Advanced)

- ORCHESTRA masterclass system
- CONCERT scale events
- AI-assisted matching and recommendation layers
- additional pod orchestration types
- mobile/PWA maturity and deeper localization

---

## 16) Non-Negotiables

- strict separation of pod, matching, orchestration, and provider logic
- persistent encounter memory across sessions
- auditable admin/host actions
- secure invite and authentication surfaces
- stable exports and post-event reporting

---

## 17) Risk Register (Phase 1 Focus)

1. matching quality/performance drift at high participant counts
2. transition latency spikes during synchronized round switching
3. no-show cascades creating participant isolation
4. invite abuse before trust controls mature
5. reconnect storms during peak active states

### Mitigations
- load and simulation testing before live event
- reassignment pool + host override
- strict rate limit + anti-abuse gates
- full instrumentation and runbooks

---

## 18) Immediate Next Execution Sequence

1. Freeze phase 1 schema and API boundaries.
2. Confirm service interfaces (matching/orchestration/video).
3. Implement Milestone 1 foundation.
4. Implement Milestone 2 engine and live orchestration.
5. Execute Milestone 3 live run and hardening.

This file is the canonical expanded implementation blueprint.