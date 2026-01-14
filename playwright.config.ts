import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for wallet stack
 *
 * Environment Variables:
 * - FRONTEND_URL: URL of the wallet-frontend (default: http://localhost:3000)
 * - BACKEND_URL: URL of the go-wallet-backend (default: http://localhost:8080)
 * - START_SERVERS: Set to 'true' to auto-start both servers (default: false)
 * - FRONTEND_PATH: Path to wallet-frontend repo (for auto-start)
 * - BACKEND_PATH: Path to go-wallet-backend repo (for auto-start)
 *
 * Example usage:
 *   # Test against already running servers
 *   FRONTEND_URL=http://localhost:3000 BACKEND_URL=http://localhost:8080 npm test
 *
 *   # Auto-start servers from local repos
 *   START_SERVERS=true FRONTEND_PATH=../wallet-frontend BACKEND_PATH=../go-wallet-backend npm test
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const START_SERVERS = process.env.START_SERVERS === 'true';
const FRONTEND_PATH = process.env.FRONTEND_PATH || '../wallet-frontend';
const BACKEND_PATH = process.env.BACKEND_PATH || '../go-wallet-backend';

// Extract hostname from FRONTEND_URL for RPID
const frontendHostname = new URL(FRONTEND_URL).hostname;

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,  // WebAuthn tests need serial execution
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Single worker for WebAuthn session consistency
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  use: {
    baseURL: FRONTEND_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Each test gets a clean browser context - no localStorage/cookies from previous tests
    storageState: undefined,
  },

  // Global test timeout
  timeout: 60000,

  // Expect assertions timeout
  expect: {
    timeout: 10000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  // Conditionally start servers if START_SERVERS=true
  ...(START_SERVERS && {
    webServer: [
      {
        // Start go-wallet-backend first
        command: `cd ${BACKEND_PATH} && go run ./cmd/server`,
        url: `${BACKEND_URL}/status`,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        env: {
          WALLET_JWT_SECRET: 'test-secret-for-e2e-testing-minimum-32-chars',
          WALLET_SERVER_WEBAUTHN_DISPLAY_NAME: 'Wallet E2E Test',
          WALLET_SERVER_RP_ID: frontendHostname,
          WALLET_SERVER_RP_ORIGIN: FRONTEND_URL,
          WALLET_SERVER_ENABLE_CREDENTIAL_REGISTRATION: 'true',
          WALLET_SERVER_REQUIRE_USER_VERIFICATION: 'true',
          WALLET_SERVER_TIMEOUT: '60000',
          WALLET_SERVER_ATTESTATION: 'none',
          WALLET_SERVER_PORT: new URL(BACKEND_URL).port || '8080',
          WALLET_LOG_LEVEL: 'info',
        },
      },
      {
        // Then start the frontend
        command: `cd ${FRONTEND_PATH} && npm run start -- --host`,
        url: FRONTEND_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        env: {
          VITE_WALLET_BACKEND_URL: BACKEND_URL,
          VITE_WEBAUTHN_RPID: frontendHostname,
          VITE_LOGIN_WITH_PASSWORD: 'false',
        },
      },
    ],
  }),
});

// Export URLs for use in test files
export const config = {
  frontendUrl: FRONTEND_URL,
  backendUrl: BACKEND_URL,
};
