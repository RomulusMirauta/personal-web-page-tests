import type { Page } from '@playwright/test';
import { appPath, appState } from './support/app';
import { expect, test } from './support/test';

/**
 * The login-style intro, played on a first visit: a square emblem; a hint line ("Hint: …", with an
 * icon) shows under the still empty password box (decoding or already whole), then the password dots type, then "Welcome"
 * decodes, then the overlay hands over to the app. Any key or a tap skips it. Screen readers get the
 * final texts. A recorder installed before the page's scripts samples the intro on every animation
 * frame, so the order is checked on the real clock; only the order is pinned, not the durations.
 */

interface Sample {
  t: number;
  phase: string;
  hint: string;
  welcome: string;
  dots: number;
  loginShown: boolean;
  hintWidth: number;
  welcomeWidth: number;
  /** The intro overlay is gone (the app took over). */
  gone: boolean;
  /** Every web font is in (a font swap may change the widths once). */
  fonts: boolean;
}

declare global {
  interface Window {
    __introLog?: Sample[];
  }
}

/** Samples the intro once per frame (only when something changed) into window.__introLog. */
function installRecorder(page: Page) {
  return page.addInitScript(() => {
    const log: Sample[] = [];
    window.__introLog = log;
    let last = '';
    let seen = false;
    const tick = () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-phase]');
      const shown = !!dialog && getComputedStyle(dialog).display !== 'none';
      const hintLine = document.querySelector<HTMLElement>('[data-intro-hint]');
      const welcomeLine = document.querySelector<HTMLElement>('[data-intro-welcome]');
      const s: Sample = {
        t: performance.now(),
        phase: dialog?.dataset.phase ?? '',
        hint: hintLine?.querySelector('[data-run]')?.textContent ?? '',
        welcome: welcomeLine?.querySelector('[data-run]')?.textContent ?? '',
        dots: dialog ? dialog.querySelectorAll('[data-on]').length : 0,
        loginShown: hintLine ? Number(getComputedStyle(hintLine.parentElement!).opacity) > 0 : false,
        hintWidth: hintLine ? Math.round(hintLine.getBoundingClientRect().width * 10) / 10 : 0,
        welcomeWidth: welcomeLine ? Math.round(welcomeLine.getBoundingClientRect().width * 10) / 10 : 0,
        gone: !shown,
        fonts: document.fonts.status === 'loaded',
      };
      const key = JSON.stringify({ ...s, t: 0 });
      if (key !== last) {
        last = key;
        log.push(s);
      }
      // Stops once the intro has come and gone (not before it mounted: hydration can be slow on CI).
      if (dialog) seen = true;
      if (!(seen && s.gone && !dialog)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** A line mid-decode: as long as its final text, but not it yet. */
const scrambled = (s: string, full: string) => s.length === full.length && s !== full;

/** The first sample matching `pred` (its time), or Infinity. */
const first = (log: Sample[], pred: (s: Sample) => boolean) => log.find(pred)?.t ?? Infinity;

/** Plays the intro to its end; returns the recorded samples. */
async function playThrough(page: Page): Promise<Sample[]> {
  await page.goto(appPath({ intro: null }));
  await expect(page.locator('html')).toHaveAttribute('data-intro', 'play');
  await page.waitForFunction(() => Boolean(window.__site));
  await expect.poll(async () => (await appState(page)).intro, { timeout: 20_000 }).toBe(false);
  return page.evaluate(() => window.__introLog!);
}

/** The final texts of the two lines: the last ones they showed. */
function finals(log: Sample[]): { hint: string; welcome: string } {
  return { hint: log.findLast((s) => s.hint)?.hint ?? '', welcome: log.findLast((s) => s.welcome)?.welcome ?? '' };
}

/** The order of the beats: hint decodes (box empty), then the dots one by one, then Welcome, then the exit. */
function checkOrder(log: Sample[]): void {
  const { welcome } = finals(log);
  expect(welcome, 'the welcome line').toMatch(/\S/);
  // The hint shows over the still empty box (decoding or already whole: the order is what counts).
  const hintShown = first(log, (s) => s.loginShown);
  const firstDot = first(log, (s) => s.dots > 0);
  const maxDots = Math.max(...log.map((s) => s.dots));
  const lastDot = first(log, (s) => s.dots === maxDots);
  const welcomeStart = first(log, (s) => s.phase === 'welcome');
  const welcomeDecoding = log.filter((s) => s.phase === 'welcome' && scrambled(s.welcome, welcome));
  const welcomeDone = first(log, (s) => s.phase === 'welcome' && s.welcome === welcome);
  const exit = first(log, (s) => s.phase === 'exit');
  expect(maxDots, 'the password dots type').toBeGreaterThan(2);
  expect(hintShown, 'the hint shows over the empty box before the first dot').toBeLessThan(firstDot);
  expect(lastDot, 'every dot is in before Welcome').toBeLessThan(welcomeStart);
  expect(welcomeDecoding.length, 'Welcome decodes').toBeGreaterThan(0);
  for (const s of welcomeDecoding) expect(s.dots).toBe(maxDots);
  expect(welcomeDone, 'Welcome is whole before the exit').toBeLessThan(exit);
  expect(exit).toBeLessThan(Infinity);
  // The dots type one after another (several samples in between), not all at once.
  expect(new Set(log.filter((s) => s.t >= firstDot && s.t <= lastDot).map((s) => s.dots)).size).toBeGreaterThan(2);
  // Each decoding line keeps its final width: nothing shifts while the glyphs resolve.
  const hintWidths = new Set(log.filter((s) => s.fonts && s.loginShown).map((s) => s.hintWidth));
  expect([...hintWidths], 'the hint line keeps one width').toHaveLength(1);
  const welcomeWidths = new Set(log.filter((s) => s.fonts && s.phase === 'welcome').map((s) => s.welcomeWidth));
  expect([...welcomeWidths], 'Welcome keeps one width').toHaveLength(1);
}

/** The emblem is the player card's square: no rounding, square, a conic ring of four colours, initials. */
async function checkEmblem(page: Page): Promise<{ w: number; h: number }> {
  const emblem = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-intro-emblem]')!;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      ring: el.style.getPropertyValue('--card-ring'),
      background: cs.backgroundImage,
      radius: cs.borderTopLeftRadius,
      w: r.width,
      h: r.height,
      initials: (el.textContent ?? '').trim(),
    };
  });
  expect(emblem.initials, 'initials').toMatch(/^\p{Lu}{2}$/u);
  expect(emblem.radius, 'square corners').toBe('0px');
  expect(emblem.w, 'a square').toBeCloseTo(emblem.h, 0);
  expect(emblem.background).toMatch(/^conic-gradient/);
  const colours = emblem.ring.match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi) ?? [];
  expect(new Set(colours).size, `the ring's colours: ${emblem.ring}`).toBe(4);
  return emblem;
}

test.describe('login intro', () => {
  test('the hint shows under the empty box, then the dots type, then Welcome, then the app', { tag: '@critical' }, async ({ page }) => {
    await installRecorder(page);
    checkOrder(await playThrough(page));
  });

  test('a square emblem; the hint line sits centred right under the box, its final text for screen readers', { tag: '@a11y' }, async ({ page }) => {
    await page.goto(appPath({ intro: null }));
    await page.waitForFunction(() => Boolean(window.__site));
    await checkEmblem(page);
    const hint = page.locator('[data-intro-hint]');
    await expect(hint).toBeVisible();
    await expect(hint.locator('svg use'), 'an icon before the hint').toHaveCount(1);
    const style = await hint.evaluate((el) => {
      // The "Hint:" label: inside the decoding run, or the first span of a still line.
      const label = (el.querySelector('[data-run]')?.firstElementChild ?? el.querySelector('span > span'))!;
      const box = el.previousElementSibling!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const welcome = el.nextElementSibling!.getBoundingClientRect();
      return {
        italic: getComputedStyle(el).fontStyle,
        label: getComputedStyle(label).textTransform,
        gapAbove: r.top - box.bottom,
        welcomeBelow: welcome.top - r.bottom,
        centred: Math.abs(r.left + r.width / 2 - (box.left + box.width / 2)),
      };
    });
    expect(style.italic).toBe('normal');
    expect(style.label, 'the "Hint:" label in capitals by CSS').toBe('uppercase');
    expect(style.gapAbove, 'right under the box').toBeGreaterThan(4);
    expect(style.gapAbove).toBeLessThan(20);
    expect(style.welcomeBelow, 'Welcome right under the hint').toBeLessThan(30);
    expect(style.centred, 'centred under the box').toBeLessThan(2);
    // Screen readers get the final text, whatever the decoding shows at the moment.
    await expect(page.getByRole('dialog')).toContainText(/hint\b.*\S/i);
    await expect(page.getByRole('dialog')).toHaveAccessibleName(/\bapp\b/i);
  });

  test('any key skips it while the hint shows over the empty box: no dot ever types', async ({ page }) => {
    await installRecorder(page);
    await page.goto(appPath({ intro: null }));
    await page.waitForFunction(() => Boolean(window.__site));
    // The login (with its hint) has appeared and no password dot has typed yet.
    await page.waitForFunction(
      () => {
        const line = document.querySelector<HTMLElement>('[data-intro-hint]');
        const dialog = document.querySelector('[role="dialog"][data-phase]');
        return !!line && Number(getComputedStyle(line.parentElement!).opacity) > 0 && !!dialog && dialog.querySelectorAll('[data-on]').length === 0;
      },
      undefined,
      { polling: 'raf' },
    );
    await page.keyboard.press('x');
    await expect.poll(async () => (await appState(page)).intro).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-intro', 'skip');
    const log = await page.evaluate(() => window.__introLog!);
    expect(log.some((s) => s.dots > 0)).toBe(false);
  });

  test('phone: the same order, a square emblem, the hint on one line inside the screen, a tap skips', { tag: '@mobile' }, async ({ page }) => {
    await installRecorder(page);
    checkOrder(await playThrough(page));

    await page.evaluate(() => sessionStorage.clear());
    await page.goto(appPath({ intro: null }));
    await page.waitForFunction(() => Boolean(window.__site));
    await checkEmblem(page);
    const width = page.viewportSize()!.width;
    const hint = await page.locator('[data-intro-hint]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, h: r.height, fs: parseFloat(getComputedStyle(el).fontSize) };
    });
    expect(hint.left).toBeGreaterThanOrEqual(8);
    expect(hint.right).toBeLessThanOrEqual(width - 8);
    expect(hint.h, 'one line').toBeLessThan(hint.fs * 2);
    // A tap skips it (on click, so nothing clicks through to the app behind it).
    await page.locator('[role="dialog"]').tap();
    await expect.poll(async () => (await appState(page)).intro).toBe(false);
  });
});
