import type { Locator, Page } from '@playwright/test';
import { afterIdle, categoryIds, dispatch, openApp, sel } from './support/app';
import { expect, test } from './support/test';

/** Computed cursor of an element: "text", "custom-pointer", "custom-arrow" or the raw value. */
async function cursorOf(locator: Locator): Promise<string> {
  const cursor = await locator.evaluate((el) => getComputedStyle(el).cursor);
  // The app's own cursor images carry a content hash: cursor-pointer.<hash>.svg, cursor.<hash>.svg.
  if (/\/cursor-pointer\.[^/"]*svg/.test(cursor)) return 'custom-pointer';
  if (/\/cursor\.[^/"]*svg/.test(cursor)) return 'custom-arrow';
  return cursor;
}

async function show(page: Page, screen: 'profile' | 'experience'): Promise<void> {
  await dispatch(page, { t: 'tab/set', screen });
  await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
}

test.describe('wheel accessibility and render hygiene', () => {
  test('detail nodes describe their place in the tree, their names unchanged', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    const [cat] = await categoryIds(page, 'hard');
    await dispatch(page, { t: 'cat/open', cat });
    const nav = await page.evaluate((id) => window.__site!.getState().nav.hard.find((c) => c.id === id)!.nodes, cat);
    const label = (id: string) => page.locator(`${sel.node}[data-node-id="${id}"]`).getAttribute('aria-label');
    for (const node of nav) {
      const button = page.getByRole('button', { name: (await label(node.id))!, exact: true });
      const count = node.children.length;
      const tail = count > 0 ? `, ${count} sub-skill${count === 1 ? '' : 's'}` : '';
      if (node.parent === null) {
        await expect(button).toHaveAccessibleDescription(`Root of the tree${tail}`);
        continue;
      }
      // "Sub-skill of <parent title>": the parent's name starts with its title (titles may hold commas).
      const description = await button.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby')!)!.textContent!);
      const match = /^Sub-skill of (.+?)(, \d+ sub-skills?)?$/.exec(description);
      expect(match?.[2] ?? '', `${node.id}: ${description}`).toBe(tail);
      expect((await label(node.parent))!.startsWith(`${match![1]}, `), `${node.id}: ${description}`).toBe(true);
      await expect(button).toHaveAccessibleDescription(description);
    }
  });

  test('one media-query subscription per query: 20 hovers and a theme switch re-add none', async ({ page }) => {
    // Counts MediaQueryList listeners: a component that re-subscribes on every render leaks them.
    await page.addInitScript(() => {
      const counts = { add: 0, remove: 0 };
      (window as unknown as { __mql: typeof counts }).__mql = counts;
      const { addEventListener: add, removeEventListener: remove } = MediaQueryList.prototype;
      MediaQueryList.prototype.addEventListener = function (...args: Parameters<typeof add>) {
        counts.add++;
        return add.apply(this, args);
      };
      MediaQueryList.prototype.removeEventListener = function (...args: Parameters<typeof remove>) {
        counts.remove++;
        return remove.apply(this, args);
      };
    });
    await openApp(page, { cursor: null });
    // The custom cursor (two queries) mounts once the browser is idle; one more idle period after
    // it, so nothing still mounting subscribes after the count below.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mql: { add: number } }).__mql.add)).toBeGreaterThanOrEqual(3);
    await afterIdle(page);
    const read = () => page.evaluate(() => ({ ...(window as unknown as { __mql: { add: number; remove: number } }).__mql }));
    const before = await read();
    const cats = await categoryIds(page, 'hard');
    for (let i = 0; i < 20; i++) await dispatch(page, { t: 'cat/hover', cat: cats[i % cats.length] });
    await page.keyboard.press('t');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await afterIdle(page); // the switch's re-render and effects (where a listener would be re-added) have run
    expect(await read()).toEqual(before);
  });

  test('a fine pointer gets the I-beam over prose and the pointer over controls', async ({ page }) => {
    await openApp(page, { cursor: null });
    test.skip((await page.evaluate(() => document.documentElement.dataset.pointer)) !== 'fine', 'needs a fine pointer');
    const [cat] = await categoryIds(page, 'hard');
    await dispatch(page, { t: 'cat/open', cat });
    const panel = page.locator(sel.panel);
    expect(await cursorOf(panel.locator('h3'))).toBe('text');
    expect(await cursorOf(panel.locator('h3 ~ p').last())).toBe('text'); // the description
    expect(await cursorOf(page.locator(`${sel.node}[role="button"]`).first())).toBe('custom-pointer');

    await show(page, 'profile');
    const about = page.getByRole('region', { name: 'About' });
    expect(await cursorOf(about.locator('p').first())).toBe('text');
    expect(await cursorOf(page.getByRole('region', { name: 'Contact' }).getByRole('link').first())).toBe('custom-pointer');
    // A section's title band is a label, not prose.
    expect(await cursorOf(about.getByRole('heading'))).toBe('custom-arrow');

    await show(page, 'experience');
    const entry = page.locator('li[data-kind]').first();
    expect(await cursorOf(entry.locator('h4'))).toBe('text');
    expect(await cursorOf(entry.locator('h4 + p'))).toBe('text');
    // The summary is plain text that can be selected and copied: prose, so the I-beam.
    expect(await cursorOf(entry.locator('p[id]'))).toBe('text');
    // A card's padding is not text: the I-beam stays on its paragraphs.
    expect(await cursorOf(entry)).toBe('custom-arrow');
  });

  test('a cut summary\'s More button keeps the pointer, also over its label', async ({ page }) => {
    // A small landscape window: one column and a large text floor, so a long summary is cut.
    await page.setViewportSize({ width: 853, height: 430 });
    await openApp(page, { cursor: null });
    test.skip((await page.evaluate(() => document.documentElement.dataset.pointer)) !== 'fine', 'needs a fine pointer');
    await show(page, 'experience');
    const more = page.locator('li[data-kind]').getByRole('button', { name: 'More', exact: true }).first();
    test.skip((await more.count()) === 0, 'no summary is long enough to be cut at this size');
    expect(await cursorOf(more)).toBe('custom-pointer');
    expect(await cursorOf(more.locator('span').first())).toBe('custom-pointer');
  });
});
