import type { Page } from '@playwright/test';
import { categoryIds, dispatch, openApp, screenOrder, settle } from './support/app';
import { finishAnimations } from './support/axe';
import { expect, test } from './support/test';

/**
 * Theme contrast from computed colours, so the result does not depend on the background's pixels:
 * text over a translucent plate is checked against the worst case behind it (black), which the
 * light theme's plates must survive.
 */

type Rgb = [number, number, number];

const lum = ([r, g, b]: Rgb) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Runs in the page: resolves CSS colours (color(), color-mix() included) through a canvas, and
 * composites translucent layers over black. Returns, per element, its text colour and the colour
 * behind it.
 */
async function textOnPlates(page: Page, root: string): Promise<{ text: string; fg: Rgb; bg: Rgb }[]> {
  return page.evaluate((rootSel) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: string, under: [number, number, number]): [number, number, number] => {
      const [r, g, b, a] = rgba(top);
      return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
    };
    const rootEl = document.querySelector(rootSel)!;
    // The plate is drawn by the root's ::before; the worst case behind it is black.
    let base = over(getComputedStyle(rootEl, '::before').backgroundColor, [0, 0, 0]);
    base = over(getComputedStyle(rootEl).backgroundColor, base);
    const out: { text: string; fg: [number, number, number]; bg: [number, number, number] }[] = [];
    for (const el of rootEl.querySelectorAll('*')) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (!own || !(el as HTMLElement).checkVisibility({ visibilityProperty: true })) continue;
      if (el.closest('.visually-hidden, [aria-hidden="true"]')) continue;
      // Every background between the root and the element, outermost first.
      const chain: Element[] = [];
      for (let p: Element | null = el; p && p !== rootEl; p = p.parentElement) chain.unshift(p);
      let bg = base;
      for (const p of chain) bg = over(getComputedStyle(p).backgroundColor, bg);
      const [r, g, b, a] = rgba(getComputedStyle(el).color);
      out.push({ text: el.textContent!.trim().slice(0, 30), fg: [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)], bg });
    }
    return out;
  }, root);
}

/** A computed colour pair of one element: its text over its own background. */
async function ownPair(page: Page, selector: string): Promise<{ fg: Rgb; bg: Rgb }> {
  return page.locator(selector).first().evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgb = (c: string): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const cs = getComputedStyle(el);
    return { fg: rgb(cs.color), bg: rgb(cs.backgroundColor) };
  });
}

test.describe('theme contrast', { tag: '@a11y' }, () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: a keyboard-focused node keeps its icon legible on the focus disc`, async ({ page }) => {
      await openApp(page, { theme });
      for (const cat of (await categoryIds(page, 'hard')).slice(0, 2)) {
        await dispatch(page, { t: 'cat/open', cat });
        await page.locator('[data-node-id]').first().focus();
        await page.keyboard.press('ArrowRight');
        await settle(page);
        const node = page.locator('[data-node-id]:focus-visible');
        await expect(node).toHaveCount(1);
        const { face, icon } = await node.evaluate((n) => {
          const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
          const rgb = (c: string) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = c;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)] as [number, number, number];
          };
          return {
            face: rgb(getComputedStyle(n.querySelector('[class*="face"]')!).fill),
            icon: rgb(getComputedStyle(n.querySelector('[class*="icon"]')!).color),
          };
        });
        // Non-text contrast (WCAG 1.4.11): at least 3:1.
        expect(contrast(face, icon), `${cat}: icon on the focus disc`).toBeGreaterThanOrEqual(3);
        await dispatch(page, { t: 'back' });
      }
    });
  }

  test('light: filled project buttons reach 4.5:1', async ({ page }) => {
    await openApp(page, { theme: 'light' });
    const screens = await screenOrder(page);
    test.skip(!screens.includes('projects'), 'no Projects screen');
    await dispatch(page, { t: 'tab/set', screen: 'projects' });
    await settle(page);
    const buttons = page.locator('a[data-primary]');
    await expect(buttons.first()).toBeVisible();
    const { fg, bg } = await ownPair(page, 'a[data-primary]');
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('light: the category tag of the skill card reaches 4.5:1 in every category of both wheels', async ({ page }) => {
    await openApp(page, { theme: 'light' });
    const low: string[] = [];
    let checked = 0;
    for (const wheel of ['hard', 'soft'] as const) {
      await dispatch(page, { t: 'wheel/set', wheel });
      for (const cat of await categoryIds(page, wheel)) {
        await dispatch(page, { t: 'cat/open', cat });
        const tag = '[data-media-slot] [class*="tag"]';
        if ((await page.locator(tag).count()) > 0) {
          const { fg, bg } = await ownPair(page, tag);
          const ratio = contrast(fg, bg);
          checked++;
          if (ratio < 4.5) low.push(`${cat}: ${ratio.toFixed(2)}:1`);
        }
        await dispatch(page, { t: 'back' });
      }
    }
    expect(checked, 'skill cards with a category tag').toBeGreaterThan(0);
    expect(low).toEqual([]);
  });

  test('light: every text in the detail panel reaches 4.5:1 even over a black background pixel', async ({ page }) => {
    await openApp(page, { theme: 'light' });
    const low: string[] = [];
    for (const cat of await categoryIds(page, 'hard')) {
      await dispatch(page, { t: 'cat/open', cat });
      await finishAnimations(page);
      const texts = await textOnPlates(page, '[data-detail-panel]');
      expect(texts.length, `${cat}: texts in the panel`).toBeGreaterThan(0);
      for (const t of texts) {
        const ratio = contrast(t.fg, t.bg);
        if (ratio < 4.5) low.push(`${cat}: "${t.text}" ${ratio.toFixed(2)}:1`);
      }
      await dispatch(page, { t: 'back' });
    }
    expect(low, low.slice(0, 10).join('\n')).toEqual([]);
  });
});
