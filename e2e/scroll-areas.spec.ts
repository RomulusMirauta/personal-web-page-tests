import type { Browser, Page } from '@playwright/test';
import { appState, dispatch, openApp, screenOrder, sel, settle } from './support/app';
import { expect, newContext, test } from './support/test';

/**
 * Scroll areas. One scroll affordance per screen: on pointer devices the footer's Scroll hint
 * speaks for the screens, whose areas only fade the edge that hides content (no cue over the text,
 * also at high zoom); touch screens have no footer hint, so an area that goes on shows its own cue
 * under the columns that go on, clear of the call-to-action box and with no plate behind it. And a
 * screen that comes back (next section and back, or Back from a skill opened by a chip) is scrolled
 * where it was left.
 */

async function openSized(browser: Browser, width: number, height: number, touch = false): Promise<Page> {
  const context = await newContext(browser, { viewport: { width, height }, isMobile: touch, hasTouch: touch });
  const page = await context.newPage();
  await openApp(page);
  return page;
}

async function showTab(page: Page, screen: string): Promise<void> {
  await dispatch(page, { t: 'tab/set', screen });
  await settle(page);
  // Entries slide in (CSS): measure once they rest.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/** The Experience screen's primary scroll area (its timeline). */
const TIMELINE = 'main [data-scroll][data-scroll-primary]';

/** Two frames: a programmatic scroll's event (which saves the place) has fired by then. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test.describe('pointer devices: the footer’s Scroll hint is the one cue', () => {
  for (const [w, h, what] of [
    [1366, 768, 'a laptop'],
    [640, 360, '1920×1080 at 300 % zoom'],
    [480, 270, '1920×1080 at 400 % zoom'],
  ] as const) {
    test(`Experience on ${what} (${w}×${h}): the timeline’s edge fades, no in-content cue`, async ({ browser }) => {
      const page = await openSized(browser, w, h);
      await showTab(page, 'experience');
      const r = await page.evaluate((s) => {
        const area = document.querySelector(s)!;
        return {
          scrollable: area.scrollHeight > area.clientHeight + 1,
          below: area.hasAttribute('data-more-below'),
          mask: getComputedStyle(area).maskImage,
          cues: document.querySelectorAll('[data-scroll-hint]').length,
        };
      }, TIMELINE);
      test.skip(!r.scrollable, 'the timeline fits at this size with the current content');
      expect(r.below).toBe(true);
      expect(r.mask).toContain('linear-gradient');
      expect(r.cues).toBe(0);
      const hints = await page.locator(`${sel.hint}:not([data-folded])`).allTextContents();
      expect(hints.filter((t) => /scroll/i.test(t))).toHaveLength(1);
      await page.context().close();
    });
  }
});

type Rect = { left: number; top: number; right: number; bottom: number };

/** One scrollable region on a touch screen (CSS px). */
interface Region {
  label: string;
  area: Rect;
  cue: Rect | null;
  columns: { name: string; rect: Rect; goesOn: boolean }[];
  plate: { image: string; color: string } | null;
  cta: Rect | null;
}

/** Every scrollable region of the current screen, with its cue, columns and the CTA box. */
const regions = (page: Page) =>
  page.evaluate((): Region[] => {
    const rect = (b: DOMRect): Rect => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
    const ctaEl = document.querySelector('[data-cta]');
    const cta = ctaEl && ctaEl.getBoundingClientRect().height > 0 && Number(getComputedStyle(ctaEl).opacity) > 0 ? rect(ctaEl.getBoundingClientRect()) : null;
    return [...document.querySelectorAll<HTMLElement>('[data-scroll][data-scrollable]')].map((el) => {
      const button = el.parentElement!.querySelector<HTMLElement>(':scope > [data-scroll-hint] button');
      // The area's columns: its children, or a lone layout wrapper's.
      const only = el.childElementCount === 1 ? el.firstElementChild! : null;
      const edge = el.getBoundingClientRect().bottom;
      const columns = [...(only && only.childElementCount > 1 ? only.children : el.children)].map((c) => ({
        name: (c.querySelector('h2, h3')?.textContent ?? c.tagName).trim(),
        rect: rect(c.getBoundingClientRect()),
        goesOn: c.getBoundingClientRect().bottom > edge + 1,
      }));
      const row = button?.parentElement;
      return {
        label: el.getAttribute('aria-label') ?? '',
        area: rect(el.getBoundingClientRect()),
        cue: button ? rect(button.getBoundingClientRect()) : null,
        columns,
        plate: row ? { image: getComputedStyle(row).backgroundImage, color: getComputedStyle(row).backgroundColor } : null,
        cta,
      };
    });
  });

const apart = (a: Rect, b: Rect) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;

/**
 * What every cue on a touch screen keeps to: a region whose columns go on past its edge shows a
 * cue; the cue sits over the columns that go on and inside the area, clear of the CTA box, with no
 * plate behind it. A region whose columns all end above its edge (only padding hides) needs none.
 */
function expectCueRules(r: Region, where: string): void {
  const at = `${where} "${r.label}"`;
  const goOn = r.columns.filter((c) => c.goesOn);
  if (!r.cue) {
    expect(goOn.map((c) => c.name), `${at}: a column goes on but there is no cue`).toEqual([]);
    return;
  }
  if (goOn.length) {
    expect(r.cue.left, `${at}: cue left`).toBeGreaterThanOrEqual(Math.min(...goOn.map((c) => c.rect.left)) - 0.5);
    expect(r.cue.right, `${at}: cue right`).toBeLessThanOrEqual(Math.max(...goOn.map((c) => c.rect.right)) + 0.5);
  }
  expect(r.cue.left >= r.area.left - 0.5 && r.cue.right <= r.area.right + 0.5, `${at}: cue inside the area horizontally`).toBe(true);
  if (r.cta) expect(apart(r.cue, r.cta), `${at}: cue clear of the CTA box`).toBe(true);
  expect(r.plate?.image, `${at}: no plate image`).toBe('none');
  expect(r.plate?.color, `${at}: no plate colour`).toBe('rgba(0, 0, 0, 0)');
}

test.describe('touch screens: the cue sits under the columns that go on, clear of the CTA box', () => {
  for (const [w, h, what] of [
    [1920, 1080, 'large touch screen'],
    [1366, 1024, 'tablet'],
    [1024, 768, 'tablet'],
    [844, 390, 'phone held sideways'],
  ] as const) {
    test(`every scroll area on every screen, ${what} ${w}×${h}`, async ({ browser }) => {
      const page = await openSized(browser, w, h, true);
      expect(await page.evaluate(() => document.documentElement.dataset.pointer)).toBe('coarse');
      let cues = 0;
      for (const screen of (await screenOrder(page)).filter((s) => s !== 'skills')) {
        await showTab(page, screen);
        for (const r of await regions(page)) {
          expectCueRules(r, `${w}×${h} ${screen}`);
          if (r.cue) cues++;
        }
      }
      // Each of these sizes has at least one screen that scrolls, so the rules above were exercised.
      expect(cues, 'cues found').toBeGreaterThan(0);
      await page.context().close();
    });
  }

  test('on the phone: every scroll area on every screen', { tag: '@mobile' }, async ({ page }) => {
    await openApp(page);
    const vp = page.viewportSize()!;
    let cues = 0;
    for (const screen of (await screenOrder(page)).filter((s) => s !== 'skills')) {
      await showTab(page, screen);
      for (const r of await regions(page)) {
        expectCueRules(r, `${vp.width}×${vp.height} ${screen}`);
        if (r.cue) cues++;
      }
    }
    // A phone shows more than fits: at least one screen scrolls, so the rules above were exercised.
    expect(cues, 'cues on the phone').toBeGreaterThan(0);
  });
});

test.describe('a screen that comes back is scrolled where it was left', () => {
  /** Scroll the Experience timeline to its end; returns its scrollTop there. */
  async function scrollTimelineToEnd(page: Page): Promise<number> {
    await showTab(page, 'experience');
    const top = await page.locator(TIMELINE).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    await frames(page);
    expect(top, 'the timeline scrolls at this size').toBeGreaterThan(0);
    return top;
  }
  const timelineTop = (page: Page) => page.locator(TIMELINE).evaluate((el) => el.scrollTop);

  // A small landscape window (one timeline column), where the timeline scrolls: at 1920×1080 the
  // work history fits.
  test.use({ viewport: { width: 853, height: 430 } });

  test('next section, then back', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const top = await scrollTimelineToEnd(page);
    await dispatch(page, { t: 'tab', dir: 1 });
    await expect.poll(async () => (await appState(page)).screen).not.toBe('experience');
    await dispatch(page, { t: 'tab', dir: -1 });
    await expect.poll(async () => (await appState(page)).screen).toBe('experience');
    await expect.poll(() => timelineTop(page)).toBe(top);
    // Back where it was: the top edge fades now.
    await expect(page.locator(TIMELINE)).toHaveAttribute('data-more-above', '');
  });

  test('Back from a skill opened by a chip', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const top = await scrollTimelineToEnd(page);
    // A chip in full view (a click would otherwise scroll the timeline to it first).
    const index = await page.locator(TIMELINE).evaluate((area) => {
      const box = area.getBoundingClientRect();
      const chips = [...area.querySelectorAll('a[href^="#/skills/"]')];
      return chips.findIndex((c) => {
        const b = c.getBoundingClientRect();
        return b.height > 0 && b.top > box.top + 8 && b.bottom < box.bottom - 80;
      });
    });
    expect(index, 'a skill chip in full view').toBeGreaterThanOrEqual(0);
    await page.locator(TIMELINE).locator('a[href^="#/skills/"]').nth(index).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/skills\//);
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/experience');
    await expect.poll(() => timelineTop(page)).toBe(top);
  });
});
