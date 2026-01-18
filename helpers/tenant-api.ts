/**
 * Tenant Admin API Helper
 *
 * Provides methods to interact with the go-wallet-backend admin API
 * for tenant management during E2E tests.
 *
 * The admin API runs on a separate port (default 8081) to keep it
 * isolated from the public API.
 */

import { APIRequestContext } from '@playwright/test';

// Admin API URL (defaults to localhost:8081)
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8081';
// Admin token for authentication
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

export interface Tenant {
  id: string;
  name: string;
  display_name?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateTenantRequest {
  id: string;
  name: string;
  display_name?: string;
  enabled?: boolean;
}

export interface TenantMembership {
  user_id: string;
  role?: 'user' | 'admin';
}

/**
 * TenantApiHelper provides methods for tenant management via the admin API
 */
export class TenantApiHelper {
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
   * Check if the admin API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request.get(`${this.adminUrl}/admin/status`, {
        headers: this.getHeaders(),
      });
      return response.ok();
    } catch {
      return false;
    }
  }

  /**
   * Get admin API status
   */
  async getStatus(): Promise<{ status: string; service: string }> {
    const response = await this.request.get(`${this.adminUrl}/admin/status`, {
      headers: this.getHeaders(),
    });
    if (!response.ok()) {
      throw new Error(`Admin API status check failed: ${response.status()}`);
    }
    return response.json();
  }

  /**
   * List all tenants
   */
  async listTenants(): Promise<Tenant[]> {
    const response = await this.request.get(`${this.adminUrl}/admin/tenants`, {
      headers: this.getHeaders(),
    });
    if (!response.ok()) {
      throw new Error(`Failed to list tenants: ${response.status()}`);
    }
    const data = await response.json();
    return data.tenants || [];
  }

  /**
   * Get a specific tenant by ID
   */
  async getTenant(tenantId: string): Promise<Tenant | null> {
    const response = await this.request.get(`${this.adminUrl}/admin/tenants/${tenantId}`, {
      headers: this.getHeaders(),
    });
    if (response.status() === 404) {
      return null;
    }
    if (!response.ok()) {
      throw new Error(`Failed to get tenant: ${response.status()}`);
    }
    return response.json();
  }

  /**
   * Create a new tenant
   */
  async createTenant(tenant: CreateTenantRequest): Promise<Tenant> {
    const response = await this.request.post(`${this.adminUrl}/admin/tenants`, {
      headers: this.getHeaders(),
      data: tenant,
    });
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to create tenant: ${response.status()} - ${error}`);
    }
    return response.json();
  }

  /**
   * Update an existing tenant
   */
  async updateTenant(tenantId: string, updates: Partial<CreateTenantRequest>): Promise<Tenant> {
    // First get the current tenant to merge with updates
    const current = await this.getTenant(tenantId);
    if (!current) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    const response = await this.request.put(`${this.adminUrl}/admin/tenants/${tenantId}`, {
      headers: this.getHeaders(),
      data: {
        id: tenantId,
        name: updates.name ?? current.name,
        display_name: updates.display_name ?? current.display_name,
        enabled: updates.enabled ?? current.enabled,
      },
    });
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to update tenant: ${response.status()} - ${error}`);
    }
    return response.json();
  }

  /**
   * Delete a tenant
   */
  async deleteTenant(tenantId: string): Promise<void> {
    const response = await this.request.delete(`${this.adminUrl}/admin/tenants/${tenantId}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok() && response.status() !== 404) {
      const error = await response.text();
      throw new Error(`Failed to delete tenant: ${response.status()} - ${error}`);
    }
  }

  /**
   * Enable a tenant
   */
  async enableTenant(tenantId: string): Promise<Tenant> {
    return this.updateTenant(tenantId, { enabled: true });
  }

  /**
   * Disable a tenant
   */
  async disableTenant(tenantId: string): Promise<Tenant> {
    return this.updateTenant(tenantId, { enabled: false });
  }

  /**
   * Get users in a tenant
   */
  async getTenantUsers(tenantId: string): Promise<string[]> {
    const response = await this.request.get(`${this.adminUrl}/admin/tenants/${tenantId}/users`, {
      headers: this.getHeaders(),
    });
    if (!response.ok()) {
      throw new Error(`Failed to get tenant users: ${response.status()}`);
    }
    const data = await response.json();
    return data.users || [];
  }

  /**
   * Add a user to a tenant
   */
  async addUserToTenant(tenantId: string, userId: string, role: string = 'user'): Promise<void> {
    const response = await this.request.post(`${this.adminUrl}/admin/tenants/${tenantId}/users`, {
      headers: this.getHeaders(),
      data: { user_id: userId, role },
    });
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to add user to tenant: ${response.status()} - ${error}`);
    }
  }

  /**
   * Remove a user from a tenant
   */
  async removeUserFromTenant(tenantId: string, userId: string): Promise<void> {
    const response = await this.request.delete(
      `${this.adminUrl}/admin/tenants/${tenantId}/users/${userId}`,
      {
        headers: this.getHeaders(),
      }
    );
    if (!response.ok()) {
      const error = await response.text();
      throw new Error(`Failed to remove user from tenant: ${response.status()} - ${error}`);
    }
  }

  /**
   * Create a tenant if it doesn't exist, or return the existing one
   */
  async ensureTenant(tenant: CreateTenantRequest): Promise<Tenant> {
    const existing = await this.getTenant(tenant.id);
    if (existing) {
      return existing;
    }
    return this.createTenant(tenant);
  }

  /**
   * Clean up test tenants (delete all except 'default')
   */
  async cleanupTestTenants(): Promise<void> {
    const tenants = await this.listTenants();
    for (const tenant of tenants) {
      if (tenant.id !== 'default') {
        try {
          await this.deleteTenant(tenant.id);
        } catch (e) {
          console.warn(`Failed to delete tenant ${tenant.id}:`, e);
        }
      }
    }
  }
}

/**
 * Helper function to decode a base64url user handle and extract tenant/user IDs
 */
export function decodeUserHandle(base64url: string): { tenantId: string; userId: string } | null {
  try {
    // Convert base64url to base64
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');

    // Decode
    const decoded = atob(paddedBase64);

    // Parse tenant:user format
    const parts = decoded.split(':');
    if (parts.length !== 2) {
      return null; // Not in tenant:user format
    }

    return {
      tenantId: parts[0],
      userId: parts[1],
    };
  } catch {
    return null;
  }
}

/**
 * Generate a unique tenant ID for testing
 */
export function generateTestTenantId(prefix: string = 'test'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
