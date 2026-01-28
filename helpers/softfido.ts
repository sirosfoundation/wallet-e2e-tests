/**
 * SoftFIDO2 WebAuthn Helper for E2E Tests
 *
 * This helper works with soft-fido2 (https://github.com/pando85/soft-fido2)
 * which provides a software-based FIDO2 authenticator that appears to the
 * browser as a real platform authenticator.
 *
 * soft-fido2 must be installed and running on the system before tests.
 * The authenticator supports:
 * - Discoverable credentials (resident keys)
 * - User verification
 * - PRF extension (for key derivation)
 *
 * To reset authenticator state between tests, use the soft-fido2 CLI
 * or delete/recreate its credential storage.
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Check if soft-fido2 authenticator is available
 */
export async function isSoftFidoAvailable(): Promise<boolean> {
  try {
    // Check if soft-fido2 process is running
    const result = await execAsync('pgrep -f soft-fido2 || pgrep -f softfido');
    return result.stdout.trim().length > 0;
  } catch {
    // pgrep returns non-zero if no process found
    return false;
  }
}

/**
 * Reset soft-fido2 credentials (clear all stored credentials)
 * This is useful between tests to ensure clean state.
 *
 * Note: The exact method depends on soft-fido2 version and configuration.
 * You may need to adjust this based on your soft-fido2 setup.
 */
export async function resetSoftFidoCredentials(): Promise<void> {
  try {
    // soft-fido2 typically stores credentials in ~/.config/soft-fido2/
    // or a similar location. Adjust path as needed.
    const credentialPaths = [
      '~/.config/soft-fido2/credentials',
      '~/.local/share/soft-fido2/credentials',
      '/var/lib/soft-fido2/credentials',
    ];

    for (const path of credentialPaths) {
      try {
        await execAsync(`rm -rf ${path.replace('~', process.env.HOME || '')}/*`);
      } catch {
        // Path may not exist, that's fine
      }
    }

    console.log('[SoftFIDO] Credentials reset');
  } catch (error) {
    console.warn('[SoftFIDO] Failed to reset credentials:', error);
  }
}

/**
 * Base64URL encoding utilities for WebAuthn data
 */
export function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function fromBase64Url(str: string): Uint8Array {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a random string for test usernames
 */
export function generateTestUsername(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `test-user-${timestamp}-${random}`;
}

/**
 * Convert tagged binary format from backend to ArrayBuffer
 * Backend uses { "$b64u": "base64url-string" } format
 */
export function taggedBinaryToBuffer(tagged: { $b64u: string }): ArrayBuffer {
  return fromBase64Url(tagged.$b64u).buffer;
}

/**
 * Generate a unique test identifier
 */
export function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
