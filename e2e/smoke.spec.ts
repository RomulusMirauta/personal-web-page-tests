import { appState, arcPoint, categoryIds, dispatch, expectMode, openApp, screenOrder, sectionNames, sel, settle, trackErrors, ui } from './support/app';
import { expect, test } from './support/test';

test.describe('smoke', { tag: '@smoke' }, () => {
  test('shows the interface each state needs', async ({ page }) => {
    await openApp(page);
    const [first] = await categoryIds(page);
    // Skills wheel: header, footer HUD with the wheel switch and key hints, the background behind it all.
    await expect(ui.header(page)).toBeVisible();
    await expect(ui.hud(page)).toBeAttached();
    await expect(ui.softSkills(page)).toBeVisible();
    await expect(ui.hints(page).first()).toBeVisible();
    await expect(ui.keycaps(page).first()).toBeVisible();
    await expect(ui.city(page)).toBeAttached();
    await expect(ui.wheel(page)).toHaveAttribute('data-active', 'true');
    await expect(ui.panel(page)).toBeHidden();
    // Detail view: the panel with its media slot; the header switches categories; no wheel switch.
    await dispatch(page, { t: 'cat/open', cat: first });
    await expect(ui.panel(page)).toBeVisible();
    await expect(ui.panel(page).locator(sel.mediaSlot)).toHaveCount(1);
    await expect(ui.categoryNav(page)).toBeVisible();
    await expect(ui.softSkills(page)).toBeHidden();
    await expect(ui.back(page).first()).toBeVisible();
  });

  test('every other section renders as a named region', async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    const names = await sectionNames(page);
    expect(screens, 'the header has a dot per section').toHaveLength(names.length);
    for (const [i, screen] of screens.entries()) {
      if (screen === 'skills') continue;
      await dispatch(page, { t: 'tab/set', screen });
      await expect(ui.sectionTitle(page)).toHaveAccessibleName(new RegExp(`^${names[i]}$`, 'i'));
      await expect(ui.screen(page, new RegExp(`^${names[i]}$`, 'i'))).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/${screen}$`));
    }
  });

  test('loads as a visitor sees it, without console errors', { tag: '@all-devices' }, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/Romulus/);
    // Like a lock screen: any key skips the intro.
    await page.keyboard.press('Escape');
    await expect(ui.sections(page)).toBeVisible();
    await expect(ui.nodes(page).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the header names the sections and cycles through them, wrapping around', async ({ page }) => {
    await openApp(page);
    const names = await sectionNames(page);
    const screens = await screenOrder(page);
    const n = names.length;
    expect(n).toBeGreaterThanOrEqual(3);
    const start = screens.indexOf('skills');
    const dots = ui.sectionDots(page);
    await expect(dots.nth(start)).toHaveAttribute('data-active', '');
    await expect(ui.sectionTitle(page)).toHaveAccessibleName(new RegExp(`^${names[start]}$`, 'i'));
    await expect(ui.prevSection(page)).toHaveAccessibleName(new RegExp(names[(start - 1 + n) % n], 'i'));
    await expect(ui.nextSection(page)).toHaveAccessibleName(new RegExp(names[(start + 1) % n], 'i'));
    // A full lap forwards: each section in turn, then back to Skills.
    for (let step = 1; step <= n; step++) {
      const i = (start + step) % n;
      await ui.nextSection(page).click();
      await expect(ui.sectionTitle(page)).toHaveAccessibleName(new RegExp(`^${names[i]}$`, 'i'));
      await expect.poll(async () => (await appState(page)).screen).toBe(screens[i]);
      await expect(dots.nth(i)).toHaveAttribute('data-active', '');
    }
    // And one step backwards wraps the other way.
    await ui.prevSection(page).click();
    await expect.poll(async () => (await appState(page)).screen).toBe(screens[(start - 1 + n) % n]);
  });

  test('opens and closes a category detail with the keyboard', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const [first] = await categoryIds(page);
    await page.keyboard.press('1');
    await expectMode(page, 'detail', first);
    await expect(page).toHaveURL(new RegExp(`#/skills/${first}/[a-z0-9-]+$`));
    await page.keyboard.press('Escape');
    await expectMode(page, 'idle');
    await expect(page).not.toHaveURL(/#\/skills\/.+/);
  });

  test('opens a category by pointer and closes it with the on-screen Back control', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    const target = cats[1] ?? cats[0];
    const p = await arcPoint(page, target);
    await page.mouse.move(p.x, p.y);
    await expectMode(page, 'hover', target);
    await settle(page);
    const q = await arcPoint(page, target);
    await page.mouse.click(q.x, q.y);
    await expectMode(page, 'detail', target);
    await settle(page);
    await ui.back(page).first().click();
    await expectMode(page, 'idle');
  });

  test('browser Back closes the detail view (opening it adds a history entry)', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('2');
    await expectMode(page, 'detail');
    await page.goBack();
    await expectMode(page, 'idle');
  });
});
