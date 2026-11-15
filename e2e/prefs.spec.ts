import type { Page } from '@playwright/test';
import { afterIdle, appPath, openApp, trackErrors } from './support/app';
import { expect, test } from './support/test';

/**
 * Stored preferences and URL flags. A small inline script in <head> puts the visitor's stored choices
 * on <html data-*> before the app's JavaScript runs, so the first paint already has the right theme
 * and settings; URL flags override them for that visit only. The intro (and its early skip) belongs
 * to the app page only.
 */

/** No ?sound= flag (the shared test flags pin sound off), so the stored choice applies. */
const STORED_SOUND = { sound: null } as const;

const CHUNKS = '**/_next/static/chunks/**';

/**
 * <html data-*> as the inline script left it: the app's script chunks are blocked, so nothing
 * hydrates (no data-hydrated, no app state written back to <html>).
 */
async function prepaint(page: Page, url: string): Promise<Record<string, string | undefined>> {
  await page.route(CHUNKS, (route) => route.abort());
  try {
    await page.goto(url);
    return await page.evaluate(() => ({ ...document.documentElement.dataset }));
  } finally {
    await page.unroute(CHUNKS);
  }
}

/** aria-pressed of a Display options row. */
async function pressed(page: Page, name: string | RegExp): Promise<string | null> {
  return page.getByRole('button', { name, exact: typeof name === 'string' }).getAttribute('aria-pressed');
}

test('T, V, A, P and K are saved and restored before hydration; the menu shows them after', { tag: '@critical' }, async ({ page }) => {
  await openApp(page, STORED_SOUND);
  for (const key of ['t', 'v', 'a', 'p', 'k']) await page.keyboard.press(key);
  await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
  expect(await page.evaluate(() => ({ ...localStorage }))).toMatchObject({ theme: 'light', sound: '1', antialias: '1', cityPaused: '1', shortcuts: 'off' });

  const before = await prepaint(page, appPath(STORED_SOUND));
  expect(before).toMatchObject({ theme: 'light', sound: 'on', antialias: 'on', cityPaused: '1', shortcuts: 'off', cityView: 'on', test: '1', intro: 'skip' });
  expect(before.hydrated).toBeUndefined();

  await openApp(page, STORED_SOUND);
  const state = await page.evaluate(() => {
    const s = window.__site!.getState() as unknown as Record<string, unknown>;
    return { theme: s.theme, sound: s.sound, antialias: s.antialias, cityPaused: s.cityPaused, cityShown: s.cityShown };
  });
  expect(state).toEqual({ theme: 'light', sound: true, antialias: true, cityPaused: true, cityShown: true });
  await page.getByRole('button', { name: 'Display options' }).click();
  expect(await pressed(page, 'Light theme')).toBe('true');
  expect(await pressed(page, 'Smooth edges')).toBe('true');
  expect(await pressed(page, 'Sound')).toBe('true');
  expect(await pressed(page, 'City')).toBe('true');
  expect(await pressed(page, 'Pause city animation')).toBe('true');
  expect(await pressed(page, /^Keys/)).toBe('false');

  // A URL override wins over the stored choice and is not saved.
  const overridden = await prepaint(page, appPath({ sound: '0', theme: 'dark', aa: '0' }));
  expect(overridden).toMatchObject({ theme: 'dark', sound: 'off', antialias: 'off', cityPaused: '1', shortcuts: 'off' });
  expect(await page.evaluate(() => ({ ...localStorage }))).toMatchObject({ theme: 'light', sound: '1', antialias: '1' });
});

test('smooth edges are on by default for visitors and off by default under ?test=1; a stored choice wins either way', async ({ page }) => {
  // A visitor (no ?test=1, nothing stored): on before paint, and still on after hydration.
  expect((await prepaint(page, '/?intro=0&city=poster')).antialias).toBe('on');
  await page.goto('/?intro=0&city=poster&cursor=0');
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === '1');
  await expect(page.locator('html')).toHaveAttribute('data-antialias', 'on');
  await page.getByRole('button', { name: 'Display options' }).click();
  expect(await pressed(page, 'Smooth edges')).toBe('true');
  expect(await page.evaluate(() => localStorage.getItem('antialias')), 'the default is not stored').toBeNull();

  // Test mode: off unless ?aa=1 (stable screenshots).
  expect((await prepaint(page, appPath())).antialias).toBe('off');
  expect((await prepaint(page, appPath({ aa: '1' }))).antialias).toBe('on');
  await openApp(page);
  expect(await page.evaluate(() => window.__site!.getState().antialias)).toBe(false);

  // A stored off wins over the visitor default; a stored on over the test-mode default.
  await page.evaluate(() => localStorage.setItem('antialias', '0'));
  expect((await prepaint(page, '/?intro=0&city=poster')).antialias).toBe('off');
  await page.evaluate(() => localStorage.setItem('antialias', '1'));
  expect((await prepaint(page, appPath())).antialias).toBe('on');
});

test('/cv/ does not arm the intro skip; the app page still plays the intro on a first visit', async ({ page }) => {
  await page.goto('/cv/');
  await expect(page.locator('html')).toHaveAttribute('data-intro', 'skip');
  await page.mouse.click(5, 5);
  for (const key of ['PageDown', 'ArrowDown', 'Enter']) await page.keyboard.press(key);
  expect(await page.evaluate(() => sessionStorage.getItem('intro-seen'))).toBeNull();

  // Same session: the app page plays the intro, before and after hydration.
  expect((await prepaint(page, appPath({ intro: null }))).intro).toBe('play');
  await openApp(page, { intro: null });
  await expect(page.locator('html')).toHaveAttribute('data-intro', 'play');
  expect(await page.evaluate(() => window.__site!.getState().intro)).toBe(true);

  // Skipping it marks the session: the next visit starts without it.
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-intro', 'skip');
  expect(await page.evaluate(() => sessionStorage.getItem('intro-seen'))).toBe('1');
  expect((await prepaint(page, appPath({ intro: null }))).intro).toBe('skip');
});

test('near-miss flags are no flags; ?debugScale needs ?test=1 and is clamped', async ({ page }) => {
  const near = await prepaint(page, '/?theme=lightx&sound=10&test=10&intro=00&aa=10&city=offx');
  // Not test mode (test=10 is no flag): smooth edges take the visitor default, on.
  expect(near).toMatchObject({ theme: 'dark', sound: 'off', test: '0', intro: 'play', antialias: 'on', cityView: 'on' });

  const radius = async (debugScale: string | null) => {
    await openApp(page, { debugScale });
    return page.evaluate(() => window.__wheel!.geometry().rInner);
  };
  // The wheel scales with the flag, which is clamped to half and double size; 0 means no scaling.
  const r = await radius(null);
  for (const [raw, k] of [['0', 1], ['-1', 0.5], ['50', 2], ['1.2', 1.2]] as const) {
    expect(await radius(raw), `?debugScale=${raw}`).toBeCloseTo(r * k, 3);
  }

  // A visitor's URL (no ?test=1) never distorts the wheel, and nothing errors.
  const errors = trackErrors(page);
  await page.goto('/?intro=0&city=poster&cursor=0&debugScale=0'); // resolves on the load event: every resource is in
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === '1');
  await afterIdle(page); // the UI that mounts once the browser is idle is up as well
  await expect(page.locator('svg[data-active]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
