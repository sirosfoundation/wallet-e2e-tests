/**
 * Discover and Trust API E2E Tests
 *
 * @tags @api @trust
 *
 * These tests verify the discover-and-trust endpoint functionality,
 * including API versioning, authentication, validation, and trust evaluation.
 *
 * Test environment requirements:
 * - go-wallet-backend running on BACKEND_URL (default: http://localhost:8080)
 * - Optional: mock-issuer running on MOCK_ISSUER_URL
 * - Optional: go-trust PDP running on TRUST_PDP_URL
 *
 * NOTE: These tests require API version 2+. If the backend doesn't support
 * the discover-and-trust endpoint, tests will be skipped automatically.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { TrustApiHelper, DiscoverAndTrustRequest } from '../../helpers/trust-api';
import { createTestUser, generateTestToken, type TestUser } from '../../helpers/test-token';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const MOCK_ISSUER_URL = process.env.MOCK_ISSUER_URL || 'http://localhost:9000';
const TRUST_PDP_URL = process.env.TRUST_PDP_URL || 'http://localhost:9090';

// Check if discover-and-trust is available before running tests
async function isApiVersionSupported(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/status`);
    if (!response.ok) return false;
    const status = await response.json();
    return (status.api_version ?? 1) >= 2;
  } catch {
    return false;
  }
}

test.describe('API Version Discovery @api @trust', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    // Check API version support upfront
    apiVersionSupported = await isApiVersionSupported();
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('status endpoint returns api_version field', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const status = await trustApi.getStatus();

    expect(status.status).toBe('ok');
    expect(status.service).toBe('wallet-backend');
    expect(status.api_version).toBeDefined();
    expect(typeof status.api_version).toBe('number');
  });

  test('api_version is 2 or higher for discover-and-trust support', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const version = await trustApi.getApiVersion();

    // API version 2 adds discover-and-trust endpoint
    expect(version).toBeGreaterThanOrEqual(2);
  });

  test('isDiscoverAndTrustAvailable returns true for API v2+', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const available = await trustApi.isDiscoverAndTrustAvailable();

    expect(available).toBe(true);
  });
});

test.describe('Discover and Trust - Authentication @api @trust', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('discover-and-trust requires authentication', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    // Don't set auth token
    trustApi.clearAuthToken();

    const { status } = await trustApi.discoverAndTrust({
      entity_identifier: 'https://issuer.example.com',
      role: 'issuer',
    });

    // Should return 401 Unauthorized
    expect(status).toBe(401);
  });
});

test.describe('Discover and Trust - Input Validation @api @trust', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();
    // Note: These tests check validation which happens before auth check
    // Some backends may return 401 first, adjust expectations accordingly
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('rejects request with missing entity_identifier', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const response = await request.post(`${BACKEND_URL}/discover-and-trust`, {
      data: {
        role: 'issuer',
        // Missing entity_identifier
      },
      headers: { 'Content-Type': 'application/json' },
    });

    // Either 400 (validation error) or 401 (auth required)
    expect([400, 401]).toContain(response.status());
  });

  test('rejects request with missing role', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const response = await request.post(`${BACKEND_URL}/discover-and-trust`, {
      data: {
        entity_identifier: 'https://issuer.example.com',
        // Missing role
      },
      headers: { 'Content-Type': 'application/json' },
    });

    expect([400, 401]).toContain(response.status());
  });

  test('rejects request with invalid role', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const response = await request.post(`${BACKEND_URL}/discover-and-trust`, {
      data: {
        entity_identifier: 'https://issuer.example.com',
        role: 'admin', // Invalid role
      },
      headers: { 'Content-Type': 'application/json' },
    });

    expect([400, 401]).toContain(response.status());
  });
});

test.describe('Discover and Trust - Response Structure @api @trust', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    // The token is signed with the same secret used by the test backend
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('issuer discovery returns correct response structure', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustIssuer(
      'https://issuer.example.com'
    );

    expect(status).toBe(200);
    expect(response).toBeDefined();

    // Verify required fields
    expect(typeof response.trusted).toBe('boolean');
    expect(typeof response.reason).toBe('string');
    expect(['success', 'partial', 'failed']).toContain(response.discovery_status);
  });

  test('verifier discovery returns correct response structure', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier(
      'https://verifier.example.com'
    );

    expect(status).toBe(200);
    expect(response).toBeDefined();

    // Verify required fields
    expect(typeof response.trusted).toBe('boolean');
    expect(typeof response.reason).toBe('string');
    // 'skipped' is valid when no trust evaluation is configured for verifiers
    expect(['success', 'partial', 'failed', 'skipped']).toContain(response.discovery_status);
  });

  test('credential_type is passed through to evaluation', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustIssuer(
      'https://issuer.example.com',
      'eu.europa.ec.eudi.pid.1'
    );

    expect(status).toBe(200);
    expect(response).toBeDefined();
  });
});

test.describe('Discover and Trust - Mock Issuer Integration @api @trust @mock', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let mockIssuerAvailable = false;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);

    // Check if mock issuer is available
    try {
      const healthCheck = await request.get(`${MOCK_ISSUER_URL}/.well-known/openid-credential-issuer`);
      mockIssuerAvailable = healthCheck.ok();
    } catch {
      mockIssuerAvailable = false;
    }
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('discovers mock issuer metadata successfully', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockIssuerAvailable, 'Mock issuer not available');

    const { response, status } = await trustApi.discoverAndTrustIssuer(MOCK_ISSUER_URL);

    expect(status).toBe(200);
    expect(response.discovery_status).toBe('success');
    expect(response.issuer_metadata).toBeDefined();
  });

  test('evaluates trust for mock issuer', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockIssuerAvailable, 'Mock issuer not available');

    const { response, status } = await trustApi.discoverAndTrustIssuer(MOCK_ISSUER_URL);

    expect(status).toBe(200);
    // Trust result depends on backend configuration
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });

  test('returns trusted_certificates when issuer has IACA', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockIssuerAvailable, 'Mock issuer not available');

    const { response, status } = await trustApi.discoverAndTrustIssuer(MOCK_ISSUER_URL);

    expect(status).toBe(200);

    // If the mock issuer has mdoc_iacas_uri, we should get certificates
    if (response.trusted && response.trusted_certificates) {
      expect(Array.isArray(response.trusted_certificates)).toBe(true);
      // Certificates should be in PEM format
      response.trusted_certificates.forEach(cert => {
        expect(cert).toContain('-----BEGIN CERTIFICATE-----');
      });
    }
  });
});

test.describe('Discover and Trust - go-trust PDP Integration @api @trust @pdp', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let pdpAvailable = false;
  let apiVersionSupported: boolean;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);

    // Check if go-trust PDP is available
    try {
      const healthCheck = await request.get(`${TRUST_PDP_URL}/.well-known/authzen-configuration`);
      pdpAvailable = healthCheck.ok();
    } catch {
      pdpAvailable = false;
    }
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('go-trust PDP is discoverable', async () => {
    test.skip(!pdpAvailable, 'go-trust PDP not available');

    const response = await request.get(`${TRUST_PDP_URL}/.well-known/authzen-configuration`);
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.policy_decision_point).toBeTruthy();
    expect(metadata.access_evaluation_endpoint).toBeTruthy();
  });

  test('trusted issuer returns trusted=true via PDP', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!pdpAvailable, 'go-trust PDP not available');

    // Use a known trusted issuer configured in the PDP
    const trustedIssuer = process.env.TRUSTED_ISSUER_URL || 'https://trusted-issuer.example.com';

    const { response, status } = await trustApi.discoverAndTrustIssuer(trustedIssuer);

    expect(status).toBe(200);
    // This test assumes the PDP is configured to trust this issuer
    // In CI, configure the PDP with appropriate trust anchors
    if (response.discovery_status === 'success') {
      expect(response.trust_framework).toBeTruthy();
    }
  });

  test('untrusted issuer returns trusted=false via PDP', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!pdpAvailable, 'go-trust PDP not available');

    // Use a known untrusted issuer
    const untrustedIssuer = 'https://malicious-issuer.example.com';

    const { response, status } = await trustApi.discoverAndTrustIssuer(untrustedIssuer);

    expect(status).toBe(200);
    // Discovery may fail, but if it succeeds, should be untrusted
    if (response.discovery_status === 'success') {
      expect(response.trusted).toBe(false);
    }
  });
});

test.describe('Discover and Trust - Backwards Compatibility @api @trust', () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('legacy endpoints still work alongside new endpoints', async () => {
    // Verify that existing proxy endpoint still works
    // This ensures backwards compatibility
    const proxyResponse = await request.post(`${BACKEND_URL}/proxy`, {
      data: {
        url: 'https://example.com/.well-known/openid-credential-issuer',
        method: 'GET',
      },
      headers: { 'Content-Type': 'application/json' },
    });

    // Should return 401 (auth required) not 404 (not found)
    expect(proxyResponse.status()).not.toBe(404);
  });

  test('status endpoint is backwards compatible', async () => {
    const response = await request.get(`${BACKEND_URL}/status`);
    expect(response.ok()).toBe(true);

    const data = await response.json();

    // Original fields should still be present
    expect(data.status).toBe('ok');
    expect(data.service).toBe('wallet-backend');

    // New field should be additive
    if (data.api_version !== undefined) {
      expect(typeof data.api_version).toBe('number');
    }
  });
});
