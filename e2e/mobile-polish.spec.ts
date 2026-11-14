import type { Browser, BrowserContext, Page } from '@playwright/test';
import { categoryIds, dispatch, openApp, sel, settle } from './support/app';
import { expect, newContext, test } from './support/test';
import type { Action } from './support/types';

/**
 * What a phone shows besides the wheel: the footer's hint strip (touch keeps only what a tap can
 * use, never an empty list), the detail panel above it, the screens' tiles and cards, the Profile's
 * centre text inside its ring, and the strip and the call-to-action box never painted over one
 * another while they swap places.
 */

const STRIP = `${sel.hud} ul[aria-label="Controls"]`;

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Other phone sizes: a small Android phone, an iPhone SE, a phone held sideways, a tablet. */
const OTHER_TOUCH = [
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 776, height: 411 },
  { width: 768, height: 1024 },
];

async function touchContext(browser: Browser, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const use = test.info().project.use;
  return newContext(browser, { viewport, deviceScaleFactor: use.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: use.userAgent });
}

/** Every finite CSS animation and transition jumps to its end (the view at rest). */
async function finishCss(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let round = 0; round < 3; round++) {
      const live = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
      if (live.length === 0) break;
      for (const a of live) a.finish();
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
  });
}

/** Dispatch, let the engine settle and every CSS fade end. */
async function go(page: Page, ...actions: Action[]): Promise<void> {
  await dispatch(page, ...actions);
  await settle(page);
  await finishCss(page);
}

/** Every Controls list that draws a box, with its visible items. */
async function drawnStrips(page: Page): Promise<{ rect: Rect; items: string[] }[]> {
  return page.evaluate((selector) => {
    const drawn = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return [...document.querySelectorAll(selector)].filter(drawn).map((ul) => ({
      rect: ul.getBoundingClientRect().toJSON() as Rect,
      items: [...ul.querySelectorAll(':scope > li:not([data-folded])')].filter(drawn).map((li) => (li.textContent ?? '').trim()),
    }));
  }, STRIP);
}

/** Lines of an aria snapshot naming a list that has no items under it. */
function emptyLists(snapshot: string): string[] {
  const lines = snapshot.split('\n');
  return lines.filter((line, i) => {
    const m = /^(\s*)- list\b/.exec(line);
    if (!m) return false;
    const next = lines[i + 1] ?? '';
    return !line.trimEnd().endsWith(':') || !next.startsWith(`${m[1]}  `);
  });
}

const rectOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().toJSON() as Rect);

/**
 * The Profile's centre block (runs in the page): how far its shown text and icons stay inside the
 * ring's central disc (CSS px, positive = inside), the text it shows, its smallest shown line (CSS
 * px), the fit it chose and each line's box width (a line the fit leaves out is clipped to a 1 px
 * box, still read by screen readers).
 */
function centreBlock() {
  const region = document.querySelector('section[aria-label="Profile"]')!;
  const chart = region.querySelector('svg[viewBox]')!;
  const disc = chart.querySelector('circle')!.getBoundingClientRect();
  const block = chart.nextElementSibling!.firstElementChild as HTMLElement;
  const cx = disc.left + disc.width / 2;
  const cy = disc.top + disc.height / 2;
  const radius = disc.width / 2;
  const shown = (el: Element | null) => {
    for (let n = el; n && n !== block.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.clip.startsWith('rect')) return false;
    }
    return true;
  };
  let reach = 0;
  const text: string[] = [];
  const corners = (b: DOMRect) => {
    if (b.width === 0) return;
    for (const x of [b.left, b.right]) for (const y of [b.top, b.bottom]) reach = Math.max(reach, Math.hypot(x - cx, y - cy));
  };
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent!.trim() || !shown(n.parentElement)) continue;
    text.push(n.textContent!.trim());
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const b of range.getClientRects()) corners(b);
  }
  for (const icon of block.querySelectorAll('svg')) if (shown(icon)) corners(icon.getBoundingClientRect());
  const k = (el: HTMLElement) => ((s) => (s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : 1))(el.closest<HTMLElement>('[data-stage]'));
  const lines = [...block.children].filter((p) => shown(p) && p.getBoundingClientRect().width > 1) as HTMLElement[];
  return {
    clear: radius - reach,
    fit: block.dataset.fit ?? null,
    text: text.join(' '),
    lines: lines.length,
    smallest: Math.min(...lines.map((p) => parseFloat(getComputedStyle(p).fontSize) * k(p))),
    widths: [...block.children].map((p) => p.getBoundingClientRect().width),
  };
}

/** The name the player card shows (read from the page: no hard-coded personal content). */
const cardName = (page: Page) => page.locator('[data-card-panel] > :first-child').evaluate((el) => (el.textContent ?? '').trim());

/** The Profile centre's checks on a phone: inside its disc, the name shown. */
async function expectCentreFits(page: Page, at: string): Promise<void> {
  await go(page, { t: 'tab/set', screen: 'profile' });
  const centre = await page.evaluate(centreBlock);
  const what = `${at}, fit ${centre.fit}: "${centre.text}"`;
  expect(centre.clear, `centre text inside the ring's disc, ${what}`).toBeGreaterThanOrEqual(0);
  expect(centre.lines, what).toBeGreaterThanOrEqual(2);
  expect(centre.text, what).toContain(await cardName(page));
}

/** The Experience band under the player card never lies under the unfolded card. */
async function expectCardClearOfExperience(page: Page, at: string): Promise<void> {
  await go(page, { t: 'tab/set', screen: 'experience' });
  const exp = await page.evaluate(() => {
    const panel = document.querySelector('[data-card-panel]') as HTMLElement;
    const card = panel.closest('button')!;
    const band = document.querySelector('section[aria-label="Experience"] h3')!;
    const title = band.firstElementChild as HTMLElement | null;
    const rect = (el: Element) => el.getBoundingClientRect().toJSON() as Rect;
    return {
      square: rect(card.firstElementChild!),
      panel: rect(panel),
      band: rect(band),
      titleCut: title ? title.scrollWidth > title.clientWidth : false,
      lines: [...panel.children]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth })),
    };
  });
  expect(overlap(exp.panel, exp.band), `${at}: card panel over the Experience band (px²)`).toBe(0);
  expect(overlap(exp.square, exp.band), `${at}: card square over the Experience band (px²)`).toBe(0);
  for (const l of exp.lines) expect(l.cut, `${at}: card line "${l.text}" is cut`).toBe(false);
  expect(exp.titleCut, `${at}: band title cut`).toBe(false);
}

test.describe('touch polish', { tag: '@mobile' }, () => {
  test('no empty Controls list on touch: the hub has no strip, other views keep their tap targets', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
    for (const wheel of ['hard', 'soft'] as const) {
      await go(page, { t: 'wheel/set', wheel });
      // Every hint of the hub is a keyboard or mouse hint here: no strip at all, and no list
      // without items for a screen reader.
      expect(await drawnStrips(page), `${wheel} hub`).toEqual([]);
      const aria = await page.locator(sel.hud).first().ariaSnapshot();
      expect(emptyLists(aria), `${wheel} hub: lists without items\n${aria}`).toEqual([]);
    }
    // Where a hint can be tapped the strip stays: Back in the detail view, Close on a screen.
    await go(page, { t: 'wheel/set', wheel: 'hard' }, { t: 'cat/open', cat: (await categoryIds(page))[0] });
    expect((await drawnStrips(page)).map((s) => s.items)).toEqual([['Back']]);
    await go(page, { t: 'back' }, { t: 'tab/set', screen: 'experience' });
    expect((await drawnStrips(page)).map((s) => s.items)).toEqual([['Close']]);
    expect(emptyLists(await page.locator(sel.hud).first().ariaSnapshot())).toEqual([]);
  });

  test('the detail panel ends above the hint strip; Back restores the hub footer', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const vp = page.viewportSize()!;
    const cta = await rectOf(page, '[data-cta]');
    await go(page, { t: 'cat/open', cat: (await categoryIds(page))[0] });
    const strip = await rectOf(page, STRIP);
    const column = await page
      .locator(`${sel.panel} [data-scroll]`)
      .first()
      .evaluate((el) => el.parentElement!.getBoundingClientRect().toJSON() as Rect);
    expect(strip.bottom, 'the strip on screen').toBeLessThanOrEqual(vp.height);
    expect(strip.top).toBeGreaterThanOrEqual(0);
    expect(column.bottom, 'the panel column ends above the strip').toBeLessThanOrEqual(strip.top + 0.5);
    expect(column.left).toBeGreaterThanOrEqual(-0.5);
    expect(column.right).toBeLessThanOrEqual(vp.width + 0.5);
    // Back on the hub: no strip, and the CTA box is back where it was.
    await go(page, { t: 'back' });
    expect(await drawnStrips(page)).toEqual([]);
    expect(await rectOf(page, '[data-cta]')).toEqual(cta);
  });

  test('QA Lab tiles stay on screen and apart; the player card never cuts a line', async ({ page }) => {
    await openApp(page);
    await go(page, { t: 'tab/set', screen: 'lab' });
    const vp = page.viewportSize()!;
    const tiles = await page.locator('[data-tile]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as Rect));
    expect(tiles.length).toBeGreaterThan(0);
    for (const [i, t] of tiles.entries()) {
      expect(t.left, `tile ${i} left`).toBeGreaterThanOrEqual(-0.5);
      expect(t.right, `tile ${i} right`).toBeLessThanOrEqual(vp.width + 0.5);
      for (const [j, u] of tiles.slice(i + 1).entries()) expect(overlap(t, u), `tiles ${i} and ${i + j + 1} overlap`).toBeLessThanOrEqual(0.5);
    }
    const lines = await page.locator('[data-card-panel] > *').evaluateAll((els) =>
      els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => ({ text: el.textContent, sw: el.scrollWidth, cw: el.clientWidth })),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.sw, `"${l.text}" is cut`).toBeLessThanOrEqual(l.cw);
  });

  test('the unfolded card never covers the Experience band; the Profile centre text stays inside its ring', async ({ page }) => {
    await openApp(page);
    const vp = page.viewportSize()!;
    await expectCardClearOfExperience(page, `${vp.width}×${vp.height}`);
    await expectCentreFits(page, `${vp.width}×${vp.height}`);
  });

  for (const viewport of OTHER_TOUCH) {
    test(`the same on another touch screen (${viewport.width}×${viewport.height})`, async ({ browser }) => {
      const context = await touchContext(browser, viewport);
      const page = await context.newPage();
      await openApp(page);
      await expectCardClearOfExperience(page, `${viewport.width}×${viewport.height}`);
      await expectCentreFits(page, `${viewport.width}×${viewport.height}`);
      await context.close();
    });
  }

  test("where the Profile's tagline wraps, no word is left alone on its last line", async ({ page }) => {
    await openApp(page);
    await go(page, { t: 'tab/set', screen: 'profile' });
    const tagline = await page
      .locator('section[aria-label="Profile"] [class*="tagline"]')
      .first()
      .evaluate((el) => {
        const range = document.createRange();
        const words: { top: number; word: string }[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const m of (n.textContent ?? '').matchAll(/\S+/g)) {
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            words.push({ top: Math.round(range.getBoundingClientRect().top), word: m[0] });
          }
        }
        const byRow = new Map<number, string[]>();
        for (const w of words) byRow.set(w.top, [...(byRow.get(w.top) ?? []), w.word]);
        return { rows: [...byRow.values()], width: el.getBoundingClientRect().width };
      });
    // A tagline the fit leaves out (a 1 px box) or one on a single row has nothing to check.
    if (tagline.width <= 1 || tagline.rows.length < 2) return;
    expect(tagline.rows.at(-1)!.length, tagline.rows.map((r) => r.join(' ')).join(' / ')).toBeGreaterThan(1);
  });
});

/** What the strip or the CTA box paints: opacity times its ancestors', visibility, its box. */
interface Painted {
  opacity: number;
  visible: boolean;
  rect: Rect;
}

/**
 * The strip and the CTA box `ms` after `action` (from the view at rest): every CSS transition and
 * animation the change started paused `ms` after its start and the engine clock stepped `ms`. Then
 * the view at rest again. Without an action: the view at rest.
 */
async function sampleFooter(page: Page, action: Action | null, ms = 0): Promise<{ strip: Painted | null; cta: Painted | null }> {
  await settle(page);
  await finishCss(page);
  const sample = await page.evaluate(
    ({ action, ms, strip }) => {
      if (action) {
        window.__wheel!.manual(true);
        window.__site!.dispatch(action);
        // getAnimations() flushes the style change of the commit above, which starts the fades.
        for (const a of document.getAnimations()) {
          if (a.playState !== 'running') continue;
          a.pause();
          a.currentTime = ms;
        }
        window.__wheel!.step(ms);
      }
      const painted = (el: Element | null) => {
        if (!el) return null;
        let opacity = 1;
        for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
        return { opacity, visible: getComputedStyle(el).visibility === 'visible', rect: el.getBoundingClientRect().toJSON() as Rect };
      };
      return { strip: painted(document.querySelector(strip)), cta: painted(document.querySelector('[data-cta]')) };
    },
    { action, ms, strip: STRIP },
  );
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
  });
  await settle(page);
  await finishCss(page);
  return sample;
}

const shows = (p: Painted | null): p is Painted => !!p && p.opacity > 0 && p.visible && p.rect.width > 0 && p.rect.height > 0;

/** Sample points through a swap, one frame apart at first, then wider (ms after the change). */
const SAMPLES_MS = [16, 48, 96, 160, 240, 320];

/**
 * Opening the detail view swaps the CTA box for the hint strip. The two never show over one another:
 * from the hub, from a screen, nor on the way back; at rest only the right one shows.
 */
async function expectSwapClean(page: Page): Promise<void> {
  const [cat] = await categoryIds(page);
  for (const ms of SAMPLES_MS) {
    for (const from of ['skills', 'experience'] as const) {
      await go(page, { t: 'tab/set', screen: 'skills' }, { t: 'back' });
      if (from !== 'skills') await go(page, { t: 'tab/set', screen: from });
      const open = await sampleFooter(page, { t: 'cat/open', cat }, ms);
      expect(open.strip, 'the strip is in the DOM').not.toBeNull();
      const both = shows(open.strip) && shows(open.cta) ? overlap(open.strip.rect, open.cta.rect) : 0;
      expect(both, `${from} → detail at ${ms} ms: strip over the CTA box (px²)`).toBe(0);
      const back = await sampleFooter(page, { t: 'back' }, ms);
      const bothBack = shows(back.strip) && shows(back.cta) ? overlap(back.strip.rect, back.cta.rect) : 0;
      expect(bothBack, `detail → ${from} at ${ms} ms: strip over the CTA box (px²)`).toBe(0);
    }
  }
  await go(page, { t: 'tab/set', screen: 'skills' }, { t: 'back' });
  expect(shows((await sampleFooter(page, null)).cta), 'the CTA box on the hub').toBe(true);
  await go(page, { t: 'cat/open', cat });
  const rest = await sampleFooter(page, null);
  expect(shows(rest.strip), 'the strip at rest in the detail view').toBe(true);
  expect(rest.strip!.opacity).toBe(1);
  expect(shows(rest.cta), 'the CTA box in the detail view').toBe(false);
}

test.describe('the hint strip and the CTA box swap without overlapping', { tag: '@mobile' }, () => {
  test('touch, dark theme', async ({ page }) => {
    await openApp(page, { theme: 'dark' });
    await expectSwapClean(page);
  });

  test('touch, light theme, reduced motion', { tag: '@a11y' }, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, { theme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expectSwapClean(page);
  });
});

test.describe('portrait window with a mouse and keyboard', () => {
  // A desktop window shaped like a phone: a fine pointer, so the key hints show.
  test.use({ viewport: { width: 411, height: 776 } });

  test('the hint strip and the CTA box swap without overlapping', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'on');
    await expectSwapClean(page);
  });
});

/** Laptops and tablets show the Profile's centre block whole: no line left out, inside the ring. */
const LAPTOPS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
];

test.describe('Profile centre on laptops', () => {
  for (const viewport of LAPTOPS) {
    test(`every line shows, inside the ring (${viewport.width}×${viewport.height})`, async ({ browser }) => {
      const context = await newContext(browser, { viewport });
      const page = await context.newPage();
      await openApp(page);
      await go(page, { t: 'tab/set', screen: 'profile' });
      const centre = await page.evaluate(centreBlock);
      expect(centre.fit).toBe('full');
      for (const [i, w] of centre.widths.entries()) expect(w, `line ${i} shown`).toBeGreaterThan(1);
      expect(centre.clear, `inside the ring's disc: "${centre.text}"`).toBeGreaterThanOrEqual(0);
      expect(centre.text).toContain(await cardName(page));
      await context.close();
    });
  }
});
