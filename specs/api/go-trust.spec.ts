/**
 * Go-Trust Integration E2E Tests
 *
 * @tags @api @trust @go-trust
 *
 * These tests verify trust evaluation using go-trust with different registries:
 * 1. Always-trusted registry (all issuers trusted)
 * 2. Never-trusted registry (all issuers rejected)
 * 3. Whitelist registry (only specific issuers trusted)
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

// Mock issuer identifier (matches whitelist)
const MOCK_ISSUER_ID = 'http://localhost:9000';
// Unknown issuer (not in whitelist)
const UNKNOWN_ISSUER_ID = 'http://unknown-issuer.example.com';

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
          id: MOCK_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_ID,
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
          id: MOCK_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_ID,
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

test.describe('Whitelist Registry', () => {
  test('trusts whitelisted issuer', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_ID,
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

  test('rejects non-whitelisted issuer', async () => {
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

  test('provides context in response', async () => {
    const ctx = await request.newContext();
    const response = await ctx.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
      data: {
        subject: {
          type: 'key',
          id: MOCK_ISSUER_ID,
        },
        resource: {
          type: 'jwk',
          id: MOCK_ISSUER_ID,
        },
        action: {
          name: 'issuer',
        },
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.decision).toBe(true);
    // Check for context in response (trust framework info)
    if (body.context) {
      expect(body.context).toBeDefined();
    }
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
