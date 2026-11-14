import type { Page } from '@playwright/test';
import { categoryIds, dispatch, expectMode, openApp, screenOrder, settle } from './support/app';
import { decode } from './support/png';
import { expect, test } from './support/test';

/**
 * The header band: the section (or category) title in the middle, the neighbours' names beside it
 * with the Q / E key caps at the edges. The rules are relations: the title stays centred, the keys
 * stay put, a neighbour's name never runs into the title, everything stays on screen, and a name too
 * long for its side ends in an ellipsis with the full name as a tooltip rather than overlapping.
 * Text runs are read from DOM Ranges (the glyph run), clipped to the label's box (an ellipsised
 * label lays out its whole text but paints only its box). All values are CSS px.
 */
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;

/** The least space between a neighbour's name and the title (CSS px): closer, the two read as one run of text. */
const MIN_GAP = 8;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Side {
  text: string;
  hidden: boolean;
  truncated: boolean;
  font: number;
  /** The label box's tooltip. */
  tip: string | null;
  /** Painted extent of the label. */
  run: Rect;
  key: Rect;
}

interface Band {
  title: { text: string } & Rect;
  prev: Side;
  next: Side;
  viewport: { width: number; height: number };
}

async function band(page: Page): Promise<Band> {
  return page.evaluate(() => {
    const nav = document.querySelector('header[data-hud] nav')!;
    const rect = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const range = (n: Node) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return r.getBoundingClientRect();
    };
    const h2 = nav.querySelector('h2')!;
    const side = (b: Element) => {
      const label = b.querySelector(':scope > span > span:not(.visually-hidden)')!;
      const box = label.parentElement!;
      const clip = box.getBoundingClientRect();
      const run = range(label);
      return {
        text: label.textContent ?? '',
        hidden: clip.width <= 1.5,
        truncated: box.scrollWidth > box.clientWidth + 0.5 || label.scrollWidth > label.clientWidth + 0.5,
        font: parseFloat(getComputedStyle(label).fontSize),
        tip: box.getAttribute('title') ?? label.getAttribute('title') ?? b.getAttribute('title'),
        run: { left: Math.max(run.left, clip.left), right: Math.min(run.right, clip.right), top: run.top, bottom: run.bottom },
        key: rect(b.querySelector('kbd')!.getBoundingClientRect()),
      };
    };
    const [prev, next] = [...nav.querySelectorAll(':scope > button')].map(side);
    return {
      title: { text: h2.textContent ?? '', ...rect(range(h2)) },
      prev,
      next,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

/** Relations that hold in every view: centred title, names clear of it, everything on screen. */
function expectBand(b: Band, what: string): void {
  const centre = (b.title.left + b.title.right) / 2;
  expect(Math.abs(centre - b.viewport.width / 2), `${what}: title centred (${centre.toFixed(1)} of ${b.viewport.width})`).toBeLessThanOrEqual(1);
  for (const [name, side, gap] of [
    ['previous', b.prev, b.title.left - b.prev.run.right],
    ['next', b.next, b.next.run.left - b.title.right],
  ] as const) {
    for (const [part, r] of [
      ['key', side.key],
      ['title', b.title],
      ...(side.hidden ? [] : ([['name', side.run]] as const)),
    ] as const) {
      expect(r.left >= -0.5 && r.right <= b.viewport.width + 0.5 && r.top >= -0.5 && r.bottom <= b.viewport.height + 0.5, `${what}: ${name} ${part} on screen`).toBe(true);
    }
    if (side.hidden) continue;
    expect(gap, `${what}: "${side.text}" (${name}) ↔ title "${b.title.text}"`).toBeGreaterThanOrEqual(MIN_GAP);
    // The key cap sits outside its name.
    if (name === 'previous') expect(side.key.right, `${what}: Q key before its name`).toBeLessThanOrEqual(side.run.left + 0.5);
    else expect(side.key.left, `${what}: E key after its name`).toBeGreaterThanOrEqual(side.run.right - 0.5);
    if (side.truncated) expect(side.tip, `${what}: "${side.text}" is cut, so its full name is a tooltip`).toBeTruthy();
  }
}

async function openHeader(page: Page, flags: Record<string, string> = {}): Promise<void> {
  await openApp(page, flags);
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

/** Wait one painted frame (labels re-fit on the frame after a layout change). */
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test.describe('header band: centred title, names clear of it, keys in place', () => {
  for (const vp of SIZES) {
    test(`at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openHeader(page);
      const screens = await screenOrder(page);
      let keys: { q: number; e: number } | null = null;
      const sameKeys = (b: Band, what: string) => {
        keys ??= { q: b.prev.key.left, e: b.next.key.left };
        expect(Math.abs(b.prev.key.left - keys.q), `${what}: the Q key stays put`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(b.next.key.left - keys.e), `${what}: the E key stays put`).toBeLessThanOrEqual(0.5);
      };

      // Sections: the names fit whole.
      for (const screen of screens) {
        await dispatch(page, { t: 'tab/set', screen });
        await frame(page);
        const b = await band(page);
        expectBand(b, screen);
        sameKeys(b, screen);
        expect(b.prev.truncated || b.next.truncated, `${screen}: section names are never cut`).toBe(false);
        expect(b.prev.hidden || b.next.hidden, `${screen}: section names are shown`).toBe(false);
      }

      // Categories, both wheels.
      for (const wheel of ['hard', 'soft'] as const) {
        await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'wheel/set', wheel });
        for (const cat of await categoryIds(page, wheel)) {
          await dispatch(page, { t: 'cat/open', cat });
          await expectMode(page, 'detail', cat);
          await frame(page);
          const b = await band(page);
          expectBand(b, `${wheel}/${cat}`);
          sameKeys(b, `${wheel}/${cat}`);
        }
        await dispatch(page, { t: 'back' });
      }
    });
  }
});

/** The WCAG 1.4.12 text-spacing test values, applied to all text. */
const TEXT_SPACING =
  '*:not(svg):not(svg *) { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';

test.describe('text-spacing override (WCAG 1.4.12): no name runs into the title', { tag: '@a11y' }, () => {
  for (const vp of [SIZES[0], SIZES[2]]) {
    test(`at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openHeader(page);
      for (const wheel of ['hard', 'soft'] as const) {
        await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'wheel/set', wheel });
        for (const cat of await categoryIds(page, wheel)) {
          await dispatch(page, { t: 'cat/open', cat });
          const tag = await page.addStyleTag({ content: TEXT_SPACING });
          await settle(page);
          await frame(page);
          expectBand(await band(page), `${wheel}/${cat} (spaced)`);
          await tag.evaluate((n) => (n as HTMLElement).remove());
        }
        await dispatch(page, { t: 'back' });
      }
    });
  }
});

test('the neighbour names share one line, in every view (1920×1080)', async ({ page }) => {
  await openHeader(page);
  const lines = new Map<number, number>();
  const expectLine = async (what: string) => {
    await frame(page);
    const b = await band(page);
    for (const s of [b.prev, b.next]) {
      if (s.hidden) continue;
      // Names of the same size sit on the same line in every view.
      const key = Math.round(s.font * 100);
      const bottom = s.run.bottom;
      if (!lines.has(key)) lines.set(key, bottom);
      expect(Math.abs(bottom - lines.get(key)!), `${what}: "${s.text}" stays on its line`).toBeLessThanOrEqual(0.5);
    }
  };
  for (const screen of await screenOrder(page)) {
    await dispatch(page, { t: 'tab/set', screen });
    await expectLine(screen);
  }
  for (const wheel of ['hard', 'soft'] as const) {
    await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'wheel/set', wheel });
    for (const cat of await categoryIds(page, wheel)) {
      await dispatch(page, { t: 'cat/open', cat });
      await expectMode(page, 'detail', cat);
      await expectLine(cat);
    }
    await dispatch(page, { t: 'back' });
  }
});

test('the header buttons announce Q / E in the detail view too, and the keys act there', { tag: '@critical' }, async ({ page }) => {
  await openHeader(page);
  const [first, second] = await categoryIds(page);
  await dispatch(page, { t: 'cat/open', cat: first });
  const nav = page.getByRole('navigation', { name: /categor/i });
  await expect(nav.getByRole('button', { name: /previous category/i })).toHaveAttribute('aria-keyshortcuts', 'Q');
  await expect(nav.getByRole('button', { name: /next category/i })).toHaveAttribute('aria-keyshortcuts', 'E');
  await page.keyboard.press('e');
  await expectMode(page, 'detail', second);
  await page.keyboard.press('q');
  await expectMode(page, 'detail', first);
});

test('the header buttons show a visible focus indicator when reached with Tab', { tag: '@a11y' }, async ({ page }) => {
  await openHeader(page);
  let found = 0;
  for (let i = 0; i < 40 && found < 2; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el?.closest('header[data-hud] nav') || el.tagName !== 'BUTTON') return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        focusVisible: el.matches(':focus-visible'),
        indicator: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none',
        onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      };
    });
    if (!f) continue;
    found++;
    expect(f).toEqual({ focusVisible: true, indicator: true, onScreen: true });
  }
  expect(found, 'both header buttons are Tab stops').toBe(2);
});

test('Q and E sit centred in their key caps (glyph ink, 1920×1080)', async ({ page }) => {
  await openHeader(page, { city: 'off' });
  const caps = await page.evaluate(() =>
    [...document.querySelectorAll('header[data-hud] nav kbd')].map((k) => {
      const r = k.getBoundingClientRect();
      return { text: k.textContent ?? '', left: r.left, top: r.top, width: r.width, height: r.height };
    }),
  );
  expect(caps.map((c) => c.text)).toEqual(['Q', 'E']);
  const shot = decode(await page.screenshot());
  /** Rows holding glyph ink inside the cap's rim (the colour at the inner corner is the cap's face). */
  const inkRows = (c: (typeof caps)[number]) => {
    const inset = Math.max(3, c.height * 0.12);
    const x0 = Math.ceil(c.left + inset);
    const x1 = Math.floor(c.left + c.width - inset);
    const y0 = Math.ceil(c.top + inset);
    const y1 = Math.floor(c.top + c.height - inset);
    const px = (x: number, y: number) => {
      const i = (y * shot.width + x) * 4;
      return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
    };
    const face = px(x0, y0);
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = px(x, y);
        if (Math.max(...p.map((v, i) => Math.abs(v - face[i]))) > 50) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
        }
      }
    return { top, bottom };
  };
  const [q, e] = caps;
  const eInk = inkRows(e);
  expect(Number.isFinite(eInk.top), 'the E glyph is drawn').toBe(true);
  // E's flat top and bottom are its cap height: centred in the cap within a pixel row (anti-aliasing
  // may add one row on another rasteriser).
  expect(Math.abs((eInk.top + eInk.bottom) / 2 - (e.top + e.height / 2)), 'E ink centre vs cap centre').toBeLessThanOrEqual(1);
  // Q's capital starts on the same row (its tail hangs below the baseline).
  expect(Math.abs(inkRows(q).top - q.top - (eInk.top - e.top)), 'Q ink top vs E ink top').toBeLessThanOrEqual(1);
});
