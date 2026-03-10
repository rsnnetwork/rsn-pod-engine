// ─── Auth Domain Types ───────────────────────────────────────────────────────

export interface MagicLinkRequest {
  email: string;
}

export interface MagicLinkVerifyRequest {
  token: string;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AuthSession {
  userId: string;
  email: string;
  role: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface JwtPayload {
  sub: string;        // userId
  email: string;
  role: string;
  displayName?: string;
  sessionId: string;
  iat: number;
  exp: number;
}
