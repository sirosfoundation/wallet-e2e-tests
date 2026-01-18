/**
 * Mock Issuer Service for E2E Testing
 *
 * Simulates an OpenID4VCI credential issuer with:
 * - /.well-known/openid-credential-issuer endpoint
 * - /.well-known/oauth-authorization-server endpoint
 * - /mdoc_iacas endpoint for IACA certificates
 *
 * Usage:
 *   node index.mjs
 *
 * Environment variables:
 *   PORT - Server port (default: 9000)
 *   ISSUER_ID - Issuer identifier URL (default: http://localhost:9000)
 *   INCLUDE_IACA - Whether to include IACA certificates (default: true)
 */

import http from 'http';

const PORT = parseInt(process.env.PORT || '9000', 10);
const ISSUER_ID = process.env.ISSUER_ID || `http://localhost:${PORT}`;
const INCLUDE_IACA = process.env.INCLUDE_IACA !== 'false';

// Test IACA certificate (self-signed for testing)
const TEST_IACA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJALKvPP8cdtHpMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBlRl
c3RDQTAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMM
BlRlc3RDQTBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQC7EL5b8/yKtM8Z7KvJKP7z
4mS0mDJW8a7hAQZ6jWxK2M8L3uKP5qL8mQxK2M8L3uKP5qL8mQxK2M8L3uKP5qL8
AgMBAAGjUDBOMB0GA1UdDgQWBBTFakeTestCertificateMB8GA1UdIwQYMBaAFBTF
akeTestCertificateMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADQQBt
estSignatureForTestPurposesOnly
-----END CERTIFICATE-----`;

// Credential issuer metadata
const credentialIssuerMetadata = {
  credential_issuer: ISSUER_ID,
  authorization_servers: [`${ISSUER_ID}`],
  credential_endpoint: `${ISSUER_ID}/credential`,
  batch_credential_endpoint: `${ISSUER_ID}/batch_credential`,
  deferred_credential_endpoint: `${ISSUER_ID}/deferred_credential`,
  display: [
    {
      name: 'Test Issuer',
      locale: 'en-US',
      logo: {
        uri: `${ISSUER_ID}/logo.png`,
        alt_text: 'Test Issuer Logo',
      },
    },
  ],
  credential_configurations_supported: {
    'eu.europa.ec.eudi.pid.1': {
      format: 'mso_mdoc',
      doctype: 'eu.europa.ec.eudi.pid.1',
      scope: 'eu.europa.ec.eudi.pid.1',
      cryptographic_binding_methods_supported: ['cose_key'],
      credential_signing_alg_values_supported: ['ES256'],
      proof_types_supported: {
        jwt: {
          proof_signing_alg_values_supported: ['ES256'],
        },
      },
      display: [
        {
          name: 'EU Digital Identity',
          locale: 'en-US',
          background_color: '#12107c',
          text_color: '#FFFFFF',
        },
      ],
    },
    'org.iso.18013.5.1.mDL': {
      format: 'mso_mdoc',
      doctype: 'org.iso.18013.5.1.mDL',
      scope: 'org.iso.18013.5.1.mDL',
      cryptographic_binding_methods_supported: ['cose_key'],
      credential_signing_alg_values_supported: ['ES256'],
      display: [
        {
          name: "Mobile Driver's License",
          locale: 'en-US',
        },
      ],
    },
  },
  // mdoc_iacas_uri points to the IACA certificates endpoint
  ...(INCLUDE_IACA ? { mdoc_iacas_uri: `${ISSUER_ID}/mdoc_iacas` } : {}),
};

// OAuth authorization server metadata
const authorizationServerMetadata = {
  issuer: ISSUER_ID,
  authorization_endpoint: `${ISSUER_ID}/authorize`,
  token_endpoint: `${ISSUER_ID}/token`,
  pushed_authorization_request_endpoint: `${ISSUER_ID}/par`,
  require_pushed_authorization_requests: true,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:pre-authorized_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['eu.europa.ec.eudi.pid.1', 'org.iso.18013.5.1.mDL'],
  dpop_signing_alg_values_supported: ['ES256'],
};

// IACA certificates response
const iacaCertificates = {
  certificates: [TEST_IACA_CERTIFICATE],
  metadata: {
    issuer: ISSUER_ID,
    updated: new Date().toISOString(),
  },
};

function handleRequest(req, res) {
  const url = req.url || '/';

  // CORS headers for testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);

  switch (url) {
    case '/.well-known/openid-credential-issuer':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(credentialIssuerMetadata, null, 2));
      break;

    case '/.well-known/oauth-authorization-server':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authorizationServerMetadata, null, 2));
      break;

    case '/mdoc_iacas':
      if (INCLUDE_IACA) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(iacaCertificates, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'IACA certificates not available' }));
      }
      break;

    case '/health':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', issuer: ISSUER_ID }));
      break;

    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', path: url }));
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Mock Issuer Service running on ${ISSUER_ID}`);
  console.log(`  /.well-known/openid-credential-issuer - Credential issuer metadata`);
  console.log(`  /.well-known/oauth-authorization-server - Authorization server metadata`);
  if (INCLUDE_IACA) {
    console.log(`  /mdoc_iacas - IACA certificates`);
  }
  console.log(`  /health - Health check endpoint`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down mock issuer...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down mock issuer...');
  server.close(() => {
    process.exit(0);
  });
});
