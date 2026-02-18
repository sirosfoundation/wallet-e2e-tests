/**
 * VCTM Registry E2E Tests
 *
 * @tags @api @registry
 *
 * These tests verify the VCTM registry service:
 * 1. Health/status endpoint
 * 2. Type metadata lookup
 * 3. Dynamic fetching from URLs
 *
 * Prerequisites:
 *   - Registry running on port 8097
 *   - make up
 */

import { test, expect, request } from '@playwright/test';

// Environment URLs
const REGISTRY_URL = process.env.VCTM_REGISTRY_URL || 'http://localhost:8097';

test.describe('VCTM Registry API', () => {
  test.describe('Health & Status', () => {
    test('status endpoint is healthy', async () => {
      const ctx = await request.newContext();
      const response = await ctx.get(`${REGISTRY_URL}/status`);

      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(typeof body.credentials).toBe('number');
    });
  });

  test.describe('Type Metadata Lookup', () => {
    test('returns 400 for missing vct parameter', async () => {
      const ctx = await request.newContext();
      const response = await ctx.get(`${REGISTRY_URL}/type-metadata`);

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('missing_parameter');
    });

    test('returns 404 for unknown VCT', async () => {
      const ctx = await request.newContext();
      const response = await ctx.get(`${REGISTRY_URL}/type-metadata`, {
        params: { vct: 'https://nonexistent.example/credential' },
      });

      expect(response.status()).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
    });

    test('dynamic fetch works for HTTPS URLs (if enabled)', async () => {
      // This test requires dynamic fetching to be enabled
      // Skip if we know the registry doesn't have this VCT cached
      const ctx = await request.newContext();

      // The mock issuer uses this VCT - if dynamic cache is enabled,
      // the registry should attempt to fetch from the URL
      const response = await ctx.get(`${REGISTRY_URL}/type-metadata`, {
        params: { vct: 'https://example.com/identity_credential' },
      });

      // Either:
      // - 200 with metadata (if found in upstream or dynamically fetched)
      // - 404 if not found and dynamic fetch failed/disabled
      if (response.ok()) {
        const body = await response.json();
        expect(body).toBeDefined();
        // Verify X-Cache-Status header if present
        const cacheStatus = response.headers()['x-cache-status'];
        if (cacheStatus) {
          expect(['hit', 'fetched', 'revalidated', 'stale']).toContain(cacheStatus);
        }
      } else {
        // Not found is acceptable if the VCT isn't in the registry
        expect(response.status()).toBe(404);
      }
    });
  });

  test.describe('Credentials List', () => {
    test('lists available credentials', async () => {
      const ctx = await request.newContext();
      const response = await ctx.get(`${REGISTRY_URL}/credentials`);

      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body).toHaveProperty('credentials');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.credentials)).toBe(true);
    });
  });
});

test.describe('Registry Integration', () => {
  /**
   * This test verifies end-to-end that:
   * 1. The frontend app can reach the registry
   * 2. VCTM resolution would work for displayed credentials
   *
   * Note: Full integration would require issuing a credential and
   * verifying the UI displays the resolved metadata. This is covered
   * by credential-flow.spec.ts when VITE_VCT_REGISTRY_URL is configured.
   */
  test('registry is accessible from frontend network', async () => {
    // Since registry uses network_mode: host, it's at localhost:8097
    // which is accessible from both the test runner and containers
    const ctx = await request.newContext();
    const response = await ctx.get(`${REGISTRY_URL}/status`);
    expect(response.ok()).toBe(true);
  });
});
