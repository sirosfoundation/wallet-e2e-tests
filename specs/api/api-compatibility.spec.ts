/**
 * API Integration Tests for wallet-frontend ↔ go-wallet-backend compatibility
 *
 * @tags @api
 *
 * These tests verify that the data formats exchanged between frontend and backend
 * are compatible, without requiring the full WebAuthn PRF flow.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

// Helper to generate test data in the same format the frontend uses
function toBase64Url(buffer: Uint8Array | ArrayBuffer): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64Url(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

test.describe('Tagged Binary Format Compatibility @api', () => {
  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: BACKEND_URL,
    });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test('registration-begin returns correct tagged binary format', async () => {
    const response = await request.post('/user/register-webauthn-begin', { data: {} });
    expect(response.ok()).toBe(true);

    const data = await response.json();

    // Verify tagged binary format for challenge
    expect(data.createOptions.publicKey.challenge).toHaveProperty('$b64u');
    const challengeB64u = data.createOptions.publicKey.challenge.$b64u;
    expect(typeof challengeB64u).toBe('string');

    // Verify we can decode it
    const challengeBytes = fromBase64Url(challengeB64u);
    expect(challengeBytes.length).toBeGreaterThan(0);

    // Verify user.id is also tagged binary
    expect(data.createOptions.publicKey.user.id).toHaveProperty('$b64u');
    const userIdB64u = data.createOptions.publicKey.user.id.$b64u;
    expect(typeof userIdB64u).toBe('string');
  });

  test('login-begin returns correct tagged binary format', async () => {
    const response = await request.post('/user/login-webauthn-begin', { data: {} });
    expect(response.ok()).toBe(true);

    const data = await response.json();

    // Verify tagged binary format for challenge
    expect(data.getOptions.publicKey.challenge).toHaveProperty('$b64u');
    const challengeB64u = data.getOptions.publicKey.challenge.$b64u;
    expect(typeof challengeB64u).toBe('string');

    const challengeBytes = fromBase64Url(challengeB64u);
    expect(challengeBytes.length).toBeGreaterThan(0);
  });

  test('register-webauthn-finish accepts tagged binary credential', async () => {
    // Get challenge first
    const beginResp = await request.post('/user/register-webauthn-begin', { data: {} });
    expect(beginResp.ok()).toBe(true);
    const beginData = await beginResp.json();

    // Create mock credential data in tagged binary format (as frontend would send)
    const mockRawId = crypto.getRandomValues(new Uint8Array(32));
    const mockAttestationObject = crypto.getRandomValues(new Uint8Array(128));
    const mockClientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.create',
      challenge: beginData.createOptions.publicKey.challenge.$b64u,
      origin: 'http://localhost:3000',
      crossOrigin: false,
    }));

    // Mock privateData (what keystore.initPrf would create)
    const mockPrivateData = {
      mainKey: {
        publicKey: {
          importKey: {
            format: 'raw',
            keyData: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(65))) },
            algorithm: { name: 'ECDH', namedCurve: 'P-256' },
          },
        },
        unwrapKey: {
          format: 'raw',
          unwrapAlgo: 'AES-KW',
          unwrappedKeyAlgo: { name: 'AES-GCM', length: 256 },
        },
      },
      prfKeys: [{
        credentialId: { $b64u: toBase64Url(mockRawId) },
        transports: [],
        prfSalt: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) },
        hkdfSalt: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) },
        hkdfInfo: { $b64u: toBase64Url(new TextEncoder().encode('test')) },
        algorithm: { name: 'AES-GCM', length: 256 },
        keypair: {
          publicKey: {
            importKey: {
              format: 'raw',
              keyData: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(65))) },
              algorithm: { name: 'ECDH', namedCurve: 'P-256' },
            },
          },
          privateKey: {
            unwrapKey: {
              format: 'jwk',
              wrappedKey: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(256))) },
              unwrapAlgo: {
                name: 'AES-GCM',
                iv: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) },
              },
              unwrappedKeyAlgo: { name: 'ECDH', namedCurve: 'P-256' },
            },
          },
        },
        unwrapKey: {
          wrappedKey: { $b64u: toBase64Url(crypto.getRandomValues(new Uint8Array(40))) },
          unwrappingKey: {
            deriveKey: {
              algorithm: { name: 'ECDH' },
              derivedKeyAlgorithm: { name: 'AES-KW', length: 256 },
            },
          },
        },
      }],
      jwe: 'dummy.jwe.value',
    };

    const finishResp = await request.post('/user/register-webauthn-finish', {
      data: {
        challengeId: beginData.challengeId,
        displayName: 'Test User',
        privateData: mockPrivateData,
        credential: {
          type: 'public-key',
          id: toBase64Url(mockRawId),
          rawId: { $b64u: toBase64Url(mockRawId) },
          response: {
            attestationObject: { $b64u: toBase64Url(mockAttestationObject) },
            clientDataJSON: { $b64u: toBase64Url(mockClientDataJSON) },
            transports: ['internal'],
          },
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
        },
      },
    });

    // We expect this to fail validation (invalid attestation), but NOT with 500 (parsing error)
    expect(finishResp.status()).not.toBe(500);

    console.log('register-webauthn-finish status:', finishResp.status());
    if (!finishResp.ok()) {
      const errorBody = await finishResp.text();
      console.log('Error response:', errorBody.substring(0, 200));
    }
  });

  test('login-webauthn-finish accepts tagged binary credential', async () => {
    // Get challenge first
    const beginResp = await request.post('/user/login-webauthn-begin', { data: {} });
    expect(beginResp.ok()).toBe(true);
    const beginData = await beginResp.json();

    // Create mock credential data in tagged binary format
    const mockRawId = crypto.getRandomValues(new Uint8Array(32));
    const mockUserHandle = crypto.getRandomValues(new Uint8Array(16));
    const mockAuthenticatorData = crypto.getRandomValues(new Uint8Array(37));
    const mockSignature = crypto.getRandomValues(new Uint8Array(64));
    const mockClientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.get',
      challenge: beginData.getOptions.publicKey.challenge.$b64u,
      origin: 'http://localhost:3000',
      crossOrigin: false,
    }));

    const finishResp = await request.post('/user/login-webauthn-finish', {
      data: {
        challengeId: beginData.challengeId,
        credential: {
          type: 'public-key',
          id: toBase64Url(mockRawId),
          rawId: { $b64u: toBase64Url(mockRawId) },
          response: {
            authenticatorData: { $b64u: toBase64Url(mockAuthenticatorData) },
            clientDataJSON: { $b64u: toBase64Url(mockClientDataJSON) },
            signature: { $b64u: toBase64Url(mockSignature) },
            userHandle: { $b64u: toBase64Url(mockUserHandle) },
          },
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
        },
      },
    });

    // We expect this to fail (no registered credential), but NOT with 500
    expect(finishResp.status()).not.toBe(500);

    console.log('login-webauthn-finish status:', finishResp.status());
  });

  test('backend /status endpoint responds correctly', async () => {
    const response = await request.get('/status');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    console.log('Backend status:', JSON.stringify(data, null, 2));

    expect(data.status).toBe('ok');
    expect(data.service).toBe('wallet-backend');
  });
});
