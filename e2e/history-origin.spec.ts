import type { Page } from '@playwright/test';
import { appState, dispatch, expectMode, openApp, sel } from './support/app';
import { expect, test } from './support/test';

/**
 * A skill reached by the browser's Back keeps the origin it was opened with. The detail panel's
 * employer chip is a plain #/experience link the browser follows itself; Back onto the skill from
 * there must not stamp Experience as its origin, so Esc still returns to the hub or to the screen a
 * chip opened it from. And every history entry keeps the title of its own view: a title set while
 * the app's own back() is on its way must not land on the entry being left (which Forward shows).
 */

const SKILL_LINK = /^Show .+ on the skill wheel$/;
const EMPLOYER_LINK = /on the Experience tab$/;

/** Where the app is, as one string: screen/mode, plus "<origin" for a detail view that has one. */
const place = (page: Page) =>
  page.evaluate(() => {
    const s = window.__site!.getState();
    return `${s.screen}/${s.mode.kind}${s.mode.kind === 'detail' && s.mode.from ? `<${s.mode.from}` : ''}`;
  });

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name every page title ends with ("<view> · <name>"), read from the live title. */
async function titleSuffix(page: Page): Promise<string> {
  const title = await page.title();
  expect(title, 'the title reads "<view> · <name>"').toMatch(/^.+ · .+$/);
  return title.slice(title.lastIndexOf(' · ') + 3);
}

/** Press E until the given screen shows (the order of the screens is not assumed). */
async function pressEUntil(page: Page, screen: string): Promise<void> {
  for (let i = 0; i < 12 && (await appState(page)).screen !== screen; i++) {
    const before = (await appState(page)).screen;
    await page.keyboard.press('e');
    await expect.poll(async () => (await appState(page)).screen).not.toBe(before);
  }
  expect((await appState(page)).screen).toBe(screen);
}

/**
 * A skill some Experience role lists (so its detail panel has an employer chip), found in a page of
 * its own so the test's history stays untouched.
 */
async function skillWithEmployer(page: Page): Promise<{ cat: string; node: string }> {
  const scout = await page.context().newPage();
  try {
    await openApp(scout);
    await dispatch(scout, { t: 'tab/set', screen: 'experience' });
    const href = await scout.locator('main').getByRole('link', { name: SKILL_LINK }).first().getAttribute('href');
    const [, , cat, node] = (href ?? '').split('/');
    expect(cat && node, `an Experience skill chip links to a skill (${href})`).toBeTruthy();
    return { cat, node };
  } finally {
    await scout.close();
  }
}

/** The detail panel's first employer chip: a plain link to the Experience tab. */
async function followEmployerChip(page: Page): Promise<void> {
  const employer = page.locator(sel.panel).getByRole('link', { name: EMPLOYER_LINK }).first();
  await expect(employer).toHaveAttribute('href', '#/experience');
  await employer.click();
  await expect.poll(() => place(page)).toBe('experience/idle');
}

test.describe('Back onto a skill keeps the origin it was opened with', { tag: '@critical' }, () => {
  test('opened on the hub: employer chip, Back, Esc ends on the hub', async ({ page }) => {
    const { cat, node } = await skillWithEmployer(page);
    await openApp(page);
    await dispatch(page, { t: 'cat/open', cat, node });
    await expectMode(page, 'detail', cat);
    await followEmployerChip(page);
    await page.goBack();
    await expect.poll(() => place(page)).toBe('skills/detail');
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('skills/idle');
    // The hub's own entry: the first one, whose bare URL stays bare.
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^(#\/skills)?$/);
  });

  test('opened by a Projects tag: employer chip, Back, Esc ends on Projects', async ({ page }) => {
    await openApp(page);
    await pressEUntil(page, 'projects');
    // A tag whose skill has an employer (an Experience role lists it).
    const tags = page.locator('main').getByRole('link', { name: SKILL_LINK });
    const count = await tags.count();
    let opened = false;
    for (let i = 0; i < count && !opened; i++) {
      await tags.nth(i).click();
      await expectMode(page, 'detail');
      const employers = await page.locator(sel.panel).getByRole('link', { name: EMPLOYER_LINK }).count();
      if (employers > 0) opened = true;
      else {
        await page.keyboard.press('Escape');
        await expect.poll(() => place(page)).toBe('projects/idle');
      }
    }
    expect(opened, 'a Projects tag opens a skill with an employer chip').toBe(true);
    await expect.poll(() => place(page)).toBe('skills/detail<projects');
    await followEmployerChip(page);
    await page.goBack();
    await expect.poll(() => place(page)).toBe('skills/detail<projects');
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('projects/idle');
    await expect(page).toHaveURL(/#\/projects$/);
  });

  test('a chip-opened skill, Esc, Forward, Esc: back on the chip’s screen', async ({ page }) => {
    await openApp(page);
    await pressEUntil(page, 'experience');
    await expect.poll(() => place(page)).toBe('experience/idle');
    await page.locator('main').getByRole('link', { name: SKILL_LINK }).first().click();
    await expect.poll(() => place(page)).toBe('skills/detail<experience');
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('experience/idle');
    await page.goForward();
    await expect.poll(() => place(page)).toBe('skills/detail<experience');
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('experience/idle');
  });
});

test.describe('history entries keep their own titles', () => {
  /** The session history's entries (URL hash and title) and the current index, read over CDP. */
  async function entries(page: Page): Promise<{ index: number; list: { hash: string; title: string }[] }> {
    const cdp = await page.context().newCDPSession(page);
    const h = await cdp.send('Page.getNavigationHistory');
    await cdp.detach();
    return { index: h.currentIndex, list: h.entries.map((e) => ({ hash: new URL(e.url).hash, title: e.title })) };
  }

  /** The entry Forward would show. */
  const forwardEntry = async (page: Page) => {
    const h = await entries(page);
    return h.list[h.index + 1];
  };

  test('1, →, ↓, Esc: the forward entry keeps the skill’s title, the hub entry the hub’s', async ({ page }) => {
    await openApp(page);
    const hubTitle = await page.title();
    const name = await titleSuffix(page);
    await page.keyboard.press('1');
    await expectMode(page, 'detail');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    // A skill's title: "<skill> · <category> · <name>".
    await expect(page).toHaveTitle(new RegExp(`^.+ · .+ · ${escapeRe(name)}$`));
    const skillHash = await page.evaluate(() => location.hash);
    const skillTitle = await page.title();
    const before = await entries(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('skills/idle');
    await expect(page).toHaveTitle(hubTitle);
    await expect.poll(() => forwardEntry(page)).toEqual({ hash: skillHash, title: skillTitle });
    const after = await entries(page);
    expect(after.list[after.index]).toEqual({ hash: expect.stringMatching(/^(#\/skills)?$/), title: hubTitle });
    // The entries behind are unchanged.
    expect(after.list.slice(0, after.index)).toEqual(before.list.slice(0, after.index));
  });

  test('an Experience chip, then Esc: the forward entry carries the skill’s title', async ({ page }) => {
    await openApp(page);
    const name = await titleSuffix(page);
    await pressEUntil(page, 'experience');
    await expect(page).toHaveTitle(new RegExp(`^Experience · ${escapeRe(name)}$`, 'i'));
    const experienceTitle = await page.title();
    await page.locator('main').getByRole('link', { name: SKILL_LINK }).first().click();
    await expectMode(page, 'detail');
    await expect(page).toHaveTitle(new RegExp(`^.+ · .+ · ${escapeRe(name)}$`));
    const skillHash = await page.evaluate(() => location.hash);
    const skillTitle = await page.title();
    await page.keyboard.press('Escape');
    await expect.poll(() => place(page)).toBe('experience/idle');
    await expect(page).toHaveTitle(experienceTitle);
    await expect.poll(() => forwardEntry(page)).toEqual({ hash: skillHash, title: skillTitle });
    const after = await entries(page);
    expect(after.list[after.index]).toEqual({ hash: '#/experience', title: experienceTitle });
  });
});
