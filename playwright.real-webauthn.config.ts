/**
 * Playwright Configuration for Real WebAuthn Testing
 *
 * This configuration runs tests in headed mode with Chrome's software
 * platform authenticator, enabling testing of real WebAuthn flows
 * without CDP virtual authenticator mocking.
 *
 * Usage:
 *   npm run test:real-webauthn
 *   make test-real-webauthn       # With Docker services
 *   make test-real-webauthn-ci    # With Xvfb for CI
 */

import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

// Load environment variables from .env file
import * as dotenv from 'dotenv';
dotenv.config();

// Use same environment variables as main config for consistency with Docker setup
const baseURL = process.env.FRONTEND_URL || 'http://localhost:3000';
const backendURL = process.env.BACKEND_URL || 'http://localhost:8080';
const adminURL = process.env.ADMIN_URL || 'http://localhost:8081';

export default defineConfig({
  testDir: './specs/real-webauthn',
  
  // Run tests serially - WebAuthn operations can conflict with each other
  fullyParallel: false,
  workers: 1,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Reporter configuration
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report-real-webauthn' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report-real-webauthn' }]],
  
  // Global timeout - real WebAuthn may need more time for UI interactions
  timeout: 60000,
  
  use: {
    // CRITICAL: Real WebAuthn requires headed mode
    headless: false,
    
    // Base URL for all page.goto() calls
    baseURL,
    
    // Browser launch options for WebAuthn support
    launchOptions: {
      args: [
        // Enable Chrome's caBLE (Cloud-Assisted BLE) and WebAuthn features
        '--enable-features=WebAuthenticationCable,WebAuthenticationMacPlatformAuthenticator',
        // Allow insecure localhost for development
        '--ignore-certificate-errors',
        // Disable various Chrome features that might interfere
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        // Enable automation features
        '--enable-automation',
        // Log WebAuthn operations for debugging
        '--vmodule=*webauthn*=3',
      ],
      // Slow down for debugging if needed
      slowMo: process.env.SLOW_MO ? parseInt(process.env.SLOW_MO) : 0,
    },
    
    // Accept self-signed certificates
    ignoreHTTPSErrors: true,
    
    // Trace collection for debugging
    trace: 'on-first-retry',
    
    // Video recording for debugging test failures
    video: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
    
    // Viewport size
    viewport: { width: 1280, height: 720 },
    
    // Extra HTTP headers
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  
  // Output directories
  outputDir: 'test-results-real-webauthn',
  
  // Projects configuration
  projects: [
    {
      name: 'real-webauthn-chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Override device settings for WebAuthn
        hasTouch: false, // Platform authenticator, not NFC
      },
    },
    // TODO: Add Firefox and Safari when their WebAuthn automation improves
    // {
    //   name: 'real-webauthn-firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'real-webauthn-safari',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],
  
  // Global setup - can be used to start services
  // globalSetup: require.resolve('./global-setup'),
  // globalTeardown: require.resolve('./global-teardown'),
  
  // Web server configuration - starts the frontend if needed
  webServer: process.env.START_WEBSERVER
    ? [
        {
          command: 'cd ../wallet-frontend && npm run dev',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120000,
        },
        {
          command: 'cd ../go-wallet-backend && go run ./cmd/wallet-backend',
          url: `${backendURL}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120000,
        },
      ]
    : undefined,
  
  // Expect configuration
  expect: {
    // Increase timeout for WebAuthn operations which may show UI
    timeout: 15000,
  },
});
