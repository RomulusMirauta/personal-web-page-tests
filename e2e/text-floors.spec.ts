import type { Browser, Page } from '@playwright/test';
import { categoryIds, dispatch, openApp, screenOrder, settle, ui } from './support/app';
import { expect, newContext, test } from './support/test';

/**
 * Legible text on small windows. The app scales its whole stage down with a transform, so text that
 * is comfortable at 1920×1080 could shrink below a readable size on a laptop. On laptop windows
 * every visible text of every screen stays at or above a 12 CSS px floor, headings stay larger than
 * the text under them, and nothing is clipped. At high browser zoom (a small CSS viewport) nothing
 * leaves its box.
 *
 * Rendered size = computed font size × the element's on-screen scale (its box against its layout
 * size), so the stage's transform is accounted for without knowing how the app scales.
 */
const LAPTOPS = [
  [1536, 695],
  [1366, 657],
  [1366, 768],
  [1280, 720],
  [1024, 768],
] as const;

/** A generic legibility floor for any text (CSS px). */
const FLOOR = 12;

/** 1280×720 and 1366×768 laptops at 200 % zoom, a 1080p laptop at 125 % and 200 %, and smaller. */
const ZOOMED = [
  [853, 430],
  [768, 365],
  [720, 405],
  [683, 384],
  [640, 360],
] as const;

async function open(browser: Browser, width: number, height: number): Promise<Page> {
  const context = await newContext(browser, { viewport: { width, height } });
  const page = await context.newPage();
  await openApp(page);
  return page;
}

/** Shows a screen and waits until its entries have slid in. Returns the screen's region selector. */
async function show(page: Page, screen: string): Promise<string> {
  await dispatch(page, { t: 'tab/set', screen });
  await settle(page);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  const name = ((await ui.sectionTitle(page).textContent()) ?? '').trim();
  return page.evaluate((name) => {
    const region = [...document.querySelectorAll('section[aria-label]')].find((s) => s.getAttribute('aria-label')!.toLowerCase() === name.toLowerCase());
    if (!region) throw new Error(`no region named ${name}`);
    return `section[aria-label="${region.getAttribute('aria-label')}"]`;
  }, name);
}

/**
 * The text-heavy screens with the floors, in header order: every screen but the skill wheel and the
 * Profile (whose floors are a known gap, checked separately below).
 */
const textScreens = async (page: Page) => (await screenOrder(page)).filter((s) => s !== 'skills' && s !== 'profile');

interface TextReport {
  /** Visible text below the floor. */
  small: string[];
  /** Headings not larger than the smallest body text under them. */
  headings: string[];
  /** Boxes whose text is wider than the box and clipped (no ellipsis meant to show it). */
  clipped: string[];
}

async function measure(page: Page, root: string, floor: number): Promise<TextReport> {
  return page.evaluate(
    ({ root, floor }) => {
      const region = document.querySelector(root)!;
      const hidden = (el: Element) => Boolean(el.closest('.visually-hidden, [aria-hidden="true"]'));
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !hidden(el);
      };
      const px = (el: Element) => {
        const k = ((s) => (s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : 1))(el.closest<HTMLElement>('[data-stage]'));
        return parseFloat(getComputedStyle(el).fontSize) * k;
      };
      const out: TextReport = { small: [], headings: [], clipped: [] };
      const sizes: number[] = [];
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!n.textContent!.trim() || !el || !shown(el)) continue;
        const size = px(el);
        if (!el.closest('h1, h2, h3, h4')) sizes.push(size);
        if (size < floor - 0.05) out.small.push(`${size.toFixed(1)} px "${n.textContent!.trim().slice(0, 30)}"`);
      }
      const body = Math.min(...sizes);
      for (const h of region.querySelectorAll('h2, h3, h4')) {
        if (!shown(h) || !h.textContent!.trim()) continue;
        if (px(h) < body - 0.05) out.headings.push(`${px(h).toFixed(1)} px heading "${h.textContent!.trim().slice(0, 30)}" under ${body.toFixed(1)} px text`);
      }
      for (const el of region.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (!shown(el) || cs.display === 'inline' || cs.display === 'contents' || el.clientWidth === 0) continue;
        if (cs.overflowX === 'visible' || cs.textOverflow === 'ellipsis') continue;
        if (![...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent!.trim())) continue;
        if (el.scrollWidth > el.clientWidth + 1) out.clipped.push(`"${el.textContent!.trim().slice(0, 30)}"`);
      }
      return out;
    },
    { root, floor },
  );
}

for (const [w, h] of LAPTOPS) {
  test(`text stays at or above ${FLOOR} CSS px and is not clipped at ${w}×${h}`, { tag: '@a11y' }, async ({ browser }) => {
    const page = await open(browser, w, h);
    for (const screen of await textScreens(page)) {
      const root = await show(page, screen);
      const r = await measure(page, root, FLOOR);
      expect(r.small, `${screen}: text under ${FLOOR} CSS px at ${w}×${h}`).toEqual([]);
      expect(r.headings, `${screen}: headings smaller than their text at ${w}×${h}`).toEqual([]);
      expect(r.clipped, `${screen}: clipped text at ${w}×${h}`).toEqual([]);
    }
    await page.context().close();
  });
}

/** Everything that leaves its box in the region, in CSS px past the box. */
async function escapes(page: Page, root: string): Promise<string[]> {
  return page.evaluate((root) => {
    const region = document.querySelector(root)!;
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${el.textContent!.trim().slice(0, 24)}"`;
    const hidden = (el: Element) => Boolean(el.closest('.visually-hidden, [data-overflow]')) || getComputedStyle(el).visibility === 'hidden';
    const scaleOf = (el: Element) => ((s) => (s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : 1))(el.closest<HTMLElement>('[data-stage]'));
    const out: string[] = [];
    // No box is wider inside than outside (a nowrap label, a button row, an area scrolling sideways).
    for (const el of region.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (hidden(el) || cs.display === 'inline' || cs.display === 'contents' || el.clientWidth === 0) continue;
      // A label ending in an ellipsis is clipped on purpose.
      if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible') continue;
      const over = (el.scrollWidth - el.clientWidth) * scaleOf(el);
      if (over > 1) out.push(`${name(el)} is wider inside: +${over.toFixed(1)} px`);
    }
    // Visible text stays inside its list item or tile, and those stay inside the region.
    const past = (what: string, inner: DOMRect, outer: DOMRect) => {
      const by = Math.max(inner.right - outer.right, outer.left - inner.left);
      if (inner.width > 0 && by > 1) out.push(`${what}: +${by.toFixed(1)} px`);
    };
    const area = region.getBoundingClientRect();
    for (const box of region.querySelectorAll('li, [data-tile]')) {
      if (hidden(box)) continue;
      const bb = box.getBoundingClientRect();
      past(`${name(box)} past its region`, bb, area);
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent!.trim() || hidden(n.parentElement!)) continue;
        // Text clipped on purpose (an ellipsis): the box that clips it must fit instead.
        let clip: Element | null = null;
        for (let e: Element | null = n.parentElement; e && e !== box; e = e.parentElement) {
          if (getComputedStyle(e).overflowX !== 'visible') clip = e;
        }
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of clip ? [clip.getBoundingClientRect()] : range.getClientRects()) past(`"${n.textContent!.trim().slice(0, 24)}" past ${name(box)}`, r, bb);
      }
    }
    return [...new Set(out)];
  }, root);
}

for (const [w, h] of ZOOMED) {
  test(`nothing leaves its box at high browser zoom (${w}×${h})`, async ({ browser }) => {
    const page = await open(browser, w, h);
    for (const screen of await textScreens(page)) {
      const root = await show(page, screen);
      expect(await escapes(page, root), `${screen} at ${w}×${h}`).toEqual([]);
    }
    await page.context().close();
  });
}

test('QA Lab tiles keep one width and stay inside their region, from laptop to high zoom', async ({ browser }) => {
  for (const [w, h] of [
    [1024, 768],
    [960, 540],
    [853, 430],
    [640, 360],
  ] as const) {
    const page = await open(browser, w, h);
    const order = await screenOrder(page);
    test.skip(!order.includes('lab'), 'no QA Lab screen');
    await show(page, 'lab');
    const r = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-tile]')].map((t) => t.getBoundingClientRect());
      const region = document.querySelector('[data-tile]')!.closest('section[aria-label]')!.getBoundingClientRect();
      return {
        count: tiles.length,
        spread: Math.max(...tiles.map((b) => b.width)) - Math.min(...tiles.map((b) => b.width)),
        past: Math.max(...tiles.map((b) => Math.max(b.right - region.right, region.left - b.left))),
      };
    });
    expect(r.count).toBeGreaterThan(0);
    expect(r.spread, `tile width spread at ${w}×${h}`).toBeLessThanOrEqual(1);
    expect(r.past, `tiles past the region at ${w}×${h}`).toBeLessThanOrEqual(1);
    await page.context().close();
  }
});

/** Up to `max` nodes of the hard wheel whose detail view shows a spec card (a list of facts). */
async function specCardNodes(page: Page, max: number): Promise<[string, string][]> {
  const found: [string, string][] = [];
  for (const cat of await categoryIds(page)) {
    await dispatch(page, { t: 'cat/open', cat });
    const nodes = await page.evaluate((c) => [...document.querySelectorAll(`[data-node-id][data-cat-id="${c}"]`)].map((n) => n.getAttribute('data-node-id')!), cat);
    for (const node of nodes) {
      await dispatch(page, { t: 'cat/open', cat, node });
      if (await page.locator('[data-media-slot] dl').count()) found.push([cat, node]);
      if (found.length >= max) break;
    }
    await dispatch(page, { t: 'back' });
    if (found.length >= max) break;
  }
  return found;
}

/** The spec card of the open node: its facts' sizes and whether they fit under its tag. */
async function specCard(page: Page) {
  await settle(page);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  return page.evaluate(() => {
    const card = document.querySelector('[data-media-slot]')!.firstElementChild!;
    const px = (el: Element) => {
      const k = ((s) => (s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : 1))(el.closest<HTMLElement>('[data-stage]'));
      return parseFloat(getComputedStyle(el).fontSize) * k;
    };
    const box = card.getBoundingClientRect();
    const facts = card.querySelector('dl')!.getBoundingClientRect();
    const tag = card.querySelector('span')!.getBoundingClientRect();
    return {
      smallest: Math.min(...[...card.querySelectorAll('dt, dd')].map(px)),
      inside: facts.top >= tag.bottom - 0.5 && facts.bottom <= box.bottom + 0.5 && facts.right <= box.right + 0.5,
      clipped: [...card.querySelectorAll('dt, dd')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
    };
  });
}

test(`spec card labels and values stay at or above ${FLOOR} CSS px at 1024×768`, { tag: '@a11y' }, async ({ browser }) => {
  const page = await open(browser, 1024, 768);
  const nodes = await specCardNodes(page, 3);
  test.skip(nodes.length === 0, 'no node shows a spec card');
  for (const [cat, node] of nodes) {
    await dispatch(page, { t: 'cat/open', cat, node });
    const r = await specCard(page);
    expect(r.smallest, node).toBeGreaterThanOrEqual(FLOOR - 0.05);
    expect({ inside: r.inside, clipped: r.clipped }, node).toEqual({ inside: true, clipped: [] });
    await dispatch(page, { t: 'back' });
  }
  await page.context().close();
});

test('spec card facts stay inside the card at high browser zoom', async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h] of [
    [853, 430],
    [640, 360],
  ] as const) {
    const page = await open(browser, w, h);
    const nodes = await specCardNodes(page, 4);
    test.skip(nodes.length === 0, 'no node shows a spec card');
    for (const [cat, node] of nodes) {
      await dispatch(page, { t: 'cat/open', cat, node });
      const r = await specCard(page);
      expect({ inside: r.inside, clipped: r.clipped }, `${node} at ${w}×${h}`).toEqual({ inside: true, clipped: [] });
      await dispatch(page, { t: 'back' });
    }
    await page.context().close();
  }
});

test(`known issue: some Profile text renders below ${FLOOR} CSS px on a 1366×768 laptop`, { tag: '@a11y' }, async ({ browser }) => {
  // Tracked, not yet fixed: on laptop windows parts of the Profile screen render below the floor.
  // The test pins the current state, so it turns red once the issue is fixed: then make it a floor check.
  test.info().annotations.push({ type: 'known issue', description: `Profile text below ${FLOOR} px at 1366×768` });
  const page = await open(browser, 1366, 768);
  const root = await show(page, 'profile');
  await expect(page.locator(root)).toBeVisible();
  expect((await measure(page, root, FLOOR)).small, 'still below the floor (fixed? turn this into a floor check)').not.toEqual([]);
  await page.context().close();
});
