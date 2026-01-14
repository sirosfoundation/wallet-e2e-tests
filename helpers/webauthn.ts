/**
 * WebAuthn Virtual Authenticator Helper for E2E Tests
 *
 * Uses Chrome DevTools Protocol (CDP) to create and manage virtual
 * authenticators for testing WebAuthn flows.
 *
 * IMPORTANT: This helper supports the PRF (Pseudo-Random Function) extension
 * which is required for wallet-frontend's key derivation. The hasPrf option
 * must be enabled for the authenticator to return PRF outputs.
 *
 * CRITICAL: Chrome's CDP virtual authenticator reports hasPrf=true but returns
 * empty PRF results. The injectPrfMock() method patches the WebAuthn API to
 * compute actual HMAC-SHA256 based PRF outputs.
 */

import type { Page, CDPSession } from '@playwright/test';

export interface AuthenticatorOptions {
  protocol?: 'ctap2' | 'u2f';
  ctap2Version?: 'ctap2_0' | 'ctap2_1';
  transport?: 'usb' | 'nfc' | 'ble' | 'cable' | 'internal';
  hasResidentKey?: boolean;
  hasUserVerification?: boolean;
  isUserVerified?: boolean;
  automaticPresenceSimulation?: boolean;
  /** Enable PRF extension support - REQUIRED for wallet-frontend */
  hasPrf?: boolean;
  /** Enable largeBlob extension support */
  hasLargeBlob?: boolean;
  /** Enable credBlob extension support */
  hasCredBlob?: boolean;
  /** Enable minPinLength extension support */
  hasMinPinLength?: boolean;
  /** Default backup eligibility state */
  defaultBackupEligibility?: boolean;
  /** Default backup state */
  defaultBackupState?: boolean;
}

export class WebAuthnHelper {
  private page: Page;
  private cdpSession: CDPSession | null = null;
  private authenticatorId: string | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Initialize CDP session and enable WebAuthn environment
   */
  async initialize(): Promise<void> {
    const context = this.page.context();
    this.cdpSession = await context.newCDPSession(this.page);
    await this.cdpSession.send('WebAuthn.enable', {
      enableUI: false,
    });
  }

  /**
   * Add a virtual authenticator with specified options
   */
  async addAuthenticator(options: AuthenticatorOptions = {}): Promise<string> {
    if (!this.cdpSession) {
      throw new Error('CDP session not initialized. Call initialize() first.');
    }

    // Default options include PRF support which is required for wallet-frontend
    const defaultOptions: AuthenticatorOptions = {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',  // CTAP 2.1 required for PRF
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,  // Enable PRF extension - CRITICAL for wallet-frontend
    };

    const mergedOptions = { ...defaultOptions, ...options };

    const result = await this.cdpSession.send('WebAuthn.addVirtualAuthenticator', {
      options: mergedOptions,
    });

    this.authenticatorId = result.authenticatorId;
    return this.authenticatorId;
  }

  /**
   * Add a virtual authenticator configured for passkey (platform) authentication
   * Suitable for testing "client-device" / platform passkey flows
   * Includes PRF extension support required for wallet-frontend key derivation
   */
  async addPlatformAuthenticator(): Promise<string> {
    return this.addAuthenticator({
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,  // Required for wallet-frontend PRF key derivation
    });
  }

  /**
   * Add a virtual authenticator configured for security key authentication
   * Suitable for testing "security-key" / roaming authenticator flows
   * Includes PRF extension support required for wallet-frontend key derivation
   */
  async addSecurityKeyAuthenticator(): Promise<string> {
    return this.addAuthenticator({
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,  // Required for wallet-frontend PRF key derivation
    });
  }

  /**
   * Add a virtual authenticator without PRF support
   * Useful for testing error handling when PRF is not available
   */
  async addAuthenticatorWithoutPrf(): Promise<string> {
    return this.addAuthenticator({
      protocol: 'ctap2',
      ctap2Version: 'ctap2_0',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: false,
    });
  }

  /**
   * Get all credentials registered on the virtual authenticator
   */
  async getCredentials(): Promise<any[]> {
    if (!this.cdpSession || !this.authenticatorId) {
      throw new Error('Authenticator not initialized');
    }

    const result = await this.cdpSession.send('WebAuthn.getCredentials', {
      authenticatorId: this.authenticatorId,
    });

    return result.credentials;
  }

  /**
   * Get a specific credential by ID
   */
  async getCredential(credentialId: string): Promise<any | null> {
    const credentials = await this.getCredentials();
    return credentials.find(c => c.credentialId === credentialId) || null;
  }

  /**
   * Set user verification state on the authenticator
   */
  async setUserVerified(verified: boolean): Promise<void> {
    if (!this.cdpSession || !this.authenticatorId) {
      throw new Error('Authenticator not initialized');
    }

    await this.cdpSession.send('WebAuthn.setUserVerified', {
      authenticatorId: this.authenticatorId,
      isUserVerified: verified,
    });
  }

  /**
   * Remove a specific credential from the authenticator
   */
  async removeCredential(credentialId: string): Promise<void> {
    if (!this.cdpSession || !this.authenticatorId) {
      throw new Error('Authenticator not initialized');
    }

    await this.cdpSession.send('WebAuthn.removeCredential', {
      authenticatorId: this.authenticatorId,
      credentialId,
    });
  }

  /**
   * Clear all credentials from the authenticator
   */
  async clearCredentials(): Promise<void> {
    if (!this.cdpSession || !this.authenticatorId) {
      throw new Error('Authenticator not initialized');
    }

    await this.cdpSession.send('WebAuthn.clearCredentials', {
      authenticatorId: this.authenticatorId,
    });
  }

  /**
   * Remove the virtual authenticator
   */
  async removeAuthenticator(): Promise<void> {
    if (!this.cdpSession || !this.authenticatorId) {
      return;
    }

    await this.cdpSession.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: this.authenticatorId,
    });

    this.authenticatorId = null;
  }

  /**
   * Clean up: disable WebAuthn environment and close CDP session
   */
  async cleanup(): Promise<void> {
    if (this.authenticatorId) {
      await this.removeAuthenticator();
    }

    if (this.cdpSession) {
      try {
        await this.cdpSession.send('WebAuthn.disable');
      } catch {
        // Session may already be closed
      }
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
  }

  /**
   * Inject PRF mock into the page
   *
   * Chrome's CDP virtual authenticator reports hasPrf=true but returns empty
   * PRF results. This injection patches the WebAuthn API to compute actual
   * HMAC-SHA256 based PRF outputs, simulating what a real authenticator would do.
   *
   * Must be called BEFORE any WebAuthn operations and BEFORE page navigation.
   */
  async injectPrfMock(): Promise<void> {
    await this.page.addInitScript(() => {
      // Store for credential-specific PRF seeds (simulates authenticator's secret)
      const credentialPrfSeeds = new Map<string, Uint8Array>();

      // Helper to convert ArrayBuffer to hex string
      const toHex = (buffer: ArrayBuffer): string =>
        Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      // Generate deterministic PRF seed for a credential
      const generatePrfSeed = async (credentialId: ArrayBuffer): Promise<Uint8Array> => {
        const idString = toHex(credentialId);
        const existing = credentialPrfSeeds.get(idString);
        if (existing) return existing;

        // Create a deterministic but unique seed based on credential ID
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.digest('SHA-256',
          new Uint8Array([...encoder.encode('prf-mock-seed:'), ...new Uint8Array(credentialId)])
        );
        const seed = new Uint8Array(keyMaterial);
        credentialPrfSeeds.set(idString, seed);
        return seed;
      };

      // Compute PRF output using HMAC-SHA256 (mimics authenticator behavior)
      const computePrfOutput = async (seed: Uint8Array, salt: ArrayBuffer): Promise<ArrayBuffer> => {
        const key = await crypto.subtle.importKey(
          'raw',
          seed,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        return crypto.subtle.sign('HMAC', key, salt);
      };

      // Patch navigator.credentials.create
      const originalCreate = navigator.credentials.create.bind(navigator.credentials);
      (navigator.credentials as any).create = async function(options: CredentialCreationOptions) {
        const credential = await originalCreate(options) as PublicKeyCredential | null;
        if (!credential) return credential;

        // Check if PRF was requested
        const prfInput = (options.publicKey as any)?.extensions?.prf;
        if (!prfInput?.eval?.first) return credential;

        // Generate PRF seed for this credential
        const seed = await generatePrfSeed(credential.rawId);

        // Compute the PRF output
        const salt = prfInput.eval.first as ArrayBuffer;
        const prfOutput = await computePrfOutput(seed, salt);

        console.log('[PRF Mock] Computed PRF for create:', toHex(prfOutput).slice(0, 16) + '...');

        // Get the original extension results
        const originalGetClientExtensionResults = credential.getClientExtensionResults.bind(credential);

        // Patch getClientExtensionResults to include computed PRF
        (credential as any).getClientExtensionResults = function() {
          const results = originalGetClientExtensionResults();
          results.prf = {
            enabled: true,
            results: {
              first: prfOutput,
            }
          };
          return results;
        };

        return credential;
      };

      // Patch navigator.credentials.get for login PRF
      const originalGet = navigator.credentials.get.bind(navigator.credentials);
      (navigator.credentials as any).get = async function(options: CredentialRequestOptions) {
        const credential = await originalGet(options) as PublicKeyCredential | null;
        if (!credential) return credential;

        // Check if PRF was requested
        const prfInput = (options.publicKey as any)?.extensions?.prf;
        if (!prfInput) return credential;

        // Get or create PRF seed for this credential
        const seed = await generatePrfSeed(credential.rawId);

        // Determine which salt to use
        let salt: ArrayBuffer | null = null;

        if (prfInput.eval?.first) {
          salt = prfInput.eval.first as ArrayBuffer;
        } else if (prfInput.evalByCredential) {
          // Find salt for this credential
          const credIdB64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          const credSalt = prfInput.evalByCredential[credIdB64];
          if (credSalt?.first) {
            salt = credSalt.first as ArrayBuffer;
          }
        }

        if (!salt) return credential;

        // Compute PRF output
        const prfOutput = await computePrfOutput(seed, salt);

        console.log('[PRF Mock] Computed PRF for get:', toHex(prfOutput).slice(0, 16) + '...');

        // Get the original extension results
        const originalGetClientExtensionResults = credential.getClientExtensionResults.bind(credential);

        // Patch getClientExtensionResults
        (credential as any).getClientExtensionResults = function() {
          const results = originalGetClientExtensionResults();
          results.prf = {
            enabled: true,
            results: {
              first: prfOutput,
            }
          };
          return results;
        };

        return credential;
      };

      console.log('[PRF Mock] WebAuthn PRF mock injected');
    });
  }

  /**
   * Get the current authenticator ID
   */
  getAuthenticatorId(): string | null {
    return this.authenticatorId;
  }
}

/**
 * Base64URL encoding utilities for WebAuthn data
 */
export function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function fromBase64Url(str: string): Uint8Array {
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const base64 = (str + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a random string for test usernames
 */
export function generateTestUsername(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `test-user-${timestamp}-${random}`;
}

/**
 * Convert tagged binary format from backend to ArrayBuffer
 * Backend uses { "$b64u": "base64url-string" } format
 */
export function taggedBinaryToBuffer(tagged: { $b64u: string }): ArrayBuffer {
  return fromBase64Url(tagged.$b64u).buffer;
}
