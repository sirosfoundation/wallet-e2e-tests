/**
 * Soft-FIDO2 WebAuthn Test Runner
 * 
 * Runs shared test definitions using soft-fido2 virtual authenticator.
 * This provides comprehensive WebAuthn testing with native PRF support.
 * 
 * @tags @real-webauthn @e2e @shared-tests
 * 
 * Prerequisites:
 *   SOFT_FIDO2_PATH=/path/to/soft-fido2 make up
 *   make test-webauthn
 */

import { test } from '@playwright/test';
import { 
  SoftFido2WebAuthnAdapter, 
  type WebAuthnAdapter,
  type WebAuthnAdapterInfo,
  type WebAuthnFixtures 
} from '../../helpers/webauthn-adapter';
import {
  allSharedTests,
} from '../shared/user-flows.shared';

// =============================================================================
// Soft-FIDO2 Test Fixture
// =============================================================================

const SOFT_FIDO2_ADAPTER_INFO: WebAuthnAdapterInfo = {
  type: 'soft-fido2',
  name: 'Soft-FIDO2 Virtual Authenticator',
  prfMocked: false,
  headless: false,
  credentialsPersist: true,
};

/**
 * Extend base test with soft-fido2 WebAuthn adapter
 */
const softFido2Test = test.extend<WebAuthnFixtures>({
  webauthnAdapter: async ({ page }, use) => {
    const adapter = new SoftFido2WebAuthnAdapter(page);
    await adapter.setup();
    await use(adapter);
    await adapter.teardown();
  },
});

// =============================================================================
// Run Shared Tests with Soft-FIDO2 Adapter
// =============================================================================

softFido2Test.describe('Soft-FIDO2 WebAuthn Tests', () => {
  softFido2Test.describe.configure({ mode: 'serial' });

  // Run all shared test suites
  allSharedTests.userRegistration(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.prfVerification(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.errorHandling(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.multiTenant(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
});
