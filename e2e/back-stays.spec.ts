import type { Page } from '@playwright/test';
import { appPath, appState, dispatch, expectHashSettles, expectMode, openApp, screenOrder, sel, ui } from './support/app';
import { expect, test } from './support/test';
import type { Screen } from './support/types';

/**
 * Navigation against the real framework router and real history traversals: the browser's Back
 * stays in the app until the visitor is back where they came in, Esc and Back agree on where a
 * skill opened by a chip returns to, the Skills tab shows the wheel its title names, and hash routes
 * survive what link trackers append to them.
 *
 * The screen order is read from the app (in a page of its own, so the test's history stays
 * untouched); no test assumes how many sections there are or which comes where.
 */

const SKILL_LINK = /^Show .+ on the skill wheel$/;
const HUB = 'skills/hard';

const screenIs = (page: Page, screen: string) => expect.poll(async () => (await appState(page)).screen).toBe(screen);
const historyLength = (page: Page) => page.evaluate(() => history.length);

/** The view as one string: screen / wheel, plus the category in a detail view (hover counts as the hub). */
const place = async (page: Page) => {
  const s = await appState(page);
  return s.mode.kind === 'detail' ? `${s.screen}/${s.wheel}/${s.mode.cat}` : `${s.screen}/${s.wheel}`;
};

/** The URL describes the view (written a moment after a push; the hub's own entry may be bare). */
const urlFollows = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__site!.getState();
        const hash = location.hash === '' ? '#/skills' : location.hash;
        if (s.screen !== 'skills') return hash === `#/${s.screen}`;
        const root = s.wheel === 'soft' ? '#/soft' : '#/skills';
        return s.mode.kind === 'detail' ? hash.startsWith(`${root}/${s.mode.cat}/`) : hash === root;
      }),
    )
    .toBe(true);

/**
 * Let the history settle before a traversal, as a visitor's pause would: the router marks an entry
 * the app pushed a frame or more later (a popstate onto an entry it has not marked reloads the
 * page), and the app re-checks its own URL writes shortly after them. The URL must describe the
 * view and then hold still.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => (history.state as { __NA?: unknown } | null)?.__NA === true);
  await urlFollows(page);
  await expectHashSettles(page, await page.evaluate(() => location.hash));
}

/** Open the app with a page before it, so Back out of the app shows (about:blank). */
async function openAfterBlank(page: Page, hash = ''): Promise<void> {
  await page.goto('about:blank');
  if (!hash) return openApp(page);
  await page.goto(`${appPath()}${hash}`);
  await page.waitForFunction(() => Boolean(window.__site));
  await page.evaluate(() => window.__site!.ready);
}

async function back(page: Page): Promise<void> {
  await page.goBack({ waitUntil: 'commit' });
}

/** Forward into the app (a fresh load when Back had left it): wait until it runs again. */
async function forward(page: Page): Promise<void> {
  await page.goForward({ waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.__site));
  await page.evaluate(() => window.__site!.ready);
}

type Marked = Window & { __sameDocument?: boolean };
/** Mark the document: a reload (the router reloads for a history state it cannot restore) drops the mark. */
const markDocument = (page: Page) => page.evaluate(() => void ((window as Marked).__sameDocument = true));
const reloaded = (page: Page) =>
  page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return (window as Marked).__sameDocument !== true || nav?.type === 'reload';
  });

/** Opens a throwaway page of the same context and runs `fn` on the app there. */
async function scout<T>(page: Page, fn: (p: Page) => Promise<T>): Promise<T> {
  const p = await page.context().newPage();
  try {
    await openApp(p);
    return await fn(p);
  } finally {
    await p.close();
  }
}

/** The screens in header order and a function giving the screen `k` E presses (negative: Q) away from Skills. */
async function sections(page: Page): Promise<{ order: Screen[]; from: (k: number) => Screen }> {
  const order = await scout(page, screenOrder);
  const start = order.indexOf('skills');
  expect(start, 'Skills is one of the sections').toBeGreaterThanOrEqual(0);
  expect(order.length, 'at least three sections').toBeGreaterThanOrEqual(3);
  const n = order.length;
  return { order, from: (k) => order[(((start + k) % n) + n) % n] };
}

/** Press E until the given screen shows (the order of the screens is not assumed), then let the URL settle. */
async function pressEUntil(page: Page, screen: string): Promise<void> {
  for (let i = 0; i < 12 && (await appState(page)).screen !== screen; i++) {
    const before = (await appState(page)).screen;
    await page.keyboard.press('e');
    await expect.poll(async () => (await appState(page)).screen).not.toBe(before);
  }
  expect((await appState(page)).screen).toBe(screen);
  await settled(page);
}

/** A skill some Experience role lists (its detail panel then has an employer chip). */
const skillWithEmployer = (page: Page) =>
  scout(page, async (p) => {
    await dispatch(p, { t: 'tab/set', screen: 'experience' });
    const href = (await p.locator('main').getByRole('link', { name: SKILL_LINK }).first().getAttribute('href')) ?? '';
    const [, , cat, node] = href.split('/');
    expect(cat && node, `an Experience skill chip links to a skill (${href})`).toBeTruthy();
    return { cat, node };
  });

/** A skill that is not its category's default, so the fallback cannot pass for it. */
const nonDefaultSkill = (page: Page) =>
  page.evaluate(() => {
    const c = window.__site!.getState().nav.hard.find((x) => x.nodes.length > 1)!;
    return { cat: c.id, node: c.nodes.find((n) => n.id !== c.defaultNode)!.id };
  });

test.describe('Back stays in the app', { tag: '@critical' }, () => {
  const cases = [
    { name: 'E E (two sections on)', keys: ['e', 'e'], at: (from: (k: number) => Screen) => `${from(2)}/hard` },
    { name: 'S (the soft wheel)', keys: ['s'], at: () => 'skills/soft' },
    { name: 'Q Q (two sections back)', keys: ['q', 'q'], at: (from: (k: number) => Screen) => `${from(-2)}/hard` },
    { name: '2 then S (a detail view left for the soft wheel)', keys: ['2', 's'], at: () => 'skills/soft' },
  ];
  for (const { name, keys, at: where } of cases) {
    test(`${name}: Back shows the hub, the next Back leaves, Forward comes back`, async ({ page }) => {
      const { from } = await sections(page);
      const at = where(from);
      await openAfterBlank(page);
      const length = await historyLength(page);
      for (const key of keys) await page.keyboard.press(key);
      await expect.poll(() => place(page)).toBe(at);
      await settled(page);
      expect(await historyLength(page), 'one entry above the hub, however it got there').toBe(length + 1);

      await back(page);
      await expect.poll(() => place(page)).toBe(HUB);
      await urlFollows(page);
      await back(page);
      await expect(page).toHaveURL('about:blank');
      await forward(page);
      await expect.poll(() => place(page)).toBe(HUB);
      await forward(page);
      await expect.poll(() => place(page)).toBe(at);
      await urlFollows(page);
    });
  }

  test('Esc from a tab pops its entry: the hub is the first entry again, Forward re-enters the tab', async ({ page }) => {
    const { from } = await sections(page);
    await openAfterBlank(page);
    await page.keyboard.press('e');
    await screenIs(page, from(1));
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe(HUB);
    await urlFollows(page);
    await page.goForward();
    await screenIs(page, from(1));
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });

  test('Q/E spam adds one history entry at most, and Back still shows the hub', async ({ page }) => {
    const { order, from } = await sections(page);
    await openApp(page);
    const length = await historyLength(page);
    // 20 keys, two E for every Q (8 steps on), then a run of E that does not end on Skills.
    const mixed = Array.from({ length: 20 }, (_, i) => (i % 3 === 2 ? 'q' : 'e'));
    const run = (8 + 19) % order.length === 0 ? 20 : 19;
    for (const keys of [mixed, Array.from({ length: run }, () => 'e')]) {
      for (const key of keys) await page.keyboard.press(key);
      await urlFollows(page);
      await expectHashSettles(page, await page.evaluate(() => location.hash), 'pending URL writes and their checks are done');
      expect(await historyLength(page)).toBeLessThanOrEqual(length + 1);
    }
    expect(await place(page)).toBe(`${from(8 + run)}/hard`);
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
  });

  test('a skill opened by a chip: Back returns to its screen, then the hub, then leaves', async ({ page }) => {
    await openAfterBlank(page);
    await pressEUntil(page, 'experience');
    await page.getByRole('link', { name: SKILL_LINK }).first().click();
    await expectMode(page, 'detail');
    await back(page);
    await screenIs(page, 'experience');
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });

  test('a deep link to a skill: Back leaves for the page before; after Esc that entry is the hub', async ({ page }) => {
    await openApp(page);
    const { cat, node } = await nonDefaultSkill(page);
    await openAfterBlank(page, `#/skills/${cat}/${node}`);
    await expect.poll(async () => (await appState(page)).mode).toMatchObject({ kind: 'detail', cat, node });
    await back(page);
    await expect(page).toHaveURL('about:blank');
    await forward(page);
    await expect.poll(async () => (await appState(page)).mode).toMatchObject({ kind: 'detail', cat, node });
    const length = await historyLength(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe(HUB);
    await urlFollows(page);
    expect(await historyLength(page)).toBe(length);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });

  test('a deep link to a tab: moving on writes the hub under the next tab, so Back shows the hub', async ({ page }) => {
    const { from } = await sections(page);
    // Two sections before Skills, so E lands on a tab, not on the hub.
    await openAfterBlank(page, `#/${from(-2)}`);
    await screenIs(page, from(-2));
    await page.keyboard.press('e');
    await screenIs(page, from(-1));
    await urlFollows(page);
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
    await urlFollows(page);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });

  // An entry the browser made itself has no history state: nothing is written over it when the
  // visitor moves on, so Back shows the place it was made for, and the page does not reload.
  test('a hash link the browser follows itself (a skill’s employer chip), then E: Back shows Experience again, without a reload', async ({ page }) => {
    const { order } = await sections(page);
    const afterExperience = order[(order.indexOf('experience') + 1) % order.length];
    const { cat, node } = await skillWithEmployer(page);
    await openAfterBlank(page);
    await dispatch(page, { t: 'cat/open', cat, node });
    await expectMode(page, 'detail', cat);
    const employer = page.locator(sel.panel).getByRole('link', { name: /on the Experience tab$/ }).first();
    await expect(employer).toHaveAttribute('href', '#/experience');
    await employer.click();
    await screenIs(page, 'experience');
    await page.keyboard.press('e');
    await screenIs(page, afterExperience);
    await settled(page);

    await markDocument(page);
    await back(page);
    await screenIs(page, 'experience');
    await urlFollows(page);
    expect(await reloaded(page)).toBe(false);
    await back(page);
    await expect.poll(() => place(page)).toBe(`skills/hard/${cat}`);
    await urlFollows(page);
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
    expect(await reloaded(page)).toBe(false);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });

  test('a hash typed in the address bar, then E: Back shows it again without a reload, Forward the tab, then the hub', async ({ page }) => {
    const { from } = await sections(page);
    const typed = from(-2);
    await openAfterBlank(page);
    const length = await historyLength(page);
    await page.goto(`${appPath()}#/${typed}`); // the same document: the browser adds an entry with no state
    await screenIs(page, typed);
    expect(await historyLength(page)).toBe(length + 1);
    await page.keyboard.press('e');
    await screenIs(page, from(-1));
    await settled(page);

    await markDocument(page);
    await back(page);
    await screenIs(page, typed);
    await urlFollows(page);
    expect(await reloaded(page)).toBe(false);
    await page.goForward({ waitUntil: 'commit' });
    await screenIs(page, from(-1));
    await urlFollows(page);
    await back(page);
    await screenIs(page, typed);
    await back(page);
    await expect.poll(() => place(page)).toBe(HUB);
    await urlFollows(page);
    expect(await reloaded(page)).toBe(false);
    await back(page);
    await expect(page).toHaveURL('about:blank');
  });
});

test.describe('Back and Esc', { tag: '@critical' }, () => {
  test('Esc from a skill opened by an Experience chip returns to Experience, whose entry survives', async ({ page }) => {
    await openApp(page);
    await pressEUntil(page, 'experience');
    const length = await historyLength(page);
    // The chips are #/skills/… links; a plain click still goes through the app.
    await page.getByRole('link', { name: SKILL_LINK }).first().click();
    await expectMode(page, 'detail');
    await expect(page).toHaveURL(/#\/skills\/[a-z0-9-]+\/[a-z0-9-]+$/);
    expect(await historyLength(page), 'the skill has its own entry').toBe(length + 1);

    await page.keyboard.press('Escape');
    await screenIs(page, 'experience');
    await expect(page).toHaveURL(/#\/experience$/);
    await expect(ui.sectionTitle(page)).toHaveText(/^experience$/i);
    expect(await historyLength(page), 'popped back to, not overwritten').toBe(length + 1);

    // Forward onto the skill again, then Esc: still back on Experience.
    await page.goForward();
    await expectMode(page, 'detail');
    await page.keyboard.press('Escape');
    await screenIs(page, 'experience');
    await expect(page).toHaveURL(/#\/experience$/);

    // The browser's own Back from the skill lands on Experience too.
    await page.goForward();
    await expectMode(page, 'detail');
    await page.goBack();
    await screenIs(page, 'experience');
    await expect(page).toHaveURL(/#\/experience$/);
    expect(await historyLength(page)).toBe(length + 1);
  });
});

test.describe('Tabs and hash routes', () => {
  test('the Skills tab shows the hard wheel after a visit to Soft skills: header and ring agree', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('s');
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    await page.keyboard.press('e');
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
    await page.keyboard.press('q');
    await screenIs(page, 'skills');
    expect((await appState(page)).wheel).toBe('hard');
    // Back on the hub's own entry, which keeps the bare URL the app was opened with.
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^(#\/skills)?$/);
    await expect(ui.sectionTitle(page)).toHaveText(/^skills$/i);
    await expect(ui.wheel(page)).not.toHaveAttribute('aria-label', /soft/i);
    // A #/soft link still opens the soft wheel.
    await page.evaluate(() => (location.hash = '#/soft'));
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    await expect(ui.wheel(page)).toHaveAttribute('aria-label', /soft/i);
  });

  test('a query string inside the hash (tracking parameters) is ignored and dropped from the URL', async ({ page }) => {
    const { from } = await sections(page);
    const tab = from(-1);
    await page.goto(`${appPath()}#/${tab}?utm_source=x`);
    await page.waitForFunction(() => Boolean(window.__site));
    await page.evaluate(() => window.__site!.ready);
    await screenIs(page, tab);
    await expect(page).toHaveURL(new RegExp(`#/${tab}$`));
    const { cat, node } = await nonDefaultSkill(page);
    await page.evaluate((h) => (location.hash = h), `#/skills/${cat}/${node}?utm_medium=social`);
    await expect.poll(async () => (await appState(page)).mode).toMatchObject({ kind: 'detail', cat, node });
    await expect(page).toHaveURL(new RegExp(`#/skills/${cat}/${node}$`));
  });
});
