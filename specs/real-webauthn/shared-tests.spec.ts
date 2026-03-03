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

// Import all shared test modules
import {
  allSharedTests,
  defineDefaultTenantFlowTests,
  defineCustomTenantFlowTests,
} from '../shared/user-flows.shared';
import {
  defineBackendCapabilitiesTests,
  defineTenantApiTests,
  defineServiceHealthTests,
} from '../shared/backend-capabilities.shared';
import {
  defineTenantRoutingTests,
  defineEndpointConstructionTests,
  defineCrossTenantIsolationTests,
  defineTenantUserHandleTests,
} from '../shared/tenant-routing.shared';
import {
  defineTenantSelectorUnauthTests,
  defineTenantSelectorAuthTests,
  defineTenantSelectorEdgeCaseTests,
} from '../shared/tenant-selector.shared';
import {
  definePdpModeControlTests,
  defineTrustRegistrationTests,
  defineAuthZenDiscoveryTests,
  defineStaticRegistryCompatTests,
} from '../shared/trust-integration.shared';
import {
  defineCredentialFlowHealthTests,
  defineCredentialIssuanceTests,
  defineCredentialIdStabilityTests,
} from '../shared/credential-flow.shared';

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

  // Core User Registration Tests
  allSharedTests.userRegistration(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.prfVerification(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.errorHandling(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  allSharedTests.multiTenant(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // Full User Flow Tests
  defineDefaultTenantFlowTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineCustomTenantFlowTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // Backend Capabilities (API-only tests)
  defineBackendCapabilitiesTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineTenantApiTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineServiceHealthTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // Tenant URL Routing Tests
  defineTenantRoutingTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineEndpointConstructionTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineCrossTenantIsolationTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineTenantUserHandleTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // TenantSelector UI Tests
  defineTenantSelectorUnauthTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineTenantSelectorAuthTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineTenantSelectorEdgeCaseTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // Trust/PDP Integration Tests
  definePdpModeControlTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineTrustRegistrationTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineAuthZenDiscoveryTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineStaticRegistryCompatTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);

  // Credential Flow Tests
  defineCredentialFlowHealthTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineCredentialIssuanceTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
  defineCredentialIdStabilityTests(softFido2Test, () => SOFT_FIDO2_ADAPTER_INFO);
});
