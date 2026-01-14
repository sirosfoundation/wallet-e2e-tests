/**
 * PRF Mock Integration Tests
 *
 * @tags @prf
 *
 * Tests the PRF mock injection that works around Chrome's CDP limitation
 * where the virtual authenticator reports PRF support but doesn't compute
 * actual PRF outputs.
 */

import { test, expect } from '@playwright/test';
import { WebAuthnHelper } from '../../helpers/webauthn';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

test.describe('PRF Mock Integration @prf', () => {
  let webauthn: WebAuthnHelper;

  test.beforeEach(async ({ page }) => {
    webauthn = new WebAuthnHelper(page);
    await webauthn.initialize();
    await webauthn.injectPrfMock();

    // Add authenticator with PRF support
    await webauthn.addPlatformAuthenticator();
  });

  test.afterEach(async () => {
    await webauthn.cleanup();
  });

  test('PRF mock computes real ArrayBuffer output on create', async ({ page, baseURL }) => {
    await page.goto(baseURL || 'http://localhost:3000');

    // Create credential with PRF extension
    const result = await page.evaluate(async () => {
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      const prfSalt = new Uint8Array(32);
      crypto.getRandomValues(prfSalt);

      const options: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: { name: 'Test RP', id: 'localhost' },
        user: {
          id: new Uint8Array(16),
          name: 'test@example.com',
          displayName: 'Test User'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required'
        },
        extensions: {
          prf: {
            eval: {
              first: prfSalt
            }
          }
        } as any
      };

      const credential = await navigator.credentials.create({ publicKey: options }) as PublicKeyCredential;
      const extensions = credential.getClientExtensionResults() as any;

      // Check PRF output
      const prf = extensions.prf;
      const prfFirst = prf?.results?.first;

      return {
        hasCredential: !!credential,
        hasPrf: !!prf,
        prfEnabled: prf?.enabled,
        prfFirstType: prfFirst?.constructor?.name || typeof prfFirst,
        prfFirstByteLength: prfFirst?.byteLength,
        prfFirstHex: prfFirst instanceof ArrayBuffer
          ? Array.from(new Uint8Array(prfFirst)).slice(0, 8).map((b: number) => b.toString(16).padStart(2, '0')).join('')
          : null
      };
    });

    console.log('PRF Mock create result:', result);

    expect(result.hasCredential).toBe(true);
    expect(result.hasPrf).toBe(true);
    expect(result.prfEnabled).toBe(true);
    expect(result.prfFirstType).toBe('ArrayBuffer');
    expect(result.prfFirstByteLength).toBe(32); // HMAC-SHA256 output
    expect(result.prfFirstHex).not.toBeNull();
    expect(result.prfFirstHex?.length).toBe(16); // First 8 bytes as hex = 16 chars
  });

  test('PRF mock produces deterministic output for same credential and salt', async ({ page, baseURL }) => {
    await page.goto(baseURL || 'http://localhost:3000');

    const result = await page.evaluate(async () => {
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      // Use fixed salt for determinism test
      const prfSalt = new Uint8Array(32).fill(42);

      const createOptions: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: { name: 'Test RP', id: 'localhost' },
        user: {
          id: new Uint8Array(16),
          name: 'test@example.com',
          displayName: 'Test User'
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform' },
        extensions: { prf: { eval: { first: prfSalt } } } as any
      };

      // Create credential
      const credential = await navigator.credentials.create({ publicKey: createOptions }) as PublicKeyCredential;
      const createPrf = (credential.getClientExtensionResults() as any).prf?.results?.first;

      // Get the same credential with same salt
      const getChallenge = new Uint8Array(32);
      crypto.getRandomValues(getChallenge);

      const getOptions: PublicKeyCredentialRequestOptions = {
        challenge: getChallenge,
        rpId: 'localhost',
        allowCredentials: [{
          type: 'public-key',
          id: credential.rawId
        }],
        extensions: {
          prf: {
            eval: { first: prfSalt }
          }
        } as any
      };

      const assertion = await navigator.credentials.get({ publicKey: getOptions }) as PublicKeyCredential;
      const getPrf = (assertion.getClientExtensionResults() as any).prf?.results?.first;

      // Convert to hex for comparison
      const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

      return {
        createPrfHex: createPrf instanceof ArrayBuffer ? toHex(createPrf) : null,
        getPrfHex: getPrf instanceof ArrayBuffer ? toHex(getPrf) : null,
        match: createPrf instanceof ArrayBuffer && getPrf instanceof ArrayBuffer && toHex(createPrf) === toHex(getPrf)
      };
    });

    console.log('Determinism test result:', result);

    expect(result.createPrfHex).not.toBeNull();
    expect(result.getPrfHex).not.toBeNull();
    expect(result.match).toBe(true);
  });

  test('PRF mock produces different output for different salts', async ({ page, baseURL }) => {
    await page.goto(baseURL || 'http://localhost:3000');

    const result = await page.evaluate(async () => {
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      // Create credential with first salt
      const prfSalt1 = new Uint8Array(32).fill(1);

      const createOptions: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: { name: 'Test RP', id: 'localhost' },
        user: {
          id: new Uint8Array(16),
          name: 'test@example.com',
          displayName: 'Test User'
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform' },
        extensions: { prf: { eval: { first: prfSalt1 } } } as any
      };

      const credential = await navigator.credentials.create({ publicKey: createOptions }) as PublicKeyCredential;
      const createPrf = (credential.getClientExtensionResults() as any).prf?.results?.first;

      // Get with different salt
      const prfSalt2 = new Uint8Array(32).fill(2);
      const getChallenge = new Uint8Array(32);
      crypto.getRandomValues(getChallenge);

      const getOptions: PublicKeyCredentialRequestOptions = {
        challenge: getChallenge,
        rpId: 'localhost',
        allowCredentials: [{
          type: 'public-key',
          id: credential.rawId
        }],
        extensions: {
          prf: {
            eval: { first: prfSalt2 }
          }
        } as any
      };

      const assertion = await navigator.credentials.get({ publicKey: getOptions }) as PublicKeyCredential;
      const getPrf = (assertion.getClientExtensionResults() as any).prf?.results?.first;

      const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

      return {
        createPrfHex: createPrf instanceof ArrayBuffer ? toHex(createPrf) : null,
        getPrfHex: getPrf instanceof ArrayBuffer ? toHex(getPrf) : null,
        different: createPrf instanceof ArrayBuffer && getPrf instanceof ArrayBuffer && toHex(createPrf) !== toHex(getPrf)
      };
    });

    console.log('Different salts test result:', result);

    expect(result.createPrfHex).not.toBeNull();
    expect(result.getPrfHex).not.toBeNull();
    expect(result.different).toBe(true);
  });

  test('PRF mock handles evalByCredential for multi-credential scenarios', async ({ page, baseURL }) => {
    await page.goto(baseURL || 'http://localhost:3000');

    const result = await page.evaluate(async () => {
      // Create two credentials
      const credentials: PublicKeyCredential[] = [];

      for (let i = 0; i < 2; i++) {
        const challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);

        const createOptions: PublicKeyCredentialCreationOptions = {
          challenge,
          rp: { name: 'Test RP', id: 'localhost' },
          user: {
            id: new Uint8Array([i + 1]),
            name: `test${i}@example.com`,
            displayName: `Test User ${i}`
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: 'platform' },
          extensions: {} as any
        };

        const cred = await navigator.credentials.create({ publicKey: createOptions }) as PublicKeyCredential;
        credentials.push(cred);
      }

      // Create evalByCredential map
      const toB64U = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      };

      const evalByCredential: Record<string, { first: Uint8Array }> = {};
      credentials.forEach((cred, i) => {
        evalByCredential[toB64U(cred.rawId)] = {
          first: new Uint8Array(32).fill(i + 10)
        };
      });

      // Get with evalByCredential
      const getChallenge = new Uint8Array(32);
      crypto.getRandomValues(getChallenge);

      const getOptions: PublicKeyCredentialRequestOptions = {
        challenge: getChallenge,
        rpId: 'localhost',
        allowCredentials: credentials.map(c => ({
          type: 'public-key' as const,
          id: c.rawId
        })),
        extensions: {
          prf: { evalByCredential }
        } as any
      };

      const assertion = await navigator.credentials.get({ publicKey: getOptions }) as PublicKeyCredential;
      const getPrf = (assertion.getClientExtensionResults() as any).prf?.results?.first;

      return {
        hasPrfResult: getPrf instanceof ArrayBuffer,
        prfByteLength: getPrf?.byteLength
      };
    });

    expect(result.hasPrfResult).toBe(true);
    expect(result.prfByteLength).toBe(32);
  });
});
