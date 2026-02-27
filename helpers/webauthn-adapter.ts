/**
 * WebAuthn Adapter Interface
 * 
 * Abstracts the differences between CDP virtual authenticator and soft-fido2
 * so that tests can be written once and run with either approach.
 */

import type { Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions } from '@playwright/test';
import { WebAuthnHelper } from './webauthn';

// =============================================================================
// Adapter Interface
// =============================================================================

/**
 * Information about the WebAuthn adapter being used
 */
export interface WebAuthnAdapterInfo {
  /** Adapter type: 'cdp' or 'soft-fido2' */
  type: 'cdp' | 'soft-fido2';
  /** Human-readable name */
  name: string;
  /** Whether PRF is mocked (CDP) or native (soft-fido2) */
  prfMocked: boolean;
  /** Whether this runs in headless mode */
  headless: boolean;
  /** Whether credentials persist across page navigations */
  credentialsPersist: boolean;
}

/**
 * Abstract interface for WebAuthn operations
 * 
 * Both CDP and soft-fido2 implementations provide this interface
 * so tests can work with either transparently.
 */
export interface WebAuthnAdapter {
  /** Get adapter info */
  info: WebAuthnAdapterInfo;
  
  /** Initialize the authenticator (called before tests) */
  setup(): Promise<void>;
  
  /** Cleanup (called after tests) */
  teardown(): Promise<void>;
  
  /** Get credentials if supported (CDP only) */
  getCredentials?(): Promise<any[]>;
  
  /** Clear credentials if supported (CDP only) */
  clearCredentials?(): Promise<void>;
}

// =============================================================================
// CDP Adapter Implementation
// =============================================================================

/**
 * CDP-based WebAuthn adapter
 * Uses Chrome DevTools Protocol virtual authenticator with PRF mock
 */
export class CdpWebAuthnAdapter implements WebAuthnAdapter {
  private page: Page;
  private helper: WebAuthnHelper | null = null;

  info: WebAuthnAdapterInfo = {
    type: 'cdp',
    name: 'CDP Virtual Authenticator',
    prfMocked: true,
    headless: true,
    credentialsPersist: false,
  };

  constructor(page: Page) {
    this.page = page;
  }

  async setup(): Promise<void> {
    this.helper = new WebAuthnHelper(this.page);
    await this.helper.initialize();
    await this.helper.injectPrfMock();
    await this.helper.addPlatformAuthenticator();
  }

  async teardown(): Promise<void> {
    if (this.helper) {
      await this.helper.cleanup();
      this.helper = null;
    }
  }

  async getCredentials(): Promise<any[]> {
    if (!this.helper) return [];
    return this.helper.getCredentials();
  }

  async clearCredentials(): Promise<void> {
    if (this.helper) {
      await this.helper.clearCredentials();
    }
  }
}

// =============================================================================
// Soft-fido2 Adapter Implementation
// =============================================================================

/**
 * Soft-fido2 based WebAuthn adapter
 * Uses UHID virtual authenticator - browser handles WebAuthn natively
 */
export class SoftFido2WebAuthnAdapter implements WebAuthnAdapter {
  private page: Page;

  info: WebAuthnAdapterInfo = {
    type: 'soft-fido2',
    name: 'Soft-FIDO2 Virtual Authenticator',
    prfMocked: false,
    headless: false,
    credentialsPersist: true,
  };

  constructor(page: Page) {
    this.page = page;
  }

  async setup(): Promise<void> {
    // soft-fido2 is managed externally via scripts/start-soft-fido2.sh
    // Nothing to do here - browser will use the UHID device automatically
    console.log('[SoftFido2Adapter] Using external soft-fido2 authenticator');
  }

  async teardown(): Promise<void> {
    // Nothing to cleanup - soft-fido2 runs externally
  }

  // Note: soft-fido2 doesn't expose credential management API
  // Credentials are managed by the virtual authenticator automatically
}

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Fixture type that provides a WebAuthn adapter
 */
export interface WebAuthnFixtures {
  webauthnAdapter: WebAuthnAdapter;
}

/**
 * Create a Playwright test fixture for CDP adapter
 */
export function createCdpFixture() {
  return async ({ page }: { page: Page }, use: (adapter: WebAuthnAdapter) => Promise<void>) => {
    const adapter = new CdpWebAuthnAdapter(page);
    await adapter.setup();
    await use(adapter);
    await adapter.teardown();
  };
}

/**
 * Create a Playwright test fixture for soft-fido2 adapter
 */
export function createSoftFido2Fixture() {
  return async ({ page }: { page: Page }, use: (adapter: WebAuthnAdapter) => Promise<void>) => {
    const adapter = new SoftFido2WebAuthnAdapter(page);
    await adapter.setup();
    await use(adapter);
    await adapter.teardown();
  };
}

// =============================================================================
// Test Registration Pattern
// =============================================================================

/**
 * Shared test definition type
 * Tests are defined as functions that receive the test runner and adapter
 */
export type SharedTestFn = (
  testRunner: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  getAdapterInfo: () => WebAuthnAdapterInfo
) => void;

/**
 * Registry for shared tests
 * Both CDP and soft-fido2 test suites can register these
 */
export const sharedTests = new Map<string, SharedTestFn>();

/**
 * Register a shared test definition
 */
export function defineSharedTest(name: string, testFn: SharedTestFn): void {
  sharedTests.set(name, testFn);
}

/**
 * Run all registered shared tests with the given test runner
 */
export function runSharedTests(
  testRunner: TestType<PlaywrightTestArgs & PlaywrightTestOptions & WebAuthnFixtures, {}>,
  adapterInfo: WebAuthnAdapterInfo
): void {
  for (const [name, testFn] of sharedTests) {
    console.log(`[Shared Tests] Registering: ${name}`);
    testFn(testRunner, () => adapterInfo);
  }
}
