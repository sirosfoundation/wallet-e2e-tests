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

  // Core User Registration Tests
  allSharedTests.userRegistration(cdpTest, () => CDP_ADAPTER_INFO);
  allSharedTests.prfVerification(cdpTest, () => CDP_ADAPTER_INFO);
  allSharedTests.errorHandling(cdpTest, () => CDP_ADAPTER_INFO);
  allSharedTests.multiTenant(cdpTest, () => CDP_ADAPTER_INFO);

  // Full User Flow Tests
  defineDefaultTenantFlowTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineCustomTenantFlowTests(cdpTest, () => CDP_ADAPTER_INFO);

  // Backend Capabilities (API-only tests)
  defineBackendCapabilitiesTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineTenantApiTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineServiceHealthTests(cdpTest, () => CDP_ADAPTER_INFO);

  // Tenant URL Routing Tests
  defineTenantRoutingTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineEndpointConstructionTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineCrossTenantIsolationTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineTenantUserHandleTests(cdpTest, () => CDP_ADAPTER_INFO);

  // TenantSelector UI Tests
  defineTenantSelectorUnauthTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineTenantSelectorAuthTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineTenantSelectorEdgeCaseTests(cdpTest, () => CDP_ADAPTER_INFO);

  // Trust/PDP Integration Tests
  definePdpModeControlTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineTrustRegistrationTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineAuthZenDiscoveryTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineStaticRegistryCompatTests(cdpTest, () => CDP_ADAPTER_INFO);

  // Credential Flow Tests
  defineCredentialFlowHealthTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineCredentialIssuanceTests(cdpTest, () => CDP_ADAPTER_INFO);
  defineCredentialIdStabilityTests(cdpTest, () => CDP_ADAPTER_INFO);
});
