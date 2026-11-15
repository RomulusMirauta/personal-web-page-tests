import type { Page } from '@playwright/test';
import { categoryIds, dispatch, openApp, sel, settle } from './support/app';
import { expect, newContext, test } from './support/test';

/**
 * Things that must fit their boxes on desktop: the wheel's nodes stay below the header band, the
 * detail text column fits without scrolling (extra chips fold into a "+N" button), the player card's
 * text is never cut at common window sizes, the Experience timeline signals that it scrolls, and the
 * Contact screen's CV and contact card buttons stay inside their column.
 */

const band = (page: Page) => page.locator('header[data-hud] nav').first();

/** Wait until every finite CSS animation (cards and columns sliding in) has finished. */
const cssAtRest = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));

/** Top of the highest visible node disc overlapping the band horizontally, minus the band's bottom (CSS px). */
async function nodeClearance(page: Page): Promise<{ gap: number; id: string | null }> {
  const b = (await band(page).boundingBox())!;
  return page.evaluate((hb) => {
    let worst = { gap: Infinity, id: null as string | null };
    for (const n of document.querySelectorAll('[data-node-id]')) {
      const face = n.querySelector('[data-el="face"]') ?? n.querySelector('circle');
      if (!face || +getComputedStyle(n).opacity === 0) continue;
      const r = face.getBoundingClientRect();
      if (r.width < 2 || r.right < hb.x || r.left > hb.x + hb.width) continue;
      const gap = r.top - (hb.y + hb.height);
      if (gap < worst.gap) worst = { gap, id: n.getAttribute('data-node-id') };
    }
    return worst;
  }, b);
}

test.describe('wheel nodes stay below the header band', () => {
  for (const kind of ['hover', 'detail'] as const) {
    test(`every hard and soft category, ${kind}`, async ({ page }) => {
      await openApp(page);
      for (const wheel of ['hard', 'soft'] as const) {
        await dispatch(page, { t: 'wheel/set', wheel });
        for (const cat of await categoryIds(page, wheel)) {
          await dispatch(page, kind === 'hover' ? { t: 'cat/hover', cat } : { t: 'cat/open', cat });
          const { gap, id } = await nodeClearance(page);
          expect({ wheel, cat, id, clear: gap >= 0 }).toEqual({ wheel, cat, id, clear: true });
          if (kind === 'detail') await dispatch(page, { t: 'back' });
        }
        await dispatch(page, { t: 'cat/hover', cat: null });
      }
    });
  }
});

/** Node ids of a category, as the wheel renders them. */
const nodesOf = (page: Page, cat: string) =>
  page.evaluate((c) => [...document.querySelectorAll(`[data-node-id][data-cat-id="${c}"]`)].map((n) => n.getAttribute('data-node-id')!), cat);

test.describe('detail text column fits at 1920×1080', () => {
  for (const wheel of ['hard', 'soft'] as const) {
    test(`${wheel} wheel: no node's default view scrolls`, async ({ page }) => {
      test.setTimeout(120_000);
      await openApp(page);
      await dispatch(page, { t: 'wheel/set', wheel });
      const over: string[] = [];
      for (const cat of await categoryIds(page, wheel)) {
        await dispatch(page, { t: 'cat/open', cat });
        for (const node of await nodesOf(page, cat)) {
          await dispatch(page, { t: 'cat/open', cat, node });
          const r = await page.evaluate(() => {
            const panel = document.querySelector('[data-detail-panel]')!;
            const areas = panel.querySelectorAll('[data-scroll]');
            const text = areas[areas.length > 1 ? 1 : 0];
            return { title: panel.querySelector('h3')?.textContent ?? '', over: text.scrollHeight - text.clientHeight, hint: panel.querySelector('[data-scroll-hint]') !== null };
          });
          if (r.over > 1 || r.hint) over.push(`${node} (${r.title}): ${r.over} px`);
        }
        await dispatch(page, { t: 'back' });
      }
      expect(over).toEqual([]);
    });
  }

  test('"+N" shows the folded chips again', async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page);
    // The first node whose chips fold, found in the live content.
    let found = false;
    for (const cat of await categoryIds(page)) {
      await dispatch(page, { t: 'cat/open', cat });
      for (const node of await nodesOf(page, cat)) {
        await dispatch(page, { t: 'cat/open', cat, node });
        if ((await page.locator(`${sel.panel} [data-chip-more] button`).count()) > 0) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    test.skip(!found, 'no node folds its chips at this size with the current content');
    const chips = page.locator(`${sel.panel} li:not([data-chip-more])`);
    const before = await chips.count();
    await page.locator(`${sel.panel} [data-chip-more] button`).first().click();
    await settle(page);
    await expect(page.locator(`${sel.panel} [data-chip-more]`)).toHaveCount(0);
    expect(await chips.count()).toBeGreaterThan(before);
  });
});

test.describe('player card text is never cut', () => {
  for (const [w, h] of [
    [1920, 1080],
    [1280, 1024],
    [1280, 720],
    [1024, 768],
    [960, 540],
  ] as const) {
    test(`${w}×${h}`, async ({ browser }) => {
      const context = await newContext(browser, { viewport: { width: w, height: h } });
      const page = await context.newPage();
      await openApp(page);
      const panel = page.locator('[data-card-panel]');
      await expect(panel).toBeVisible();
      const parts = await panel.evaluate((p) =>
        [...p.children].map((e) => ({ text: e.textContent, wide: e.scrollWidth - e.clientWidth, tall: e.scrollHeight - e.clientHeight })),
      );
      for (const part of parts) expect(part, part.text ?? '').toMatchObject({ wide: 0, tall: 0 });
      // The name line is tall enough for its descenders (the comma below "ț"): at least the font's
      // normal line height.
      const name = await panel.locator(':scope > :first-child').evaluate((e) => ({
        box: (e as HTMLElement).offsetHeight,
        font: parseFloat(getComputedStyle(e).fontSize),
      }));
      expect(name.box).toBeGreaterThanOrEqual(name.font * 1.2);
      // The card ends before the header band starts.
      const p = (await panel.boundingBox())!;
      const b = (await band(page).boundingBox())!;
      expect(p.x + p.width).toBeLessThanOrEqual(b.x);
      await context.close();
    });
  }
});

test('the Experience timeline fades the edge that hides content; the footer offers Scroll', async ({ page }) => {
  await openApp(page);
  await dispatch(page, { t: 'tab/set', screen: 'experience' });
  await settle(page);
  const r = await page.evaluate(() => {
    const area = document.querySelector('main [data-scroll][data-scroll-primary]') ?? document.querySelector('[data-scroll][aria-label="Work and education"]')!;
    return {
      scrollable: area.scrollHeight > area.clientHeight + 1,
      below: area.hasAttribute('data-more-below'),
      mask: getComputedStyle(area).maskImage,
      cues: document.querySelectorAll('[data-scroll-hint]').length,
    };
  });
  test.skip(!r.scrollable, 'the timeline fits at this size with the current content');
  // On a pointer device the footer's Scroll hint is the one cue; no cue over the content.
  expect(r.below).toBe(true);
  expect(r.mask).toContain('linear-gradient');
  expect(r.cues).toBe(0);
  const hints = await page.locator(`${sel.hint}:not([data-folded])`).allTextContents();
  expect(hints.filter((t) => /scroll/i.test(t))).toHaveLength(1);
});

test('Contact: the CV and contact card buttons stay inside their column and end on its right edge', async ({ page }) => {
  await openApp(page);
  await dispatch(page, { t: 'tab/set', screen: 'contact' });
  await settle(page);
  await cssAtRest(page);
  const r = await page.evaluate(() => {
    // The CV and contact card row (Download CV, the vCard, the printable CV): every link of the row.
    const buttons = [...document.querySelector('a[download]')!.parentElement!.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
    const column = document.querySelector('a[download]')!.closest('[data-scroll]')!;
    const box = column.getBoundingClientRect();
    const cs = getComputedStyle(column);
    return {
      count: buttons.length,
      right: Math.max(...buttons.map((b) => b.right)),
      left: Math.min(...buttons.map((b) => b.left)),
      contentRight: box.right - parseFloat(cs.paddingRight),
      contentLeft: box.left + parseFloat(cs.paddingLeft),
    };
  });
  expect(r.count).toBeGreaterThan(0);
  expect(r.right).toBeLessThanOrEqual(r.contentRight + 1);
  expect(r.left).toBeGreaterThanOrEqual(r.contentLeft - 1);
  expect(Math.abs(r.right - r.contentRight), 'the row ends on the content’s right edge').toBeLessThanOrEqual(1);
});
