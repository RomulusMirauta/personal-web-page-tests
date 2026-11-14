import type { Page } from '@playwright/test';
import { appPath, dispatch, openApp, screenOrder, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * What the browser draws and how much the page moves follow the app live: the colour scheme and
 * the browser chrome colour follow the theme (T), an OS "reduce motion" switch applies at once, and
 * a skip before the scripts have loaded says the app is loading.
 */

/** Colour schemes in use and the theme metas. Browsers take the first theme-color in tree order. */
async function scheme(page: Page) {
  return page.evaluate(() => {
    const cs = (el: Element) => getComputedStyle(el).colorScheme;
    const regions = [...document.querySelectorAll('[data-scroll]')];
    const themeColors = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    return {
      theme: document.documentElement.dataset.theme,
      html: cs(document.documentElement),
      body: cs(document.body),
      regions: regions.length ? [...new Set(regions.map(cs))] : 'none',
      themeColor: themeColors[0]?.content ?? null,
      themeColorMetas: themeColors.length,
      colorSchemeMeta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content ?? null,
    };
  });
}

/** Relative luminance of a #rrggbb colour (0 black … 1 white). */
function luminance(hex: string): number {
  const [r, g, b] = (hex.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i) ?? []).slice(1).map((h) => parseInt(h, 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test('color-scheme and the browser chrome colour follow T', { tag: '@a11y' }, async ({ page }) => {
  await openApp(page);
  // A screen with scroll regions (they inherit the scheme from <body>).
  const screens = await screenOrder(page);
  test.skip(!screens.includes('experience'), 'no Experience screen');
  await dispatch(page, { t: 'tab/set', screen: 'experience' });
  const dark = await scheme(page);
  expect(dark).toMatchObject({ theme: 'dark', html: 'dark', body: 'dark', regions: ['dark'] });
  // The live theme-color and at most one static fallback after it; the page supports both schemes.
  expect(dark.themeColorMetas).toBeGreaterThanOrEqual(1);
  expect(dark.themeColorMetas).toBeLessThanOrEqual(2);
  expect(dark.colorSchemeMeta).toMatch(/dark/);
  expect(dark.colorSchemeMeta).toMatch(/light/);

  await page.keyboard.press('t');
  await expect.poll(() => scheme(page)).toMatchObject({ theme: 'light', html: 'light', body: 'light', regions: ['light'] });
  const light = await scheme(page);
  expect(light.themeColor).not.toBe(dark.themeColor);
  expect(luminance(light.themeColor!), `light ${light.themeColor} is lighter than dark ${dark.themeColor}`).toBeGreaterThan(luminance(dark.themeColor!));

  await page.keyboard.press('t');
  await expect.poll(() => scheme(page)).toMatchObject({ theme: 'dark', html: 'dark', body: 'dark', regions: ['dark'], themeColor: dark.themeColor });
});

test('the light theme-color is in place before <body> is parsed (no dark flash), and stays', async ({ page }) => {
  // Every change of the effective theme-color, and whether <body> existed yet when it was seen.
  await page.addInitScript(() => {
    const seen: { color: string | null; body: boolean }[] = [];
    (window as unknown as { __themeColors: typeof seen }).__themeColors = seen;
    new MutationObserver(() => {
      const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null;
      if (seen.at(-1)?.color !== color) seen.push({ color, body: !!document.body });
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });
  });
  await openApp(page, { theme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', '1');
  const seen = await page.evaluate(() => (window as unknown as { __themeColors: { color: string | null; body: boolean }[] }).__themeColors);
  const final = (await scheme(page)).themeColor;
  // At most the static value while the parser is still in <head>, then the light one for good.
  expect(seen.at(-1)).toEqual({ color: final, body: false });
  expect(seen.filter((s) => s.body)).toEqual([]);
  expect(luminance(final!), `light theme-color ${final}`).toBeGreaterThan(0.5);
  expect((await scheme(page)).body).toBe('light');
});

test('an OS reduced-motion switch applies live, without a reload', { tag: '@a11y' }, async ({ page }) => {
  await openApp(page);
  const html = page.locator('html');
  /** The entrance animation of the screen just shown: its name and duration in ms. */
  const screenAnimation = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('main')!);
      return { name: cs.animationName, ms: parseFloat(cs.animationDuration) * (cs.animationDuration.endsWith('ms') ? 1 : 1000) };
    });
  const show = async (screen: string) => {
    await dispatch(page, { t: 'tab/set', screen });
  };
  const screens = (await screenOrder(page)).filter((s) => s !== 'skills');
  const [a, b] = screens;
  await expect(html).toHaveAttribute('data-motion', 'full');
  await show(a);
  await expect.poll(async () => (await screenAnimation()).name).not.toBe('none');
  const full = await screenAnimation();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(html).toHaveAttribute('data-motion', 'reduce');
  await show(b);
  await expect.poll(async () => (await screenAnimation()).name).not.toBe(full.name);
  const reduced = await screenAnimation();
  expect(reduced.ms, 'the reduced entrance is no longer than the full one').toBeLessThanOrEqual(full.ms);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(html).toHaveAttribute('data-motion', 'full');
  await show(a);
  await expect.poll(screenAnimation).toEqual(full);
});

test('a skip before the scripts load shows a loading line until the app is ready', async ({ page }) => {
  // A slow network: the script chunks wait until released, so the page stays prerendered HTML.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_next/static/chunks/**', async (route) => {
    await held;
    await route.continue();
  });
  const loading = page.getByText(/^Loading/);
  try {
    await page.goto(appPath({ intro: null }), { waitUntil: 'commit' });
    const html = page.locator('html');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(loading).toBeHidden();

    await page.keyboard.press('x');
    await expect(html).toHaveAttribute('data-intro', 'skip');
    await expect(page.getByRole('dialog')).toBeHidden();
    // Not a bare background: the line shows (after its short fade-in) while the bundle still downloads.
    await expect(loading).toBeVisible();
    await expect.poll(() => loading.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await html.getAttribute('data-hydrated')).toBeNull();
  } finally {
    release();
  }
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', '1');
  await expect(loading).toBeHidden();
  await expect(ui.sections(page)).toBeVisible();
});
