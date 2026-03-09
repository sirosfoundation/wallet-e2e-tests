/**
 * Go-Trust Integration E2E Tests
 *
 * @tags @api @trust @go-trust
 *
 * These tests verify trust evaluation using go-trust with different registries:
 * 1. Always-trusted registry (all issuers trusted)
 * 2. Never-trusted registry (all issuers rejected)
 * 3. Whitelist registry (name-to-key binding verification)
 *
 * Prerequisites:
 *   - docker-compose -f docker-compose.test.yml -f docker-compose.go-trust.yml up -d
 *   - go-trust services running on ports 9091, 9092, 9093
 *
 * Usage:
 *   npx playwright test specs/api/go-trust.spec.ts
 */

import { test, expect, request } from '@playwright/test';

// Go-Trust service URLs
const GO_TRUST_ALLOW_URL = process.env.GO_TRUST_ALLOW_URL || 'http://localhost:9094';
const GO_TRUST_DENY_URL = process.env.GO_TRUST_DENY_URL || 'http://localhost:9092';
const GO_TRUST_WHITELIST_URL = process.env.GO_TRUST_WHITELIST_URL || 'http://localhost:9093';

// Mock service URLs  
// For key binding tests, we need to use the Docker internal URL because
// go-trust-whitelist runs inside Docker and needs to fetch JWKS from mock-issuer
const MOCK_ISSUER_URL = process.env.MOCK_ISSUER_URL || 'http://localhost:9000';
const MOCK_VERIFIER_URL = process.env.MOCK_VERIFIER_URL || 'http://localhost:9001';

// Docker-internal URLs for whitelist tests (go-trust fetches JWKS from these)
const MOCK_ISSUER_DOCKER_URL = 'http://mock-issuer:9000';
const MOCK_VERIFIER_DOCKER_URL = 'http://mock-verifier:9001';

// Unknown issuer (not in whitelist)
const UNKNOWN_ISSUER_ID = 'http://unknown-issuer.example.com';

// Helper to fetch JWKS from mock services
async function fetchJWKS(baseUrl: string): Promise<{ keys: any[] }> {
  const ctx = await request.newContext();
  const response = await ctx.get(`${baseUrl}/.well-known/jwks.json`);
  if (!response.ok()) {
    throw new Error(`Failed to fetch JWKS from ${baseUrl}: ${response.status()}`);
  }
  return response.json();
}

// Generate a fake JWK that doesn't match any real key
function generateFakeJWK(): Record<string, any> {
  return {
    kty: 'EC',
    crv: 'P-256',
    // These are fake coordinates that won't match any real key
    x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    kid: 'fake-key-1',
    use: 'sig',
    alg: 'ES256',
  };
}

test.describe('Go-Trust Service Health', () => {
  test('always-trusted service is healthy', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_ALLOW_URL}/healthz`);
    expect(response.ok()).toBe(true);
  });

  test('never-trusted service is healthy', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_DENY_URL}/healthz`);
    expect(response.ok()).toBe(true);
  });

  test('whitelist service is healthy', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_WHITELIST_URL}/healthz`);
    expect(response.ok()).toBe(true);
  });

  test('services report readyz status', async () => {
    const ctx = await request.newContext();

    // Static registries may report not_ready (503) since they don't use external refresh.
    // We verify the endpoints respond with valid JSON containing status field.
    // Note: 200 = ready, 503 = not ready, both are valid responses.
    const allowReady = await ctx.get(`${GO_TRUST_ALLOW_URL}/readyz`);
    expect([200, 503]).toContain(allowReady.status());
    const allowBody = await allowReady.json();
    expect(allowBody).toHaveProperty('status');

    const denyReady = await ctx.get(`${GO_TRUST_DENY_URL}/readyz`);
    expect([200, 503]).toContain(denyReady.status());
    const denyBody = await denyReady.json();
    expect(denyBody).toHaveProperty('status');

    const whitelistReady = await ctx.get(`${GO_TRUST_WHITELIST_URL}/readyz`);
    expect([200, 503]).toContain(whitelistReady.status());
    const whitelistBody = await whitelistReady.json();
    expect(whitelistBody).toHaveProperty('status');
  });
});

test.describe('Always-Trusted Registry', () => {
  test('trusts any issuer', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_ALLOW_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_URL,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
  });

  test('trusts unknown issuer', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_ALLOW_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: UNKNOWN_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: UNKNOWN_ISSUER_ID,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
  });
});

test.describe('Never-Trusted Registry', () => {
  test('rejects any issuer', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_DENY_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_URL,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(false);
  });

  test('rejects unknown issuer', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_DENY_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: UNKNOWN_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: UNKNOWN_ISSUER_ID,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(false);
  });
});

test.describe('Whitelist Registry - Key Binding Verification', () => {
  // These tests verify that the whitelist registry validates actual name-to-key bindings
  // by fetching JWKS from mock services, not just checking identifiers.

  test('trusts whitelisted issuer with correct key', async () => {
    // Fetch the actual signing key from the mock issuer
    const jwks = await fetchJWKS(MOCK_ISSUER_URL);
    expect(jwks.keys.length).toBeGreaterThan(0);
    const issuerKey = jwks.keys[0];

    const ctx = await request.newContext();
    // Use the Docker-internal URL as subject.id since go-trust-whitelist resolves
    // JWKS from inside Docker (mock-issuer:9000)
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_DOCKER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_DOCKER_URL,
          key: [issuerKey],
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
    // Verify the response includes key fingerprint (proves key binding was checked)
    expect(body.context?.reason?.key_fingerprint).toBeDefined();
    expect(body.context?.reason?.matched_list).toBe('issuers');
  });

  test('trusts whitelisted verifier with correct key', async () => {
    // Fetch the actual signing key from the mock verifier
    const jwks = await fetchJWKS(MOCK_VERIFIER_URL);
    expect(jwks.keys.length).toBeGreaterThan(0);
    const verifierKey = jwks.keys[0];

    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_VERIFIER_DOCKER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_VERIFIER_DOCKER_URL,
          key: [verifierKey],
        },
        action: {
          name: 'verifier',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
    expect(body.context?.reason?.key_fingerprint).toBeDefined();
    expect(body.context?.reason?.matched_list).toBe('verifiers');
  });

  test('rejects whitelisted issuer with wrong key', async () => {
    // Use a fake key that does NOT match the issuer's real key
    const fakeKey = generateFakeJWK();

    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_DOCKER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_DOCKER_URL,
          key: [fakeKey],
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    // The subject IS in the whitelist, but the key doesn't match -> denied
    expect(body.decision).toBe(false);
  });

  test('rejects non-whitelisted issuer regardless of key', async () => {
    const fakeKey = generateFakeJWK();

    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: UNKNOWN_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: UNKNOWN_ISSUER_ID,
          key: [fakeKey],
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(false);
  });

  test('resolution-only request allows whitelisted subject without key', async () => {
    const ctx = await request.newContext();
    // Send a request without resource.type and resource.key (resolution-only)
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_DOCKER_URL,
        },
        resource: {
          id: MOCK_ISSUER_DOCKER_URL,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
    expect(body.context?.reason?.resolution_only).toBe(true);
  });

  test('resolution-only request rejects non-whitelisted subject', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: UNKNOWN_ISSUER_ID,
        },
        resource: {
          id: UNKNOWN_ISSUER_ID,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(false);
  });

  test('verifier key does not work as issuer key', async () => {
    // Fetch the verifier's key and try to use it as an issuer key
    const jwks = await fetchJWKS(MOCK_VERIFIER_URL);
    const verifierKey = jwks.keys[0];

    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_DOCKER_URL,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_DOCKER_URL,
          key: [verifierKey],
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    // Verifier's key should NOT match issuer's registered keys
    expect(body.decision).toBe(false);
  });
});

test.describe('Info Endpoint', () => {
  test('always-trusted reports registry info', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_ALLOW_URL}/info`);

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty('registries');
    expect(Array.isArray(body.registries)).toBe(true);
    expect(body.registries.length).toBeGreaterThan(0);
    expect(body.registries[0].type).toBe('static_always_trusted');
  });

  test('never-trusted reports registry info', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_DENY_URL}/info`);

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.registries[0].type).toBe('static_never_trusted');
  });

  test('whitelist reports registry info', async () => {
    const ctx = await request.newContext();
    const response = await ctx.get(`${GO_TRUST_WHITELIST_URL}/info`);

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.registries[0].type).toBe('static_whitelist');
  });
});
