/**
 * Test Token Generator
 *
 * Generates valid JWT tokens for E2E testing.
 * The token is signed with the same secret used by the test backend.
 */

import { createHmac, randomUUID } from 'crypto';

// Default JWT secret used by the test backend
// This matches the WALLET_JWT_SECRET environment variable used when starting the backend for tests
const DEFAULT_JWT_SECRET = 'test-secret-for-e2e-testing-minimum-32-chars';

export interface TokenClaims {
  user_id: string;
  did?: string;
  iat?: number;
  exp?: number;
}

/**
 * Base64URL encode a string (JWT-safe encoding)
 */
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a JWT token for testing
 */
export function generateTestToken(
  claims: Partial<TokenClaims> = {},
  secret: string = DEFAULT_JWT_SECRET
): string {
  const now = Math.floor(Date.now() / 1000);

  // Default claims
  const tokenClaims: TokenClaims = {
    user_id: claims.user_id || randomUUID(),
    did: claims.did || `did:key:test-${randomUUID()}`,
    iat: claims.iat || now,
    exp: claims.exp || now + 3600, // 1 hour expiry
  };

  // JWT header
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(tokenClaims));

  // Create signature
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Generate a test user with a valid token
 */
export interface TestUser {
  userId: string;
  did: string;
  token: string;
}

export function createTestUser(): TestUser {
  const userId = randomUUID();
  const did = `did:key:test-${userId}`;
  const token = generateTestToken({ user_id: userId, did });

  return {
    userId,
    did,
    token,
  };
}

/**
 * Get the JWT secret from environment or use default
 */
export function getJwtSecret(): string {
  return process.env.WALLET_JWT_SECRET || DEFAULT_JWT_SECRET;
}
