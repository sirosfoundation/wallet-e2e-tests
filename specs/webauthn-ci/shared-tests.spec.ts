/**
 * CDP WebAuthn Test Runner
 * 
 * Runs shared test definitions using CDP virtual authenticator with PRF mock.
 * This provides CI/CD-compatible WebAuthn testing.
 * 
 * @tags @webauthn-ci @e2e @shared-tests
 */

import { test } from '@playwright/test';
import { 
  CdpWebAuthnAdapter, 
  type WebAuthnAdapter,
  type WebAuthnAdapterInfo,
  type WebAuthnFixtures 
} from '../../helpers/webauthn-adapter';
import {
  allSharedTests,
} from '../shared/user-flows.shared';

// =============================================================================
// CDP Test Fixture
// =============================================================================

const CDP_ADAPTER_INFO: WebAuthnAdapterInfo = {
  type: 'cdp',
  name: 'CDP Virtual Authenticator',
  prfMocked: true,
  headless: true,
  credentialsPersist: false,
};

/**
 * Extend base test with CDP WebAuthn adapter
 */
const cdpTest = test.extend<WebAuthnFixtures>({
  webauthnAdapter: async ({ page }, use) => {
    const adapter = new CdpWebAuthnAdapter(page);
    await adapter.setup();
    await use(adapter);
    await adapter.teardown();
  },
});

// =============================================================================
// Run Shared Tests with CDP Adapter
// =============================================================================

cdpTest.describe('CDP WebAuthn Tests', () => {
  cdpTest.describe.configure({ mode: 'serial' });

  // Run all shared test suites
  allSharedTests.userRegistration(cdpTest, () => CDP_ADAPTER_INFO);
  allSharedTests.prfVerification(cdpTest, () => CDP_ADAPTER_INFO);
  allSharedTests.errorHandling(cdpTest, () => CDP_ADAPTER_INFO);
  // Multi-tenant tests work but take longer - include for comprehensive testing
  allSharedTests.multiTenant(cdpTest, () => CDP_ADAPTER_INFO);
});
