import type { Browser } from '@playwright/test';
import { openApp } from './support/app';
import { PHONE_RE } from './support/privacy';
import { expect, newContext, test } from './support/test';

/**
 * /cv/ is server-rendered: without JavaScript it still carries the whole content, so recruiters'
 * tools, search engines and readers with scripts off get the same CV.
 */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The title of every skill node of both wheels, read from the running app (scripts on): each node is
 * selected in turn and the detail panel's heading names it.
 */
async function nodeTitles(browser: Browser): Promise<string[]> {
  // Scripts on here: a context opened in a test inherits the describe block's options.
  const context = await newContext(browser, { javaScriptEnabled: true });
  try {
    const page = await context.newPage();
    await openApp(page);
    return await page.evaluate(async () => {
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const site = window.__site!;
      window.__wheel!.manual(true);
      const titles: string[] = [];
      for (const wheel of ['hard', 'soft'] as const) {
        site.dispatch({ t: 'wheel/set', wheel });
        await frame();
        for (const cat of site.getState().nav[wheel]) {
          site.dispatch({ t: 'cat/open', cat: cat.id });
          await frame();
          window.__wheel!.settle();
          for (const node of cat.nodes) {
            site.dispatch({ t: 'node/focus', node: node.id });
            await frame();
            window.__wheel!.settle();
            const title = document.querySelector('[data-detail-panel] h3')?.textContent?.trim();
            if (title) titles.push(title);
          }
          site.dispatch({ t: 'back' });
          await frame();
          window.__wheel!.settle();
        }
      }
      return [...new Set(titles)];
    });
  } finally {
    await context.close();
  }
}

test.describe('/cv/ without JavaScript', { tag: '@all-devices' }, () => {
  test.use({ javaScriptEnabled: false });

  test('lists every skill node of both wheels', async ({ page, browser }) => {
    const titles = await nodeTitles(browser);
    expect(titles.length, 'the wheels have skill nodes').toBeGreaterThan(0);
    const response = await page.goto('/cv/');
    expect(response?.status()).toBe(200);
    const text = norm((await page.locator('body').textContent()) ?? '');
    const missing = titles.filter((t) => !text.includes(norm(t)));
    expect(missing, `missing on /cv/: ${missing.join(', ')}`).toEqual([]);
  });

  test('carries a non-empty tech stack section', async ({ page }) => {
    await page.goto('/cv/');
    const stack = page.locator('section[aria-labelledby="cv-stack"]');
    await expect(stack).toHaveCount(1);
    expect(norm((await stack.textContent()) ?? '').length).toBeGreaterThan(20);
  });

  test('never shows a phone number', async ({ page }) => {
    await page.goto('/cv/');
    const html = await page.content();
    const text = (await page.locator('body').textContent()) ?? '';
    expect(PHONE_RE.test(html), 'a phone-like number in the HTML').toBe(false);
    expect(PHONE_RE.test(text), 'a phone-like number in the text').toBe(false);
  });

  test('is reachable from the main page without scripts', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/');
    const link = page.locator('a[href*="cv/"]').first();
    await expect(link).toBeAttached();
    const href = (await link.getAttribute('href'))!;
    const response = await page.goto(new URL(href, page.url()).href);
    expect(response?.status()).toBe(200);
    await expect(page.locator('main h2').first()).toBeVisible();
  });
});
