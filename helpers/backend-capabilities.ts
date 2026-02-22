/**
 * Backend Capabilities Helper
 *
 * Provides utilities for detecting backend capabilities such as
 * WebSocket support, API version, and enabled features.
 *
 * This is used by E2E tests to dynamically adjust behavior based
 * on what the backend under test supports.
 *
 * Transport Modes:
 *   TRANSPORT_MODE env var controls which transport to test:
 *   - 'auto': Use best available (WebSocket if supported, else HTTP)
 *   - 'websocket': Force WebSocket only (skip if unavailable)
 *   - 'http': Force HTTP only (even if WebSocket is available)
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ENGINE_URL = process.env.ENGINE_URL || BACKEND_URL;
const TRANSPORT_MODE = process.env.TRANSPORT_MODE || 'auto';

/**
 * Valid transport modes
 */
export type TransportMode = 'auto' | 'websocket' | 'http';

/**
 * Get configured transport mode
 */
export function getTransportMode(): TransportMode {
  const mode = TRANSPORT_MODE.toLowerCase();
  if (mode === 'websocket' || mode === 'http' || mode === 'auto') {
    return mode;
  }
  console.warn(`Invalid TRANSPORT_MODE '${TRANSPORT_MODE}', using 'auto'`);
  return 'auto';
}

/**
 * Backend status response from /status endpoint
 */
export interface BackendStatus {
  status: string;
  service: string;
  version?: string;
  api_version?: number;
  capabilities?: string[];
  roles?: string[];
}

/**
 * Cached status responses
 */
let cachedBackendStatus: BackendStatus | null = null;
let cachedEngineStatus: BackendStatus | null = null;

/**
 * Fetch status from backend
 */
export async function fetchBackendStatus(forceRefresh = false): Promise<BackendStatus | null> {
  if (cachedBackendStatus && !forceRefresh) {
    return cachedBackendStatus;
  }

  try {
    const response = await fetch(`${BACKEND_URL}/status`);
    if (!response.ok) {
      console.warn(`Backend status check failed: ${response.status}`);
      return null;
    }
    cachedBackendStatus = await response.json();
    return cachedBackendStatus;
  } catch (error) {
    console.warn(`Backend not reachable: ${error}`);
    return null;
  }
}

/**
 * Fetch status from engine (if different from backend)
 */
export async function fetchEngineStatus(forceRefresh = false): Promise<BackendStatus | null> {
  if (ENGINE_URL === BACKEND_URL) {
    return fetchBackendStatus(forceRefresh);
  }

  if (cachedEngineStatus && !forceRefresh) {
    return cachedEngineStatus;
  }

  try {
    const response = await fetch(`${ENGINE_URL}/status`);
    if (!response.ok) {
      console.warn(`Engine status check failed: ${response.status}`);
      return null;
    }
    cachedEngineStatus = await response.json();
    return cachedEngineStatus;
  } catch (error) {
    console.warn(`Engine not reachable: ${error}`);
    return null;
  }
}

/**
 * Check if WebSocket transport is available
 *
 * WebSocket is available when the backend/engine reports 'websocket'
 * in its capabilities array.
 */
export async function isWebSocketAvailable(): Promise<boolean> {
  const status = await fetchEngineStatus();
  if (!status) return false;

  const capabilities = status.capabilities || [];
  return capabilities.includes('websocket');
}

/**
 * Check API version
 *
 * Returns the API version from the backend, or 1 if not specified.
 */
export async function getApiVersion(): Promise<number> {
  const status = await fetchBackendStatus();
  return status?.api_version ?? 1;
}

/**
 * Check if a specific capability is available
 */
export async function hasCapability(capability: string): Promise<boolean> {
  const status = await fetchEngineStatus();
  if (!status) return false;

  const capabilities = status.capabilities || [];
  return capabilities.includes(capability);
}

/**
 * Get all capabilities
 */
export async function getCapabilities(): Promise<string[]> {
  const status = await fetchEngineStatus();
  return status?.capabilities || [];
}

/**
 * Clear cached status (useful between tests)
 */
export function clearStatusCache(): void {
  cachedBackendStatus = null;
  cachedEngineStatus = null;
}

/**
 * Get transport mode description for logging
 *
 * Returns a human-readable description of what transport(s) are available
 * and what mode is configured.
 */
export async function getTransportDescription(): Promise<string> {
  const wsAvailable = await isWebSocketAvailable();
  const apiVersion = await getApiVersion();
  const mode = getTransportMode();

  const available: string[] = ['http'];
  if (wsAvailable) {
    available.unshift('websocket');
  }

  return `API v${apiVersion}, available: [${available.join(', ')}], mode: ${mode}`;
}

/**
 * Get the VITE_TRANSPORT_PREFERENCE value for the current transport mode
 *
 * Maps TRANSPORT_MODE to the frontend configuration value.
 */
export function getViteTransportPreference(): string {
  const mode = getTransportMode();
  switch (mode) {
    case 'websocket':
      return 'websocket';
    case 'http':
      return 'http';
    case 'auto':
    default:
      return 'websocket,http';
  }
}

/**
 * Check if the configured transport mode can run with current backend
 *
 * Returns an object with:
 * - canRun: boolean - whether tests can proceed
 * - reason: string - explanation for logging/skip message
 * - effectiveTransport: string - what transport will actually be used
 */
export async function validateTransportMode(): Promise<{
  canRun: boolean;
  reason: string;
  effectiveTransport: string;
}> {
  const mode = getTransportMode();
  const wsAvailable = await isWebSocketAvailable();

  switch (mode) {
    case 'websocket':
      if (!wsAvailable) {
        return {
          canRun: false,
          reason: 'WebSocket mode requested but backend does not support WebSocket',
          effectiveTransport: 'none',
        };
      }
      return {
        canRun: true,
        reason: 'Using WebSocket transport (forced)',
        effectiveTransport: 'websocket',
      };

    case 'http':
      return {
        canRun: true,
        reason: wsAvailable
          ? 'Using HTTP transport (forced, WebSocket available but not used)'
          : 'Using HTTP transport',
        effectiveTransport: 'http',
      };

    case 'auto':
    default:
      return {
        canRun: true,
        reason: wsAvailable
          ? 'Using WebSocket transport (auto-detected)'
          : 'Using HTTP transport (WebSocket not available)',
        effectiveTransport: wsAvailable ? 'websocket' : 'http',
      };
  }
}

/**
 * Get list of available transport modes based on backend capabilities
 *
 * Returns transport modes that can actually run against the current backend.
 */
export async function getAvailableTransportModes(): Promise<TransportMode[]> {
  const wsAvailable = await isWebSocketAvailable();
  const modes: TransportMode[] = ['http'];
  if (wsAvailable) {
    modes.unshift('websocket');
    modes.push('auto');
  }
  return modes;
}

/**
 * Backend type detection
 *
 * Identifies which backend implementation is running:
 * - 'go-wallet-backend': Go implementation with mode support and WebSocket
 * - 'wallet-backend-server': Original TypeScript implementation
 * - 'unknown': Could not determine backend type
 */
export type BackendType = 'go-wallet-backend' | 'wallet-backend-server' | 'unknown';

/**
 * Detect which backend implementation is running
 *
 * Uses the service name from /status response to identify the backend.
 */
export async function getBackendType(): Promise<BackendType> {
  const status = await fetchBackendStatus();
  if (!status) return 'unknown';

  const service = status.service?.toLowerCase() || '';

  // go-wallet-backend reports service as "wallet-backend" or "go-wallet-backend"
  // and has roles like ["backend", "engine"]
  if (
    service.includes('go-wallet') ||
    (status.roles && status.roles.length > 0) ||
    (status.capabilities && status.capabilities.includes('websocket'))
  ) {
    return 'go-wallet-backend';
  }

  // wallet-backend-server (TypeScript) typically reports different service name
  // and doesn't have roles or WebSocket capability
  if (service.includes('wallet-backend') || service.includes('backend')) {
    return 'wallet-backend-server';
  }

  return 'unknown';
}

/**
 * Check if backend supports mode-based deployment
 *
 * Only go-wallet-backend supports running in different modes
 * (backend-only, engine-only, all, registry).
 */
export async function supportsModes(): Promise<boolean> {
  const status = await fetchBackendStatus();
  // Only go-wallet-backend has roles in the status response
  return !!(status?.roles && status.roles.length > 0);
}

/**
 * Get a description of the backend for logging
 */
export async function getBackendDescription(): Promise<string> {
  const status = await fetchBackendStatus();
  if (!status) return 'Backend not reachable';

  const type = await getBackendType();
  const parts = [
    `type: ${type}`,
    `service: ${status.service}`,
  ];

  if (status.version) {
    parts.push(`version: ${status.version}`);
  }
  if (status.roles && status.roles.length > 0) {
    parts.push(`roles: [${status.roles.join(', ')}]`);
  }
  if (status.capabilities && status.capabilities.length > 0) {
    parts.push(`capabilities: [${status.capabilities.join(', ')}]`);
  }

  return parts.join(', ');
}
