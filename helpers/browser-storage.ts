/**
 * Browser Storage Helper for E2E Tests
 *
 * Provides utilities for clearing browser storage (localStorage, sessionStorage,
 * IndexedDB) to ensure test isolation.
 */

import type { Page, BrowserContext } from '@playwright/test';

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

/**
 * Navigate to a blank page and clear all storage before navigating to the target.
 * This ensures a completely clean state.
 * 
 * @param page - The Playwright page instance
 * @param url - The URL to navigate to after clearing storage
 */
export async function navigateWithCleanStorage(page: Page, url: string): Promise<void> {
  // Navigate to about:blank first to ensure we're in a clean state
  await page.goto('about:blank');
  
  // Clear storage on the blank page
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  
  // Navigate to the target URL
  await page.goto(url);
}

/**
 * Clear browser context storage state.
 * This clears cookies, localStorage, etc. at the context level.
 */
export async function clearContextStorage(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}
