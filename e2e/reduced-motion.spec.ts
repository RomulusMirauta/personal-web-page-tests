import type { Page } from '@playwright/test';
import { appPath, appState, categoryIds, expectMode, sel } from './support/app';
import { decode, diff } from './support/png';
import { expect, test } from './support/test';

/**
 * prefers-reduced-motion: no intro, transitions collapse into short fades, no live 3D background
 * (the static poster only), and a settled page that does not move at all.
 */

/**
 * The longest a transition may take under reduced motion: a quick fade, nothing that travels. A
 * generic bound for "short", not the app's own timing.
 */
const SHORT_FADE_MS = 250;
/** The two captures of the still check are this far apart: anything moving changes pixels within it. */
const STILL_WINDOW_MS = 500;
/** Largest per-channel difference that still counts as the same pixel (rasteriser noise, not motion). */
const STILL_TOLERANCE = 12;

/** Test hooks beyond the shared types: the city's diagnostics and the UI's idle signal. */
type Hooks = {
  __city: { ready: Promise<void>; renderer: string; info(): { state: string; path: string | null; running: boolean } };
  __site: { settle(): Promise<void> };
};

const cityInfo = (page: Page) =>
  page.evaluate(() => {
    const city = (window as unknown as Hooks).__city;
    const i = city.info();
    return { renderer: city.renderer, state: i.state, path: i.path, running: i.running };
  });

/**
 * The page at rest, by its own signals instead of a fixed delay: the background ready (painted), the
 * UI idle, two painted frames, and no CSS animation running.
 */
async function atRest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Hooks;
    await w.__city.ready;
    await w.__site.settle();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), {
      message: 'no CSS animation or transition still running',
      intervals: [25],
    })
    .toBe(0);
}

async function boot(page: Page, flags: Record<string, string | null> = {}): Promise<void> {
  await page.goto(appPath(flags));
  await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
  await page.evaluate(() => window.__site!.ready);
}

test.describe('reduced motion', { tag: '@a11y' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('skips the intro and marks the document', async ({ page }) => {
    await boot(page, { intro: null });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await expect(page.locator('html')).toHaveAttribute('data-intro', 'skip');
    expect((await appState(page)).intro).toBe(false);
  });

  test('opens the detail view within one short fade', async ({ page }) => {
    await boot(page);
    const [first] = await categoryIds(page);
    // The manual clock reports how long the transition took to finish.
    const ms = await page.evaluate(async (cat) => {
      window.__wheel!.manual(true);
      window.__wheel!.settle();
      window.__site!.dispatch({ t: 'cat/open', cat });
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return window.__wheel!.settle().ms;
    }, first);
    expect(ms).toBeLessThanOrEqual(SHORT_FADE_MS);
    await expectMode(page, 'detail', first);
  });

  test('runs no long or endless CSS animation', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('1');
    await expectMode(page, 'detail');
    const long = await page.evaluate(
      (max) =>
        document
          .getAnimations()
          .map((a) => {
            const t = a.effect?.getComputedTiming();
            const name = 'animationName' in a ? (a as CSSAnimation).animationName : 'transitionProperty' in a ? (a as CSSTransition).transitionProperty : 'web-animation';
            return { name, duration: Number(t?.duration ?? 0), iterations: Number(t?.iterations ?? 1) };
          })
          .filter((a) => a.duration > max || !Number.isFinite(a.iterations)),
      SHORT_FADE_MS,
    );
    expect(long, JSON.stringify(long)).toEqual([]);
  });

  test('never starts the 3D background: no worker, no canvas, poster only', async ({ page }) => {
    const workers: string[] = [];
    page.on('worker', (w) => workers.push(w.url()));
    // The page clock (time flows as usual until the jump below), so the test can pass any deferred
    // load of the scene instead of waiting it out.
    await page.clock.install();
    await page.goto(appPath({ city: null }));
    await page.waitForFunction(() => Boolean(window.__site && window.__city));
    await page.evaluate(() => window.__city!.ready);
    // Far past any point the live scene would load, even with the UI never going idle; then two
    // frames, since a load starts its worker and inserts its canvas synchronously.
    await page.clock.fastForward(120_000);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    expect(workers).toEqual([]);
    expect(await page.locator(`${sel.city} canvas`).count()).toBe(0);
    // The poster, with no scene path: the load was skipped, not merely not started yet.
    expect(await cityInfo(page)).toEqual({ renderer: 'poster', state: 'poster', path: null, running: false });
  });

  test('keeps the page, background included, still once settled', async ({ page }) => {
    // Requests in flight: a late icon sprite or image would change pixels without anything moving.
    let inFlight = 0;
    page.on('request', () => inFlight++);
    page.on('requestfinished', () => inFlight--);
    page.on('requestfailed', () => inFlight--);
    await page.goto(appPath({ city: null }));
    await page.waitForFunction(() => Boolean(window.__site && window.__wheel && window.__city));
    await page.evaluate(() => window.__site!.ready);
    await atRest(page);
    await expect.poll(() => inFlight, { message: 'no request still in flight', intervals: [25] }).toBe(0);
    expect(await cityInfo(page), 'reduced motion keeps the poster').toMatchObject({ renderer: 'poster', running: false });
    const a = decode(await page.screenshot());
    await page.waitForTimeout(STILL_WINDOW_MS); // the observation window itself, not a wait for a condition
    const b = decode(await page.screenshot());
    expect(diff(a, b, STILL_TOLERANCE), `pixels changed by more than ${STILL_TOLERANCE}/255`).toBe(0);
  });
});
