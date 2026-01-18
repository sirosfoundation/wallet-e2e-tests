/**
 * Issuer Admin API Helper
 *
 * Provides methods to interact with the go-wallet-backend admin API
 * for issuer management during E2E tests.
 *
 * Issuers are managed per-tenant at:
 *   GET/POST     /admin/tenants/:tenant_id/issuers
 *   GET/PUT/DEL  /admin/tenants/:tenant_id/issuers/:issuer_id
 */

import { APIRequestContext } from '@playwright/test';

// Admin API URL (defaults to localhost:8081)
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
// Admin token for authentication
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

export interface Issuer {
  id: number;
  tenant_id: string;
  credential_issuer_identifier: string;
  client_id?: string;
  visible: boolean;
}

export interface CreateIssuerRequest {
  credential_issuer_identifier: string;
  client_id?: string;
  visible?: boolean;
}

export interface UpdateIssuerRequest {
  credential_issuer_identifier?: string;
  client_id?: string;
  visible?: boolean;
}

/**
 * IssuerApiHelper provides methods for issuer management via the admin API
 */
export class IssuerApiHelper {
  private request: APIRequestContext;
  private adminUrl: string;
  private adminToken: string;

  constructor(request: APIRequestContext, adminUrl: string = ADMIN_URL, adminToken: string = ADMIN_TOKEN) {
    this.request = request;
    this.adminUrl = adminUrl;
    this.adminToken = adminToken;
  }

  /**
   * Get default headers including authorization if token is set
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.adminToken) {
      headers['Authorization'] = `Bearer ${this.adminToken}`;
    }
    return headers;
  }

  /**
   * List all issuers for a tenant
   */
  async listIssuers(tenantId: string): Promise<Issuer[]> {
    const response = await this.request.get(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers`,
      { headers: this.getHeaders() }
    );
    if (!response.ok()) {
      throw new Error(`Failed to list issuers: ${response.status()}`);
    }
    const data = await response.json();
    return data.issuers || [];
  }

  /**
   * Get a specific issuer by ID
   */
  async getIssuer(tenantId: string, issuerId: number): Promise<Issuer | null> {
    const response = await this.request.get(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers/${issuerId}`,
      { headers: this.getHeaders() }
    );
    if (response.status() === 404) {
      return null;
    }
    if (!response.ok()) {
      throw new Error(`Failed to get issuer: ${response.status()}`);
    }
    return response.json();
  }

  /**
   * Find an issuer by its credential_issuer_identifier
   */
  async findIssuerByIdentifier(tenantId: string, identifier: string): Promise<Issuer | null> {
    const issuers = await this.listIssuers(tenantId);
    return issuers.find(i => i.credential_issuer_identifier === identifier) || null;
  }

  /**
   * Create a new issuer for a tenant
   */
  async createIssuer(tenantId: string, issuer: CreateIssuerRequest): Promise<Issuer> {
    const response = await this.request.post(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers`,
      {
        headers: this.getHeaders(),
        data: issuer,
      }
    );
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to create issuer: ${response.status()} - ${error}`);
    }
    return response.json();
  }

  /**
   * Create an issuer and return both the response and status
   */
  async createIssuerRaw(tenantId: string, issuer: CreateIssuerRequest): Promise<{ status: number; data?: Issuer; error?: string }> {
    const response = await this.request.post(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers`,
      {
        headers: this.getHeaders(),
        data: issuer,
      }
    );
    if (!response.ok()) {
      return { status: response.status(), error: await response.text() };
    }
    return { status: response.status(), data: await response.json() };
  }

  /**
   * Update an existing issuer
   */
  async updateIssuer(tenantId: string, issuerId: number, updates: UpdateIssuerRequest): Promise<Issuer> {
    const response = await this.request.put(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers/${issuerId}`,
      {
        headers: this.getHeaders(),
        data: updates,
      }
    );
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to update issuer: ${response.status()} - ${error}`);
    }
    return response.json();
  }

  /**
   * Delete an issuer
   */
  async deleteIssuer(tenantId: string, issuerId: number): Promise<void> {
    const response = await this.request.delete(
      `${this.adminUrl}/admin/tenants/${tenantId}/issuers/${issuerId}`,
      { headers: this.getHeaders() }
    );
    if (!response.ok() && response.status() !== 404) {
      const error = await response.text();
      throw new Error(`Failed to delete issuer: ${response.status()} - ${error}`);
    }
  }

  /**
   * Delete an issuer by its identifier
   */
  async deleteIssuerByIdentifier(tenantId: string, identifier: string): Promise<boolean> {
    const issuer = await this.findIssuerByIdentifier(tenantId, identifier);
    if (!issuer) {
      return false;
    }
    await this.deleteIssuer(tenantId, issuer.id);
    return true;
  }

  /**
   * Create an issuer if it doesn't exist, or return the existing one
   */
  async ensureIssuer(tenantId: string, issuer: CreateIssuerRequest): Promise<Issuer> {
    const existing = await this.findIssuerByIdentifier(tenantId, issuer.credential_issuer_identifier);
    if (existing) {
      return existing;
    }
    return this.createIssuer(tenantId, issuer);
  }

  /**
   * Register the mock issuer (convenience method)
   */
  async registerMockIssuer(tenantId: string = 'default', mockIssuerUrl: string = process.env.MOCK_ISSUER_URL || 'http://localhost:9000'): Promise<Issuer> {
    return this.ensureIssuer(tenantId, {
      credential_issuer_identifier: mockIssuerUrl,
      client_id: 'wallet-e2e-test',
      visible: true,
    });
  }

  /**
   * Unregister the mock issuer
   */
  async unregisterMockIssuer(tenantId: string = 'default', mockIssuerUrl: string = process.env.MOCK_ISSUER_URL || 'http://localhost:9000'): Promise<boolean> {
    return this.deleteIssuerByIdentifier(tenantId, mockIssuerUrl);
  }

  /**
   * Clean up all test issuers (delete all issuers for a tenant)
   */
  async cleanupIssuers(tenantId: string): Promise<void> {
    const issuers = await this.listIssuers(tenantId);
    for (const issuer of issuers) {
      try {
        await this.deleteIssuer(tenantId, issuer.id);
      } catch (e) {
        console.warn(`Failed to delete issuer ${issuer.id}:`, e);
      }
    }
  }
}
