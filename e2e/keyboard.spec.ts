import type { Page } from '@playwright/test';
import {
  appPath,
  appState,
  arcPoint,
  categoryIds,
  dispatch,
  expectMode,
  focused,
  openApp,
  screenOrder,
  sel,
  settle,
  tabToCategory,
  tabToNode,
  tabUntil,
  ui,
} from './support/app';
import { expect, test } from './support/test';
import type { Action } from './support/types';

/**
 * Everything is reachable without a pointer (WCAG 2.1.1), with visible focus. The hub has one roving
 * category stop (its nodes are not tab stops); Enter opens that category and focus moves to the
 * selected node, whose tree is then navigable. Enter/Space on any other focused control belong to
 * that control, and single-character shortcuts can be turned off (WCAG 2.1.4).
 */

/** Turn the single-character shortcuts off or on, as the app's own setting does. */
const setShortcuts = (page: Page, on: boolean) =>
  page.evaluate((value) => {
    document.documentElement.dataset.shortcuts = value;
  }, on ? 'on' : 'off');

const theme = (page: Page) => page.evaluate(() => window.__site!.getState().theme);
const uiHidden = (page: Page) => page.evaluate(() => window.__site!.getState().uiHidden);
const sound = (page: Page) => page.evaluate(() => window.__site!.getState().sound);
const menuTrigger = (page: Page) => page.getByRole('button', { name: 'Display options' });
const card = (page: Page) => page.locator('button:has([data-card-panel])');

/** The Display options row that has focus: its place among the menu's rows (-1: focus is elsewhere). */
const focusedRow = (page: Page) =>
  page.evaluate(() => {
    const row = document.activeElement?.closest('[data-row]');
    return row ? [...document.querySelectorAll('[data-row]')].indexOf(row) : -1;
  });

test.describe('keyboard-only flow', () => {
  test('opens a category from its tab stop and walks the open tree', { tag: ['@critical', '@a11y'] }, async ({ page }) => {
    await openApp(page);
    // Hub nodes are deliberately not tab stops: one roving category button stands for the wheel.
    await expect(page.locator(`${sel.node}[tabindex="0"]`)).toHaveCount(0);
    await expect(page.locator(`${sel.wheel} ${sel.category}[tabindex="0"]`)).toHaveCount(1);

    const cat = await tabToCategory(page);
    await expect(page.locator(`${sel.category}[data-cat-id="${cat}"]:focus-visible`)).toHaveCount(1);
    await expectMode(page, 'hover', cat);

    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cat);
    await expect.poll(async () => (await focused(page)).node).not.toBeNull();
    const nodeId = (await focused(page)).node!;
    await expect(page.locator(`[data-node-id="${nodeId}"]:focus-visible`)).toHaveCount(1);
    await expect(page.locator(`${sel.node}[tabindex="0"]`)).toHaveCount(1);
    const opened = (await appState(page)).mode;
    expect(opened.kind === 'detail' && opened.node).toBe(nodeId);

    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => {
        const m = (await appState(page)).mode;
        return m.kind === 'detail' ? m.node : null;
      })
      .not.toBe(nodeId);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expectMode(page, 'detail', cat);

    await page.keyboard.press('Escape');
    await expectMode(page, 'idle');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

  test('reaches a node with Tab and Enter only', { tag: ['@critical', '@a11y'] }, async ({ page }) => {
    await openApp(page);
    const nodeId = await tabToNode(page);
    expect((await focused(page)).node).toBe(nodeId);
  });

  test('switches sections with Q/E and opens categories with number keys', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    const n = screens.length;
    const start = screens.indexOf('skills');
    // E through every section, wrapping round to Skills again.
    for (let step = 1; step <= n; step++) {
      const screen = screens[(start + step) % n];
      await page.keyboard.press('e');
      await expect.poll(async () => (await appState(page)).screen).toBe(screen);
      if (screen !== 'skills') await expect(page).toHaveURL(new RegExp(`#/${screen}$`));
    }
    // Q goes the other way; Esc on a section returns to Skills.
    const before = screens[(start - 1 + n) % n];
    await page.keyboard.press('q');
    await expect(page).toHaveURL(new RegExp(`#/${before}$`));
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).screen).toBe('skills');

    // PageUp/PageDown scroll; they do not switch sections. The ArrowRight after them is a sentinel:
    // keys are handled in order, so once its hover shows, the page keys have been handled too.
    const cats = await categoryIds(page);
    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => {
        const s = await appState(page);
        return { screen: s.screen, mode: s.mode };
      }, 'PageDown / PageUp leave the hub alone; the ArrowRight after them hovers the first category')
      .toEqual({ screen: 'skills', mode: { kind: 'hover', cat: cats[0] } });

    await page.keyboard.press('2');
    await expectMode(page, 'detail', cats[1]);
    // Inside the detail view Q/E follow the header arrows: previous/next category.
    await page.keyboard.press('e');
    await expectMode(page, 'detail', cats[2 % cats.length]);
    await page.keyboard.press('q');
    await expectMode(page, 'detail', cats[1]);
    await page.keyboard.press('Escape');
    await expectMode(page, 'idle');
  });

  test('toggles the soft-skills wheel with S and returns with Escape', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('s');
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    await expect(page).toHaveURL(/#\/soft$/);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).wheel).toBe('hard');
  });

  test('moves the hover around the ring with the arrow keys and selects with Enter', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const cats = await categoryIds(page);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[0]);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[1]);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cats[1]);
  });

  test('Tab past the wheel ends the hover its focus held; Enter on SOFT SKILLS toggles the wheel', async ({ page }) => {
    await openApp(page);
    await expect(ui.softSkills(page)).toBeVisible();
    // Walk past the wheel: its category stop takes focus (and hovers) on the way, and the hover that
    // only keyboard focus held ends when focus leaves the wheel.
    const stops = await tabUntil(page, (f) => /soft skills/i.test(f.text) && f.cat === null && f.node === null, { what: 'the SOFT SKILLS button' });
    expect(stops.some((f) => f.cat !== null), 'Tab passes the wheel’s category stop before the SOFT SKILLS button').toBe(true);
    await expectMode(page, 'idle');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    expect((await appState(page)).mode.kind).not.toBe('detail');
  });

  test('Enter on the SOFT SKILLS control toggles the wheel instead of opening a pointer-held hover', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [cat] = await categoryIds(page);
    // A hover the pointer holds survives focus moving elsewhere: Enter then belongs to the focused control.
    const p = await arcPoint(page, cat);
    await page.mouse.move(p.x, p.y);
    await expectMode(page, 'hover', cat);
    await ui.softSkills(page).focus();
    await expectMode(page, 'hover', cat);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    expect((await appState(page)).mode.kind, 'Enter must not also open the hovered category').not.toBe('detail');
  });

  test('single-key shortcuts can be turned off; named keys keep working', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await setShortcuts(page, false);
    const cats = await categoryIds(page);
    for (const key of ['e', 'q', 's', '2']) await page.keyboard.press(key);
    // Arrow keys, Enter and Escape are not single-character shortcuts. ArrowRight is also the
    // sentinel: keys are handled in order, so once its hover shows, E, Q, S and 2 have been too.
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => {
        const s = await appState(page);
        return { screen: s.screen, wheel: s.wheel, mode: s.mode };
      }, 'E, Q, S and 2 do nothing with shortcuts off; the ArrowRight after them hovers the first category')
      .toEqual({ screen: 'skills', wheel: 'hard', mode: { kind: 'hover', cat: cats[0] } });
    await expect(page).not.toHaveURL(/#\/(?!skills)[a-z]/);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cats[0]);
    await page.keyboard.press('Escape');
    await expectMode(page, 'idle');
    // Back on: E switches sections again.
    await setShortcuts(page, true);
    await page.keyboard.press('e');
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
  });

  test('off the wheel ↑ ↓ / Home / End scroll the screen and ← → leave the section alone; Q / E switch', async ({ page }) => {
    // A small landscape window: the Experience timeline (the screen's primary region) overflows.
    await page.setViewportSize({ width: 1024, height: 576 });
    await openApp(page);
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await expect(page).toHaveURL(/#\/experience$/);
    const timeline = page.locator('main [data-scroll][data-scroll-primary]');
    await expect(timeline).toHaveAttribute('data-scrollable', '');
    // A focusable, named region (WCAG 2.1.1), and the footer says the keys scroll it.
    await expect(timeline).toHaveAttribute('tabindex', '0');
    await expect(timeline).toHaveAttribute('aria-label', /\S/);
    const hints = page.getByRole('list', { name: 'Controls' });
    await expect(hints).toContainText(/scroll/i);
    await expect(hints).not.toContainText(/navigate/i);

    // Nothing focused in it, the pointer away from it: the keys scroll the primary region.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const top = () => timeline.evaluate((el) => el.scrollTop);
    await page.keyboard.press('ArrowDown');
    await expect.poll(top).toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect.poll(() => timeline.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Home');
    await expect.poll(top).toBe(0);
    for (const key of ['ArrowRight', 'ArrowLeft']) await page.keyboard.press(key);
    expect((await appState(page)).screen).toBe('experience');

    // Focused, the region scrolls natively (the browser's own arrow-key scrolling).
    await timeline.focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(top).toBeGreaterThan(0);
    expect((await appState(page)).screen).toBe('experience');

    await page.keyboard.press('q');
    await expect.poll(async () => (await appState(page)).screen).not.toBe('experience');
  });
});

test.describe('keyboard: state and focus edge cases', () => {
  /** The stage has finished fading out (visibility hidden: the browser has dropped focus from it). */
  const stageGone = (page: Page) =>
    expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-stage]')!).visibility)).toBe('hidden');

  test('Enter and the arrows act on the highlighted category, not on the arc keyboard focus was left on', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    expect(cats.length).toBeGreaterThanOrEqual(4);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[0]);
    expect((await focused(page)).cat).toBe(cats[0]);
    // The mouse highlights another category; keyboard focus stays on the first arc.
    let p = await arcPoint(page, cats[2]);
    await page.mouse.move(p.x, p.y);
    await expectMode(page, 'hover', cats[2]);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[3]);
    await settle(page);
    p = await arcPoint(page, cats[0]);
    await page.mouse.move(p.x, p.y);
    await expectMode(page, 'hover', cats[0]);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cats[0]);
  });

  test('with single-key shortcuts off, letters, digits and Tab bring a hidden interface back', async ({ page }) => {
    await openApp(page);
    await setShortcuts(page, false);
    for (const key of ['x', 't', '5', 'Tab']) {
      await dispatch(page, { t: 'ui/hide' });
      expect(await uiHidden(page)).toBe(true);
      await page.keyboard.press(key);
      await expect.poll(() => uiHidden(page), `${key} shows the interface`).toBe(false);
    }
    // Keys off: T is not a shortcut, so it only brought the interface back.
    expect(await theme(page)).toBe('dark');
    // Shortcuts on: the scene keys keep it hidden, Tab still shows it.
    await setShortcuts(page, true);
    await dispatch(page, { t: 'ui/hide' });
    await page.keyboard.press('t');
    await expect.poll(() => theme(page)).toBe('light');
    expect(await uiHidden(page)).toBe(true);
    await page.keyboard.press('Tab');
    await expect.poll(() => uiHidden(page)).toBe(false);
  });

  test('showing the interface again gives focus back to where it was before hiding', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[0]);
    await page.keyboard.press('h');
    await stageGone(page);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await focused(page)).cat).toBe(cats[0]);

    // Hidden from the menu's Hide row: the row is gone with the closed menu, so its trigger takes focus.
    await menuTrigger(page).focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('button', { name: /hide interface/i }).focus();
    await page.keyboard.press('Enter');
    await stageGone(page);
    await page.keyboard.press('x');
    await expect.poll(async () => (await focused(page)).text).toMatch(/display options|hide interface/i);
  });

  test('holding a key down toggles once; held arrows keep stepping the wheel', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await page.keyboard.down('t');
    for (let i = 0; i < 5; i++) await page.keyboard.down('t'); // auto-repeat: repeat = true (6 keydowns: an even count)
    await page.keyboard.up('t');
    await expect.poll(() => theme(page)).toBe('light');

    await page.keyboard.down('e');
    for (let i = 0; i < 4; i++) await page.keyboard.down('e');
    await page.keyboard.up('e');
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
    // The held E is the sentinel for the held T: handled after it, so a late toggle would show by now.
    expect(await theme(page), 'six T keydowns (one press, five repeats) toggle the theme once').toBe('light');
    await page.keyboard.press('q');
    await expect.poll(async () => (await appState(page)).screen).toBe('skills');

    const cats = await categoryIds(page);
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 2; i++) await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await expectMode(page, 'hover', cats[2]);
  });

  test('Esc closes a pinned Display options menu wherever focus is; arrows in it move between its rows', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    await trigger.click();
    await page.mouse.move(900, 900);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('e'); // focus moves to the new screen's title
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
    const screen = (await appState(page)).screen;
    // A route change closes the menu: pin it again on the new screen.
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await page.mouse.move(900, 900);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Focus elsewhere (on the page), as after a shortcut that moved it: Esc still closes the menu first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect((await appState(page)).screen, 'the first Esc only closes the menu').toBe(screen);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).screen).toBe('skills');

    await settle(page);
    await trigger.focus();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(page), '↓ on the trigger opens the menu at its first row').toBe(0);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(page)).toBe(1);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(page)).toBe(0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    // ↓ is the sentinel: once focus reaches the next row, ← and → (which do nothing here) were handled.
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(page), '← → keep the row, ↓ moves on').toBe(1);
    expect((await appState(page)).mode.kind, 'arrows in the menu never reach the wheel').toBe('idle');
  });

  test('a deep link into a detail view focuses its selected node', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    // A soft skill that is not its category's default, a bare soft category, a bare hard category.
    const links = await page.evaluate(() => {
      const nav = window.__site!.getState().nav;
      const soft = nav.soft.find((c) => c.nodes.some((n) => n.id !== c.defaultNode && n.parent !== null)) ?? nav.soft[0];
      const node = soft.nodes.find((n) => n.id !== soft.defaultNode && n.parent !== null)?.id ?? null;
      return [
        { hash: node ? `#/soft/${soft.id}/${node}` : `#/soft/${soft.id}`, node },
        { hash: `#/soft/${nav.soft[0].id}`, node: null },
        { hash: `#/skills/${nav.hard[0].id}`, node: null },
      ];
    });
    for (const { hash, node } of links) {
      await page.goto('about:blank');
      await page.goto(`${appPath()}${hash}`);
      await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
      await page.evaluate(() => window.__site!.ready);
      await expect.poll(async () => (await focused(page)).node, `${hash}: focus is on a node`).not.toBeNull();
      if (node) expect((await focused(page)).node, hash).toBe(node);
    }
  });
});

/**
 * Keyboard focus follows the wheel: once the arrows move the hover, Enter opens the highlighted
 * category (as the ENTER · SELECT hint says), whatever control a click or Tab left focused; S and a
 * digit in quick succession leave focus on the selected node.
 */
test.describe('keyboard: focus follows the wheel', () => {
  /** ArrowRight from a HUD control: the hover moves, focus follows it onto the arc, Enter opens it. */
  async function arrowThenEnter(page: Page, wheel: 'hard' | 'soft' = 'hard') {
    await settle(page);
    const cats = await categoryIds(page, wheel);
    await page.keyboard.press('ArrowRight');
    await expectMode(page, 'hover', cats[0]);
    await expect.poll(async () => (await focused(page)).cat, 'focus is on the hovered arc').toBe(cats[0]);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cats[0]);
    const s = await appState(page);
    expect(s.screen).toBe('skills');
    expect(s.wheel).toBe(wheel);
  }

  test('after a mouse click on a header button, ArrowRight + Enter opens the hovered category', async ({ page }) => {
    await openApp(page);
    await ui.nextSection(page).click();
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
    await ui.prevSection(page).click();
    await expect.poll(async () => (await appState(page)).screen).toBe('skills');
    // A mouse press focuses no header control: the view change put focus on the screen's title.
    expect(await focused(page)).toMatchObject({ tag: 'h2', text: expect.stringMatching(/^skills$/i) });
    await arrowThenEnter(page);
  });

  test('after a click on Next section, hovering a category and Enter open it', async ({ page }) => {
    await openApp(page);
    // Start one section before Skills, so Next section lands on the hub.
    const screens = await screenOrder(page);
    const before = screens[(screens.indexOf('skills') - 1 + screens.length) % screens.length];
    await dispatch(page, { t: 'tab/set', screen: before });
    await ui.nextSection(page).click();
    await expect.poll(async () => (await appState(page)).screen).toBe('skills');
    await settle(page);
    expect((await focused(page)).text, 'the click left no focus on the button').not.toMatch(/next section/i);
    const cats = await categoryIds(page);
    const p = await arcPoint(page, cats[1]);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', cats[1]);
    await page.keyboard.press('Enter');
    await expectMode(page, 'detail', cats[1]);
    expect((await appState(page)).screen).toBe('skills');
    // From the keyboard the button still works: Tab to it, Enter switches the section.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).mode.kind).not.toBe('detail');
    await page.mouse.move(5, 540);
    await ui.prevSection(page).focus();
    await page.keyboard.press('Tab');
    await expect(ui.nextSection(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
  });

  test('after a Tab to a header button, and with the keyboard shortcuts off, the same', async ({ page }) => {
    await openApp(page);
    await tabUntil(page, (f) => /next section/i.test(f.text), { what: 'the Next section button' });
    await arrowThenEnter(page);

    await openApp(page);
    await setShortcuts(page, false);
    await ui.nextSection(page).click();
    await expect.poll(async () => (await appState(page)).screen).not.toBe('skills');
    await ui.prevSection(page).click();
    await arrowThenEnter(page);
  });

  test('after clicking Soft skills, ArrowRight + Enter opens the hovered soft category', async ({ page }) => {
    await openApp(page);
    await ui.softSkills(page).click();
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    await arrowThenEnter(page, 'soft');

    // Soft skills, then Hard skills: the hard wheel's category opens, the wheel does not flip.
    await openApp(page);
    await ui.softSkills(page).click();
    await expect.poll(async () => (await appState(page)).wheel).toBe('soft');
    await settle(page);
    await page.getByRole('button', { name: /hard skills/i }).click();
    await expect.poll(async () => (await appState(page)).wheel).toBe('hard');
    await arrowThenEnter(page);
  });

  test('an open menu keeps focus and the arrows', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('2'); // a digit still opens a category behind the open menu
    await expect.poll(async () => (await appState(page)).mode.kind).toBe('detail');
    await expect(trigger).toBeFocused();
  });

  for (const gap of [0, 50, 300]) {
    test(`S then 1 ${gap} ms apart: focus lands on the selected node`, async ({ page }) => {
      await openApp(page);
      // The start-up animation ends on the real clock (the wheel swap under test runs on it): the
      // hook waits for the interface to go idle without switching the engine to manual time.
      await page.evaluate(() => (window.__site as unknown as { settle(): Promise<void> }).settle());
      await page.keyboard.press('s');
      if (gap > 0) await page.waitForTimeout(gap); // the input timing under test, not a wait
      await page.keyboard.press('1');
      await expectMode(page, 'detail');
      const selected = async () => {
        const m = (await appState(page)).mode;
        return m.kind === 'detail' ? m.node : null;
      };
      await expect.poll(async () => (await focused(page)).node, 'focus is on the selected node').toBe(await selected());
      expect(await page.evaluate(() => document.activeElement?.matches('g[data-node-id]') ?? false)).toBe(true);
    });
  }
});

/** M opens and closes the Display options menu, V toggles the sound, R folds and unfolds the player card. */
test.describe('keyboard: M menu, V sound, R player card', () => {
  test('M opens the menu at its first row, ↓ moves, M closes it and focus goes back to where it was; Esc too', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    await expect(trigger).toHaveAttribute('aria-keyshortcuts', 'M');
    await expect(trigger).toHaveAttribute('title', 'Display options (M)');
    const cats = await categoryIds(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await focused(page)).cat).toBe(cats[0]);

    await page.keyboard.press('m');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => focusedRow(page)).toBe(0);
    const mode = (await appState(page)).mode;
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedRow(page)).toBe(1);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => focusedRow(page)).toBe(0);
    expect((await appState(page)).mode, 'the arrows stay in the menu').toEqual(mode);
    await page.keyboard.press('m');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => (await focused(page)).cat, 'focus is back on the category').toBe(cats[0]);

    await page.keyboard.press('m');
    await expect.poll(() => focusedRow(page)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => (await focused(page)).cat).toBe(cats[0]);
    expect((await appState(page)).screen, 'Esc only closed the menu').toBe('skills');

    // Nothing focused before M: closing leaves focus on the page, not on the trigger.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('m');
    await expect.poll(() => focusedRow(page)).toBe(0);
    await page.keyboard.press('m');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test('M works on every screen and view, and closes a menu the mouse opened', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    const cats = await categoryIds(page);
    const screens = await screenOrder(page);
    const views: Action[][] = [
      ...screens.filter((s) => s !== 'skills').map((screen): Action[] => [{ t: 'tab/set', screen }]),
      [{ t: 'tab/set', screen: 'skills' }, { t: 'wheel/toggle' }],
      [{ t: 'wheel/set', wheel: 'hard' }, { t: 'cat/open', cat: cats[1] }],
    ];
    for (const actions of views) {
      await dispatch(page, ...actions);
      const before = await appState(page);
      const focusBefore = await focused(page);
      await page.keyboard.press('m');
      await expect(trigger, JSON.stringify(actions)).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => focusedRow(page)).toBe(0);
      await page.keyboard.press('m');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(await focused(page), 'focus is back where it was').toEqual(focusBefore);
      // M changes nothing else (focus back on a hub category hovers it, as a Tab onto it does).
      const after = await appState(page);
      expect([after.screen, after.wheel]).toEqual([before.screen, before.wheel]);
      if (before.mode.kind === 'detail') expect(after.mode).toEqual(before.mode);
    }
    // Opened by hovering: M closes it at once, the pointer still on the trigger.
    await page.mouse.move(5, 540);
    await trigger.hover();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('m');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Pinned by a click: M closes it too.
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('m');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('V toggles the sound: state, announcement and menu row agree', async ({ page }) => {
    await openApp(page);
    const row = page.locator('[data-row="sound"]');
    await expect(row).toHaveAttribute('aria-keyshortcuts', 'V');
    await expect(row).toHaveAttribute('title', 'Sound (V)');
    await expect(row.locator('kbd')).toHaveText('V');
    expect(await sound(page)).toBe(false);
    await page.keyboard.press('v');
    await expect.poll(() => sound(page)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-sound', 'on');
    await expect(page.locator('[role="status"]', { hasText: /^Sound on$/ })).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.down('v');
    await page.keyboard.down('v'); // auto-repeat: no second toggle
    await page.keyboard.up('v');
    await expect.poll(() => sound(page)).toBe(false);
    // Negative check: a toggle from the repeat would arrive within a few frames, so this short
    // pause is what proves its absence.
    await page.waitForTimeout(100);
    expect(await sound(page)).toBe(false);
    await expect(menuTrigger(page), 'V never opens the menu').toHaveAttribute('aria-expanded', 'false');
  });

  test('R folds the card, unfolds it pinned open and folds it again; focus stays put', async ({ page }) => {
    await openApp(page);
    await expect(card(page)).toHaveAttribute('aria-keyshortcuts', 'R');
    const name = await card(page).getAttribute('aria-label');
    // Wherever the card starts (it shows unfolded for a moment after load), R leaves it folded.
    if ((await card(page).getAttribute('data-expanded')) !== null) {
      await page.keyboard.press('r');
      await expect(card(page)).not.toHaveAttribute('data-expanded');
    }
    await settle(page);
    const cats = await categoryIds(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await focused(page)).cat).toBe(cats[0]);
    await page.keyboard.press('r');
    await expect(card(page)).toHaveAttribute('data-expanded', '');
    await expect(card(page)).toHaveAttribute('data-pinned', '');
    // Pinned: the mouse passing over it and a click elsewhere keep it open.
    await card(page).hover();
    await page.mouse.move(5, 540);
    await page.mouse.click(5, 540);
    await expect(card(page)).toHaveAttribute('data-expanded', '');
    await page.keyboard.press('r');
    await expect(card(page)).not.toHaveAttribute('data-expanded');
    await expect(card(page)).not.toHaveAttribute('data-pinned');
    expect(await card(page).getAttribute('aria-label'), 'its name never changes').toBe(name);
    await expect(card(page)).not.toBeFocused();
    // With the interface hidden, R only brings it back.
    await page.keyboard.press('h');
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
    await page.keyboard.press('r');
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'shown');
    await expect(card(page)).not.toHaveAttribute('data-expanded');
  });

  test('with the single-key shortcuts off, M, V and R do nothing and are not announced; K brings them back', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    if ((await card(page).getAttribute('data-expanded')) !== null) {
      await page.keyboard.press('r'); // fold the card
      await expect(card(page)).not.toHaveAttribute('data-expanded');
    }
    await page.keyboard.press('k');
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
    await expect(menuTrigger(page)).not.toHaveAttribute('aria-keyshortcuts');
    await expect(menuTrigger(page)).toHaveAttribute('title', 'Display options');
    await expect(card(page)).not.toHaveAttribute('aria-keyshortcuts');
    for (const key of ['m', 'v', 'r']) await page.keyboard.press(key);
    // Negative check: none of the three may act; anything they did would show within a few frames.
    await page.waitForTimeout(200);
    await expect(menuTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(card(page)).not.toHaveAttribute('data-expanded');
    expect(await sound(page)).toBe(false);
    await page.keyboard.press('k');
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'on');
    await page.keyboard.press('m');
    await expect(menuTrigger(page)).toHaveAttribute('aria-expanded', 'true');
  });
});
