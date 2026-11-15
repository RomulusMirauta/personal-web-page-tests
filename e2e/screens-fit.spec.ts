import { dispatch, openApp, screenOrder, sectionTitleText, sel, settle, ui } from './support/app';
import { expect, newContext, test } from './support/test';

/**
 * The QA Lab and Projects screens fit their box on common desktop and wide screens: nothing
 * scrolls, no card, tile or row is cut at the bottom, no line-clamped text is cut short, and the
 * footer offers no Scroll hint. (The Experience timeline scrolls by design: fit.spec.ts.)
 */
const SIZES = [
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [1440, 900],
] as const;

const FITTING_SCREENS = ['lab', 'projects'];

for (const [w, h] of SIZES) {
  test(`QA Lab and Projects fit at ${w}×${h}`, async ({ browser }) => {
    const context = await newContext(browser, { viewport: { width: w, height: h } });
    const page = await context.newPage();
    await openApp(page);
    const order = await screenOrder(page);
    const screens = FITTING_SCREENS.filter((s) => order.includes(s));
    expect(screens.length, 'the screens under test exist').toBeGreaterThan(0);
    for (const screen of screens) {
      await dispatch(page, { t: 'tab/set', screen });
      await settle(page);
      // The screen's region carries the name the header shows for it.
      const name = await sectionTitleText(page);
      // Cards and tiles slide in (CSS): measure once they rest.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
      const r = await page.evaluate((name) => {
        const region = [...document.querySelectorAll('section[aria-label]')].find((s) => s.getAttribute('aria-label')!.toLowerCase() === name.toLowerCase())!;
        const area = region.querySelector('[data-scroll]')!;
        const box = area.getBoundingClientRect();
        // Cards, tiles and rows whose bottom edge would hide below the area.
        const cut = [...area.querySelectorAll('li')]
          .filter((li) => {
            const b = li.getBoundingClientRect();
            return b.height > 0 && b.bottom > box.bottom + 0.5;
          })
          .map((li) => li.textContent!.trim().slice(0, 30));
        const clamped = [...area.querySelectorAll<HTMLElement>('p')]
          .filter((p) => getComputedStyle(p).webkitLineClamp !== 'none' && p.scrollHeight > p.clientHeight + 1)
          .map((p) => p.textContent!.slice(0, 30));
        return {
          over: area.scrollHeight - area.clientHeight,
          scrollable: area.hasAttribute('data-scrollable'),
          hint: region.querySelector('[data-scroll-hint]') !== null,
          cut,
          clamped,
        };
      }, name);
      expect(r, `${name} at ${w}×${h}`).toEqual({ over: 0, scrollable: false, hint: false, cut: [], clamped: [] });
      const hints = await page.locator(`${sel.hint}:not([data-folded])`).allTextContents();
      expect(hints.filter((t) => /scroll/i.test(t)), `${name} footer hints at ${w}×${h}`).toEqual([]);
    }
    await context.close();
  });
}
