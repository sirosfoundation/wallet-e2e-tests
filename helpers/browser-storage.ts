/**
 * Browser Storage Helper for E2E Tests
 *
 * Provides utilities for clearing browser storage (localStorage, sessionStorage,
 * IndexedDB) to ensure test isolation.
 */

import type { Page } from '@playwright/test';

/**
 * Inject storage clearing script into page context.
 * This runs before any page scripts and clears all browser storage.
 *
 * IMPORTANT: Call this in test.beforeEach BEFORE any page.goto() calls.
 */
export async function injectStorageClearing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Clear localStorage and sessionStorage
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      console.warn('[Storage Clear] Failed to clear localStorage/sessionStorage:', e);
    }

    // Clear all IndexedDB databases
    if ('indexedDB' in window) {
      indexedDB.databases().then(databases => {
        databases.forEach(db => {
          if (db.name) {
            indexedDB.deleteDatabase(db.name);
            console.log('[Storage Clear] Deleted IndexedDB:', db.name);
          }
        });
      }).catch(e => {
        console.warn('[Storage Clear] Failed to enumerate IndexedDB:', e);
      });
    }

    console.log('[Storage Clear] Browser storage cleared');
  });
}

/**
 * Clear browser storage after page has loaded.
 * Use this to clear storage mid-test if needed.
 */
export async function clearBrowserStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Clear localStorage and sessionStorage
    localStorage.clear();
    sessionStorage.clear();

    // Clear all IndexedDB databases
    return new Promise<void>((resolve) => {
      if (!('indexedDB' in window)) {
        resolve();
        return;
      }

      indexedDB.databases().then(databases => {
        let pending = databases.length;
        if (pending === 0) {
          resolve();
          return;
        }

        databases.forEach(db => {
          if (db.name) {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = req.onerror = () => {
              pending--;
              if (pending === 0) resolve();
            };
          } else {
            pending--;
            if (pending === 0) resolve();
          }
        });
      }).catch(() => resolve());
    });
  });
}
