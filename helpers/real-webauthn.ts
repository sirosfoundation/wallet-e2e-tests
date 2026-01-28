/**
 * Real WebAuthn Helper for E2E Tests
 *
 * Unlike the CDP-based virtual authenticator helper, this module provides
 * utilities for testing with real browser WebAuthn implementations.
 *
 * Key differences from CDP virtual authenticator:
 * - No credential injection - tests must go through real registration
 * - PRF extension works correctly (no mocking needed)
 * - May show native OS dialogs for user verification
 * - Credentials persist in browser/OS credential storage
 *
 * Requirements:
 * - Playwright must run in headed mode (headless: false)
 * - Chrome should be launched with WebAuthn feature flags
 */

import type { Page, BrowserContext } from '@playwright/test';

export interface WebAuthnCredentialRecord {
  id: string;
  rawId: ArrayBuffer;
  publicKey: ArrayBuffer;
  signCount: number;
  transports?: string[];
  createdAt: Date;
  rpId: string;
  userHandle?: ArrayBuffer;
}

export interface WebAuthnOperationResult {
  success: boolean;
  operationType: 'create' | 'get';
  duration: number;
  error?: string;
  credentialId?: string;
  userHandle?: string;
  hasPrf?: boolean;
  prfOutput?: {
    first?: ArrayBuffer;
    second?: ArrayBuffer;
  };
}

/**
 * Options for real WebAuthn testing
 */
export interface RealWebAuthnOptions {
  /**
   * Timeout for WebAuthn operations (in milliseconds)
   * Real authenticators may show UI that needs user interaction
   */
  operationTimeout?: number;

  /**
   * Whether to track WebAuthn operations via injected scripts
   */
  enableTracking?: boolean;

  /**
   * Whether to automatically handle the "Choose a passkey" dialog
   * (where supported)
   */
  autoSelectPasskey?: boolean;
}

/**
 * Helper class for real WebAuthn testing
 *
 * This helper works with real browser WebAuthn implementations,
 * not CDP virtual authenticators. It tracks WebAuthn operations
 * and provides utilities for waiting on async credential flows.
 */
export class RealWebAuthnHelper {
  private page: Page;
  private context: BrowserContext;
  private options: Required<RealWebAuthnOptions>;
  private isInitialized = false;

  constructor(page: Page, options: RealWebAuthnOptions = {}) {
    this.page = page;
    this.context = page.context();
    this.options = {
      operationTimeout: options.operationTimeout ?? 30000,
      enableTracking: options.enableTracking ?? true,
      autoSelectPasskey: options.autoSelectPasskey ?? true,
    };
  }

  /**
   * Initialize the helper by injecting tracking scripts
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (this.options.enableTracking) {
      await this.injectTrackingScripts();
    }

    this.isInitialized = true;
  }

  /**
   * Inject scripts to track WebAuthn operations
   */
  private async injectTrackingScripts(): Promise<void> {
    await this.page.addInitScript(() => {
      // Create a namespace for WebAuthn tracking
      const webauthnTracker = {
        pendingOperation: null as 'create' | 'get' | null,
        lastOperation: null as WebAuthnOperationResult | null,
        operationHistory: [] as WebAuthnOperationResult[],
      };

      // Make it available on window for test access
      (window as any).__webauthnTracker__ = webauthnTracker;

      // Store original methods
      const originalCreate = navigator.credentials.create.bind(navigator.credentials);
      const originalGet = navigator.credentials.get.bind(navigator.credentials);

      // Helper to extract credential info safely
      function extractCredentialInfo(credential: Credential | null): Partial<WebAuthnOperationResult> {
        if (!credential || credential.type !== 'public-key') {
          return {};
        }

        const pubkeyCred = credential as PublicKeyCredential;
        const result: Partial<WebAuthnOperationResult> = {
          credentialId: btoa(String.fromCharCode(...new Uint8Array(pubkeyCred.rawId))),
        };

        // Check for authenticator assertion response (login)
        const response = pubkeyCred.response;
        if ('userHandle' in response && response.userHandle) {
          try {
            const decoder = new TextDecoder('utf-8');
            result.userHandle = decoder.decode(response.userHandle as ArrayBuffer);
          } catch {
            result.userHandle = btoa(String.fromCharCode(...new Uint8Array(response.userHandle as ArrayBuffer)));
          }
        }

        // Check for PRF extension results
        const extensions = pubkeyCred.getClientExtensionResults();
        if (extensions && 'prf' in extensions) {
          result.hasPrf = true;
          const prfResults = (extensions as any).prf?.results;
          if (prfResults) {
            result.prfOutput = {
              first: prfResults.first,
              second: prfResults.second,
            };
          }
        }

        return result;
      }

      // Wrap create (registration)
      navigator.credentials.create = async (options?: CredentialCreationOptions) => {
        const startTime = Date.now();
        webauthnTracker.pendingOperation = 'create';

        try {
          const credential = await originalCreate(options);
          const duration = Date.now() - startTime;
          const credentialInfo = extractCredentialInfo(credential);

          const result: WebAuthnOperationResult = {
            success: true,
            operationType: 'create',
            duration,
            ...credentialInfo,
          };

          webauthnTracker.lastOperation = result;
          webauthnTracker.operationHistory.push(result);
          webauthnTracker.pendingOperation = null;

          console.log('[RealWebAuthn] Registration completed:', result);
          return credential;
        } catch (error: any) {
          const duration = Date.now() - startTime;
          const result: WebAuthnOperationResult = {
            success: false,
            operationType: 'create',
            duration,
            error: error?.message || String(error),
          };

          webauthnTracker.lastOperation = result;
          webauthnTracker.operationHistory.push(result);
          webauthnTracker.pendingOperation = null;

          console.error('[RealWebAuthn] Registration failed:', result);
          throw error;
        }
      };

      // Wrap get (authentication)
      navigator.credentials.get = async (options?: CredentialRequestOptions) => {
        const startTime = Date.now();
        webauthnTracker.pendingOperation = 'get';

        // Log the options for debugging
        console.log('[RealWebAuthn] Authentication started with options:', {
          rpId: options?.publicKey?.rpId,
          allowCredentials: options?.publicKey?.allowCredentials?.length ?? 'none (discoverable)',
          userVerification: options?.publicKey?.userVerification,
          hasPrfInputs: !!(options?.publicKey?.extensions as any)?.prf,
        });

        try {
          const credential = await originalGet(options);
          const duration = Date.now() - startTime;
          const credentialInfo = extractCredentialInfo(credential);

          const result: WebAuthnOperationResult = {
            success: true,
            operationType: 'get',
            duration,
            ...credentialInfo,
          };

          webauthnTracker.lastOperation = result;
          webauthnTracker.operationHistory.push(result);
          webauthnTracker.pendingOperation = null;

          console.log('[RealWebAuthn] Authentication completed:', result);
          return credential;
        } catch (error: any) {
          const duration = Date.now() - startTime;
          const result: WebAuthnOperationResult = {
            success: false,
            operationType: 'get',
            duration,
            error: error?.message || String(error),
          };

          webauthnTracker.lastOperation = result;
          webauthnTracker.operationHistory.push(result);
          webauthnTracker.pendingOperation = null;

          console.error('[RealWebAuthn] Authentication failed:', result);
          throw error;
        }
      };
    });
  }

  /**
   * Wait for any pending WebAuthn operation to complete
   */
  async waitForOperation(timeout?: number): Promise<WebAuthnOperationResult | null> {
    const effectiveTimeout = timeout ?? this.options.operationTimeout;

    try {
      await this.page.waitForFunction(
        () => (window as any).__webauthnTracker__?.pendingOperation === null,
        { timeout: effectiveTimeout }
      );

      return await this.getLastOperation();
    } catch (error) {
      // Operation timed out
      return null;
    }
  }

  /**
   * Get the result of the last WebAuthn operation
   */
  async getLastOperation(): Promise<WebAuthnOperationResult | null> {
    return await this.page.evaluate(() => {
      return (window as any).__webauthnTracker__?.lastOperation ?? null;
    });
  }

  /**
   * Get all WebAuthn operations that have occurred on this page
   */
  async getOperationHistory(): Promise<WebAuthnOperationResult[]> {
    return await this.page.evaluate(() => {
      return (window as any).__webauthnTracker__?.operationHistory ?? [];
    });
  }

  /**
   * Check if a WebAuthn operation is currently pending
   */
  async isPending(): Promise<boolean> {
    return await this.page.evaluate(() => {
      return (window as any).__webauthnTracker__?.pendingOperation !== null;
    });
  }

  /**
   * Wait for a successful registration and return the result
   */
  async waitForRegistration(timeout?: number): Promise<WebAuthnOperationResult> {
    const result = await this.waitForOperation(timeout);

    if (!result) {
      throw new Error('WebAuthn registration timed out');
    }

    if (!result.success) {
      throw new Error(`WebAuthn registration failed: ${result.error}`);
    }

    if (result.operationType !== 'create') {
      throw new Error(`Expected registration (create) but got ${result.operationType}`);
    }

    return result;
  }

  /**
   * Wait for a successful authentication and return the result
   */
  async waitForAuthentication(timeout?: number): Promise<WebAuthnOperationResult> {
    const result = await this.waitForOperation(timeout);

    if (!result) {
      throw new Error('WebAuthn authentication timed out');
    }

    if (!result.success) {
      throw new Error(`WebAuthn authentication failed: ${result.error}`);
    }

    if (result.operationType !== 'get') {
      throw new Error(`Expected authentication (get) but got ${result.operationType}`);
    }

    return result;
  }

  /**
   * Clear the operation history
   */
  async clearHistory(): Promise<void> {
    await this.page.evaluate(() => {
      if ((window as any).__webauthnTracker__) {
        (window as any).__webauthnTracker__.operationHistory = [];
        (window as any).__webauthnTracker__.lastOperation = null;
      }
    });
  }

  /**
   * Check if the browser supports WebAuthn
   */
  async isSupported(): Promise<boolean> {
    return await this.page.evaluate(() => {
      return (
        typeof window.PublicKeyCredential !== 'undefined' &&
        typeof navigator.credentials !== 'undefined' &&
        typeof navigator.credentials.create === 'function' &&
        typeof navigator.credentials.get === 'function'
      );
    });
  }

  /**
   * Check if the browser reports platform authenticator availability
   */
  async isPlatformAuthenticatorAvailable(): Promise<boolean> {
    return await this.page.evaluate(async () => {
      if (typeof window.PublicKeyCredential === 'undefined') {
        return false;
      }

      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    });
  }

  /**
   * Check if conditional mediation (autofill passkeys) is available
   */
  async isConditionalMediationAvailable(): Promise<boolean> {
    return await this.page.evaluate(async () => {
      if (typeof window.PublicKeyCredential === 'undefined') {
        return false;
      }

      try {
        // @ts-ignore - conditional mediation API
        return await PublicKeyCredential.isConditionalMediationAvailable?.() ?? false;
      } catch {
        return false;
      }
    });
  }
}

/**
 * Fixture factory for Playwright test fixtures
 */
export function createRealWebAuthnFixture(options?: RealWebAuthnOptions) {
  return async ({ page }: { page: Page }, use: (helper: RealWebAuthnHelper) => Promise<void>) => {
    const helper = new RealWebAuthnHelper(page, options);
    await helper.initialize();
    await use(helper);
  };
}
