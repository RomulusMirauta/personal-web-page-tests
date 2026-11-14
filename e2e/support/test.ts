/**
 * The suite's `test` and `expect`. Every spec imports them from here (not from @playwright/test) so
 * that each browser context it uses blocks the analytics hosts: a test run against production must
 * never count as a visit or skew the real-user performance data.
 *
 * Contexts a spec opens itself (browser.newContext) go through newContext() below for the same reason.
 */
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions } from '@playwright/test';

/** Hosts and paths of the analytics the production build loads (page-view counter, Web Vitals). */
export const ANALYTICS = [
  /^https?:\/\/[^/]+\/_vercel\/(insights|speed-insights)\//,
  /^https?:\/\/([^/]+\.)?goatcounter\.com\//,
  /^https?:\/\/gc\.zgo\.at\//,
] as const;

export function isAnalytics(url: string): boolean {
  return ANALYTICS.some((re) => re.test(url));
}

/** Abort every analytics request of a context (scripts, beacons, pixels). */
export async function blockAnalytics(context: BrowserContext): Promise<void> {
  await context.route((url) => isAnalytics(url.href), (route) => route.abort('blockedbyclient'));
}

/** browser.newContext() with the project's options and the analytics blocked. */
export async function newContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, ...options });
  await blockAnalytics(context);
  return context;
}

export const test = base.extend<{ analyticsBlocked: void }>({
  analyticsBlocked: [
    async ({ context }, use) => {
      await blockAnalytics(context);
      await use();
    },
    { auto: true },
  ],
});

/**
 * An aborted analytics request shows up as a console error ("Failed to load resource"); error
 * collectors filter those out with this.
 */
export function isBlockedRequestNoise(text: string): boolean {
  return /ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(text) || isAnalytics(text);
}

export { expect };
