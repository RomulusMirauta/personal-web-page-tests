import type { Locator, Page } from '@playwright/test';
import { appState, dispatch, openApp, sel, settle, ui } from './support/app';
import { expect, test } from './support/test';
import type { Action } from './support/types';

/**
 * Chips: a skill or employer name does the same thing on every screen, as a real link. Experience's
 * skill chips and the Projects tags that name a skill open that skill (#/skills/<cat>/<node>); the
 * detail panel's employer chips open Experience. A Ctrl/⌘ click opens the link in a new tab; Enter
 * and Space activate it. Plain-text chips (not links) are drawn solid, never dashed: a dashed rim
 * has a meaning of its own on the wheel.
 */

const SKILL_LINK = /^Show .+ on the skill wheel$/;

/** Screens settle their build-in animations (cards, entries) before a click lands on them. */
async function show(page: Page, ...actions: Action[]): Promise<void> {
  await dispatch(page, ...actions);
  await settle(page);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/** The first skill chip of the Experience timeline that is on screen (not folded behind "+N"). */
function experienceChip(page: Page): Locator {
  return ui.screen(page, /^experience$/i).locator('li:not([data-overflow]) > a[aria-label$="on the skill wheel"]').first();
}

/** The first Projects tag that names a skill. */
function projectsTag(page: Page): Locator {
  return ui.screen(page, /^projects$/i).getByRole('link', { name: SKILL_LINK }).first();
}

/** "#/skills/<cat>/<node>" → its parts. */
function skillOf(href: string): { cat: string; node: string } {
  expect(href).toMatch(/^#\/skills\/[\w-]+\/[\w-]+$/);
  const [, , cat, node] = href.split('/');
  return { cat, node };
}

test('a Projects tag that names a skill opens that skill; Esc goes back to Projects', { tag: '@critical' }, async ({ page }) => {
  await openApp(page);
  await show(page, { t: 'tab/set', screen: 'projects' });
  const tag = projectsTag(page);
  const href = (await tag.getAttribute('href'))!;
  const { cat, node } = skillOf(href);
  await tag.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
  // The app opens the skill on its own pushed entry, and the detail view remembers the screen it
  // was opened from, so Esc pops back to Projects.
  await expect.poll(async () => (await appState(page)).mode).toEqual({ kind: 'detail', cat, node, from: 'projects' });
  expect((await appState(page)).screen).toBe('skills');
  expect(await page.evaluate(() => (history.state as { detail?: boolean } | null)?.detail)).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await appState(page)).screen).toBe('projects');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/projects');
});

test('Ctrl/⌘ + click on an Experience skill chip opens the skill in a new tab and leaves this one', async ({ page, context }) => {
  await openApp(page);
  await show(page, { t: 'tab/set', screen: 'experience' });
  const chip = experienceChip(page);
  const href = (await chip.getAttribute('href'))!;
  const { cat, node } = skillOf(href);
  const [tab] = await Promise.all([context.waitForEvent('page'), chip.click({ modifiers: ['ControlOrMeta'] })]);
  await tab.waitForLoadState();
  expect(new URL(tab.url()).hash).toBe(href);
  // The new tab opens the app on that skill's detail view.
  await tab.waitForFunction(() => Boolean(window.__site && window.__wheel));
  await expect.poll(() => tab.evaluate(() => window.__site!.getState().mode)).toEqual({ kind: 'detail', cat, node });
  await tab.close();
  // This tab stays on Experience.
  expect((await appState(page)).screen).toBe('experience');
  expect(await page.evaluate(() => location.hash)).toBe('#/experience');
});

test('Enter and Space on a focused skill chip open the skill', { tag: '@critical' }, async ({ page }) => {
  await openApp(page);
  for (const key of ['Enter', 'Space']) {
    await show(page, { t: 'tab/set', screen: 'experience' });
    const chip = experienceChip(page);
    const href = (await chip.getAttribute('href'))!;
    await chip.focus();
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => location.hash), key).toBe(href);
    expect((await appState(page)).mode.kind).toBe('detail');
  }
  // A Projects tag too (its plain activation opens the skill like an Experience chip).
  await show(page, { t: 'tab/set', screen: 'projects' });
  const tag = projectsTag(page);
  const href = (await tag.getAttribute('href'))!;
  await tag.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
});

test('an employer chip of the detail view opens Experience', async ({ page }) => {
  await openApp(page);
  // A skill an Experience role lists, so its panel names the employer.
  await show(page, { t: 'tab/set', screen: 'experience' });
  const { cat, node } = skillOf((await experienceChip(page).getAttribute('href'))!);
  await show(page, { t: 'tab/set', screen: 'skills' }, { t: 'cat/open', cat, node });
  const employer = page.locator(sel.panel).getByRole('link', { name: /on the Experience tab$/ }).first();
  await expect(employer).toHaveAttribute('href', '#/experience');
  await employer.click();
  await expect.poll(async () => (await appState(page)).screen).toBe('experience');
  await expect(page).toHaveURL(/#\/experience$/);
});

test('plain-text chips are solid, never dashed, and as tall as the link chips beside them', async ({ page }) => {
  await openApp(page);
  /** Every visible chip under `root`: link or plain, its rim style, height and row. */
  const chips = (root: string) =>
    page.evaluate((rootSel) => {
      const local = (el: Element) => [...el.classList].map((c) => c.slice(c.lastIndexOf('_') + 1));
      return [...document.querySelectorAll(`${rootSel} *`)]
        .filter((el) => local(el).includes('chip') && el.getBoundingClientRect().height > 0)
        .map((el) => {
          const cs = getComputedStyle(el);
          return {
            text: el.textContent!.trim(),
            link: el.tagName === 'A' || el.tagName === 'BUTTON',
            style: cs.borderTopStyle,
            height: Math.round(el.getBoundingClientRect().height * 100) / 100,
            row: Math.round(el.getBoundingClientRect().top),
          };
        });
    }, root);

  await show(page, { t: 'tab/set', screen: 'projects' });
  const tags = await chips('section[aria-label="Projects"]');
  expect(tags.some((c) => !c.link), 'Projects has plain tags').toBe(true);
  expect(tags.some((c) => c.link), 'Projects has skill links').toBe(true);
  for (const c of tags) expect(['solid', 'none'], c.text).toContain(c.style);
  // One height per row of tags, plain or link.
  for (const top of new Set(tags.map((c) => c.row))) {
    expect(new Set(tags.filter((c) => c.row === top).map((c) => c.height)).size, `tags at y ${top}`).toBe(1);
  }

  // The detail views: employer, project and "Also used" chips ("+N" shows the folded ones). Walk the
  // first category's skills until one shows plain chips; none may be dashed on the way.
  const [first] = await page.evaluate(() => window.__site!.getState().nav.hard);
  await show(page, { t: 'tab/set', screen: 'skills' });
  let plain = 0;
  for (const n of first.nodes) {
    await show(page, { t: 'cat/open', cat: first.id, node: n.id });
    const more = page.locator(`${sel.panel} [data-chip-more] button`);
    if (await more.count()) await more.first().click();
    const detail = await chips(sel.panel);
    for (const c of detail) expect(['solid', 'none'], `${n.id}: ${c.text}`).toContain(c.style);
    plain += detail.filter((c) => !c.link).length;
    if (plain > 0) break;
  }
  expect(plain, 'some detail view has plain chips').toBeGreaterThan(0);
});
