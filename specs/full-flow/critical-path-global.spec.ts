/**
 * Critical Path Tests for Global (Non-Tenant) Registration and Login
 *
 * @tags @critical @full-flow
 *
 * These tests verify the COMPLETE user journey for global authentication
 * (backward compatible with single-tenant deployments).
 *
 * This ensures that:
 * 1. Global registration creates a working credential
 * 2. Global login can use that credential
 * 3. The same user ID is returned after both operations
 * 4. Legacy users (without tenant) continue to work
 */

import { test, expect, request, Page, APIRequestContext } from '@playwright/test';
import { WebAuthnHelper, generateTestUsername } from '../../helpers/webauthn';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Helper to perform global registration via WebAuthn API
 */
async function performGlobalRegistration(
  page: Page,
  apiRequest: APIRequestContext,
  username: string
): Promise<{
  userId: string;
  token: string;
  credentialId: string;
}> {
  // Step 1: Begin global registration
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/user/register-webauthn-begin`,
    {
      data: { display_name: username },
    }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin registration failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const publicKey = beginData.createOptions.publicKey;
  const userIdB64 = publicKey.user.id.$b64u || publicKey.user.id;
  const challengeB64 = publicKey.challenge.$b64u || publicKey.challenge;

  // Step 2: Create credential using browser WebAuthn API
  const credentialResult = await page.evaluate(async (params) => {
    function fromBase64Url(b64u: string): Uint8Array {
      const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
      const binary = atob(paddedBase64);
      return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
    }

    function toBase64Url(bytes: Uint8Array): string {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        rp: { id: params.rpId, name: params.rpName },
        user: {
          id: fromBase64Url(params.userId),
          name: params.username,
          displayName: params.username,
        },
        challenge: fromBase64Url(params.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -8 },   // EdDSA
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          requireResidentKey: true,
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
      },
    };

    const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to create credential');

    const response = credential.response as AuthenticatorAttestationResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        attestationObject: { '$b64u': toBase64Url(new Uint8Array(response.attestationObject)) },
        transports: response.getTransports?.() || ['internal'],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: publicKey.rp.id,
    rpName: publicKey.rp.name,
    userId: userIdB64,
    username,
    challenge: challengeB64,
  });

  // Step 3: Finish registration
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/user/register-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: credentialResult,
        displayName: username,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish registration failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();

  return {
    userId: finishData.uuid,
    token: finishData.appToken,
    credentialId: credentialResult.id,
  };
}

/**
 * Helper to perform global login via WebAuthn API
 */
async function performGlobalLogin(
  page: Page,
  apiRequest: APIRequestContext
): Promise<{
  userId: string;
  token: string;
  tenantId?: string;
}> {
  // Step 1: Begin global login
  const beginResponse = await apiRequest.post(
    `${BACKEND_URL}/user/login-webauthn-begin`,
    { data: {} }
  );

  if (beginResponse.status() !== 200) {
    const errorText = await beginResponse.text();
    throw new Error(`Begin login failed: ${beginResponse.status()} - ${errorText}`);
  }

  const beginData = await beginResponse.json();
  const getOptions = beginData.getOptions;
  const challengeB64 = getOptions.publicKey.challenge.$b64u || getOptions.publicKey.challenge;

  // Step 2: Get credential assertion
  const assertionResult = await page.evaluate(async (params) => {
    function fromBase64Url(b64u: string): Uint8Array {
      const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
      const binary = atob(paddedBase64);
      return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
    }

    function toBase64Url(bytes: Uint8Array): string {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge: fromBase64Url(params.challenge),
        rpId: params.rpId,
        userVerification: 'required',
      },
    };

    const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to get credential');

    const response = credential.response as AuthenticatorAssertionResponse;

    return {
      id: credential.id,
      rawId: { '$b64u': toBase64Url(new Uint8Array(credential.rawId)) },
      type: credential.type,
      response: {
        clientDataJSON: { '$b64u': toBase64Url(new Uint8Array(response.clientDataJSON)) },
        authenticatorData: { '$b64u': toBase64Url(new Uint8Array(response.authenticatorData)) },
        signature: { '$b64u': toBase64Url(new Uint8Array(response.signature)) },
        userHandle: response.userHandle
          ? { '$b64u': toBase64Url(new Uint8Array(response.userHandle)) }
          : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }, {
    rpId: getOptions.publicKey.rpId,
    challenge: challengeB64,
  });

  // Step 3: Finish login
  const finishResponse = await apiRequest.post(
    `${BACKEND_URL}/user/login-webauthn-finish`,
    {
      data: {
        challengeId: beginData.challengeId,
        credential: assertionResult,
      },
    }
  );

  if (finishResponse.status() !== 200) {
    const errorText = await finishResponse.text();
    throw new Error(`Finish login failed: ${finishResponse.status()} - ${errorText}`);
  }

  const finishData = await finishResponse.json();

  return {
    userId: finishData.uuid,
    token: finishData.appToken,
    tenantId: finishData.tenantId,
  };
}

test.describe('Critical Path: Global Registration → Login @critical', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();
    await webauthn.addPlatformAuthenticator();

    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterEach(async () => {
    if (webauthn) {
      await webauthn.cleanup();
    }
  });

  /**
   * CRITICAL TEST: Register a user globally and immediately login
   *
   * This test ensures backward compatibility for single-tenant deployments
   * and legacy users without tenant association.
   */
  test('should register a global user and immediately login successfully', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    // STEP 1: Register the user via global endpoint
    console.log(`Registering global user ${username}...`);
    const registration = await performGlobalRegistration(page, apiRequest, username);

    // Verify registration returned expected data
    expect(registration.userId).toBeDefined();
    expect(registration.userId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(registration.token).toBeDefined();
    expect(registration.credentialId).toBeDefined();

    console.log(`Registration successful: userId=${registration.userId}`);

    // STEP 2: Immediately attempt login
    console.log('Attempting login with registered credential...');
    const login = await performGlobalLogin(page, apiRequest);

    // Verify login succeeded
    expect(login.userId).toBeDefined();
    expect(login.token).toBeDefined();

    // CRITICAL: The same user ID must be returned
    expect(login.userId).toBe(registration.userId);

    // For global users, tenantId should be 'default' or undefined
    if (login.tenantId) {
      expect(login.tenantId).toBe('default');
    }

    console.log(`Login successful: userId=${login.userId}`);
  });

  test('should allow multiple users to register and login', async ({
    page,
    request: apiRequest,
  }) => {
    // Register and login user A
    const usernameA = generateTestUsername();
    const registrationA = await performGlobalRegistration(page, apiRequest, usernameA);
    expect(registrationA.userId).toBeDefined();

    const loginA = await performGlobalLogin(page, apiRequest);
    expect(loginA.userId).toBe(registrationA.userId);

    // Clear and register user B
    await webauthn.clearCredentials();

    const usernameB = generateTestUsername();
    const registrationB = await performGlobalRegistration(page, apiRequest, usernameB);
    expect(registrationB.userId).toBeDefined();
    expect(registrationB.userId).not.toBe(registrationA.userId);

    const loginB = await performGlobalLogin(page, apiRequest);
    expect(loginB.userId).toBe(registrationB.userId);
  });

  test('should work after page navigation', async ({
    page,
    request: apiRequest,
  }) => {
    const username = generateTestUsername();

    const registration = await performGlobalRegistration(page, apiRequest, username);
    expect(registration.userId).toBeDefined();

    // Navigate away and back
    await page.goto('about:blank');
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState('domcontentloaded');

    // Login should still work
    const login = await performGlobalLogin(page, apiRequest);
    expect(login.userId).toBe(registration.userId);
  });
});
