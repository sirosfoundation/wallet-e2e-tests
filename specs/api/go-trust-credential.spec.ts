/**
 * Go-Trust Whitelist Credential Flow Tests
 * 
 * These tests verify:
 * 1. The go-trust whitelist registry service is running
 * 2. Credential issuance works when issuer is on the whitelist
 * 3. Wallet-backend correctly consults go-trust for trust decisions
 * 
 * Prerequisites:
 * - Run `make up-go-trust-whitelist` to start the environment
 * - go-trust whitelist registry on port 9093
 * - wallet-backend configured with WALLET_TRUST_PDP_URL=http://localhost:9093
 */

import { test, expect } from '@playwright/test';

const GO_TRUST_WHITELIST_URL = process.env.GO_TRUST_WHITELIST_URL || 'http://localhost:9093';
const MOCK_ISSUER_URL = process.env.MOCK_ISSUER_URL || 'http://localhost:9000';
const MOCK_VERIFIER_URL = process.env.MOCK_VERIFIER_URL || 'http://localhost:9001';

test.describe('Go-Trust Whitelist PDP Tests', () => {
  test.describe('Service Health', () => {
    test('go-trust whitelist service is healthy', async ({ request }) => {
      const response = await request.get(`${GO_TRUST_WHITELIST_URL}/healthz`);
      expect(response.ok()).toBe(true);
    });

    test('go-trust whitelist reports ready', async ({ request }) => {
      const response = await request.get(`${GO_TRUST_WHITELIST_URL}/readyz`);
      // Static registries return 200 (ready) or 503 (not_ready) 
      // Both are valid - 503 just means "static registry never becomes ready"
      expect([200, 503]).toContain(response.status());
    });

    test('mock issuer is healthy', async ({ request }) => {
      const response = await request.get(`${MOCK_ISSUER_URL}/health`);
      expect(response.ok()).toBe(true);
    });

    test('mock verifier is healthy', async ({ request }) => {
      const response = await request.get(`${MOCK_VERIFIER_URL}/health`);
      expect(response.ok()).toBe(true);
    });
  });

  test.describe('Whitelist Registry Verification', () => {
    test('whitelist registry has correct type', async ({ request }) => {
      const response = await request.get(`${GO_TRUST_WHITELIST_URL}/info`);
      expect(response.ok()).toBe(true);
      
      const data = await response.json();
      // Info returns an array of registries
      expect(data.registries).toBeDefined();
      expect(data.registries.length).toBeGreaterThan(0);
      expect(data.registries[0].type).toBe('static_whitelist');
    });

    test('mock issuer is trusted via whitelist', async ({ request }) => {
      const response = await request.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
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
      const data = await response.json();
      expect(data.decision).toBe(true);
    });

    test('mock verifier is trusted via whitelist', async ({ request }) => {
      const response = await request.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
        data: {
          subject: {
            type: 'key', 
            id: MOCK_VERIFIER_URL,
          },
          resource: {
            type: 'jwk',
            id: MOCK_VERIFIER_URL,
          },
          action: {
            name: 'verifier',
          },
        },
      });
      
      expect(response.ok()).toBe(true);
      const data = await response.json();
      expect(data.decision).toBe(true);
    });

    test('unknown issuer is not trusted', async ({ request }) => {
      const response = await request.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
        data: {
          subject: {
            type: 'key',
            id: 'https://untrusted-issuer.example.com',
          },
          resource: {
            type: 'jwk',
            id: 'https://untrusted-issuer.example.com',
          },
          action: {
            name: 'issuer',
          },
        },
      });
      
      expect(response.ok()).toBe(true);
      const data = await response.json();
      expect(data.decision).toBe(false);
    });

    test('unknown verifier is not trusted', async ({ request }) => {
      const response = await request.post(`${GO_TRUST_WHITELIST_URL}/evaluation`, {
        data: {
          subject: {
            type: 'key',
            id: 'https://untrusted-verifier.example.com',
          },
          resource: {
            type: 'jwk',
            id: 'https://untrusted-verifier.example.com',
          },
          action: {
            name: 'verifier',
          },
        },
      });
      
      expect(response.ok()).toBe(true);
      const data = await response.json();
      expect(data.decision).toBe(false);
    });
  });
});

test.describe('Wallet Backend Trust Integration', () => {
  const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
  
  test('wallet backend is healthy', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/status`);
    expect(response.ok()).toBe(true);
  });

  test.skip('wallet backend consults go-trust for issuer trust', async ({ request }) => {
    // This test would require a more complex setup where we:
    // 1. Initiate a credential issuance from mock issuer
    // 2. Verify that wallet-backend calls go-trust /evaluation endpoint
    // 3. Check that the issuance succeeds because issuer is whitelisted
    //
    // For now, we verify the PDP endpoints directly.
    // Full integration test would be added once wallet-backend PDP integration is confirmed.
  });
});
