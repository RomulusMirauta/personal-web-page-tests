import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { appState, arcPoint, categoryIds, dispatch, expectMode, openApp, screenOrder, sel, settle } from './support/app';
import { expect, newContext, test } from './support/test';

/**
 * The app on a phone: the skill wheel fits the screen between the header and the footer, every
 * control is a usable touch target, nothing scrolls sideways, and touch input (tap, long press,
 * swipe) does what a visitor expects. Runs in the phone project (a real browser viewport with its
 * bars drawn); a few other phone sizes are opened in their own context.
 */

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** Other phone sizes: a small Android phone, an iPhone SE, and a phone held sideways. */
const OTHER_PHONES = [
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 776, height: 411 },
];

/** WCAG 2.5.8 (Target Size, Minimum). */
const MIN_TARGET = 24;
/** A generic legibility floor for text on a phone (CSS px). */
const MIN_TEXT = 12;

/** A phone context of another size, with the same device traits as the phone project. */
async function phoneContext(browser: Parameters<typeof newContext>[0], viewport: { width: number; height: number }): Promise<BrowserContext> {
  const use = test.info().project.use;
  return newContext(browser, { viewport, deviceScaleFactor: use.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: use.userAgent });
}

/** A one-finger swipe through CDP touch events (they also produce touch pointer events). */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', at?: { x: number; y: number }) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [at] : [] });

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

/** The ring on screen (CSS px): its centre and the middle of its band. */
async function ringOnScreen(page: Page): Promise<{ cx: number; cy: number; r: number }> {
  return page.evaluate(() => {
    const g = window.__wheel!.geometry();
    const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
    return { cx: m.a * g.center.x + m.e, cy: m.d * g.center.y + m.f, r: (m.a * (g.rInner + g.rOuter)) / 2 };
  });
}

/** The box around everything the wheel draws right now (ring and visible nodes), in CSS px. */
async function wheelBox(page: Page): Promise<Rect> {
  return page.evaluate((selector) => {
    const painted = (el: Element) => {
      for (let n: Element | null = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) === 0) return false;
      return getComputedStyle(el).visibility !== 'hidden';
    };
    const svg = document.querySelector(selector)!;
    const parts = [...svg.querySelectorAll('[data-cat-id]')].filter(painted).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const left = Math.min(...parts.map((r) => r.left));
    const top = Math.min(...parts.map((r) => r.top));
    const right = Math.max(...parts.map((r) => r.right));
    const bottom = Math.max(...parts.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }, sel.wheel);
}

/** The header band, the legend and the footer's controls, in CSS px. */
async function frame(page: Page): Promise<{ band: Rect; legend: Rect | null; footer: Rect[] }> {
  return page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect().toJSON() as Rect;
    const shown = (el: Element) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const legend = document.querySelector('[aria-label="Skill levels"]');
    return {
      band: r(document.querySelector('header[data-hud] nav')!),
      legend: legend && shown(legend) ? r(legend) : null,
      footer: [...document.querySelectorAll('footer[data-hud] button, footer[data-hud] a[href], [data-cta]')].filter(shown).map(r),
    };
  });
}

/**
 * Every control of the header and footer a finger can hit (painted, not hidden), with its box and
 * name. The wheel's own arcs and nodes are excluded: they are drawn shapes with their own hit areas.
 */
async function hudControls(page: Page): Promise<{ name: string; rect: Rect }[]> {
  return page.evaluate(() => {
    const painted = (el: Element) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || getComputedStyle(el).visibility === 'hidden') return false;
      for (let n: Element | null = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) === 0) return false;
      return !el.closest('[inert], [aria-hidden="true"]');
    };
    const els = new Set([...document.querySelectorAll('[data-hud] button, [data-hud] a[href], [data-cta]')]);
    return [...els]
      .filter((el) => !el.closest('svg') && painted(el))
      .map((el) => ({
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        rect: el.getBoundingClientRect().toJSON() as Rect,
      }));
  });
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Distance from a point to a rectangle (0 inside it). */
const distance = (x: number, y: number, r: Rect) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

/**
 * WCAG 2.5.8: a target is at least 24×24 CSS px, or a 24 px circle centred on it intersects no
 * other target and no other undersized target's circle (the spacing exception).
 */
function targetSizeFailures(controls: { name: string; rect: Rect }[]): string[] {
  const small = (r: Rect) => r.width < MIN_TARGET - 0.5 || r.height < MIN_TARGET - 0.5;
  const centre = (r: Rect) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  const out: string[] = [];
  for (const c of controls) {
    if (!small(c.rect)) continue;
    const a = centre(c.rect);
    for (const o of controls) {
      if (o === c || overlap(o.rect, c.rect) === o.rect.width * o.rect.height) continue;
      const b = centre(o.rect);
      const clash = small(o.rect) ? Math.hypot(a.x - b.x, a.y - b.y) < MIN_TARGET : distance(a.x, a.y, o.rect) < MIN_TARGET / 2;
      if (clash) out.push(`"${c.name}" (${c.rect.width.toFixed(1)}×${c.rect.height.toFixed(1)} px) is too close to "${o.name}"`);
    }
  }
  return out;
}

/**
 * Checks the hub's layout on a page: no sideways scroll, the wheel (with each category hovered in
 * turn, its largest state) inside the viewport between the header band and the legend, the footer
 * controls on screen and apart, and every header/footer control a usable target.
 */
async function expectHubFits(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, zoom: visualViewport?.scale ?? 1 }));
  expect(doc, 'no sideways scroll, no zoom-out').toEqual({ sw: vp.width, w: vp.width, zoom: 1 });
  const f = await frame(page);
  const at = `${vp.width}×${vp.height}`;
  for (const cat of [null, ...(await categoryIds(page))]) {
    await dispatch(page, { t: 'cat/hover', cat });
    const w = await wheelBox(page);
    const what = `${at}, ${cat ?? 'no category'} hovered`;
    expect(w.left, `${what}: wheel left edge on screen`).toBeGreaterThanOrEqual(0);
    expect(w.right, `${what}: wheel right edge on screen`).toBeLessThanOrEqual(vp.width);
    expect(w.top, `${what}: wheel below the header band`).toBeGreaterThanOrEqual(f.band.bottom);
    expect(w.bottom, `${what}: wheel on screen`).toBeLessThanOrEqual(vp.height);
    if (f.legend) expect(overlap(w, f.legend), `${what}: wheel over the legend (px²)`).toBe(0);
    for (const box of f.footer) expect(overlap(w, box), `${what}: wheel over a footer control (px²)`).toBe(0);
  }
  await dispatch(page, { t: 'cat/hover', cat: null });
  for (const [i, a] of f.footer.entries()) {
    expect(a.left >= -0.5 && a.right <= vp.width + 0.5 && a.top >= -0.5 && a.bottom <= vp.height + 0.5, `${at}: footer control ${i} on screen`).toBe(true);
    for (const b of f.footer.slice(i + 1)) if (overlap(a, b) !== a.width * a.height && overlap(a, b) !== b.width * b.height) expect(overlap(a, b), `${at}: footer controls overlap`).toBe(0);
    if (f.legend) expect(overlap(a, f.legend), `${at}: footer control over the legend`).toBe(0);
  }
  const controls = await hudControls(page);
  expect(controls.length).toBeGreaterThan(0);
  for (const c of controls) {
    expect(c.rect.left >= -0.5 && c.rect.right <= vp.width + 0.5 && c.rect.top >= -0.5 && c.rect.bottom <= vp.height + 0.5, `${at}: "${c.name}" on screen`).toBe(true);
  }
  expect(targetSizeFailures(controls), `${at}: target size`).toEqual([]);
}

/** Visible text below `floor` CSS px (rendered size: font size times the element's on-screen scale). */
async function textUnder(page: Page, floor: number, skip: string | null = null): Promise<string[]> {
  return page.evaluate(
    ({ floor, skip }) => {
      const out: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent!.trim() || el instanceof SVGElement || el.closest('.visually-hidden, [aria-hidden="true"]')) continue;
        if (skip && el.closest(skip)) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        let painted = true;
        for (let e: Element | null = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) painted = false;
        if (!painted) continue;
        // The stage is scaled with a transform: its box against its layout width.
        const k = ((s) => (s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : 1))(el.closest<HTMLElement>('[data-stage]'));
        const px = parseFloat(getComputedStyle(el).fontSize) * k;
        if (px < floor - 0.05) out.push(`${px.toFixed(1)} px "${n.textContent!.trim().slice(0, 30)}"`);
      }
      return out;
    },
    { floor, skip },
  );
}

test.describe('phone', { tag: '@mobile' }, () => {
  test('loads, the wheel fits the screen, and a tap opens a category', { tag: '@smoke' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const vp = page.viewportSize()!;
    const w = await wheelBox(page);
    expect(w.left).toBeGreaterThanOrEqual(0);
    expect(w.right).toBeLessThanOrEqual(vp.width);
    expect(w.top).toBeGreaterThanOrEqual((await frame(page)).band.bottom);
    expect(w.bottom).toBeLessThanOrEqual(vp.height);
    const [target] = await categoryIds(page);
    // On touch the first tap selects, the second opens.
    await page.touchscreen.tap(...xy(await arcPoint(page, target)));
    await expectMode(page, 'hover', target);
    await settle(page);
    await page.touchscreen.tap(...xy(await arcPoint(page, target)));
    await expectMode(page, 'detail', target);
    await expect(page.locator(sel.panel).first()).toBeVisible();
  });

  test('is a touch device to the app: coarse pointer, single-key shortcuts off', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-pointer', 'coarse');
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
  });

  test('the hub fits: wheel between header and footer, controls on screen and usable, no sideways scroll', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await expectHubFits(page);
  });

  for (const viewport of OTHER_PHONES) {
    test(`the hub fits on other phone sizes too (${viewport.width}×${viewport.height})`, async ({ browser }) => {
      const context = await phoneContext(browser, viewport);
      const page = await context.newPage();
      await openApp(page);
      await settle(page);
      await expectHubFits(page);
      await context.close();
    });
  }

  test(`hub text is at least ${MIN_TEXT} px, the player card aside`, async ({ page }) => {
    await openApp(page);
    await settle(page);
    expect(await textUnder(page, MIN_TEXT, '[data-hud="card"]')).toEqual([]);
  });

  test(`known issue: the player card's name renders below ${MIN_TEXT} px on phones`, async ({ page }) => {
    // Tracked, not yet fixed: the card's name line scales down with the layout on phones. The test
    // pins the current state, so it turns red once the issue is fixed: then make it a floor check.
    test.info().annotations.push({ type: 'known issue', description: `player card text below ${MIN_TEXT} px on phones` });
    await openApp(page);
    await settle(page);
    await expect(page.locator('[data-card-panel]').first()).toBeVisible();
    expect(await textUnder(page, MIN_TEXT), 'still below the floor (fixed? turn this into a floor check)').not.toEqual([]);
  });

  test('the player card shows each line whole', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const lines = await page.locator('[data-card-panel] > *').evaluateAll((els) =>
      els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 0.5 })),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.cut, `"${l.text}" is cut`).toBe(false);
  });

  test('a tap selects a category (opens nothing); a second tap on it opens it', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    const target = cats[1] ?? cats[0];
    await page.touchscreen.tap(...xy(await arcPoint(page, target)));
    await expectMode(page, 'hover', target);
    await settle(page);
    expect((await appState(page)).mode).toEqual({ kind: 'hover', cat: target });
    await page.touchscreen.tap(...xy(await arcPoint(page, target)));
    await expectMode(page, 'detail', target);
  });

  test('the tap that opens a category sends no click past the wheel into the detail view', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await page.evaluate(() => {
      const w = window as unknown as { clicks: string[] };
      w.clicks = [];
      // The tap's own click may land on the arc it tapped; it must not reach anything else.
      window.addEventListener(
        'click',
        (e) => {
          const t = e.target as Element;
          if (!t.closest('svg[data-active]')) w.clicks.push(t.outerHTML.slice(0, 80));
        },
        true,
      );
    });
    const clicks = () => page.evaluate(() => (window as unknown as { clicks: string[] }).clicks);
    for (const cat of await categoryIds(page)) {
      await dispatch(page, { t: 'back' });
      await settle(page);
      const at = xy(await arcPoint(page, cat));
      await page.touchscreen.tap(...at);
      await expectMode(page, 'hover', cat);
      await settle(page);
      await page.evaluate(() => ((window as unknown as { clicks: string[] }).clicks.length = 0));
      await page.touchscreen.tap(...at);
      await expectMode(page, 'detail', cat);
      await settle(page);
      expect(await clicks(), cat).toEqual([]);
      expect((await appState(page)).screen).toBe('skills');
    }
  });

  test('a tap on another category moves the selection; a tap away from the wheel clears it', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    const [a, b] = [cats[0], cats[cats.length - 1]];
    await page.touchscreen.tap(...xy(await arcPoint(page, a)));
    await expectMode(page, 'hover', a);
    await settle(page);
    await page.touchscreen.tap(...xy(await arcPoint(page, b)));
    await expectMode(page, 'hover', b);
    await settle(page);
    // A point in empty space: below the wheel and the legend, above the footer's controls.
    const w = await wheelBox(page);
    const f = await frame(page);
    const top = Math.max(w.bottom, f.legend?.bottom ?? 0);
    const bottom = Math.min(...f.footer.map((r) => r.top));
    expect(bottom - top, 'empty space under the wheel').toBeGreaterThan(8);
    const free = await page.evaluate(
      ({ y }) => {
        for (let x = innerWidth - 8; x > 8; x -= 8) {
          const el = document.elementFromPoint(x, y);
          if (el && !el.closest('button, a, [role="button"], [data-cat-id]')) return { x, y };
        }
        return null;
      },
      { y: (top + bottom) / 2 },
    );
    expect(free, 'a free spot under the wheel').not.toBeNull();
    await page.touchscreen.tap(free!.x, free!.y);
    await expectMode(page, 'idle');
    expect((await appState(page)).screen).toBe('skills');
  });

  test('a long press or a drag that ends where it began opens nothing', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    const p = await arcPoint(page, cats[1] ?? cats[0]);
    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, 'touchStart', p);
    // A long press is defined by its duration, so this wait is the input itself, well past a tap.
    await page.waitForTimeout(700);
    await touch(cdp, 'touchEnd');
    await touch(cdp, 'touchStart', p);
    await touch(cdp, 'touchMove', { x: p.x + 30, y: p.y });
    await touch(cdp, 'touchMove', p);
    await touch(cdp, 'touchEnd');
    await cdp.detach();
    await settle(page);
    expect((await appState(page)).mode.kind).not.toBe('detail');
    expect(await page.evaluate(() => ({ y: scrollY, zoom: visualViewport?.scale ?? 1 })), 'neither scrolled nor zoomed').toEqual({ y: 0, zoom: 1 });
  });

  test('a finger dragged round the ring opens nothing and keeps the section', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const ring = await ringOnScreen(page);
    const at = (deg: number) => {
      const t = (deg * Math.PI) / 180;
      return { x: ring.cx + ring.r * Math.sin(t), y: ring.cy - ring.r * Math.cos(t) };
    };
    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, 'touchStart', at(200));
    for (let deg = 205; deg <= 520; deg += 5) {
      await touch(cdp, 'touchMove', at(deg));
      expect((await appState(page)).mode.kind, `at ${deg}°`).not.toBe('detail');
    }
    await touch(cdp, 'touchEnd');
    await cdp.detach();
    await settle(page);
    const s = await appState(page);
    expect(s.screen).toBe('skills');
    expect(s.mode.kind).not.toBe('detail');
    expect(await page.evaluate(() => ({ y: scrollY, zoom: visualViewport?.scale ?? 1 }))).toEqual({ y: 0, zoom: 1 });
  });

  test('swiping sideways in the detail view switches categories, and back', async ({ page }) => {
    await openApp(page);
    const cats = await categoryIds(page);
    test.skip(cats.length < 2, 'needs two categories');
    // Touch screens keep single-key shortcuts off, so the category is opened through the store.
    await dispatch(page, { t: 'cat/open', cat: cats[0] });
    await settle(page);
    const vp = page.viewportSize()!;
    const y = (await frame(page)).band.bottom + 40;
    await swipe(page, { x: vp.width * 0.8, y }, { x: vp.width * 0.2, y });
    await expect
      .poll(async () => {
        const m = (await appState(page)).mode;
        return m.kind === 'detail' ? m.cat : null;
      })
      .not.toBe(cats[0]);
    await settle(page);
    await swipe(page, { x: vp.width * 0.2, y }, { x: vp.width * 0.8, y });
    await expectMode(page, 'detail', cats[0]);
  });

  test('swipes through every section in header order; no section scrolls sideways', async ({ page }) => {
    await openApp(page);
    const order = await screenOrder(page);
    await settle(page);
    const vp = page.viewportSize()!;
    const start = order.indexOf('skills');
    // Low on the screen, clear of the wheel and the footer's controls.
    const f = await frame(page);
    const y = Math.min(...f.footer.map((r) => r.top)) - 12;
    const seen: string[] = [];
    for (let i = 1; i <= order.length; i++) {
      const expected = order[(start + i) % order.length];
      await swipe(page, { x: vp.width * 0.8, y }, { x: vp.width * 0.2, y });
      await expect.poll(async () => (await appState(page)).screen).toBe(expected);
      await settle(page);
      seen.push(expected);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${expected}: no sideways scroll`).toBeLessThanOrEqual(vp.width);
    }
    expect(seen.at(-1)).toBe('skills');
  });
});
