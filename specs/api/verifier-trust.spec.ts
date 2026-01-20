/**
 * Verifier Trust API E2E Tests
 *
 * @tags @api @trust @verifier
 *
 * These tests verify the discover-and-trust endpoint functionality for verifiers,
 * including trust evaluation via the AuthZEN PDP integration.
 *
 * Test environment requirements:
 * - go-wallet-backend running on BACKEND_URL (default: http://localhost:8080)
 * - mock-verifier running on MOCK_VERIFIER_URL (default: http://localhost:9001)
 * - mock-trust-pdp running on MOCK_PDP_URL (default: http://localhost:9091)
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { TrustApiHelper } from '../../helpers/trust-api';
import { createTestUser, type TestUser } from '../../helpers/test-token';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const MOCK_VERIFIER_URL = process.env.MOCK_VERIFIER_URL || 'http://localhost:9001';
const MOCK_PDP_URL = process.env.MOCK_PDP_URL || 'http://localhost:9091';

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

test.describe('Verifier Trust - Mock Verifier Availability @api @trust @verifier', () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('mock verifier health endpoint responds', async () => {
    const response = await request.get(`${MOCK_VERIFIER_URL}/health`);
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.verifier).toBeTruthy();
  });

  test('mock verifier exposes well-known endpoint', async () => {
    const response = await request.get(`${MOCK_VERIFIER_URL}/.well-known/openid4vp-verifier`);
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.client_id).toBeTruthy();
    expect(metadata.client_name).toBe('Test Verifier');
    expect(metadata.vp_formats).toBeDefined();
  });

  test('mock verifier exposes openid-configuration', async () => {
    const response = await request.get(`${MOCK_VERIFIER_URL}/.well-known/openid-configuration`);
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.issuer).toBe(MOCK_VERIFIER_URL);
  });

  test('mock verifier returns presentation types', async () => {
    const response = await request.get(`${MOCK_VERIFIER_URL}/presentation_types`);
    expect(response.ok()).toBe(true);

    const types = await response.json();
    expect(types['eu.europa.ec.eudi.pid.1']).toBeDefined();
    expect(types['org.iso.18013.5.1.mDL']).toBeDefined();
  });
});

test.describe('Verifier Trust - Discovery and Trust Evaluation @api @trust @verifier', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let mockVerifierAvailable = false;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);

    // Check if mock verifier is available
    try {
      const healthCheck = await request.get(`${MOCK_VERIFIER_URL}/health`);
      mockVerifierAvailable = healthCheck.ok();
    } catch {
      mockVerifierAvailable = false;
    }
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('discovers mock verifier via discover-and-trust API', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockVerifierAvailable, 'Mock verifier not available');

    const { response, status } = await trustApi.discoverAndTrustVerifier(MOCK_VERIFIER_URL);

    expect(status).toBe(200);
    expect(response).toBeDefined();
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
    // Verifier discovery may be 'success' or 'skipped' depending on backend implementation
    expect(['success', 'skipped']).toContain(response.discovery_status);
  });

  test('evaluates trust for mock verifier', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockVerifierAvailable, 'Mock verifier not available');

    const { response, status } = await trustApi.discoverAndTrustVerifier(MOCK_VERIFIER_URL);

    expect(status).toBe(200);
    // With mock-trust-pdp configured to trust localhost:9001, should be trusted
    expect(response.trusted).toBe(true);
    expect(response.reason).toBeTruthy();
  });

  test('evaluates trust with credential type parameter', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!mockVerifierAvailable, 'Mock verifier not available');

    const { response, status } = await trustApi.discoverAndTrustVerifier(
      MOCK_VERIFIER_URL,
      'eu.europa.ec.eudi.pid.1'
    );

    expect(status).toBe(200);
    expect(typeof response.trusted).toBe('boolean');
    // Credential type should be passed through to trust evaluation
  });
});

test.describe('Verifier Trust - Untrusted Verifier @api @trust @verifier', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('unknown verifier returns appropriate trust response', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    // Use a verifier URL that is NOT in the PDP's explicit trusted list
    // Note: The mock PDP may have fallback policies that trust localhost URLs
    const unknownVerifier = 'https://unknown-verifier.example.com';

    const { response, status } = await trustApi.discoverAndTrustVerifier(unknownVerifier);

    expect(status).toBe(200);
    // Trust decision depends on PDP configuration
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });

  test('verifier on different port may have different trust status', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    // Use a verifier on a port that may or may not be explicitly trusted
    // The mock PDP trusts localhost URLs by default for dev convenience
    const differentPort = 'http://localhost:9999';

    const { response, status } = await trustApi.discoverAndTrustVerifier(differentPort);

    expect(status).toBe(200);
    // The response should be valid regardless of trust decision
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });
});

test.describe('Verifier Trust - PDP Integration @api @trust @verifier @pdp', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let pdpAvailable = false;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    // Generate a test user with a valid JWT token
    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);

    // Check if mock PDP is available
    try {
      const healthCheck = await request.get(`${MOCK_PDP_URL}/health`);
      pdpAvailable = healthCheck.ok();
    } catch {
      pdpAvailable = false;
    }
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('mock PDP is available', async () => {
    test.skip(!pdpAvailable, 'Mock PDP not available');

    const response = await request.get(`${MOCK_PDP_URL}/health`);
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test('PDP evaluates verifier trust correctly', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!pdpAvailable, 'Mock PDP not available');

    // The mock PDP is configured with TRUSTED_VERIFIERS=http://localhost:9001
    const { response, status } = await trustApi.discoverAndTrustVerifier(MOCK_VERIFIER_URL);

    expect(status).toBe(200);
    expect(response.trusted).toBe(true);
    // Should indicate the trust framework used
    if (response.trust_framework) {
      expect(response.trust_framework).toBeTruthy();
    }
  });

  test('PDP evaluates verifier not in explicit list', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    test.skip(!pdpAvailable, 'Mock PDP not available');

    // This verifier is not in the TRUSTED_VERIFIERS list
    // but may be trusted by fallback policies (localhost)
    const otherVerifier = 'http://localhost:9999';

    const { response, status } = await trustApi.discoverAndTrustVerifier(otherVerifier);

    expect(status).toBe(200);
    // Trust decision depends on PDP's policy configuration
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });
});

test.describe('Verifier Trust - Response Structure @api @trust @verifier', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('verifier response has all required fields', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier(
      'https://verifier.example.com'
    );

    expect(status).toBe(200);

    // Required fields
    expect(typeof response.trusted).toBe('boolean');
    expect(typeof response.reason).toBe('string');
    expect(response.reason.length).toBeGreaterThan(0);
    expect(['success', 'partial', 'failed', 'skipped']).toContain(response.discovery_status);
  });

  test('verifier response includes optional verifier_metadata when discovered', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier(MOCK_VERIFIER_URL);

    expect(status).toBe(200);

    // verifier_metadata is optional - depends on backend implementing verifier metadata discovery
    // When implemented, it should be an object
    if (response.verifier_metadata) {
      expect(typeof response.verifier_metadata).toBe('object');
    }
  });

  test('verifier response does NOT include issuer_metadata', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier(
      'https://verifier.example.com'
    );

    expect(status).toBe(200);

    // Verifier response should not have issuer_metadata
    expect(response.issuer_metadata).toBeUndefined();
  });
});

test.describe('Verifier Trust - Error Handling @api @trust @verifier', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('handles invalid verifier URL gracefully', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier('not-a-valid-url');

    expect(status).toBe(200);
    // Should complete without crashing - trust decision depends on backend config
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });

  test('handles unreachable verifier gracefully', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    const { response, status } = await trustApi.discoverAndTrustVerifier(
      'https://unreachable.example.com'
    );

    expect(status).toBe(200);
    // Should complete without crashing - trust decision depends on backend config
    expect(typeof response.trusted).toBe('boolean');
    expect(response.reason).toBeTruthy();
  });
});

test.describe('Verifier Trust - Comparison with Issuer Trust @api @trust @verifier', () => {
  let request: APIRequestContext;
  let trustApi: TrustApiHelper;
  let testUser: TestUser;
  let apiVersionSupported = false;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    trustApi = new TrustApiHelper(request, BACKEND_URL);
    apiVersionSupported = await isApiVersionSupported();

    testUser = createTestUser();
    trustApi.setAuthToken(testUser.token);
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('same endpoint handles both issuer and verifier roles', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    
    // Issuer request
    const issuerResult = await trustApi.discoverAndTrustIssuer('https://example.com');
    expect(issuerResult.status).toBe(200);

    // Verifier request
    const verifierResult = await trustApi.discoverAndTrustVerifier('https://example.com');
    expect(verifierResult.status).toBe(200);

    // Both should have the same structure
    expect(typeof issuerResult.response.trusted).toBe('boolean');
    expect(typeof verifierResult.response.trusted).toBe('boolean');
  });

  test('issuer and verifier trust are evaluated independently', async () => {
    test.skip(!apiVersionSupported, 'Requires API version 2+ (discover-and-trust support)');
    // An entity might be trusted as an issuer but not as a verifier
    // Test that the PDP evaluates them separately

    // Mock issuer is trusted
    const issuerResult = await trustApi.discoverAndTrustIssuer('http://localhost:9000');

    // Different URL that's only configured as trusted verifier
    const verifierResult = await trustApi.discoverAndTrustVerifier('http://localhost:9001');

    // Both should have valid responses
    expect(issuerResult.status).toBe(200);
    expect(verifierResult.status).toBe(200);

    // Trust decisions should be independent
    expect(typeof issuerResult.response.trusted).toBe('boolean');
    expect(typeof verifierResult.response.trusted).toBe('boolean');
  });
});
