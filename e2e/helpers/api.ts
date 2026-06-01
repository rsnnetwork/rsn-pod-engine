import { TestUser } from './auth';

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';

async function apiRequest(user: TestUser, method: string, path: string, body?: any) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user.accessToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

export async function createPod(host: TestUser, name: string): Promise<{ id: string; name: string }> {
  const res = await apiRequest(host, 'POST', '/pods', {
    name,
    description: 'E2E test pod',
    visibility: 'private',
    podType: 'speed_networking',
    orchestrationMode: 'timed_rounds',
    communicationMode: 'hybrid',
  });
  return res.data;
}

export async function addPodMember(host: TestUser, podId: string, userId: string, role: 'member' | 'host' = 'member') {
  return apiRequest(host, 'POST', `/pods/${podId}/members`, { userId, role });
}

export async function createSession(host: TestUser, podId: string, title: string, scheduledAt: Date): Promise<{ id: string; title: string }> {
  const res = await apiRequest(host, 'POST', '/sessions', {
    podId,
    title,
    description: 'E2E test session',
    scheduledAt: scheduledAt.toISOString(),
    config: {
      eventType: 'speed_networking',
      numberOfRounds: 3,
      maxParticipants: 50,
      timerVisibility: 'always_visible',
      ratingWindowSeconds: 10,
      lobbyDurationSeconds: 300,
      noShowTimeoutSeconds: 60,
      roundDurationSeconds: 60,
      transitionDurationSeconds: 30,
      closingLobbyDurationSeconds: 300,
    },
  });
  return res.data;
}

export async function registerForSession(user: TestUser, sessionId: string) {
  return apiRequest(user, 'POST', `/sessions/${sessionId}/register`);
}

export async function startSession(host: TestUser, sessionId: string) {
  return apiRequest(host, 'POST', `/sessions/${sessionId}/start`);
}

export async function endSession(host: TestUser, sessionId: string) {
  return apiRequest(host, 'POST', `/sessions/${sessionId}/end`);
}

export { apiRequest };
