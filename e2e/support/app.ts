/**
 * Shared helpers: how the specs open and drive the app.
 *
 * The suite is black-box: it never imports application code. It talks to the app through
 *   - the UI itself, roles and accessible names first (getByRole), data attributes second;
 *   - URL hash routes (#/<screen>, #/skills/<category>/<node>);
 *   - a small test-hook API the production build exposes only when the page is opened with ?test=1
 *     (see types.ts). The hooks give two things a black-box suite cannot get otherwise: the app's
 *     state (to assert on it, and to wait on it instead of sleeping) and a manual animation clock,
 *     so an animated transition can be run to its end in one call instead of waiting for it.
 *
 * Selectors live here so a markup change is fixed in one place. Each data selector is a single
 * selector, so a spec can append to it, as in `${sel.city} canvas`.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from './test';
import type { Action, Mode, Screen } from './types';

/**
 * Query flags for a deterministic page: test hooks on, intro skipped, a fixed seed for the
 * procedural background, the static background poster instead of the live 3D scene, no sound,
 * no custom cursor.
 */
export const TEST_FLAGS = { test: '1', intro: '0', seed: '42', city: 'poster', sound: '0', cursor: '0' } as const;

/** Relative URL of the app with query flags (null drops a flag). */
export function appPath(flags: Record<string, string | null> = {}, path = ''): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...TEST_FLAGS, ...flags })) if (v !== null) q.set(k, v);
  return `/${path}?${q.toString()}`;
}

/** Data selectors (one selector each, so specs can append to them). */
export const sel = {
  header: 'header[data-hud]',
  hud: 'footer[data-hud]',
  panel: '[data-detail-panel]',
  mediaSlot: '[data-media-slot]',
  specCard: '[data-spec-card]',
  hint: '[aria-label="Controls"] li',
  keycap: '[data-hud] kbd',
  city: '[data-city-mode]',
  wheel: 'svg[data-active]',
  /** The wheel's category buttons (skill nodes carry data-cat-id too). */
  category: '[data-cat-id]:not([data-node-id])',
  node: '[data-node-id]',
  /** The header's section dots, one per screen, in header order. */
  sectionDot: 'header[data-hud] ol li',
} as const;

export const ui = {
  sections: (page: Page): Locator => page.getByRole('navigation', { name: /sections/i }),
  prevSection: (page: Page): Locator => ui.sections(page).getByRole('button', { name: /previous/i }),
  nextSection: (page: Page): Locator => ui.sections(page).getByRole('button', { name: /next/i }),
  sectionTitle: (page: Page): Locator => ui.sections(page).getByRole('heading'),
  /** The header in the detail view: previous/next category. */
  categoryNav: (page: Page): Locator => page.getByRole('navigation', { name: /categor/i }),
  header: (page: Page): Locator => page.locator(sel.header).first(),
  hud: (page: Page): Locator => page.locator(sel.hud).first(),
  panel: (page: Page): Locator => page.locator(sel.panel).first(),
  hints: (page: Page): Locator => page.locator(sel.hint),
  keycaps: (page: Page): Locator => page.locator(sel.keycap),
  city: (page: Page): Locator => page.locator(sel.city).first(),
  wheel: (page: Page): Locator => page.locator(sel.wheel).first(),
  categories: (page: Page): Locator => page.locator(`${sel.wheel} ${sel.category}`),
  nodes: (page: Page): Locator => page.locator(sel.node),
  node: (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`),
  sectionDots: (page: Page): Locator => page.locator(sel.sectionDot),
  /** Anchored: skill titles such as "Back-end data checks" also contain the word. */
  back: (page: Page): Locator => page.getByRole('button', { name: /^back$/i }),
  softSkills: (page: Page): Locator => page.getByRole('button', { name: /soft skills/i }),
  /** A screen root (Profile, Experience, …): a named region. */
  screen: (page: Page, name: RegExp): Locator => page.getByRole('region', { name }),
};

/** Collect console errors and page errors for the lifetime of the page (blocked analytics excluded). */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Open the app in test mode and wait until the hooks report ready. */
export async function openApp(page: Page, flags: Record<string, string | null> = {}): Promise<void> {
  await page.goto(appPath(flags));
  await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
  await page.evaluate(() => window.__site!.ready);
}

export async function appState(page: Page): Promise<{ screen: Screen; wheel: string; mode: Mode; intro: boolean }> {
  return page.evaluate(() => {
    const s = window.__site!.getState();
    return { screen: s.screen, wheel: s.wheel, mode: s.mode, intro: s.intro };
  });
}

/** Category ids of a wheel, in ring order, read from the app (never hard-coded: content changes). */
export async function categoryIds(page: Page, wheel: 'hard' | 'soft' = 'hard'): Promise<string[]> {
  return page.evaluate((w) => window.__site!.getState().nav[w].map((c) => c.id), wheel);
}

/** Each category of a wheel with the node selected when it opens. */
export async function categories(page: Page, wheel: 'hard' | 'soft' = 'hard'): Promise<{ id: string; node: string | null }[]> {
  return page.evaluate((w) => window.__site!.getState().nav[w].map((c) => ({ id: c.id, node: c.defaultNode })), wheel);
}

/**
 * Dispatch actions through the app's store and let each transition finish on the manual clock.
 * The clock stays manual afterwards, so the next step starts from a settled layout.
 */
export async function dispatch(page: Page, ...actions: Action[]): Promise<void> {
  await page.evaluate(async (list) => {
    window.__wheel!.manual(true);
    for (const a of list) {
      window.__site!.dispatch(a);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      window.__wheel!.settle();
    }
  }, actions);
}

/** Let running transitions finish on the (manual) clock, then give the page two frames to paint. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__wheel!.manual(true);
    window.__wheel!.settle();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/** An idle period of the browser, then two frames: UI mounted lazily after load is up. */
export async function afterIdle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestIdleCallback(() => requestAnimationFrame(() => requestAnimationFrame(() => r())), { timeout: 2_000 }),
      ),
  );
}

/**
 * The screens in header order (the order of the header's dots), read from the app: one "next
 * section" step per dot, starting from the current screen, which it ends on again since the order
 * wraps around. Call it before the steps a test checks: it changes screens. Specs use this
 * instead of a hard-coded list, so adding or reordering a section does not break them.
 */
export async function screenOrder(page: Page): Promise<Screen[]> {
  const dots = ui.sectionDots(page);
  const count = await dots.count();
  const active = await dots.evaluateAll((els) => els.findIndex((el) => el.hasAttribute('data-active')));
  const visited = await page.evaluate(async (n) => {
    window.__wheel!.manual(true);
    const order: Screen[] = [];
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    for (let i = 0; i < n; i++) {
      order.push(window.__site!.getState().screen);
      window.__site!.dispatch({ t: 'tab', dir: 1 });
      await frame();
      window.__wheel!.settle();
    }
    return order;
  }, count);
  // visited[k] is the screen k steps after the active one: rotate into header order.
  return visited.map((_s, i) => visited[(i - Math.max(active, 0) + count) % count]);
}

/** The section names as the header's dots label them, in header order. */
export async function sectionNames(page: Page): Promise<string[]> {
  return ui.sectionDots(page).locator('button').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
}

/**
 * Viewport point on a category's arc (mid-angle, mid-stroke), so a test can aim a real pointer at
 * it. Call settle() first.
 */
export async function arcPoint(page: Page, catId: string, radiusFactor = 0.5): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ catId, radiusFactor }) => {
      const g = window.__wheel!.geometry();
      const arc = g.arcs.find((a) => a.id === catId);
      if (!arc) throw new Error(`no arc for ${catId}`);
      const theta = (((arc.a0 + arc.a1) / 2) * Math.PI) / 180;
      const r = g.rInner + (g.rOuter - g.rInner) * radiusFactor;
      const x = g.center.x + r * Math.sin(theta);
      const y = g.center.y - r * Math.cos(theta);
      const svg = document.querySelector('svg[data-active]') ?? document.querySelector('[data-node-id]')?.closest('svg');
      const m = (svg as SVGSVGElement | null)?.getScreenCTM();
      return m ? { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f } : { x, y };
    },
    { catId, radiusFactor },
  );
}

/** Wait until the app reaches a mode (kind, and category when given). */
export async function expectMode(page: Page, kind: Mode['kind'], cat?: string): Promise<void> {
  await expect
    .poll(async () => {
      const m = (await appState(page)).mode;
      return m.kind === kind && (cat === undefined || ('cat' in m && m.cat === cat));
    })
    .toBe(true);
}

/**
 * How long the URL must hold still to count as settled. The app re-checks each URL write a short
 * moment later and repairs one the framework router reverted; a revert and its repair both fall
 * inside this window.
 */
export const URL_STABLE_MS = 500;

/**
 * Wait until location.hash settles on `expected`: equal to it and unchanged for URL_STABLE_MS. It
 * samples, because pushState/replaceState fire no event.
 */
export async function expectHashSettles(page: Page, expected: string, message = `the URL settles on ${expected}`): Promise<void> {
  let last: string | null = null;
  let since = 0;
  await expect
    .poll(
      async () => {
        const hash = await page.evaluate(() => location.hash);
        if (hash !== last) {
          last = hash;
          since = Date.now();
        }
        return { hash, settled: Date.now() - since >= URL_STABLE_MS };
      },
      { message, intervals: [25] },
    )
    .toEqual({ hash: expected, settled: true });
}

/** What has keyboard focus: a category button, a node, or another element (with its accessible text). */
export async function focused(page: Page): Promise<{ cat: string | null; node: string | null; tag: string; text: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const isNode = Boolean(el?.hasAttribute('data-node-id'));
    return {
      cat: el && !isNode ? el.getAttribute('data-cat-id') : null,
      node: isNode ? el!.getAttribute('data-node-id') : null,
      tag: el?.tagName.toLowerCase() ?? '',
      text: `${el?.getAttribute('aria-label') ?? ''} ${el?.textContent ?? ''}`.replace(/\s+/g, ' ').trim(),
    };
  });
}

export type Focus = Awaited<ReturnType<typeof focused>>;

/**
 * Press Tab until `done(focus)` holds; returns every focus stop on the way (the last one matched).
 * Throws after `maxTabs` presses.
 */
export async function tabUntil(
  page: Page,
  done: (f: Focus) => boolean,
  { maxTabs = 40, what = 'the target' }: { maxTabs?: number; what?: string } = {},
): Promise<Focus[]> {
  const stops: Focus[] = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    stops.push(f);
    if (done(f)) return stops;
  }
  throw new Error(`${what} never received focus after ${maxTabs} Tab presses: ${stops.map((s) => s.cat ?? s.node ?? s.text.slice(0, 20)).join(' → ')}`);
}

/** Tab to the wheel's category stop. Returns its id. */
export async function tabToCategory(page: Page, maxTabs = 40): Promise<string> {
  const stops = await tabUntil(page, (f) => f.cat !== null, { maxTabs, what: 'a category button' });
  return stops[stops.length - 1].cat!;
}

/**
 * Keyboard-only path into a skill tree: Tab to the category stop, Enter opens it, and focus moves
 * to the selected node of the detail view. Returns that node's id.
 */
export async function tabToNode(page: Page, maxTabs = 40): Promise<string> {
  const cat = await tabToCategory(page, maxTabs);
  await page.keyboard.press('Enter');
  await expectMode(page, 'detail', cat);
  await expect.poll(async () => (await focused(page)).node, { message: 'focus moves to a node of the opened category' }).not.toBeNull();
  return (await focused(page)).node!;
}

/** Fire keydowns in one task: input faster than any frame, the way a double press can arrive. */
export async function keysInOneTask(page: Page, keys: string[]): Promise<void> {
  await page.evaluate((ks) => {
    for (const key of ks) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }, keys);
}
