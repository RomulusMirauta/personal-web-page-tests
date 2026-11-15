import type { Page } from '@playwright/test';
import { appState, arcPoint, categoryIds, dispatch, expectMode, focused, openApp, screenOrder, settle, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * The Display options menu (top-right trigger). A hover-opened menu stays open on the way from the
 * trigger to any row, also on a diagonal path, and closes at once when the pointer leaves elsewhere;
 * closed, it is one Tab stop that ↓ / Enter (or M) open from the keyboard, and a keyboard-opened menu
 * closes when focus leaves it, so no later Tab stop hides under it. After a mouse visit the arrow
 * keys stay the page's (they scroll the screen or step the wheel); after a click on the trigger they
 * work the menu, also where a click does not focus. C switching the city off under a focused
 * Pause city row keeps focus in the menu.
 */
const trigger = (page: Page) => page.getByRole('button', { name: 'Display options' });
const plate = (page: Page) => page.locator('ul[aria-label="Display options"]');
const expanded = async (page: Page) => (await trigger(page).getAttribute('aria-expanded')) === 'true';
const settings = (page: Page) =>
  page.evaluate(() => {
    const s = window.__site!.getState() as unknown as Record<string, unknown>;
    const { theme, antialias, sound, cityShown, cityPaused, uiHidden } = s;
    return { theme, antialias, sound, cityShown, cityPaused, uiHidden, keys: document.documentElement.dataset.shortcuts ?? 'on' };
  });

/** From now on, records whether the menu closes at any moment (aria-expanded turning false). */
async function watchClosing(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const t = document.querySelector('button[aria-label="Display options"]')!;
    const w = window as unknown as { menuClosed?: boolean; menuWatch?: MutationObserver };
    w.menuWatch?.disconnect();
    w.menuClosed = t.getAttribute('aria-expanded') !== 'true';
    w.menuWatch = new MutationObserver(() => {
      if (t.getAttribute('aria-expanded') !== 'true') w.menuClosed = true;
    });
    w.menuWatch.observe(t, { attributes: true, attributeFilter: ['aria-expanded'] });
  });
  return () =>
    page.evaluate(async () => {
      // Pointer updates render on the next task: let them land first.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return (window as unknown as { menuClosed?: boolean }).menuClosed === true;
    });
}

/** Hover-open the menu, coming from the header on the left as a visitor would; returns the trigger centre. */
async function hoverOpen(page: Page): Promise<{ x: number; y: number }> {
  const box = (await trigger(page).boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(5, page.viewportSize()!.height / 2);
  await expect.poll(() => expanded(page)).toBe(false);
  await page.mouse.move(centre.x - 200, centre.y);
  await page.mouse.move(centre.x, centre.y, { steps: 8 });
  await expect.poll(() => expanded(page)).toBe(true);
  // The rows have arrived (they fade and slide in one after another).
  await expect
    .poll(() => plate(page).locator('li').evaluateAll((lis) => lis.every((li) => getComputedStyle(li).transform === 'none' && getComputedStyle(li).opacity === '1')))
    .toBe(true);
  return centre;
}

/** Hover-open the menu, then go straight from the trigger to a row and click it. */
async function hoverClick(page: Page, name: string): Promise<void> {
  const from = await hoverOpen(page);
  const row = (await page.getByRole('button', { name }).boundingBox())!;
  const to = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
  for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 6, from.y + ((to.y - from.y) * k) / 6);
  await page.mouse.click(to.x, to.y);
}

/**
 * Whether the menu covers the focused control: the topmost element at 3 or more of 5 inner points
 * of its box belongs to the menu. False on the menu itself.
 */
const focusUnderMenu = (page: Page) =>
  page.evaluate(() => {
    const t = document.querySelector('button[aria-label="Display options"]')!;
    const menu = t.parentElement!;
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || menu.contains(a)) return false;
    const r = a.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const points = [
      [0.5, 0.5],
      [0.2, 0.3],
      [0.8, 0.3],
      [0.2, 0.7],
      [0.8, 0.7],
    ];
    const hits = points.filter(([fx, fy]) => {
      const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      return !!el && menu.contains(el) && !a.contains(el);
    }).length;
    return hits >= 3;
  });
const inMenu = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[data-hud="menu"]')));

test.describe('Display options menu', () => {
  for (const vp of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ]) {
    test(`diagonal path from the trigger to each row keeps the menu open, and the click toggles that row (${vp.width}×${vp.height})`, async ({ page }) => {
      test.slow();
      await page.setViewportSize(vp);
      await openApp(page);
      await settle(page);
      const rows = plate(page).locator(':scope > li');
      const names = await rows.evaluateAll((lis) => lis.map((li) => li.querySelector(':scope > * > span')!.textContent ?? ''));
      expect(names.length).toBeGreaterThan(0);
      for (const [i, name] of names.entries()) {
        const from = await hoverOpen(page);
        const label = (await rows.nth(i).locator(':scope > * > span').first().boundingBox())!;
        const to = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
        const closed = await watchClosing(page);
        // A straight 12-step path from the trigger centre to the row's label.
        for (let k = 1; k <= 12; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12);
        expect(await closed(), `${name}: the menu stayed open all the way`).toBe(false);
        if (await rows.nth(i).locator(':scope > a').count()) {
          // A link (the list view of /cv/): the click would land on it.
          expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.textContent ?? '', to)).toContain(name);
          continue;
        }
        if (name === 'Controls') {
          // Opens the Controls screen, closing the menu; Esc closes it again.
          await page.mouse.click(to.x, to.y);
          await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog', { name: 'Controls' })).toHaveCount(0);
          continue;
        }
        if (name === 'Hints') {
          // Not app state: the gesture hints switch, kept on the device. Its pressed state toggles.
          const button = rows.nth(i).locator(':scope > button');
          await expect(button).toHaveAttribute('aria-pressed', 'true');
          await page.mouse.click(to.x, to.y);
          await expect(button, `${name}: the click toggled it`).toHaveAttribute('aria-pressed', 'false');
          await page.mouse.click(to.x, to.y);
          await expect(button).toHaveAttribute('aria-pressed', 'true');
          continue;
        }
        const before = await settings(page);
        await page.mouse.click(to.x, to.y);
        await expect.poll(() => settings(page), `${name}: the click toggled it`).not.toEqual(before);
        if ((await settings(page)).uiHidden) {
          await page.evaluate(() => window.__site!.dispatch({ t: 'ui/show' }));
          await expect.poll(async () => (await settings(page)).uiHidden).toBe(false);
          continue;
        }
        // Back as it was (the menu is still open under the pointer).
        await page.mouse.click(to.x, to.y);
        await expect.poll(() => settings(page)).toEqual(before);
      }
    });
  }

  test('leaving away from the plate closes the hover-opened menu at once (no grace delay)', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const box = (await trigger(page).boundingBox())!;
    for (const [where, steps] of [
      ['up', 1],
      ['right', 1],
      ['left along the header, past the plate', 6],
      ['down past the plate', 6],
    ] as const) {
      const c = await hoverOpen(page);
      const p = (await plate(page).boundingBox())!;
      const to = {
        up: { x: c.x, y: box.y - 4 },
        right: { x: box.x + box.width + 4, y: c.y },
        'left along the header, past the plate': { x: p.x - 4, y: c.y },
        'down past the plate': { x: c.x, y: p.y + p.height + 4 },
      }[where];
      await page.mouse.move(to.x, to.y, { steps });
      // Short on purpose: a grace delay would keep it open past this.
      await expect.poll(() => expanded(page), { message: where, timeout: 150 }).toBe(false);
    }
  });

  // The trigger's corners are rounded and hit testing follows them: heading down-left for the middle
  // rows, the mouse leaves it at a point still inside its box.
  for (const vp of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
  ]) {
    test(`leaving the trigger through its rounded bottom-left corner keeps the menu open, 1 to 8 px per move (${vp.width}×${vp.height})`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openApp(page);
      await settle(page);
      for (const px of [1, 2, 3, 5, 8]) {
        const c = await hoverOpen(page);
        const p = (await plate(page).boundingBox())!;
        const closed = await watchClosing(page);
        // 45° down-left from the trigger centre, on into the plate.
        const len = Math.max(p.y - c.y + 20, 40);
        await page.mouse.move(c.x - len, c.y + len, { steps: Math.max(1, Math.round((len * Math.SQRT2) / px)) });
        expect(await closed(), `${px} px per move: the menu stayed open all the way`).toBe(false);
      }
    });
  }

  // Hiding the interface ends the hover visit, whether the mouse rests on the trigger or is on its
  // way to the rows: nothing of the hover path is left to keep the menu open or closed later.
  for (const moving of [false, true]) {
    test(`H with the mouse ${moving ? 'heading for the rows' : 'resting on the trigger'} leaves no hover path behind: shown again by a key, ↓ opens the menu and it stays open as the mouse moves`, async ({ page }) => {
      await openApp(page);
      await settle(page);
      const c = await hoverOpen(page);
      await page.keyboard.press('h');
      if (moving) await page.mouse.move(c.x - 40, c.y + 60, { steps: 2 });
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-stage]')!).visibility)).toBe('hidden');
      await page.mouse.move(400, 600, { steps: 4 }); // away, so nothing hovers the menu when it shows again
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await settings(page)).uiHidden).toBe(false);
      await trigger(page).focus();
      await page.keyboard.press('ArrowDown');
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
      const closed = await watchClosing(page);
      await page.mouse.move(450, 700, { steps: 4 });
      expect(await closed(), 'the mouse moving far from the menu left it open').toBe(false);
    });
  }

  // Focus order follows the layout: the trigger sits between the header's Next section button and the wheel.
  test('the closed menu is one Tab stop; ↓ opens it at the first row, Enter pins it there', { tag: ['@a11y', '@critical'] }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    await ui.nextSection(page).focus();
    await page.keyboard.press('Tab');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Tab');
    const next = await focused(page);
    expect(next.cat, `the next stop after the closed menu is the wheel, not "${next.text}"`).not.toBeNull();

    await page.keyboard.press('Shift+Tab');
    await expect(trigger(page)).toBeFocused();
    // Focus left the wheel, and its hover with it: the wheel is idle before ↓ as after.
    await expectMode(page, 'idle');
    await page.keyboard.press('ArrowDown');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
    expect((await appState(page)).mode.kind, '↓ on the trigger never steps the wheel').toBe('idle');
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
  });

  // Each screen starts right below the menu's plate: a menu left open while Tab walks on would hide
  // the focused control.
  for (const vp of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
  ]) {
    test(`a keyboard-opened menu closes when Tab leaves it; no later stop is under the plate (${vp.width}×${vp.height})`, { tag: '@a11y' }, async ({ page }) => {
      test.slow();
      await page.setViewportSize(vp);
      await openApp(page);
      // Every screen, Skills last.
      const screens = await screenOrder(page);
      const order = [...screens.filter((s) => s !== 'skills'), 'skills'];
      for (const screen of order) {
        await dispatch(page, { t: 'tab/set', screen });
        await settle(page);
        await ui.nextSection(page).focus();
        await page.keyboard.press('Tab');
        await expect(trigger(page)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(trigger(page), `${screen}: Enter opens it`).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
        const enabled = await plate(page).locator(':scope > li > button:not(:disabled), :scope > li > a[href]').count();
        let rows = 1;
        for (; rows < 20; rows++) {
          await page.keyboard.press('Tab');
          if (!(await inMenu(page))) break;
          await expect(trigger(page), `${screen}: open while Tab walks its rows`).toHaveAttribute('aria-expanded', 'true');
        }
        expect(rows, `${screen}: Tab walked every row`).toBe(enabled);
        await expect(trigger(page), `${screen}: closed once focus left it`).toHaveAttribute('aria-expanded', 'false');
        // The menu's fade-out is done: no stop of the screen, the footer included, sits under it.
        await expect.poll(() => plate(page).evaluate((ul) => getComputedStyle(ul).visibility)).toBe('hidden');
        for (let i = 0; i < 30 && !(await inMenu(page)); i++) {
          expect(await focusUnderMenu(page), `${screen}: "${(await focused(page)).text.slice(0, 40)}" is under the menu`).toBe(false);
          await page.keyboard.press('Tab');
        }
      }
    });
  }

  test('Shift+Tab out of a key-pinned menu and Tab out of a click-pinned one also close it; a click elsewhere closes a mouse pin', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await settle(page);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
    await page.keyboard.press('Shift+Tab');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page), 'the trigger is part of the menu').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).text).toMatch(/next section/i);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');

    // Pinned with the mouse: a click elsewhere on the page closes it; pinned again, a keyboard exit
    // closes it too.
    await trigger(page).click();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.click(5, 540);
    await expect(trigger(page), 'a click elsewhere closes it').toHaveAttribute('aria-expanded', 'false');
    await trigger(page).click();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await trigger(page).focus();
    await page.keyboard.press('Tab');
    expect(await inMenu(page), 'Tab from the trigger enters the open rows').toBe(true);
    for (let i = 0; i < 20 && (await inMenu(page)); i++) await page.keyboard.press('Tab');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    expect(await focusUnderMenu(page)).toBe(false);
  });

  // M opens the menu as Enter on its trigger does, so Tab or Shift+Tab out of a menu that M opened
  // closes it too, and no stop of the screen is left under the plate.
  test('a menu that M opened closes when Tab or Shift+Tab leaves it; no later stop is under the plate', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await settle(page);
    await page.mouse.move(5, 540);
    await page.keyboard.press('m');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
    const enabled = await plate(page).locator(':scope > li > button:not(:disabled), :scope > li > a[href]').count();
    let rows = 1;
    for (; rows < 20; rows++) {
      await page.keyboard.press('Tab');
      if (!(await inMenu(page))) break;
      await expect(trigger(page), 'open while Tab walks its rows').toHaveAttribute('aria-expanded', 'true');
    }
    expect(rows, 'Tab walked every row').toBe(enabled);
    await expect(trigger(page), 'closed once focus left it').toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => plate(page).evaluate((ul) => getComputedStyle(ul).visibility)).toBe('hidden');
    for (let i = 0; i < 30 && !(await inMenu(page)); i++) {
      expect(await focusUnderMenu(page), `"${(await focused(page)).text.slice(0, 40)}" is under the menu`).toBe(false);
      await page.keyboard.press('Tab');
    }

    // Shift+Tab: from the first row onto the trigger (still open), then out of the menu (closed).
    await page.keyboard.press('m');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
    await page.keyboard.press('Shift+Tab');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page), 'the trigger is part of the menu').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).text).toMatch(/next section/i);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('M pins it open like Enter on the trigger and leaves the hover and focus rules as they were', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await page.mouse.move(5, 540);
    await page.keyboard.press('m');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-hud="menu"] [data-pinned]')).toHaveCount(1);
    // Pinned: the pointer crossing the trigger and leaving again keeps it open.
    const box = (await trigger(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(5, 540, { steps: 4 });
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('m');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-hud="menu"] [data-pinned]')).toHaveCount(0);
    // Hover opens it for as long as it lasts, and focus alone still does not open it.
    await hoverOpen(page);
    await page.mouse.move(5, 540);
    await expect.poll(() => expanded(page)).toBe(false);
    await trigger(page).focus();
    await page.waitForTimeout(150); // a negative check: focus alone must not open it within this window
    expect(await expanded(page)).toBe(false);
  });

  // A mouse visit leaves focus on the closed trigger, unseen (no ring): the arrows stay the page's.
  for (const [visit, viaMouse] of [
    ['hover, click Sound, leave', (page: Page) => hoverClick(page, 'Sound')],
    [
      'click the trigger open, then closed, where a click does not focus (WebKit)',
      async (page: Page) => {
        await page.evaluate(() => document.addEventListener('mousedown', (e) => e.preventDefault(), true));
        await trigger(page).click();
        await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
        await trigger(page).click();
      },
    ],
  ] as const) {
    test(`after a mouse visit (${visit}) ↓ scrolls the Experience screen and the closed menu stays closed`, async ({ page }) => {
      // A small landscape window, where the Experience timeline overflows and scrolls.
      await page.setViewportSize({ width: 853, height: 430 });
      await openApp(page);
      await dispatch(page, { t: 'tab/set', screen: 'experience' });
      await expect(page.locator('main [data-scroll][data-scroll-primary]')).toHaveAttribute('data-scrollable', '');
      const scrolled = () => page.evaluate(() => Array.from(document.querySelectorAll('main [data-scroll]'), (el) => el.scrollTop).reduce((a, b) => a + b, 0));
      await viaMouse(page);
      await page.mouse.move(5, 215); // away, to the left
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger(page)).toBeFocused();
      expect(await scrolled()).toBe(0);
      await page.keyboard.press('ArrowDown');
      await expect.poll(scrolled, '↓ scrolled the screen').toBeGreaterThan(0);
      const once = await scrolled();
      // The browser shows a focus ring after a key press; the next ↓ still scrolls (if there is room left).
      const room = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main [data-scroll]'), (el) => el.scrollHeight - el.clientHeight - el.scrollTop).reduce((a, b) => a + b, 0),
      );
      if (room > 1) {
        await page.keyboard.press('ArrowDown');
        await expect.poll(scrolled, 'the next ↓ scrolled on').toBeGreaterThan(once);
      }
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger(page)).toBeFocused();
      // Back on the trigger from the keyboard, ↓ opens the menu again.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(trigger(page)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(async () => (await focused(page)).text).toMatch(/^light theme/i);
    });
  }

  test('after a mouse visit (hover, click Sound, leave) ↓ steps the wheel on Skills; the closed menu stays closed', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await hoverClick(page, 'Sound');
    await page.mouse.move(5, 540); // away, to the left (off the wheel)
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger(page)).toBeFocused();
    expect((await appState(page)).mode.kind).toBe('idle');
    const [first, second] = await categoryIds(page);
    await page.keyboard.press('ArrowDown');
    await expectMode(page, 'hover', first);
    await page.keyboard.press('ArrowDown');
    await expectMode(page, 'hover', second);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('after a click on the trigger the arrows and Enter work the menu, not the wheel, where a click does not focus (WebKit)', async ({ page }) => {
    await openApp(page);
    await settle(page);
    // WebKit and the macOS browsers do not focus a button on mousedown: the same here.
    await page.evaluate(() => document.addEventListener('mousedown', (e) => e.preventDefault(), true));
    await page.mouse.move(5, 540);
    await trigger(page).click();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger(page)).toBeFocused();
    const before = await settings(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^smooth edges/i);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await settings(page)).antialias).toBe(!before.antialias);
    expect((await appState(page)).mode.kind, 'the wheel behind the menu stayed idle').toBe('idle');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('C on the focused Pause city row keeps focus in the open menu (on City), never on the page', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    await trigger(page).focus();
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 6 && !/^pause city/i.test((await focused(page)).text); i++) await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await focused(page)).text).toMatch(/^pause city/i);
    await page.keyboard.press('c');
    await expect.poll(async () => (await settings(page)).cityShown).toBe(false);
    await expect(page.getByRole('button', { name: 'Pause city animation' })).toBeDisabled();
    // A frame later the browser has dropped focus from the disabled row: it must not reach the page.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.getByRole('button', { name: 'City', exact: true })).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    expect((await focused(page)).text, 'Tab goes on from City, past the unavailable row').toMatch(/^hide interface/i);
  });
});

test.describe('Display options menu on a phone', () => {
  test('a tap outside the open menu closes it and never reaches the wheel behind it; a hash change closes it', { tag: '@mobile' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [cat] = await categoryIds(page);
    const point = await arcPoint(page, cat);
    const tapTrigger = async () => {
      const box = (await trigger(page).boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    };
    await tapTrigger();
    await page.touchscreen.tap(point.x, point.y);
    await expect(trigger(page), 'the tap outside closes the menu').toHaveAttribute('aria-expanded', 'false');
    // A negative window: the tap that closed the menu must not preview the category behind it.
    await page.waitForTimeout(300);
    expect((await appState(page)).mode.kind, 'no category preview behind the menu').toBe('idle');
    expect(await page.evaluate(() => location.hash)).not.toMatch(/skills\//);

    // With the menu closed the same tap previews the category, as before.
    await page.touchscreen.tap(point.x, point.y);
    await expectMode(page, 'hover', cat);

    await tapTrigger();
    await page.evaluate(() => (location.hash = '#/profile'));
    await expect(trigger(page), 'a hash change closes the menu').toHaveAttribute('aria-expanded', 'false');
  });
});
