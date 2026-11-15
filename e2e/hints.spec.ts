import type { Page } from '@playwright/test';
import { arcPoint, categoryIds, expectMode, openApp, settle } from './support/app';
import { expect, test } from './support/test';

/**
 * Gesture hints. On the Skills hub a "hover / tap to explore" plate shows on a first visit and ends
 * by itself, or at the first pointer move over the wheel (a phone: the first touch). On a phone, a
 * tab switch made with a tap on the header's ‹ / › shows a tab-swipe hint (chevrons); never with a
 * mouse or the keyboard. The Display options menu's Hints row turns every hint off (kept on the
 * device) and back on. Test mode turns the hints off; the ?hoverhint=1 / ?tabhint=1 flags turn them
 * on again, and the engine's manual clock runs them.
 */

const HOVER = '[data-hover-hint]';
const TAB = '[data-tab-hint]';
/** Engine ms well past the end of any hint (each runs a few seconds). */
const PAST_THE_END = 10_000;

const step = (page: Page, ms: number) => page.evaluate((t) => window.__wheel!.step(t), ms);

/** Open the app with these hint flags, the engine clock manual from the start. */
async function open(page: Page, flags: Record<string, string>): Promise<void> {
  await openApp(page, flags);
  await page.evaluate(() => window.__wheel!.manual(true));
}

/** The ring centre on screen: over the wheel, on no category. */
function ringCentre(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const g = window.__wheel!.geometry();
    const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
    return { x: m.a * g.center.x + m.e, y: m.d * g.center.y + m.f };
  });
}

const hintsRow = (page: Page) => page.locator('[data-hud="menu"]').getByRole('button', { name: /^hints$/i });

/** Tap the header's ‹ (-1) or › (+1) with a finger, on the manual engine clock. */
async function tapArrow(page: Page, arrow: -1 | 1): Promise<void> {
  await page.evaluate(() => window.__wheel!.manual(true));
  const nav = page.getByRole('navigation', { name: /sections/i });
  const b = await nav.getByRole('button', { name: arrow < 0 ? /^previous/i : /^next/i }).locator('kbd').boundingBox();
  await page.touchscreen.tap(b!.x + b!.width / 2, b!.y + b!.height / 2);
}

test.describe('the explore hint on the Skills hub', () => {
  test('off in test mode unless asked for; with the flag it shows from the first frame and ends by itself', async ({ page }) => {
    await open(page, {});
    await step(page, 300);
    await expect(page.locator(HOVER)).toBeHidden();

    await open(page, { hoverhint: '1' });
    await step(page, 300);
    await expect(page.locator(HOVER)).toBeVisible();
    await expect(page.locator(HOVER)).toContainText(/explore/i);
    // It is a picture over the wheel: it never takes the pointer.
    expect(await page.locator(HOVER).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    await step(page, PAST_THE_END);
    await expect(page.locator(HOVER)).toBeHidden();
  });

  test('a pointer move away from the wheel leaves it up; the first one over the wheel ends it at once', async ({ page }) => {
    await open(page, { hoverhint: '1' });
    await step(page, 300);
    await expect(page.locator(HOVER)).toBeVisible();
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width - 40, 60);
    await step(page, 100);
    await expect(page.locator(HOVER)).toBeVisible();
    const c = await ringCentre(page);
    await page.mouse.move(c.x, c.y);
    await expect(page.locator(HOVER)).toBeHidden();
    await step(page, 300);
    await expect(page.locator(HOVER)).toBeHidden();
  });

  test('never again in a later session once a category has been hovered', async ({ page }) => {
    await open(page, { hoverhint: '1' });
    await settle(page);
    const [cat] = await categoryIds(page);
    const p = await arcPoint(page, cat);
    await page.mouse.move(p.x, p.y);
    await expectMode(page, 'hover', cat);
    // A new session on the same device.
    await page.evaluate(() => sessionStorage.clear());
    await page.mouse.move(5, 5);
    await open(page, { hoverhint: '1' });
    await expect(page.locator(HOVER)).toBeHidden();
    await step(page, PAST_THE_END);
    await expect(page.locator(HOVER)).toBeHidden();
  });

  test('phone: it says tap, and the first touch anywhere ends it', { tag: '@mobile' }, async ({ page }) => {
    await open(page, { hoverhint: '1' });
    await step(page, 300);
    await expect(page.locator(HOVER)).toBeVisible();
    await expect(page.locator(HOVER)).toContainText(/tap/i);
    await page.touchscreen.tap(4, page.viewportSize()!.height * 0.5);
    await expect(page.locator(HOVER)).toBeHidden();
  });
});

test.describe('the Hints row of the Display options menu', () => {
  test('switching it off ends the hint on screen at once; it stays off after a reload; on again, the hint shows in the next session', { tag: '@a11y' }, async ({ page }) => {
    await open(page, { hoverhint: '1' });
    await step(page, 500);
    await expect(page.locator(HOVER)).toBeVisible();
    // Keyboard only: M opens the menu, the Hints row is a toggle button.
    await page.keyboard.press('m');
    await expect(hintsRow(page)).toHaveAttribute('aria-pressed', 'true');
    await hintsRow(page).focus();
    await page.keyboard.press('Enter');
    await expect(hintsRow(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(HOVER), 'the hint on screen ends at once').toBeHidden();

    // Kept on the device: a new session starts with the hints off.
    await page.evaluate(() => sessionStorage.clear());
    await open(page, { hoverhint: '1' });
    await step(page, 500);
    await expect(page.locator(HOVER)).toBeHidden();
    await page.getByRole('button', { name: 'Display options' }).click();
    await expect(hintsRow(page)).toHaveAttribute('aria-pressed', 'false');

    // On again: the next session shows the hint.
    await hintsRow(page).click();
    await expect(hintsRow(page)).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => sessionStorage.clear());
    await page.mouse.move(5, 5);
    await open(page, { hoverhint: '1' });
    await step(page, 500);
    await expect(page.locator(HOVER)).toBeVisible();
  });
});

test.describe('the tab-swipe hint', () => {
  test('phone: after a tap on › the chevrons show; the first touch ends them', { tag: '@mobile' }, async ({ page }) => {
    await open(page, { tabhint: '1' });
    await settle(page);
    await tapArrow(page, 1);
    await step(page, 1500);
    await expect(page.locator(TAB)).toBeVisible();
    await expect(page.locator(`${TAB} [data-tab-chevron]`).first()).toBeAttached();
    const vp = page.viewportSize()!;
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.6);
    await expect(page.locator(TAB)).toBeHidden();
  });

  test('phone: never after the keyboard (E, or Enter on ›)', { tag: '@mobile' }, async ({ page }) => {
    await open(page, { tabhint: '1' });
    await settle(page);
    await page.keyboard.press('e');
    await settle(page);
    await page.getByRole('navigation', { name: /sections/i }).getByRole('button', { name: /^next/i }).focus();
    await page.keyboard.press('Enter');
    await step(page, 1500);
    await expect(page.locator(TAB)).toBeHidden();
  });

  test('never on a desktop with a mouse', async ({ page }) => {
    await open(page, { tabhint: '1' });
    await settle(page);
    await page.getByRole('navigation', { name: /sections/i }).getByRole('button', { name: /^next/i }).click();
    await step(page, 1500);
    await expect(page.locator(TAB)).toHaveCount(0);
  });
});
