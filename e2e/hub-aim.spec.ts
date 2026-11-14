import { appState, expectMode, openApp, settle } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * Hub aim: a click on the hub opens the category the wheel highlights, on the node the pointer is
 * aimed at when that node is one of its own. A reach that crosses another category on its way in
 * leaves that one highlighted, and the click opens it, never a node of a category that is not
 * highlighted. The aim lets go when the wheel stops taking pointer input (the interface hides, or
 * the wheels swap). Transitions run on the app's manual clock (settle()), never on wall time.
 */
type Pt = { x: number; y: number };

/** Viewport centre of a node, from its rendered face. */
async function nodeCentre(page: Page, id: string): Promise<Pt> {
  return page.evaluate((id) => {
    const face = document.querySelector(`[data-el="node"][data-node-id="${id}"] circle[class*="face"]`)!.getBoundingClientRect();
    return { x: face.x + face.width / 2, y: face.y + face.height / 2 };
  }, id);
}

async function ringCentre(page: Page): Promise<Pt> {
  return page.evaluate(() => {
    const c = window.__wheel!.geometry().center;
    const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
    return { x: m.a * c.x + m.c * c.y + m.e, y: m.b * c.x + m.d * c.y + m.f };
  });
}

/** The node(s) the wheel marks as aimed at. */
async function aimed(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[data-aim]')].map((el) => el.getAttribute('data-node-id') ?? ''));
}

async function hovered(page: Page): Promise<string | null> {
  const m = (await appState(page)).mode;
  return m.kind === 'hover' ? m.cat : null;
}

async function opened(page: Page): Promise<{ cat: string; node: string | null } | null> {
  const m = (await appState(page)).mode;
  return m.kind === 'detail' ? { cat: m.cat, node: m.node } : null;
}

test.describe('hub aim', () => {
  test('a click never opens a node outside the highlighted category, wherever the reach comes from', async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page);
    await settle(page);
    const nodes = await page.evaluate(() => window.__site!.getState().nav.hard.flatMap((c) => c.nodes.map((n) => ({ cat: c.id, node: n.id }))));
    const vp = page.viewportSize()!;
    const problems: string[] = [];
    let clicks = 0;
    for (const n of nodes) {
      const spot = await nodeCentre(page, n.node);
      // One quick reach from the bottom-right corner onto the node's resting spot, then the relayout settles.
      await page.mouse.move(vp.width - 20, vp.height - 20);
      await settle(page);
      await page.mouse.move(spot.x, spot.y, { steps: 14 });
      await settle(page);
      const cat = await hovered(page);
      const aim = await aimed(page);
      if (cat === null) continue;
      // Whatever is aimed at belongs to the highlighted category.
      const aimCat = aim.length ? await page.evaluate((id) => document.querySelector(`[data-el="node"][data-node-id="${id}"]`)!.getAttribute('data-cat-id'), aim[0]) : null;
      if (aim.length > 1 || (aimCat !== null && aimCat !== cat)) problems.push(`${n.node}: aim ${aim.join(',')} (${aimCat}) while ${cat} is highlighted`);
      await page.mouse.click(spot.x, spot.y);
      await expectMode(page, 'detail');
      clicks++;
      const o = (await opened(page))!;
      if (o.cat !== cat) problems.push(`${n.node}: ${cat} highlighted, ${o.cat} opened`);
      if (aim.length === 1 && o.node !== aim[0]) problems.push(`${n.node}: aimed at ${aim[0]}, opened ${o.node}`);
      await page.evaluate(() => window.__site!.dispatch({ t: 'back' }));
      await settle(page);
    }
    expect(clicks, 'reaches that highlighted a category').toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  test('a reach from the hub onto a node aims at it, and the click opens it', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const nav = await page.evaluate(() => window.__site!.getState().nav.hard.map((c) => ({ cat: c.id, node: c.nodes.find((n) => n.id !== c.defaultNode)?.id ?? c.nodes[0].id })));
    for (const { cat, node } of nav) {
      const spot = await nodeCentre(page, node);
      const c = await ringCentre(page);
      await page.mouse.move(c.x, c.y);
      await settle(page);
      await page.mouse.move(spot.x, spot.y, { steps: 6 });
      await expectMode(page, 'hover', cat);
      await settle(page);
      expect(await aimed(page), `${node}: the aim`).toEqual([node]);
      // The relayout may have moved the node: click where it is drawn now.
      const now = await nodeCentre(page, node);
      await page.mouse.click(now.x, now.y);
      await expectMode(page, 'detail', cat);
      expect((await opened(page))!.node).toBe(node);
      await page.evaluate(() => window.__site!.dispatch({ t: 'back' }));
      await settle(page);
    }
  });

  test('the aim lets go when the wheel stops taking pointer input: the interface hides, or the wheels swap', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [first] = await page.evaluate(() => window.__site!.getState().nav.hard.map((c) => ({ cat: c.id, node: c.nodes.find((n) => n.id !== c.defaultNode)?.id ?? c.nodes[0].id })));
    const spot = await nodeCentre(page, first.node);
    const c = await ringCentre(page);
    await page.mouse.move(c.x, c.y);
    await settle(page);
    await page.mouse.move(spot.x, spot.y, { steps: 6 });
    await expectMode(page, 'hover', first.cat);
    await settle(page);
    expect(await aimed(page)).toEqual([first.node]);
    // H: the hidden wheel aims at nothing.
    await page.keyboard.press('h');
    await expect.poll(() => aimed(page)).toEqual([]);
    // Shown again, a new reach from the hub aims at the node once more.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__site!.getState().uiHidden)).toBe(false);
    await settle(page);
    const back = await nodeCentre(page, first.node);
    await page.mouse.move(c.x, c.y);
    await settle(page);
    await page.mouse.move(back.x, back.y, { steps: 6 });
    await expectMode(page, 'hover', first.cat);
    await settle(page);
    await expect.poll(() => aimed(page)).toEqual([first.node]);
    // S: the wheel sweeping out aims at nothing either.
    await page.keyboard.press('s');
    await expect.poll(() => aimed(page)).toEqual([]);
  });
});
