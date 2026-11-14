/**
 * Hide interface (H, or Display options → Hide interface): only the background shows, and the wheel
 * takes no input. One click or tap brings the interface back and does nothing else (as a key does):
 * it does not hover, open or focus what appears under the pointer, and the next press is an
 * ordinary one. The on-screen hint says what brings the interface back, stays legible over the
 * background, and shows again whenever the pointer moves or the mouse wheel turns.
 */
import { appState, arcPoint, categoryIds, dispatch, expectHashSettles, expectMode, openApp, settle } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

const uiHidden = (page: Page) => page.evaluate(() => window.__site!.getState().uiHidden);
const wheelStatus = (page: Page) => page.locator('svg[data-active] + [role="status"]').textContent();
const hint = (page: Page) => page.locator('[data-ui-hint]');
const hintOpacity = (page: Page) => hint(page).evaluate((el) => Number(getComputedStyle(el).opacity));
/** The visible line of the hint (innerText skips the line for the other input, and is upper case). */
const hintText = (page: Page) => hint(page).evaluate((el) => (el as HTMLElement).innerText.trim().toLowerCase());
const history = (page: Page) => page.evaluate(() => ({ hash: location.hash, length: window.history.length }));
const menuTrigger = (page: Page) => page.getByRole('button', { name: 'Display options' });
const pinned = (page: Page) => page.locator('[data-pinned]');
/**
 * A negative window: longer than the browser takes to re-hover what appears under a still pointer.
 * Nothing signals that a re-hover did not come, so the checks after it run once the window has
 * passed. This is browser behaviour, not an app timing.
 */
const REHOVER_MS = 700;

/** A spot at the left edge, halfway down: empty of controls on every screen. */
const quietSpot = (page: Page) => ({ x: 8, y: page.viewportSize()!.height / 2 });

/** Wait until the stage has faded out (visibility hidden: it takes no hit tests). */
async function stageGone(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-stage]')!).visibility)).toBe('hidden');
}

/** H, then wait until the stage has faded out. */
async function hide(page: Page): Promise<void> {
  await page.keyboard.press('h');
  await stageGone(page);
}

/** WCAG relative luminance of an sRGB colour (0–255 channels). */
const luminance = ([r, g, b]: number[]) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Luminances (sorted) of the screenshot pixels in a box, decoded in the page. */
async function luminances(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number[]> {
  const shot = (await page.screenshot({ clip })).toString('base64');
  const pixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    ctx.canvas.width = img.width;
    ctx.canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const out: number[][] = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
    return out;
  }, shot);
  return pixels.map(luminance).sort((a, b) => a - b);
}

test.describe('hidden interface', () => {
  test('the hidden wheel ignores the pointer: no hover, no sound, no announcement', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __oscillators: number };
      w.__oscillators = 0;
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        w.__oscillators++;
        return create.call(this);
      };
    });
    const oscillators = () => page.evaluate(() => (window as unknown as { __oscillators: number }).__oscillators);
    await openApp(page, { sound: '1' });
    await settle(page);
    const points = [];
    for (const id of await categoryIds(page)) points.push(await arcPoint(page, id));
    // A key press is the user gesture that lets the AudioContext start: V off, V on.
    await page.keyboard.press('v');
    await page.keyboard.press('v');
    expect(await page.evaluate(() => window.__site!.getState().sound)).toBe(true);
    await hide(page);
    const status = await wheelStatus(page);
    const ticks = await oscillators();
    for (const p of points) await page.mouse.move(p.x, p.y, { steps: 4 });
    // Each move's handlers have run; two frames let the UI commit whatever they changed.
    await settle(page);
    expect((await appState(page)).mode).toEqual({ kind: 'idle' });
    expect(await oscillators()).toBe(ticks);
    expect(await wheelStatus(page)).toBe(status);
  });

  test('hiding drops the hover the pointer holds, so the interface comes back idle', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [first] = await categoryIds(page);
    const p = await arcPoint(page, first);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', first);
    await page.keyboard.press('h');
    await expectMode(page, 'idle');
    await page.keyboard.press('Escape');
    await expect.poll(() => uiHidden(page)).toBe(false);
    expect((await appState(page)).mode).toEqual({ kind: 'idle' });
  });

  test('a click while hidden only brings the interface back', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [first] = await categoryIds(page);
    const p = await arcPoint(page, first);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', first);
    await hide(page);
    const before = await history(page);
    await page.mouse.click(p.x + 2, p.y + 2);
    await expect.poll(() => uiHidden(page)).toBe(false);
    // The URL holds still: the click wrote no history.
    await expectHashSettles(page, before.hash, 'the click that shows the interface writes no history');
    expect((await appState(page)).mode).toEqual({ kind: 'idle' });
    expect(await history(page)).toEqual(before);
  });

  test('a click on the menu trigger position while hidden does not open or pin the menu', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    const box = (await trigger.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(quietSpot(page).x, quietSpot(page).y);
    await hide(page);
    await page.mouse.move(at.x, at.y, { steps: 3 });
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => uiHidden(page)).toBe(false);
    await page.waitForTimeout(REHOVER_MS); // negative window: the browser's re-hover must not open the menu
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pinned(page)).toHaveCount(0);
    await expect(trigger).not.toBeFocused();
    // Once the mouse moves, hovering works as usual (the menu opens), and a click pins it.
    await page.mouse.move(at.x + 1, at.y);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(pinned(page)).toHaveCount(0);
    await page.mouse.click(at.x + 1, at.y);
    await expect(pinned(page)).toHaveCount(1);
  });

  test('shown by a click, a press without a move acts at once: an arc opens its category', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [first] = await categoryIds(page);
    const p = await arcPoint(page, first);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await hide(page);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => uiHidden(page)).toBe(false);
    await page.waitForTimeout(REHOVER_MS); // negative window: the browser's re-hover must not hover the arc
    expect((await appState(page)).mode).toEqual({ kind: 'idle' });
    // A trackpad tap, or a mouse that has not moved: it reaches the arc.
    await page.mouse.down();
    await page.mouse.up();
    await expectMode(page, 'detail', first);
  });

  test('shown by a click, a press without a move on the menu trigger pins the menu', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    const box = (await trigger.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true'); // hovered open
    await hide(page);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => uiHidden(page)).toBe(false);
    await page.waitForTimeout(REHOVER_MS); // negative window: the browser's re-hover must not open the menu
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.down();
    await page.mouse.up();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(pinned(page)).toHaveCount(1);
  });

  test('hidden from the menu, a click brings the interface back with the menu closed and focus on its trigger, as a key does', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const trigger = menuTrigger(page);
    await trigger.click();
    await page.getByRole('button', { name: /hide interface/i }).click();
    await stageGone(page);
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width * 0.3, vp.height * 0.85);
    await expect.poll(() => uiHidden(page)).toBe(false);
    await page.waitForTimeout(REHOVER_MS); // negative window: the browser's re-hover must not open the menu
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(pinned(page)).toHaveCount(0);
    // The Hide row sits in the closed menu now: its trigger takes focus (focus alone does not open it).
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Hidden from the menu by keyboard and shown by a key: focus goes back to the trigger.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /hide interface/i }).focus();
    await page.keyboard.press('Enter');
    await stageGone(page);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('a click reveal returns focus like a key reveal: to the element that had it before H', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await settle(page);
    const chip = page.getByRole('link', { name: /^Show .+ on the skill wheel$/ }).nth(2);
    await chip.focus();
    await expect(chip).toBeFocused();
    // Shown by a key: focus is back on the chip.
    await hide(page);
    await page.keyboard.press('x');
    await expect.poll(() => uiHidden(page)).toBe(false);
    await expect(chip).toBeFocused();
    // Shown by a click: the same, and the click does nothing else.
    await hide(page);
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await expect.poll(() => uiHidden(page)).toBe(false);
    await expect(chip).toBeFocused();
    expect((await appState(page)).screen).toBe('experience');
  });

  test('keys keep their behaviour, and a key reveal leaves the next click alone', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [first] = await categoryIds(page);
    const p = await arcPoint(page, first);
    const theme = await page.evaluate(() => window.__site!.getState().theme);
    await hide(page);
    await page.keyboard.press('t'); // a display key: it acts and the interface stays hidden
    await expect.poll(() => page.evaluate(() => window.__site!.getState().theme)).not.toBe(theme);
    await page.keyboard.press('F2'); // the browser's keys pass through
    expect(await uiHidden(page)).toBe(true);
    await page.keyboard.press('x'); // any other key brings it back
    await expect.poll(() => uiHidden(page)).toBe(false);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', first);
    await page.mouse.click(p.x, p.y);
    await expectMode(page, 'detail', first);
  });

  test('V (sound) acts and keeps it hidden; Esc brings it back', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await hide(page);
    const sound = await page.evaluate(() => window.__site!.getState().sound);
    await page.keyboard.press('v');
    await expect.poll(() => page.evaluate(() => window.__site!.getState().sound)).toBe(!sound);
    expect(await uiHidden(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => uiHidden(page)).toBe(false);
  });

  test('the hint says how to show the interface, and shows again whenever the pointer moves or the wheel turns', async ({ page }) => {
    await openApp(page);
    const spot = quietSpot(page);
    await page.mouse.move(spot.x, spot.y);
    await page.keyboard.press('h');
    expect(await hintText(page)).toMatch(/click or press esc/);
    // It fades away on its own …
    await expect.poll(() => hintOpacity(page)).toBe(0);
    // … and a pointer move brings it back.
    await page.mouse.move(spot.x + 40, spot.y - 40, { steps: 2 });
    await expect.poll(() => hintOpacity(page)).toBeGreaterThan(0.5);
    await expect.poll(() => hintOpacity(page)).toBe(0);
    // So does the mouse wheel …
    await page.mouse.wheel(0, 120);
    await expect.poll(() => hintOpacity(page)).toBeGreaterThan(0.5);
    // … and neither brought the interface back or stepped the invisible wheel.
    expect(await uiHidden(page)).toBe(true);
    expect((await appState(page)).mode).toEqual({ kind: 'idle' });

    // Touch screens read the tap line.
    await page.evaluate(() => (document.documentElement.dataset.pointer = 'coarse'));
    expect(await hintText(page)).toMatch(/^tap/);
    await page.keyboard.press('Escape');
    await expect.poll(() => uiHidden(page)).toBe(false);
    await expect(hint(page)).toHaveCount(0);
  });

  // The hint has no veil behind it: it is read against the background itself.
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: the hint reads at 4.5:1 or more over the background behind it`, { tag: '@a11y' }, async ({ page }) => {
      await openApp(page, { theme });
      const spot = quietSpot(page);
      await page.mouse.move(spot.x, spot.y);
      await hide(page);
      const line = hint(page).locator('span').first();
      const box = (await line.boundingBox())!;
      const ink = await hint(page).evaluate((el) => getComputedStyle(el).color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number));
      // The background alone in the hint's box (the hint's own pixels left out).
      await hint(page).evaluate((el) => (el.style.visibility = 'hidden'));
      const behind = await luminances(page, box);
      const at = (q: number) => behind[Math.min(behind.length - 1, Math.floor(q * behind.length))];
      const text = luminance(ink);
      // Median and both tails (5 % / 95 %): a few lit windows aside, every pixel behind the words.
      for (const q of [0.05, 0.5, 0.95]) expect({ q, ratio: contrast(text, at(q)) >= 4.5 }).toEqual({ q, ratio: true });
    });
  }
});

for (const device of [
  { name: 'tablet', tag: [] as string[], use: { hasTouch: true, viewport: { width: 1280, height: 800 } } },
  { name: 'phone', tag: ['@mobile'], use: {} },
]) {
  test.describe(`hidden interface on a touch screen (${device.name})`, { tag: device.tag }, () => {
    test.use(device.use);

    test('hidden from the menu, a tap brings the interface back without hovering or opening the menu', async ({ page }) => {
      await openApp(page);
      await settle(page);
      const [first] = await categoryIds(page);
      const p = await arcPoint(page, first);
      const trigger = menuTrigger(page);
      await trigger.tap();
      await page.getByRole('button', { name: /hide interface/i }).tap();
      await stageGone(page);
      await page.touchscreen.tap(p.x, p.y);
      await expect.poll(() => uiHidden(page)).toBe(false);
      await page.waitForTimeout(REHOVER_MS); // negative window: the tap must not hover or open what appeared under it
      expect((await appState(page)).mode).toEqual({ kind: 'idle' });
      // The menu that hid the interface stays closed; focus is back on its trigger, as after a key.
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(pinned(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // The next tap is an ordinary one: a tap on a category selects it, a second tap opens it.
      await page.touchscreen.tap(p.x, p.y);
      await expectMode(page, 'hover', first);
      await settle(page);
      const q = await arcPoint(page, first);
      await page.touchscreen.tap(q.x, q.y);
      await expectMode(page, 'detail', first);
    });

    // Chromium sends every tap a click; Mobile Safari only when the element tapped, or an ancestor
    // below <body>, handles clicks itself (window and document listeners never count). Read over CDP.
    test('a tap anywhere on the hidden interface hits an element that handles clicks itself', async ({ page }) => {
      await openApp(page);
      await settle(page);
      const cdp = await page.context().newCDPSession(page);
      /** The event types that the element under (x, y) and its ancestors below <body> listen for themselves. */
      const ownListeners = async (x: number, y: number) => {
        const count = await page.evaluate(
          ([px, py]) => {
            const chain: Element[] = [];
            for (let el = document.elementFromPoint(px, py); el && el !== document.body; el = el.parentElement) chain.push(el);
            (window as unknown as { __tapChain: Element[] }).__tapChain = chain;
            return chain.length;
          },
          [x, y],
        );
        const types: string[] = [];
        for (let i = 0; i < count; i++) {
          const { result } = await cdp.send('Runtime.evaluate', { expression: `window.__tapChain[${i}]` });
          const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
          types.push(...listeners.map((l) => l.type));
        }
        return types;
      };
      const { width, height } = page.viewportSize()!;
      await page.evaluate(() => window.__site!.dispatch({ t: 'ui/hide' }));
      await stageGone(page);
      for (const [x, y] of [
        [width / 2, height / 2],
        [width - 24, 24],
        [24, height - 24],
      ]) {
        expect({ x, y, click: (await ownListeners(x, y)).includes('click') }).toEqual({ x, y, click: true });
      }
      await cdp.detach();
      await page.touchscreen.tap(width / 2, height / 2);
      await expect.poll(() => uiHidden(page)).toBe(false);
      expect((await appState(page)).mode).toEqual({ kind: 'idle' });
    });
  });
}
