# RSN Testing Guide

## Quick Start

### 1. Generate Test Token

Generate a valid JWT token for API testing:

```bash
node test/utils/get-magic-token.js
```

This outputs:
- Valid JWT access token (15 min expiry)
- Validates against your local server
- Use in Postman `accessToken` variable

### 2. Run Smoke Tests

Quick validation of core API functionality:

```bash
# Make sure server is running first
cd server
npm run dev

# In another terminal
node test/integration/smoke-tests.js
```

**Smoke Test Coverage:**
- ✅ Server health check
- ✅ Authentication routes
- ✅ Middleware layers (auth, validation, CORS)
- ✅ Error handlers (404, 401)
- ✅ Rate limiting

### 3. Run E2E Tests

Full end-to-end flow validation:

```bash
node test/e2e/test-e2e-flow.js
```

**E2E Test Coverage:**
- ✅ Authentication (magic link → JWT)
- ✅ User profile operations
- ✅ Pod creation
- ✅ Session creation
- ✅ Invite generation
- ✅ Participant registration
- ✅ Rating submission

### 4. Postman Collection

Interactive API testing with Postman:

1. **Import Collection**
   - Open Postman
   - Import → Upload Files
   - Select `docs/api/RSN-API.postman_collection.json`

2. **Setup Environment**
   - Create environment: `RSN-Dev`
   - Variables:
     ```
     baseUrl: http://localhost:3001
     accessToken: (run get-magic-token.js to get this)
     podId: (auto-populated on pod creation)
     sessionId: (auto-populated on session creation)
     inviteCode: (auto-populated on invite creation)
     matchId: (auto-populated on match creation)
     ```

3. **Testing Flow**
   - Health Check → 200 OK
   - Auth → Request Magic Link → Verify
   - Create Pod → Create Session → Register
   - Submit Rating → View Encounters

---

## Test Coverage

| Type | Count | Status | Coverage |
|---|---|---|---|
| **Unit Tests (Jest)** | 165 | ✅ All passing | 63% statements |
| **Integration Tests** | 13 suites | ✅ All passing | Route + Service |
| **Smoke Tests** | 10 checks | ✅ All passing | Core API functionality |
| **E2E Tests** | 8 steps | ✅ All passing | Full user journey |
| **API Endpoints** | 46 | ✅ All tested | Postman collection |

---

## Running Jest Tests

### All Tests
```bash
npm test
```

### Server Tests Only
```bash
npx jest --config server/jest.config.js
```

### Shared Tests Only
```bash
npx jest --config shared/jest.config.js
```

### Watch Mode
```bash
npm test -- --watch
```

### Coverage Report
```bash
npm test -- --coverage
```

---

## Test Environment Setup

### Prerequisites
- PostgreSQL 17+ running
- Database `rsn_dev` created
- User `rsn_dev` with password `rsn_dev_password`
- Server running on port 3001

### Database Setup
```bash
# Create database (if not exists)
cd server
npm run migrate
```

### Environment Variables
See `server/.env.example` for required configuration.

---

## Troubleshooting

### JWT Token Expired
```bash
# Generate fresh token
node test/utils/get-magic-token.js
# Copy new token to Postman accessToken variable
```

### Database Connection Error
```bash
# Verify PostgreSQL is running
# Check server/.env credentials match your DB
```

### Port Already in Use
```bash
# Change port in server/.env
PORT=3002
```

---

## Test Data

### Default Test User
- **ID**: `550e8400-e29b-41d4-a716-446655440001`
- **Email**: `test@example.com`
- **Role**: `member`
- **Password**: N/A (magic link auth)

### Creating Additional Test Data
Use Postman collection endpoints to create:
- Pods (speed_networking, roundtable, etc.)
- Sessions (scheduled events)
- Invites (pod, session, direct)
- Ratings (quality scores 1-5)

---

## Next Steps

After testing Milestone 1:
- [ ] Matching engine integration tests
- [ ] Real-time event tests (Socket.IO)
- [ ] Video routing tests (LiveKit)
- [ ] Frontend E2E tests (Playwright/Cypress)

See [plan.md](../plan.md) for full roadmap.
