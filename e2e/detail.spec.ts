import { categoryIds, dispatch, openApp, sel, settle, trackErrors } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * The detail view's spec card (the media slot of a skill without its own image or video): its glyph
 * wears the skill's level look, a soft-skill card stays balanced, and the project names it lists
 * are never cut in the middle, also after a live resize.
 */

type Where = { wheel: 'hard' | 'soft'; cat: string; node: string };

/** Every node of both wheels with its category. */
async function allNodes(page: Page): Promise<Where[]> {
  return page.evaluate(() => {
    const nav = window.__site!.getState().nav;
    return (['hard', 'soft'] as const).flatMap((wheel) => nav[wheel].flatMap((c) => c.nodes.map((n) => ({ wheel, cat: c.id, node: n.id }))));
  });
}

async function openNode(page: Page, w: Where): Promise<void> {
  await dispatch(page, { t: 'wheel/set', wheel: w.wheel }, { t: 'cat/open', cat: w.cat, node: w.node });
}

/** Runs in the page: a computed colour → [r, g, b, a] via a canvas (color-mix resolves). */
function rgba(colour: string): number[] {
  const el = document.createElement('div');
  el.style.color = colour;
  document.body.append(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: the spec card's glyph wears the skill's level look (its face on the wheel)`, async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, { theme });
    await page.addScriptTag({ content: `window.__rgba = ${rgba.toString()};` });
    // One skill per level look, each with a spec card, found in the live wheel.
    const seen = new Set<string>();
    for (const w of (await allNodes(page)).filter((n) => n.wheel === 'hard')) {
      const visual = await page.locator(`[data-node-id="${w.node}"]`).first().getAttribute('data-visual');
      if (!visual || seen.has(visual)) continue;
      await openNode(page, w);
      if ((await page.locator(sel.specCard).count()) === 0) continue;
      seen.add(visual);
      const r = await page.evaluate((id) => {
        // The selected node takes keyboard focus (a focus face): compare its resting face.
        (document.activeElement as HTMLElement | null)?.blur();
        const toRgba = (window as unknown as { __rgba: (c: string) => number[] }).__rgba;
        const glyph = document.querySelector('[data-spec-card] [data-visual]')!;
        const face = document.querySelector(`[data-node-id="${id}"] [class*="face"]`)!;
        const g = getComputedStyle(glyph);
        const f = getComputedStyle(face);
        return {
          visual: glyph.getAttribute('data-visual'),
          fill: toRgba(g.backgroundColor).join(),
          face: toRgba(f.fill).join(),
          ring: g.borderTopStyle === 'dashed' ? toRgba(g.borderTopColor).join() : null,
          faceRing: f.strokeDasharray !== 'none' ? toRgba(f.stroke).join() : null,
        };
      }, w.node);
      expect(r, `${w.node} (${theme})`).toEqual({ visual, fill: r.face, face: r.face, ring: r.faceRing, faceRing: r.faceRing });
      if (seen.size === 3) break;
    }
    expect(seen.size, 'spec cards of three level looks').toBe(3);
  });
}

test('a soft-skill spec card is balanced: the glyph is centred unless facts stand beside it', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await dispatch(page, { t: 'wheel/set', wheel: 'soft' });
  const off: string[] = [];
  let cards = 0;
  for (const cat of await categoryIds(page, 'soft')) {
    await dispatch(page, { t: 'cat/open', cat });
    const ids = await page.evaluate((c) => [...document.querySelectorAll(`[data-node-id][data-cat-id="${c}"]`)].map((n) => n.getAttribute('data-node-id')!), cat);
    for (const node of ids) {
      await dispatch(page, { t: 'cat/open', cat, node });
      const r = await page.evaluate(() => {
        const card = document.querySelector('[data-spec-card]');
        if (!card) return null;
        const box = card.getBoundingClientRect();
        const glyph = card.querySelector('[data-visual]')!.getBoundingClientRect();
        return {
          facts: card.querySelectorAll('dl dt').length,
          // The glyph's distance from the card's centre line, as a share of the card's width.
          offset: Math.abs((glyph.left + glyph.right) / 2 - (box.left + box.right) / 2) / box.width,
        };
      });
      if (!r) continue;
      cards++;
      if (r.facts === 0 && r.offset > 0.1) off.push(`${node}: ${JSON.stringify(r)}`);
    }
    await dispatch(page, { t: 'back' });
  }
  expect(cards, 'soft-skill spec cards').toBeGreaterThan(0);
  expect(off).toEqual([]);
});

/** The spec card's project names: whole, one per line, inside the card; a "+N" counts the rest. */
async function projectNames(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-spec-card]')!;
    const box = card.getBoundingClientRect();
    const names = [...card.querySelectorAll<HTMLElement>('[data-project-name]')];
    const rects = names.map((n) => n.getBoundingClientRect());
    return {
      texts: names.map((n) => n.textContent!),
      // Each name starts a line of its own and is never clipped.
      ownLines: rects.every((r, i) => i === 0 || r.top >= rects[i - 1].bottom - 0.5),
      clipped: names.filter((n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).map((n) => n.textContent),
      inside: rects.every((r) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5),
    };
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(`project names on a spec card are never cut mid-name (${viewport.width}×${viewport.height})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await openApp(page);
    const bad: string[] = [];
    let checked = 0;
    for (const w of await allNodes(page)) {
      await openNode(page, w);
      // A skill with its own image or video has no spec card; a card without projects has no names.
      if ((await page.locator(`${sel.specCard} [data-project-name]`).count()) === 0) continue;
      checked++;
      const r = await projectNames(page);
      // Only the last name may carry a "+N" for the names left out.
      const plusN = r.texts.filter((t) => / \+\d+$/.test(t));
      const lastOnly = plusN.length === 0 || (plusN.length === 1 && / \+\d+$/.test(r.texts.at(-1)!));
      if (!lastOnly || !r.ownLines || r.clipped.length > 0 || !r.inside || r.texts.some((t) => !t.trim())) bad.push(`${w.node}: ${JSON.stringify(r)}`);
    }
    expect(checked, 'spec cards that list projects').toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
}

test('project names refit on a live resize, without errors', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = trackErrors(page);
  await openApp(page);
  // The skill whose card lists the most projects.
  let best: { w: Where; names: number } | null = null;
  for (const w of await allNodes(page)) {
    await openNode(page, w);
    const names = await page.locator(`${sel.specCard} [data-project-name]`).count();
    if (names > (best?.names ?? 0)) best = { w, names };
  }
  expect(best, 'a spec card lists projects').not.toBeNull();
  await openNode(page, best!.w);
  const fit = () =>
    page.evaluate(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const card = document.querySelector('[data-spec-card]')!.getBoundingClientRect();
      const names = [...document.querySelectorAll('[data-spec-card] [data-project-name]')];
      return { names: names.length, inside: names.every((n) => n.getBoundingClientRect().bottom <= card.bottom + 0.5) };
    });
  const laptop = await fit();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await settle(page);
  const desktop = await fit();
  await page.setViewportSize({ width: 1366, height: 768 });
  await settle(page);
  const back = await fit();
  expect({ laptop: laptop.inside, desktop: desktop.inside, back: back.inside }).toEqual({ laptop: true, desktop: true, back: true });
  expect(desktop.names, 'names shown').toBeGreaterThan(0);
  expect(back.names, 'the same names as before the resize').toBe(laptop.names);
  expect(errors).toEqual([]);
});
