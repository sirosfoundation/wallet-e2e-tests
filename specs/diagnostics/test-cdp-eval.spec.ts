import { test, expect } from '@playwright/test';
import { WebAuthnHelper } from '../../helpers/webauthn';

test('CDP test in page.evaluate', async ({ page }) => {
  const webauthn = new WebAuthnHelper(page);
  await webauthn.initialize();
  await webauthn.injectPrfMock();
  await webauthn.addPlatformAuthenticator();

  await page.goto('http://localhost:3000');
  await page.waitForLoadState('domcontentloaded');

  // Test credential creation via page.evaluate
  const result = await page.evaluate(async () => {
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
        attestation: 'direct',
      },
    };

    try {
      const cred = await navigator.credentials.create(createOptions) as PublicKeyCredential;
      if (!cred) return { error: 'null credential' };
      
      const response = cred.response as AuthenticatorAttestationResponse;
      return {
        id: cred.id,
        type: cred.type,
        attestationObjectLength: response.attestationObject.byteLength,
        clientDataJSONLength: response.clientDataJSON.byteLength,
        extensions: cred.getClientExtensionResults(),
      };
    } catch (e) {
      return { error: String(e) };
    }
  });

  console.log('Result:', JSON.stringify(result, null, 2));
});
