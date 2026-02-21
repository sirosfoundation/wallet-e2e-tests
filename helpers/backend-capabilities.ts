/**
 * Backend Capabilities Helper
 *
 * Provides utilities for detecting backend capabilities such as
 * WebSocket support, API version, and enabled features.
 *
 * This is used by E2E tests to dynamically adjust behavior based
 * on what the backend under test supports.
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const ENGINE_URL = process.env.ENGINE_URL || BACKEND_URL;

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
 * Returns a human-readable description of what transport(s) are available.
 */
export async function getTransportDescription(): Promise<string> {
  const wsAvailable = await isWebSocketAvailable();
  const apiVersion = await getApiVersion();

  const transports: string[] = ['http'];
  if (wsAvailable) {
    transports.unshift('websocket');
  }

  return `API v${apiVersion}, transports: ${transports.join(', ')}`;
}
