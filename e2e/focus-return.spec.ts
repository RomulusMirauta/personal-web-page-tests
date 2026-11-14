import type { Locator, Page } from '@playwright/test';
import { appPath, appState, categoryIds, dispatch, expectMode, openApp, sel, settle } from './support/app';
import { decode } from './support/png';
import { expect, test } from './support/test';
import type { Action } from './support/types';

/**
 * Where keyboard focus lands. A skill chip that opened the detail view gets focus back when the
 * view closes (Esc, the footer's Back hint, the browser's Back) instead of the screen title a whole
 * screen of Tabs away; a chip that "+N" revealed returns focus to its own entry; and only a close
 * does this (the panel's employer chip is a detour: Back onto the skill and Esc still return to the
 * chip). Tab never parks a control in a scroll area's edge fade; the first Tab after the intro
 * reaches the player card; the footer's hint buttons show a focus ring.
 */

const CHIPS = 'main a[href^="#/skills/"]';
/** Below this mask opacity a focused control counts as faded out. */
const MIN_ALPHA = 0.75;

/**
 * The focused element's place in its scroll area: the edge fade's opacity at its centre (1: no
 * fade). The fade heights are read from the area's own CSS custom properties.
 */
const focusInArea = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const area = el?.closest<HTMLElement>('[data-scroll]');
    if (!el || !area || area === el) return null;
    const b = el.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    const scale = a.height / area.offsetHeight || 1; // the stage may be scaled with a transform
    const cs = getComputedStyle(area);
    const fadeTop = parseFloat(cs.getPropertyValue('--fade-top')) * scale;
    const fadeBottom = parseFloat(cs.getPropertyValue('--fade-bottom')) * scale;
    const cy = b.top + b.height / 2;
    let alpha = 1;
    if (area.hasAttribute('data-more-below') && cy > a.bottom - fadeBottom) alpha = Math.max(0, (a.bottom - cy) / fadeBottom);
    if (area.hasAttribute('data-more-above') && cy < a.top + fadeTop) alpha = Math.min(alpha, Math.max(0, (cy - a.top) / fadeTop));
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return { name, alpha, fades: fadeTop > 0 && fadeBottom > 0, visible: b.bottom > a.top && b.top < a.bottom };
  });

/** Wait until the scroll areas have stopped moving (a focus scroll may be smooth). */
const scrollsSettled = (page: Page) =>
  page.evaluate(async () => {
    const tops = () => [...document.querySelectorAll('[data-scroll]')].map((el) => el.scrollTop).join();
    for (let last = tops(), i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = tops();
      if (now === last) return;
      last = now;
    }
  });

/** The focused skill chip: its link and which of the screen's chips with that link it is. */
const focusedChip = (page: Page) =>
  page.evaluate((selector) => {
    const el = document.activeElement;
    if (!el?.matches(selector)) return null;
    const href = el.getAttribute('href')!;
    const same = [...document.querySelectorAll(selector)].filter((c) => c.getAttribute('href') === href);
    return { href, index: same.indexOf(el) };
  }, CHIPS);

/** The focused element's timeline entry on Experience (its place among the screen's entries), or -1. */
const focusedEntry = (page: Page) =>
  page.evaluate(() => {
    const entry = document.activeElement?.closest('main ol > li');
    return entry ? [...document.querySelectorAll('main ol > li')].indexOf(entry) : -1;
  });

/** The detail panel's first employer chip: a plain link to the Experience tab, which the browser follows. */
const employerChip = (page: Page) => page.locator(sel.panel).getByRole('link', { name: /on the Experience tab$/ }).first();

/** Focus where it lands now: shown in its area, outside the fades. */
async function expectFocusShown(page: Page) {
  await scrollsSettled(page);
  const at = await focusInArea(page);
  expect(at?.visible, 'the focus shows in its area').toBe(true);
  expect(at!.fades, 'the scroll area declares its fade heights').toBe(true);
  expect(at!.alpha, `"${at!.name}" sits outside the fades`).toBeGreaterThanOrEqual(MIN_ALPHA);
}

async function openScreen(page: Page, screen: 'experience' | 'projects', size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await openApp(page);
  await dispatch(page, { t: 'tab/set', screen });
  await settle(page);
  await page.mouse.move(1, 300);
}

/** Tab until the `nth` skill chip of the screen has focus (deep enough that its area has scrolled). */
async function tabToChip(page: Page, nth: number) {
  let seen = 0;
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, CHIPS)) seen += 1;
    if (seen === nth) return (await focusedChip(page))!;
  }
  throw new Error(`Tab never reached chip ${nth}`);
}

const LAPTOP = { width: 1366, height: 768 };

test.describe('focus goes back to the chip that opened a skill', { tag: ['@a11y', '@critical'] }, () => {
  for (const screen of ['experience', 'projects'] as const) {
    for (const how of ['Escape', 'the footer Back hint', 'browser Back'] as const) {
      test(`${screen}, ${LAPTOP.width}×${LAPTOP.height}: Enter on a chip, then ${how}`, async ({ page }) => {
        await openScreen(page, screen, LAPTOP);
        const total = await page.locator(CHIPS).count();
        expect(total, 'the screen has skill chips').toBeGreaterThan(0);
        const chip = await tabToChip(page, Math.min(total, 8));
        await page.keyboard.press('Enter');
        await expectMode(page, 'detail');
        if (how === 'Escape') await page.keyboard.press('Escape');
        else if (how === 'the footer Back hint') await page.locator(sel.hud).getByRole('button', { name: /^.*back$/i }).click();
        else await page.goBack();
        await expect.poll(async () => (await appState(page)).screen).toBe(screen);
        await expect.poll(() => focusedChip(page)).toEqual(chip);
        await expectFocusShown(page);
        // The next Tab goes on from the chip, not from the top of the screen.
        const before = await page.evaluateHandle(() => document.activeElement!);
        await page.keyboard.press('Tab');
        const after = await page.evaluate(
          (prev) => {
            const el = document.activeElement!;
            return { inMain: el.closest('main') !== null, follows: (prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 };
          },
          before,
        );
        expect(after).toEqual({ inMain: true, follows: true });
      });
    }
  }
});

test.describe('a chip that "+N" revealed: focus comes back to its own entry', { tag: '@a11y' }, () => {
  for (const how of ['Escape', 'browser Back'] as const) {
    test(`Experience, ${LAPTOP.width}×${LAPTOP.height}: expand an entry, Enter on a chip it revealed, then ${how}`, async ({ page }) => {
      await openScreen(page, 'experience', LAPTOP);
      // Keyboard only: Tab to the first entry's "+N", expand it, Shift+Tab onto the last chip it shows.
      const onMore = () => page.evaluate(() => /^Show \d+ more skills?$/.test(document.activeElement?.getAttribute('aria-label') ?? ''));
      for (let i = 0; i < 80 && !(await onMore()); i++) await page.keyboard.press('Tab');
      expect(await onMore(), 'Tab reaches a "+N"').toBe(true);
      const shown = await page.evaluate(
        () => [...document.activeElement!.closest('ul')!.querySelectorAll('a')].filter((a) => a.checkVisibility({ visibilityProperty: true })).length,
      );
      await page.keyboard.press('Enter');
      await expect(page.locator(':focus')).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Shift+Tab');
      const opened = await page.evaluate(() => {
        const el = document.activeElement!;
        const entries = [...document.querySelectorAll('main ol > li')];
        return {
          href: el.getAttribute('href'),
          entry: entries.indexOf(el.closest('main ol > li')!),
          place: [...el.closest('ul')!.querySelectorAll('a')].indexOf(el as HTMLAnchorElement),
        };
      });
      expect(opened.href).toMatch(/^#\/skills\//);
      expect(opened.place, 'a chip the collapsed entry does not show').toBeGreaterThanOrEqual(shown);
      await page.keyboard.press('Enter');
      await expectMode(page, 'detail');
      if (how === 'Escape') await page.keyboard.press('Escape');
      else await page.goBack();
      await expect.poll(async () => (await appState(page)).screen).toBe('experience');
      // The entry shows collapsed again: focus is on its own "+N" (or the chip itself, were it
      // shown), never on a twin chip of the same skill in another entry.
      await expect.poll(() => focusedEntry(page)).toBe(opened.entry);
      const target = await page.evaluate(() => ({ href: document.activeElement!.getAttribute('href'), expanded: document.activeElement!.getAttribute('aria-expanded') }));
      expect(target.href === opened.href || target.expanded === 'false', JSON.stringify(target)).toBe(true);
      await expectFocusShown(page);
    });
  }
});

test.describe('only a close gives the chip focus back: a link followed out of the skill is a detour', { tag: '@a11y' }, () => {
  test(`Experience, ${LAPTOP.width}×${LAPTOP.height}: the employer chip leaves focus to the tab; Back and Esc then return to the chip`, async ({ page }) => {
    await openScreen(page, 'experience', LAPTOP);
    // A chip a few entries down the timeline (its skill's panel names the employers that used it).
    const entries = page.locator('main ol').first().locator(':scope > li');
    const chip = entries.nth(Math.min(2, (await entries.count()) - 1)).locator(CHIPS.replace('main ', '')).first();
    await chip.focus();
    const opened = (await focusedChip(page))!;
    expect(opened).not.toBeNull();
    const entry = await focusedEntry(page);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail');
    await employerChip(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await appState(page)).mode.kind).toBe('idle');
    expect((await appState(page)).screen).toBe('experience');
    // Followed, not closed: focus is not forced back onto the chip; it lands on the tab's title.
    await expect(page.locator('[data-focus-landing="screen"]')).toBeFocused();
    expect(await focusedChip(page)).toBeNull();
    // Back onto the skill, then Esc: that closes it, onto the chip that opened it.
    await page.goBack();
    await expectMode(page, 'detail');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).screen).toBe('experience');
    await expect.poll(() => focusedChip(page)).toEqual(opened);
    expect(await focusedEntry(page)).toBe(entry);
    await expectFocusShown(page);
  });

  test(`Projects, ${LAPTOP.width}×${LAPTOP.height}: a tag’s skill, its employer chip, Back, Esc: focus is on the tag again`, async ({ page }) => {
    await openScreen(page, 'projects', LAPTOP);
    const tags = page.locator(CHIPS);
    let opened: Awaited<ReturnType<typeof focusedChip>> = null;
    for (let i = 0, n = await tags.count(); i < n && !opened; i++) {
      await tags.nth(i).focus();
      const tag = await focusedChip(page);
      await page.keyboard.press('Enter');
      await expectMode(page, 'detail');
      if ((await employerChip(page).count()) > 0) opened = tag;
      else {
        await page.keyboard.press('Escape');
        await expect.poll(() => focusedChip(page)).toEqual(tag);
      }
    }
    expect(opened, 'a Projects tag opens a skill with an employer chip').not.toBeNull();
    await employerChip(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await appState(page)).screen).toBe('experience');
    await page.goBack();
    await expectMode(page, 'detail');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).screen).toBe('projects');
    await expect.poll(() => focusedChip(page)).toEqual(opened);
    await expectFocusShown(page);
  });
});

test.describe('Tab focus never rests in a scroll fade', { tag: '@a11y' }, () => {
  for (const size of [LAPTOP, { width: 1280, height: 720 }]) {
    for (const screen of ['experience', 'projects'] as const) {
      test(`${screen} at ${size.width}×${size.height}`, async ({ page }) => {
        await openScreen(page, screen, size);
        const faded: string[] = [];
        let stops = 0;
        for (let i = 0; i < 90; i++) {
          await page.keyboard.press('Tab');
          if (await page.evaluate((hud) => document.activeElement?.closest(hud) !== null, sel.hud)) break; // past the screen
          await scrollsSettled(page);
          const at = await focusInArea(page);
          if (!at) continue;
          expect(at.fades, 'the scroll area declares its fade heights').toBe(true);
          stops += 1;
          if (at.alpha < MIN_ALPHA) faded.push(`"${at.name}" at ${at.alpha.toFixed(2)}`);
        }
        expect(stops, 'the walk went through the scroll area').toBeGreaterThan(5);
        expect(faded).toEqual([]);
      });
    }
  }
});

test('after the intro, the page heading has focus and the first Tab reaches the player card', { tag: ['@a11y', '@critical'] }, async ({ page }) => {
  await page.goto(appPath({ intro: null }));
  await expect(page.locator('html')).toHaveAttribute('data-intro', 'play');
  await page.waitForFunction(() => Boolean(window.__site));
  await page.evaluate(() => window.__site!.ready);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await appState(page)).intro).toBe(false);
  await expect(page.locator('[data-focus-landing="page"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('complementary', { name: 'Player card' }).getByRole('button')).toBeFocused();
});

/**
 * Pixels that change in the band just outside the hint between its focused and unfocused look, per
 * side (the ring is the only thing that changes there).
 */
async function ringSides(page: Page, hint: Locator): Promise<Record<'top' | 'right' | 'bottom' | 'left', number>> {
  const box = (await hint.boundingBox())!;
  const pad = 6;
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad), width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad) };
  await settle(page);
  const focusedShot = decode(await page.screenshot({ clip, animations: 'disabled' }));
  await hint.evaluate((el) => (el as HTMLElement).blur());
  await settle(page);
  const plainShot = decode(await page.screenshot({ clip, animations: 'disabled' }));
  const sides = { top: 0, right: 0, bottom: 0, left: 0 };
  const scale = focusedShot.width / clip.width; // device pixels per CSS px
  for (let y = 0; y < focusedShot.height; y++) {
    for (let x = 0; x < focusedShot.width; x++) {
      const cx = clip.x + x / scale;
      const cy = clip.y + y / scale;
      const i = (y * focusedShot.width + x) * 4;
      const a = focusedShot.data;
      const b = plainShot.data;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d < 90) continue;
      if (!(cx > box.x - 5 && cx < box.x + box.width + 5 && cy > box.y - 5 && cy < box.y + box.height + 5)) continue;
      if (cy < box.y - 0.5) sides.top++;
      else if (cy > box.y + box.height + 0.5) sides.bottom++;
      else if (cx < box.x - 0.5) sides.left++;
      else if (cx > box.x + box.width + 0.5) sides.right++;
    }
  }
  return sides;
}

test.describe('footer hints show a focus ring', { tag: '@a11y' }, () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const size of [{ width: 1920, height: 1080 }, LAPTOP]) {
      test(`${theme}, ${size.width}×${size.height}: Close and Back hints`, async ({ page }) => {
        await page.setViewportSize(size);
        await openApp(page, { theme });
        await page.mouse.move(1, 300);
        const [firstCat] = await categoryIds(page);
        const cases: [string, Action[]][] = [
          ['close', [{ t: 'tab/set', screen: 'profile' }]],
          ['back', [{ t: 'tab/set', screen: 'skills' }, { t: 'cat/open', cat: firstCat }]],
        ];
        for (const [label, setup] of cases) {
          await dispatch(page, ...setup);
          await settle(page);
          const hint = page.locator(`${sel.hud} ul[aria-label="Controls"]`).getByRole('button', { name: new RegExp(`${label}$`, 'i') });
          await expect(hint).toHaveCount(1);
          // Keyboard focus: Tab onto it from the control before it.
          await hint.evaluate((el) => {
            const tabbable = [...document.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter(
              (e) => e.tabIndex >= 0 && !e.closest('[inert]') && e.checkVisibility(),
            );
            tabbable[tabbable.indexOf(el as HTMLElement) - 1]?.focus();
          });
          await page.keyboard.press('Tab');
          await expect(hint).toBeFocused();
          expect(await hint.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
          const sides = await ringSides(page, hint);
          for (const [side, n] of Object.entries(sides)) expect(n, `${label}: ring pixels on the ${side}`).toBeGreaterThan(0);
        }
      });
    }
  }
});
