import type { Page } from '@playwright/test';
import { expect, test } from './support/test';

/**
 * The 404 page: a missing path answers 404 with a page of its own (title, description, link
 * preview, kept out of search results), and the keys it announces lead home.
 */

const MISSING = '/this-page-does-not-exist/';

/** Serves a stub for the app's home page, so a test sees where a key leads without booting the app. */
async function stubHome(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>home</title>' }),
  );
}

test.describe('404 page', { tag: '@all-devices' }, () => {
  test('a missing page answers 404 with its own title, description and link preview, without the home URL', async ({ page }) => {
    const res = await page.goto(MISSING);
    expect(res!.status()).toBe(404);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page).toHaveTitle(/not found/i);
    const title = await page.title();
    const head = await page.evaluate(() => {
      const meta = (key: string) => document.querySelector(`meta[name="${key}"], meta[property="${key}"]`)?.getAttribute('content') ?? null;
      const keys = ['description', 'robots', 'og:url', 'og:type', 'og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
      return Object.fromEntries(keys.map((k) => [k, meta(k)]));
    });
    const description = head.description;
    expect(description, 'a description of its own').toBeTruthy();
    expect(head).toEqual({
      description,
      robots: 'noindex',
      // No canonical URL or page type: the home page's would claim this page is the home page.
      'og:url': null,
      'og:type': null,
      'og:title': title,
      'og:description': description,
      'og:image': expect.stringMatching(/^https?:\/\/.+\.png(\?|$)/),
      'twitter:card': 'summary_large_image',
      'twitter:title': title,
      'twitter:description': description,
      'twitter:image': expect.stringMatching(/^https?:\/\/.+\.png(\?|$)/),
    });
  });

  test('the keys it announces go home, under its own CSP', { tag: '@critical' }, async ({ page }) => {
    await stubHome(page);
    await page.addInitScript(() => {
      const list: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = list;
      document.addEventListener('securitypolicyviolation', (e) => list.push(`${e.effectiveDirective} ${e.blockedURI}`));
    });
    for (const key of ['Escape', 'Backspace', 'ArrowLeft', 'Enter']) {
      await page.goto(MISSING);
      await expect(page).toHaveTitle(/not found/i);
      // The page's policy lets its own key script run.
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
      await page.keyboard.press(key);
      await page.waitForURL((url) => url.pathname === '/');
    }
  });

  test('chords and other keys stay on the page', async ({ page }) => {
    await stubHome(page);
    await page.goto(MISSING);
    for (const key of ['Alt+ArrowLeft', 'Control+Enter', 'Shift+Backspace', 'ArrowRight', 'x']) await page.keyboard.press(key);
    // A key that does go home, last: had any of the above navigated, the page would have left already.
    expect(new URL(page.url()).pathname).toBe(MISSING);
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => url.pathname === '/');
  });

  test('the home link works by pointer too', async ({ page }) => {
    await stubHome(page);
    await page.goto(MISSING);
    await page.locator('a[data-home]').click();
    await page.waitForURL((url) => url.pathname === '/');
  });

  test('the static copies of the page stay out of search results', async ({ page }) => {
    // A static export writes the page to these paths too, where they answer 200.
    for (const path of ['/404/', '/_not-found/']) {
      await page.goto(path);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    }
  });
});

test.describe('404 page key cap', () => {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
  ]) {
    test(`shows an arrow icon centred in a square cap at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(MISSING);
      // The icon's geometry comes from an external sprite: wait until it has loaded.
      await page.waitForFunction(() => (document.querySelector('a[data-home] kbd use')?.getBoundingClientRect().width ?? 0) > 0);
      const r = await page.evaluate(() => {
        const cap = document.querySelector('a[data-home] kbd')!;
        const use = cap.querySelector('svg use')!;
        // A <use>'s client rect is its drawn geometry: the arrow's ink, not the icon's box.
        const ink = use.getBoundingClientRect();
        const c = cap.getBoundingClientRect();
        const cs = getComputedStyle(cap);
        const [t, rt, b, l] = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
        return {
          text: cap.textContent,
          href: use.getAttribute('href'),
          // Centre of the arrow's ink minus the centre of the cap's inside.
          dx: ink.left + ink.width / 2 - (c.left + l + (c.width - l - rt) / 2),
          dy: ink.top + ink.height / 2 - (c.top + t + (c.height - t - b) / 2),
          square: Math.abs(c.width - c.height),
          inside: ink.left >= c.left && ink.right <= c.right && ink.top >= c.top && ink.bottom <= c.bottom,
        };
      });
      expect(r.text, 'an icon, no text').toBe('');
      expect(r.href).toMatch(/arrow-left$/);
      expect(Math.abs(r.dx), JSON.stringify(r)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.dy), JSON.stringify(r)).toBeLessThanOrEqual(1);
      expect(r.square).toBeLessThanOrEqual(0.5);
      expect(r.inside).toBe(true);
    });
  }
});
