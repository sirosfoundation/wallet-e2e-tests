/**
 * Trust API Helper
 *
 * Provides methods to interact with the go-wallet-backend trust-related endpoints
 * for E2E testing of the discover-and-trust functionality.
 */

import { APIRequestContext } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

export interface DiscoverAndTrustRequest {
  entity_identifier: string;
  role: 'issuer' | 'verifier';
  credential_type?: string;
}

export interface DiscoverAndTrustResponse {
  issuer_metadata?: Record<string, unknown>;
  verifier_metadata?: Record<string, unknown>;
  trusted: boolean;
  reason: string;
  trusted_certificates?: string[];
  trust_framework?: string;
  discovery_status: 'success' | 'partial' | 'failed';
  discovery_error?: string;
}

export interface StatusResponse {
  status: string;
  service: string;
  api_version?: number;
}

/**
 * TrustApiHelper provides methods for trust-related API operations
 */
export class TrustApiHelper {
  private request: APIRequestContext;
  private backendUrl: string;
  private authToken: string | null = null;

  constructor(request: APIRequestContext, backendUrl: string = BACKEND_URL) {
    this.request = request;
    this.backendUrl = backendUrl;
  }

  /**
   * Set the authentication token for subsequent requests
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Clear the authentication token
   */
  clearAuthToken(): void {
    this.authToken = null;
  }

  /**
   * Get the status response including API version
   */
  async getStatus(): Promise<StatusResponse> {
    const response = await this.request.get(`${this.backendUrl}/status`);
    if (!response.ok()) {
      throw new Error(`Status request failed: ${response.status()}`);
    }
    return await response.json();
  }

  /**
   * Get the API version from the backend
   * Returns 1 if api_version is not present (backwards compatibility)
   */
  async getApiVersion(): Promise<number> {
    const status = await this.getStatus();
    return status.api_version ?? 1;
  }

  /**
   * Check if discover-and-trust is available (API version >= 2)
   */
  async isDiscoverAndTrustAvailable(): Promise<boolean> {
    const version = await this.getApiVersion();
    return version >= 2;
  }

  /**
   * Call the discover-and-trust endpoint
   * Requires authentication
   */
  async discoverAndTrust(
    request: DiscoverAndTrustRequest
  ): Promise<{ response: DiscoverAndTrustResponse; status: number }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await this.request.post(
      `${this.backendUrl}/api/discover-and-trust`,
      {
        data: request,
        headers,
      }
    );

    let data: DiscoverAndTrustResponse | null = null;
    try {
      data = await response.json();
    } catch {
      // Response might not be JSON for error cases
    }

    return {
      response: data as DiscoverAndTrustResponse,
      status: response.status(),
    };
  }

  /**
   * Convenience method for issuer discovery and trust evaluation
   */
  async discoverAndTrustIssuer(
    issuerIdentifier: string,
    credentialType?: string
  ): Promise<{ response: DiscoverAndTrustResponse; status: number }> {
    return this.discoverAndTrust({
      entity_identifier: issuerIdentifier,
      role: 'issuer',
      credential_type: credentialType,
    });
  }

  /**
   * Convenience method for verifier discovery and trust evaluation
   */
  async discoverAndTrustVerifier(
    verifierIdentifier: string,
    credentialType?: string
  ): Promise<{ response: DiscoverAndTrustResponse; status: number }> {
    return this.discoverAndTrust({
      entity_identifier: verifierIdentifier,
      role: 'verifier',
      credential_type: credentialType,
    });
  }
}

/**
 * Helper to get a JWT token for authenticated API calls
 * This performs a WebAuthn registration to get a valid session
 */
export async function getAuthToken(request: APIRequestContext): Promise<string | null> {
  // For API-level tests, we might need to mock this or use a test token
  // In a real scenario, this would involve completing WebAuthn registration
  // For now, return null to test unauthenticated scenarios
  return null;
}
