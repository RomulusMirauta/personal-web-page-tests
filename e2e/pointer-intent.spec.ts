import { appPath, appState, arcPoint, categories, categoryIds, dispatch, expectMode, openApp, settle } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * Pointer intent on the skill wheel: the category the visitor aims at is the category that
 * highlights, and the skill the visitor aims at is the skill that opens.
 * - Aiming at an arc hovers its category; moving off the wheel lets it go; moving from one arc to
 *   the next never drops the hover on the way; a click on a hovered arc opens it.
 * - In the hub, a click where a node was aimed opens that node, even after the hovered category's
 *   relayout has moved it.
 * - In the detail view, a node becomes the selection once the pointer rests on it, so passing over
 *   other nodes on the way to the panel keeps the selection; a mouse-only visitor never gets the
 *   keyboard focus ring.
 * Transitions run on the app's manual clock: settle() runs them to their end, so no step depends
 * on wall time.
 */

type Pt = { x: number; y: number };

/** Viewport centre and radius of a node, from its rendered face. */
async function nodeCentre(page: Page, id: string): Promise<Pt & { r: number }> {
  return page.evaluate((id) => {
    const face = document.querySelector(`[data-el="node"][data-node-id="${id}"] circle[class*="face"]`)!.getBoundingClientRect();
    return { x: face.x + face.width / 2, y: face.y + face.height / 2, r: face.width / 2 };
  }, id);
}

/** Viewport point of the ring's centre (the hub's hole). */
async function ringCentre(page: Page): Promise<Pt> {
  return page.evaluate(() => {
    const c = window.__wheel!.geometry().center;
    const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
    return { x: m.a * c.x + m.c * c.y + m.e, y: m.b * c.x + m.d * c.y + m.f };
  });
}

/** Viewport points along the ring's middle, from one angle to another (degrees clockwise from 12 o'clock). */
async function ringPath(page: Page, from: number, to: number, steps: number): Promise<Pt[]> {
  return page.evaluate(
    ({ from, to, steps }) => {
      const g = window.__wheel!.geometry();
      const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
      const r = (g.rInner + g.rOuter) / 2;
      return Array.from({ length: steps + 1 }, (_v, i) => {
        const theta = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
        const x = g.center.x + r * Math.sin(theta);
        const y = g.center.y - r * Math.cos(theta);
        return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
      });
    },
    { from, to, steps },
  );
}

/** Two frames: input already sent has been handled and rendered. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function hovered(page: Page): Promise<string | null> {
  const m = (await appState(page)).mode;
  return m.kind === 'hover' ? m.cat : null;
}

async function selected(page: Page): Promise<string | null> {
  const m = (await appState(page)).mode;
  return m.kind === 'detail' ? m.node : null;
}

/** A point at the left edge of the viewport, halfway down: off the wheel. */
const offWheel = (page: Page): Pt => ({ x: 8, y: page.viewportSize()!.height / 2 });

test.describe('pointer intent: arcs', () => {
  test('aiming at an arc hovers its category, and moving off the wheel lets it go', async ({ page }) => {
    await openApp(page);
    await settle(page);
    for (const cat of await categoryIds(page)) {
      const p = await arcPoint(page, cat);
      await page.mouse.move(p.x, p.y, { steps: 4 });
      await expectMode(page, 'hover', cat);
      const away = offWheel(page);
      await page.mouse.move(away.x, away.y, { steps: 4 });
      await expectMode(page, 'idle');
      await settle(page);
    }
  });

  test('moving from one arc to the next never drops the hover on the way', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const arcs = await page.evaluate(() => window.__wheel!.geometry().arcs.map((a) => ({ id: a.id, mid: (a.a0 + a.a1) / 2 })));
    expect(arcs.length, 'categories on the wheel').toBeGreaterThan(1);
    for (let i = 0; i + 1 < arcs.length; i++) {
      const [a, b] = [arcs[i], arcs[i + 1]];
      // Settled on the first arc's hover, then along the ring onto the next one, across the gap between them.
      const start = await arcPoint(page, a.id);
      await page.mouse.move(start.x, start.y, { steps: 4 });
      await expectMode(page, 'hover', a.id);
      await settle(page);
      const fromAngle = await page.evaluate((id) => {
        const arc = window.__wheel!.geometry().arcs.find((x) => x.id === id)!;
        return (arc.a0 + arc.a1) / 2;
      }, a.id);
      const toAngle = await page.evaluate((id) => {
        const arc = window.__wheel!.geometry().arcs.find((x) => x.id === id)!;
        return (arc.a0 + arc.a1) / 2;
      }, b.id);
      const lost: string[] = [];
      for (const p of await ringPath(page, fromAngle, toAngle, 24)) {
        await page.mouse.move(p.x, p.y);
        await frames(page);
        const h = await hovered(page);
        if (h === null) lost.push(`(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
      }
      expect(lost, `${a.id} → ${b.id}: points where no category was hovered`).toEqual([]);
      await expectMode(page, 'hover', b.id);
    }
  });

  test('a click on a hovered arc opens that category', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const cats = await categoryIds(page);
    const target = cats[cats.length - 1];
    const p = await arcPoint(page, target);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', target);
    await settle(page);
    const q = await arcPoint(page, target);
    await page.mouse.click(q.x, q.y);
    await expectMode(page, 'detail', target);
  });
});

test.describe('pointer intent: nodes', () => {
  test('hub: a click where a node was aimed opens that node, once the hover relayout has run', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const [cat] = await categories(page);
    // A node of the first category other than the one it opens on by default.
    const node = await page.evaluate(
      ({ id, fallback }) => window.__site!.getState().nav.hard.find((c) => c.id === id)!.nodes.find((n) => n.id !== fallback)!.id,
      { id: cat.id, fallback: cat.node },
    );
    const aim = await nodeCentre(page, node);
    // Out from the hub's hole straight onto the node's resting spot.
    const c = await ringCentre(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.move(aim.x, aim.y, { steps: 6 });
    await expectMode(page, 'hover', cat.id);
    await settle(page);
    await page.mouse.click(aim.x, aim.y);
    await expectMode(page, 'detail', cat.id);
    expect(await selected(page)).toBe(node);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/skills/${cat.id}/${node}`);
  });

  test('detail: resting on a node selects it', async ({ page }) => {
    await openApp(page);
    const [cat] = await categories(page);
    await dispatch(page, { t: 'cat/open', cat: cat.id });
    const before = await selected(page);
    const other = await page.evaluate(
      ({ id, before }) =>
        [...document.querySelectorAll(`[data-el="node"][data-cat-id="${id}"]`)].map((n) => n.getAttribute('data-node-id')!).find((n) => n !== before)!,
      { id: cat.id, before },
    );
    const p = await nodeCentre(page, other);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await frames(page);
    // The clock is held: passing onto the node alone does not select it …
    expect(await selected(page)).toBe(before);
    // … resting on it does.
    await settle(page);
    await expect.poll(() => selected(page)).toBe(other);
  });

  test('detail: moving to the panel across other nodes keeps the selection', async ({ page }) => {
    await openApp(page);
    const [cat] = await categories(page);
    await dispatch(page, { t: 'cat/open', cat: cat.id });
    const nodes = await page.evaluate(
      (id) => [...document.querySelectorAll(`svg[data-active] [data-el="node"][data-cat-id="${id}"]`)].map((n) => n.getAttribute('data-node-id')!),
      cat.id,
    );
    const panel = (await page.locator('[data-detail-panel]').first().boundingBox())!;
    const to = { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 };
    // A start node whose straight path to the panel passes over other nodes.
    let found = false;
    for (const start of nodes) {
      const from = await nodeCentre(page, start);
      const path = Array.from({ length: 25 }, (_v, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / 25, y: from.y + ((to.y - from.y) * (i + 1)) / 25 }));
      const crosses = await page.evaluate(
        ({ path, start }) => path.some((p) => {
          const id = document.elementFromPoint(p.x, p.y)?.closest('[data-node-id]')?.getAttribute('data-node-id');
          return Boolean(id) && id !== start;
        }),
        { path, start },
      );
      if (!crosses) continue;
      found = true;
      // Rest on the start node: it becomes the selection.
      await page.mouse.move(from.x, from.y, { steps: 2 });
      await settle(page);
      await expect.poll(() => selected(page)).toBe(start);
      // A pointer's pace: each move is handled before the next, the clock held between them.
      for (const p of path) {
        await page.mouse.move(p.x, p.y);
        await frames(page);
      }
      await settle(page);
      expect(await selected(page), 'the selection after reaching the panel').toBe(start);
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/skills/${cat.id}/${start}`);
      break;
    }
    expect(found, 'a node whose path to the panel crosses other nodes').toBe(true);
  });

  test('a mouse-only visitor never gets the keyboard focus ring on a node', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const focusRing = () => page.evaluate(() => [...document.querySelectorAll('[data-node-id]')].filter((n) => n.matches(':focus-visible')).map((n) => n.getAttribute('data-node-id')));
    const [cat] = await categories(page);
    const p = await arcPoint(page, cat.id);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expectMode(page, 'hover', cat.id);
    await settle(page);
    const q = await arcPoint(page, cat.id);
    await page.mouse.click(q.x, q.y);
    await expectMode(page, 'detail', cat.id);
    await settle(page);
    expect(await focusRing()).toEqual([]);
    const before = await selected(page);
    const other = await page.evaluate(
      ({ id, before }) =>
        [...document.querySelectorAll(`[data-el="node"][data-cat-id="${id}"]`)].map((n) => n.getAttribute('data-node-id')!).find((n) => n !== before)!,
      { id: cat.id, before },
    );
    const o = await nodeCentre(page, other);
    await page.mouse.move(o.x, o.y, { steps: 3 });
    await settle(page);
    await expect.poll(() => selected(page)).toBe(other);
    expect(await focusRing()).toEqual([]);
    await page.mouse.click(o.x, o.y);
    await settle(page);
    expect(await focusRing()).toEqual([]);
  });

  test('a deep link focuses its node; a mouse selection afterwards leaves exactly one node focused', async ({ page }) => {
    await openApp(page);
    const [cat] = await categories(page);
    const nodes = await page.evaluate((id) => window.__site!.getState().nav.hard.find((c) => c.id === id)!.nodes.map((n) => n.id), cat.id);
    const [linked, other] = nodes.filter((n) => n !== cat.node).concat(cat.node ?? []);
    await page.goto(`${appPath()}#/skills/${cat.id}/${linked}`);
    await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
    await page.evaluate(() => window.__site!.ready);
    await settle(page);
    // The deep link put keyboard focus on the selected node.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-node-id') ?? null)).toBe(linked);
    const p = await nodeCentre(page, other);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await settle(page);
    await expect.poll(() => selected(page)).toBe(other);
    // Focus follows the selection: one node holds it, the old one lets go.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-node-id') ?? null)).not.toBe(linked);
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-node-id]')].filter((n) => n.matches(':focus')).length)).toBeLessThanOrEqual(1);
  });
});
