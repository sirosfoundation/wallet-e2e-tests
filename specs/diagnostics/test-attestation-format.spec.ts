import { test, expect } from '@playwright/test';
import { WebAuthnHelper } from '../../helpers/webauthn';

test('Check attestation format from CDP', async ({ page }) => {
  const webauthn = new WebAuthnHelper(page);
  await webauthn.initialize();
  await webauthn.addPlatformAuthenticator();

  await page.goto('http://localhost:3000');
  await page.waitForLoadState('domcontentloaded');

  // Test credential creation via page.evaluate
  const result = await page.evaluate(async () => {
    function toBase64Url(bytes: Uint8Array): string {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        rp: { name: 'test', id: 'localhost' },
        user: {
          id: new Uint8Array([1,2,3,4]),
          name: 'test@test.com',
          displayName: 'Test User',
        },
        challenge: new Uint8Array([1,2,3,4,5,6,7,8]),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
        },
        attestation: 'none',  // Try 'none' instead of 'direct'
      },
    };

    try {
      const cred = await navigator.credentials.create(createOptions) as PublicKeyCredential;
      if (!cred) return { error: 'null credential' };
      
      const response = cred.response as AuthenticatorAttestationResponse;
      const attestationBytes = new Uint8Array(response.attestationObject);
      
      // Decode CBOR attestation to see format
      // First byte of CBOR map tells us structure
      return {
        id: cred.id,
        attestationObjectB64: toBase64Url(attestationBytes),
        attestationObjectFirstBytes: Array.from(attestationBytes.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' '),
        clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
      };
    } catch (e) {
      return { error: String(e) };
    }
  });

  console.log('Result:', JSON.stringify(result, null, 2));
});
