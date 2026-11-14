import type { Page } from '@playwright/test';
import { dispatch, openApp, screenOrder, settle } from './support/app';
import { expect, test } from './support/test';

/**
 * The names Chromium itself gives the controls and headings in <main> (its accessibility tree over
 * CDP). Unlike Playwright's own computation it applies CSS text-transform, so text shown in
 * capitals reads in capitals unless the element carries its name in sentence case.
 */

interface AxRow {
  role: string;
  name: string;
  description: string;
}

/** Every named node under the <main> landmark, as Chromium exposes it. */
async function mainNames(page: Page): Promise<AxRow[]> {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: { nodeId: string; ignored: boolean; role?: { value: string }; name?: { value: string }; description?: { value: string }; childIds?: string[] }[];
  };
  await cdp.detach();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const main = nodes.find((n) => !n.ignored && n.role?.value === 'main');
  expect(main, 'a <main> landmark').toBeDefined();
  const rows: AxRow[] = [];
  const queue = [...(main!.childIds ?? [])];
  while (queue.length) {
    const n = byId.get(queue.shift()!);
    if (!n) continue;
    queue.push(...(n.childIds ?? []));
    if (n.ignored || !n.name?.value || n.role?.value === 'StaticText' || n.role?.value === 'InlineTextBox') continue;
    rows.push({ role: n.role?.value ?? '', name: n.name.value, description: n.description?.value ?? '' });
  }
  return rows;
}

/** Words in capitals that the DOM spells otherwise: capitals added by CSS (acronyms are written in capitals). */
async function shouted(page: Page, rows: AxRow[]): Promise<string[]> {
  const text = await page.evaluate(() => document.querySelector('main')!.textContent ?? '');
  return rows.flatMap((r) => (r.name.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? []).filter((w) => !text.includes(w)).map((w) => `${r.role} "${r.name}": ${w}`));
}

test.describe('names Chromium reads on the screens', { tag: '@a11y' }, () => {
  test('every screen: names in <main> are in sentence case', async ({ page }) => {
    await openApp(page);
    const screens = (await screenOrder(page)).filter((s) => s !== 'skills');
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) {
      await dispatch(page, { t: 'tab/set', screen });
      await settle(page);
      const rows = await mainNames(page);
      expect(rows.length, `${screen}: named nodes`).toBeGreaterThan(3);
      expect(await shouted(page, rows), screen).toEqual([]);
    }
  });

  test('project links name their action and target, and say they open a new tab', async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    test.skip(!screens.includes('projects'), 'no Projects screen');
    await dispatch(page, { t: 'tab/set', screen: 'projects' });
    await settle(page);
    const links = (await mainNames(page)).filter((r) => r.role === 'link' && /^(Live|Repo): /.test(r.name));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.name).toMatch(/^(Live|Repo): \S.* \(opens in a new tab\)$/);
  });

  test('a cut Experience summary: its "More" button is named "More" and described by its entry', async ({ page }) => {
    // A small landscape window, where summaries are cut and get a "More" button.
    await page.setViewportSize({ width: 853, height: 430 });
    await openApp(page);
    const screens = await screenOrder(page);
    test.skip(!screens.includes('experience'), 'no Experience screen');
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await settle(page);
    const titles = await page.locator('li[data-kind] h4').allTextContents();
    const more = (await mainNames(page)).filter((r) => r.role === 'button' && /^more$/i.test(r.name));
    expect(more.length).toBeGreaterThan(0);
    for (const m of more) {
      expect(m.name).toBe('More');
      expect(titles).toContain(m.description);
    }
  });
});
