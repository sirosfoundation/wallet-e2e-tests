/**
 * Mock Verifier Service for E2E Testing
 *
 * Simulates an OpenID4VP verifier with:
 * - /.well-known/openid4vp-verifier endpoint
 * - /presentation_request endpoint (simulated)
 *
 * Usage:
 *   npx ts-node mocks/verifier/index.ts
 *
 * Environment variables:
 *   PORT - Server port (default: 9001)
 *   VERIFIER_ID - Verifier identifier URL (default: http://localhost:9001)
 */

import * as http from 'http';

const PORT = parseInt(process.env.PORT || '9001', 10);
const VERIFIER_ID = process.env.VERIFIER_ID || `http://localhost:${PORT}`;

// Verifier metadata
const verifierMetadata = {
  issuer: VERIFIER_ID,
  client_id: VERIFIER_ID,
  client_name: 'Test Verifier',
  redirect_uris: [`${VERIFIER_ID}/callback`],
  response_types_supported: ['vp_token'],
  response_modes_supported: ['direct_post'],
  vp_formats: {
    mso_mdoc: {
      alg: ['ES256', 'ES384', 'ES512'],
    },
    jwt_vp: {
      alg: ['ES256', 'ES384'],
    },
  },
  presentation_definition_uri_supported: true,
  request_object_signing_alg_values_supported: ['ES256'],
  display: [
    {
      name: 'Test Verifier',
      locale: 'en-US',
      logo: {
        uri: `${VERIFIER_ID}/logo.png`,
        alt_text: 'Test Verifier Logo',
      },
    },
  ],
  // Trust chain / policy information
  trust_framework: 'test-framework',
  organization_name: 'Test Organization',
  organization_id: 'test-org-001',
};

// Supported presentation types
const presentationTypes = {
  'eu.europa.ec.eudi.pid.1': {
    name: 'European Digital Identity',
    required_fields: ['family_name', 'given_name', 'birth_date'],
  },
  'org.iso.18013.5.1.mDL': {
    name: "Mobile Driver's License",
    required_fields: ['family_name', 'given_name', 'document_number'],
  },
};

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
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
    case '/.well-known/openid4vp-verifier':
    case '/.well-known/openid-configuration':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(verifierMetadata, null, 2));
      break;

    case '/presentation_types':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(presentationTypes, null, 2));
      break;

    case '/health':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', verifier: VERIFIER_ID }));
      break;

    case '/presentation_request':
      if (req.method === 'POST') {
        // Simulate creating a presentation request
        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            request_id: requestId,
            request_uri: `${VERIFIER_ID}/requests/${requestId}`,
            expires_in: 300,
          })
        );
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      }
      break;

    default:
      // Handle dynamic request URIs
      if (url.startsWith('/requests/')) {
        const requestId = url.split('/').pop();
        // Return a mock presentation definition
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            response_type: 'vp_token',
            client_id: VERIFIER_ID,
            redirect_uri: `${VERIFIER_ID}/callback`,
            response_mode: 'direct_post',
            nonce: `nonce-${requestId}`,
            presentation_definition: {
              id: `pd-${requestId}`,
              input_descriptors: [
                {
                  id: 'eu.europa.ec.eudi.pid.1',
                  format: {
                    mso_mdoc: {
                      alg: ['ES256'],
                    },
                  },
                  constraints: {
                    limit_disclosure: 'required',
                    fields: [
                      { path: ["$['family_name']"], intent_to_retain: false },
                      { path: ["$['given_name']"], intent_to_retain: false },
                    ],
                  },
                },
              ],
            },
          })
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: url }));
      }
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Mock Verifier Service running on ${VERIFIER_ID}`);
  console.log(`  /.well-known/openid4vp-verifier - Verifier metadata`);
  console.log(`  /presentation_types - Supported presentation types`);
  console.log(`  /presentation_request - Create presentation request (POST)`);
  console.log(`  /health - Health check endpoint`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down mock verifier...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down mock verifier...');
  server.close(() => {
    process.exit(0);
  });
});
