import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for CI/CD WebAuthn testing
 * 
 * This config is optimized for running in CI environments:
 * - Uses CDP virtual authenticator with PRF mock (no soft-fido2)
 * - Runs in headless mode (no display required)
 * - Targets only webauthn-ci test specs
 * 
 * Usage:
 *   npx playwright test --config=playwright.webauthn-ci.config.ts
 *   make test-webauthn-ci
 * 
 * Environment Variables (same as main config):
 * - FRONTEND_URL: URL of the wallet-frontend (default: http://localhost:3000)
 * - BACKEND_URL: URL of the go-wallet-backend (default: http://localhost:8080)
 * - ADMIN_URL: URL of the admin API (default: http://localhost:8081)
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';

export default defineConfig({
  // Only run webauthn-ci tests
  testDir: './specs/webauthn-ci',
  
  // Serial execution for WebAuthn consistency
  fullyParallel: false,
  workers: 1,
  
  // CI settings
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  
  // Reporting - simplified for CI
  reporter: process.env.CI 
    ? [['html', { open: 'never', outputFolder: 'playwright-report-ci' }], ['list'], ['github']]
    : [['html', { open: 'never', outputFolder: 'playwright-report-ci' }], ['list']],

  use: {
    baseURL: FRONTEND_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    storageState: undefined,
    
    // Headless mode - required for CI
    headless: true,
  },

  // Timeouts
  timeout: 60000,
  expect: {
    timeout: 10000,
  },

  projects: [
    {
      name: 'chromium-ci',
      use: {
        ...devices['Desktop Chrome'],
        // Chrome channel for latest features
        channel: 'chrome',
        // Additional Chrome flags for WebAuthn
        launchOptions: {
          args: [
            // Enable experimental web platform features (for WebAuthn extensions)
            '--enable-experimental-web-platform-features',
            // Enable blink features for cryptography (PRF uses SubtleCrypto)
            '--enable-blink-features=WebAuthenticationExtendedInfoMetrics',
            // Disable GPU for CI stability
            '--disable-gpu',
            // No sandbox for Docker environments
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // Disable dev shm (for Docker)
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
  ],

  // Output directory for artifacts
  outputDir: 'test-results-ci',
});
