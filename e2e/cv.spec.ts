import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { appState, dispatch, openApp, screenOrder } from './support/app';
import { expect, test } from './support/test';

/**
 * /cv/ (the list view of the same content) on screen: readable in both themes, section links for a
 * page many screens long, and the list view as a two-way switch (L / Esc / the back links return to
 * the screen the visitor came from). Print and no-JS behaviour live in cv-print.spec and cv-nojs.spec.
 */

async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      // Storage blocked: the default theme applies.
    }
  }, theme);
}

/** WCAG contrast of each skill-level label against the page background. */
async function levelContrast(page: Page): Promise<{ text: string; ratio: number }[]> {
  return page.evaluate(() => {
    const rgb = (c: string) => {
      const v = (c.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return c.startsWith('color(srgb') ? v : v.map((x) => x / 255);
    };
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = lum(getComputedStyle(document.body).backgroundColor);
    const out: { text: string; ratio: number }[] = [];
    for (const el of document.querySelectorAll('main li[id] > p > span')) {
      if (!/\b(Expert|Proficient|Hands-on|Familiar)\b/.test(el.textContent ?? '')) continue;
      const fg = lum(getComputedStyle(el).color);
      out.push({ text: el.textContent ?? '', ratio: Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100 });
    }
    return out;
  });
}

const toc = (page: Page) => page.getByRole('navigation', { name: /on this page/i });
const backLink = (page: Page) => page.getByRole('link', { name: /^back to the app$/i });

test.describe('/cv/ on screen', { tag: '@a11y' }, () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} theme: no axe colour-contrast findings, every level label at least 4.5:1`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/cv/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const results = await new AxeBuilder({ page }).withRules(['color-contrast', 'link-in-text-block']).analyze();
      const found = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} — ${n.failureSummary}`));
      expect(found, found.slice(0, 5).join('\n')).toEqual([]);
      const labels = await levelContrast(page);
      expect(labels.length, 'the CV shows skill levels').toBeGreaterThan(0);
      const low = labels.filter((l) => l.ratio < 4.5);
      expect(low, JSON.stringify(low.slice(0, 5))).toEqual([]);
    });
  }

  test('headings are written in sentence case, on screen and in print', async ({ page }) => {
    await page.goto('/cv/');
    // innerText applies CSS text-transform: a heading styled into capitals would read as shouting.
    const shouted = async () =>
      page.locator('main h2').evaluateAll((hs) => hs.map((h) => (h as HTMLElement).innerText).filter((t) => /[a-z]/i.test(t) && t === t.toUpperCase() && t.length > 3));
    expect(await shouted()).toEqual([]);
    await page.emulateMedia({ media: 'print' });
    expect(await shouted()).toEqual([]);
  });

  test('the section nav reaches each section and is hidden in print', async ({ page }) => {
    await page.goto('/cv/');
    const links = toc(page).getByRole('link');
    expect(await links.count()).toBeGreaterThanOrEqual(3);
    for (const link of await links.all()) {
      const href = (await link.getAttribute('href'))!;
      expect(href).toMatch(/^#/);
      await page.evaluate(() => window.scrollTo(0, 0));
      await link.click();
      const heading = page.locator(`h2${href}`);
      await expect(heading).toHaveText((await link.textContent())!);
      await expect(heading).toBeInViewport();
    }
    // Hidden in print, so out of the accessibility tree: found through the element instead of its role.
    const handle = await toc(page).elementHandle();
    await page.emulateMedia({ media: 'print' });
    expect(await handle!.evaluate((n) => getComputedStyle(n).display)).toBe('none');
  });

  test('skill links: no underline until hover, and a target of at least 24 px', async ({ page }) => {
    await page.goto('/cv/');
    const chip = page.locator('main ol li > p > a[href^="#"]').first();
    const line = () => chip.evaluate((a) => getComputedStyle(a).textDecorationLine);
    expect(await line()).toBe('none');
    await chip.hover();
    expect(await line()).toBe('underline');
    const box = (await chip.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24); // WCAG 2.5.8 target size
  });
});

test.describe('/cv/ and back: the list view is a two-way switch', { tag: '@critical' }, () => {
  test('L and Esc return to the screen the visitor came from', async ({ page }) => {
    await openApp(page);
    // A screen other than the start screen, so "back" cannot be confused with the default.
    const screens = await screenOrder(page);
    const from = screens.filter((s) => s !== 'skills').at(-1)!;
    await dispatch(page, { t: 'tab/set', screen: from });
    await expect(page).toHaveURL(new RegExp(`#/${from}$`));
    const backOnScreen = async () => {
      await expect(page).toHaveURL(new RegExp(`\\?.*#/${from}$`));
      await page.waitForFunction(() => Boolean(window.__site));
      await expect.poll(async () => (await appState(page)).screen).toBe(from);
    };

    await page.keyboard.press('l');
    await page.waitForURL(/\/cv\/$/);
    await page.keyboard.press('Escape');
    await backOnScreen();

    // L again, a jump within the page, then L: still the screen before the CV, not the jump.
    await page.keyboard.press('l');
    await page.waitForURL(/\/cv\/$/);
    const link = toc(page).getByRole('link').nth(1);
    const href = (await link.getAttribute('href'))!;
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/cv/${href}$`));
    await page.keyboard.press('l');
    await backOnScreen();

    // The back link at the top does the same.
    await page.keyboard.press('l');
    await page.waitForURL(/\/cv\/$/);
    await page.getByRole('navigation', { name: /^app$/i }).getByRole('link', { name: /^back to the app$/i }).click();
    await backOnScreen();
  });

  test('opened directly, Esc and the back link lead to the app root', { tag: '@all-devices' }, async ({ page }) => {
    await page.goto('/cv/');
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => url.pathname === '/' && !url.hash);
    await page.goto('/cv/');
    await page.getByRole('contentinfo').getByRole('link', { name: /^back to the app$/i }).click();
    await page.waitForURL((url) => url.pathname === '/' && !url.hash);
    await expect(backLink(page)).toHaveCount(0);
  });
});
