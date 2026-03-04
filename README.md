# RSN Pod Engine

**Real-time Speed Networking Platform** — Phase 1 Implementation

Transform traditional networking through intelligent algorithms, structured conversations, and seamless video connections.

---

## 🎯 Project Status

**Current Milestone**: Milestone 1 (Foundation) — ✅ **COMPLETE**

| Milestone | Status | Details |
|---|---|---|
| **M1: Foundation** | ✅ Complete | Backend API, auth, database, testing |
| **M2: Integration** | 🔄 Next | Matching engine, real-time, video, frontend |
| **M3: Scale** | ⏳ Planned | Performance optimization, 300+ participants |

### Milestone 1 Exit Criteria ✅

- ✅ Pod and session creation works through API
- ✅ Participant registration records persist correctly
- ✅ Architecture and schema validated
- ✅ 165/165 tests passing (Jest + E2E)
- ✅ 46 API endpoints validated via Postman
- ✅ RBAC enforcement confirmed

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **PostgreSQL** 17+
- **npm** or **pnpm**

### Installation

```bash
# Clone repository
git clone https://github.com/YOUR_USERNAME/rsn-pod-engine.git
cd rsn-pod-engine

# Install dependencies
npm install

# Setup database
createdb rsn_dev
psql rsn_dev < server/src/db/migrations/001_initial_schema.sql

# Configure environment
cp server/.env.example server/.env
# Edit server/.env with your database credentials

# Start development server
cd server
npm run dev
```

Server runs on **http://localhost:3001**

### Testing

```bash
# Run all tests
npm test

# Generate coverage report
npm test -- --coverage

# Run E2E tests
node test/e2e/test-e2e-flow.js

# API testing with Postman
# Import docs/api/RSN-API.postman_collection.json
```

See [test/README.md](test/README.md) for comprehensive testing guide.

---

## 📐 Architecture

### Tech Stack

- **Backend**: Node.js + Express.js + TypeScript
- **Database**: PostgreSQL 17
- **Real-time**: Socket.IO (M2)
- **Video**: LiveKit (M2)
- **Frontend**: React + TypeScript (M2)
- **Auth**: Magic Link → JWT (15min access, 7d refresh)
- **Testing**: Jest (165 tests), Postman (46 endpoints), E2E automation

### Monorepo Structure

```
RSN/
├── server/          # Express API + Socket.IO
│   ├── src/
│   │   ├── routes/      # 7 API route groups
│   │   ├── services/    # 8 core services
│   │   ├── middleware/  # 7 middleware layers
│   │   ├── db/          # Migrations + connection pool
│   │   └── config/      # Environment + logger
│   └── __tests__/       # 14 test suites
├── shared/          # TypeScript contracts
│   └── src/types/       # Enums, errors, config
├── test/
│   ├── utils/           # JWT generator
│   ├── e2e/             # Full flow automation
│   └── README.md        # Testing guide
├── docs/
│   └── api/             # Postman collection
├── plan.md              # Implementation blueprint
└── progress.md          # Milestone tracking
```

### Database Schema

15 tables:
- **Identity**: users, magic_links
- **Organization**: pods, pod_members
- **Events**: sessions, session_participants
- **Matching**: matches, ratings, encounter_history
- **Invites**: invites
- **User**: user_subscriptions, user_preferences
- **System**: audit_logs, rate_limit_logs, notification_queue

---

## 🔑 Key Features (Milestone 1)

### Authentication
- ✅ Magic link email authentication
- ✅ JWT access tokens (15min) + refresh tokens (7d)
- ✅ Role-based access control (member, host, admin)

### Pod Management
- ✅ Create/update/delete pods
- ✅ Pod types: speed_networking, roundtable, office_hours, workshop
- ✅ Capacity limits: 6-300 participants
- ✅ Member management

### Session Management
- ✅ Schedule networking sessions
- ✅ Participant registration
- ✅ Session lifecycle (scheduled → active → completed)
- ✅ Host controls

### Invites System
- ✅ 3 invite types: pod, session, platform
- ✅ Unique 8-char codes
- ✅ Rate limiting (5 per hour)
- ✅ Expiration tracking

### Rating & Feedback
- ✅ Post-conversation quality ratings (1-5)
- ✅ Encounter history tracking
- ✅ Duplicate prevention
- ✅ Analytics foundation

---

## 📖 API Reference

### Base URL
```
http://localhost:3001
```

### Authentication Flow
```bash
# 1. Request magic link
POST /auth/magic-link
{ "email": "user@example.com" }

# 2. Verify token (from email link)
POST /auth/verify-magic-link
{ "token": "64-char-hex-token" }

# 3. Use JWT in headers
Authorization: Bearer <accessToken>
```

### Core Endpoints

| Endpoint | Method | Description |
|---|---|---|
| **Health Check** | | |
| `/health` | GET | Server status |
| **Auth** | | |
| `/auth/magic-link` | POST | Request magic link |
| `/auth/verify-magic-link` | POST | Verify token → JWT |
| `/auth/refresh` | POST | Refresh access token |
| **Users** | | |
| `/users/me` | GET | Current user profile |
| `/users/me` | PATCH | Update profile |
| **Pods** | | |
| `/pods` | GET | List all pods |
| `/pods` | POST | Create pod |
| `/pods/:id` | GET/PATCH/DELETE | Pod operations |
| **Sessions** | | |
| `/sessions` | GET | List sessions |
| `/sessions` | POST | Create session |
| `/sessions/:id/register` | POST | Register participant |
| **Invites** | | |
| `/invites` | POST | Generate invite code |
| `/invites/:code` | GET | Validate invite |
| **Ratings** | | |
| `/ratings` | POST | Submit quality rating |
| `/ratings/encounters` | GET | View encounter history |

Full collection: [docs/api/RSN-API.postman_collection.json](docs/api/RSN-API.postman_collection.json)

---

## 🧪 Testing

### Coverage Summary

| Module | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| **Overall** | 63.27% | 53.92% | 56.87% | 63.22% |
| Middleware | 85%+ | 75%+ | 90%+ | 85%+ |
| Services | 70%+ | 60%+ | 75%+ | 70%+ |

### Test Categories

- **Unit Tests**: 165 tests across 14 suites
- **Integration Tests**: API routes + database
- **E2E Tests**: Full user journey (8 steps)
- **Manual Testing**: 46 Postman endpoints validated

See [test/README.md](test/README.md) for full testing guide.

---

## 🗺️ Roadmap

### ✅ Milestone 1: Foundation (COMPLETE)

- [x] Database schema + migrations
- [x] Magic link authentication
- [x] Pod & session management
- [x] Invites system
- [x] Rating & feedback
- [x] Comprehensive testing
- [x] API documentation

### 🔄 Milestone 2: Integration (Next)

- [ ] Matching engine integration
- [ ] Socket.IO real-time orchestration
- [ ] LiveKit video routing
- [ ] React frontend client
- [ ] Live session simulation

### ⏳ Milestone 3: Scale

- [ ] Performance optimization
- [ ] Support 300+ participants
- [ ] Advanced analytics
- [ ] Production deployment

Full details: [plan.md](plan.md)

Execution log: [progress.md](progress.md)

---

## 🤝 Contributing

### Branching Strategy

- **main**: Production-ready code (protected)
- **staging**: Pre-production testing (default development)
- **feature/\***: Feature branches (merge to staging)

### Development Workflow

1. Create feature branch from `staging`
2. Implement changes with tests
3. Run full test suite: `npm test`
4. Create PR to `staging`
5. After validation, promote to `main`

---

## 📄 License

[License details to be added]

---

## 📞 Support

For questions or issues:
- Review [plan.md](plan.md) for architecture details
- Check [progress.md](progress.md) for current status
- See [test/README.md](test/README.md) for testing help

---

**Built with ❤️ for better networking experiences**
