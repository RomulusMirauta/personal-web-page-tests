import { dispatch, openApp, settle, ui } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * The detail panel's chip rows: the project and employer chips, and the "Also used" group of tools
 * that belong to a skill without a node of their own. The group is plain text chips (no links) on
 * a row of its own, inside the text column and clear of the media slot. When the column has no room
 * for every chip, a "+N" fold says what it hides; Enter on it shows the rest and puts focus on the
 * first chip it revealed, with its focus ring whole.
 */

type Opened = { cat: string; node: string };

/** Every node of the hard wheel, in ring order. */
async function hardNodes(page: Page): Promise<Opened[]> {
  return page.evaluate(() => window.__site!.getState().nav.hard.flatMap((c) => c.nodes.map((n) => ({ cat: c.id, node: n.id }))));
}

/** Open each node in turn and count its "Also used" items (folded ones included): the node with the most. */
async function busiestNode(page: Page): Promise<(Opened & { items: number }) | null> {
  let best: (Opened & { items: number }) | null = null;
  for (const n of await hardNodes(page)) {
    await dispatch(page, { t: 'cat/open', cat: n.cat, node: n.node });
    const more = page.locator('[data-detail-panel] [data-chip-more] button');
    if ((await more.count()) > 0) await more.click();
    const items = await page.locator('[data-detail-panel] [data-also-used] li').count();
    if (items > (best?.items ?? 0)) best = { ...n, items };
  }
  return best;
}

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * CSS px of the focused element's focus ring (outline and offset) that its scroll area clips, the
 * most on any side (0: the whole ring shows). The area clips at its padding box, scrollbar excluded.
 */
function ringClipped(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const area = el?.closest<HTMLElement>('[data-scroll]');
    if (!el || !area) return Infinity;
    const box = area.getBoundingClientRect();
    const k = box.height / area.offsetHeight;
    const cs = getComputedStyle(el);
    const ring = ((parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0)) * k;
    const r = el.getBoundingClientRect();
    return Math.max(
      0,
      box.top - (r.top - ring),
      r.bottom + ring - (box.top + area.clientHeight * k),
      box.left - (r.left - ring),
      r.right + ring - (box.left + area.clientWidth * k),
    );
  });
}

for (const device of [
  { name: 'desktop', tag: [] as string[] },
  { name: 'phone', tag: ['@mobile'] },
]) {
  test.describe(`"Also used" row (${device.name})`, { tag: device.tag }, () => {
    test('lists its items as plain chips inside the text column, clear of the media', async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page);
      const target = await busiestNode(page);
      expect(target, 'some skill lists "Also used" tools').not.toBeNull();
      await dispatch(page, { t: 'cat/open', cat: target!.cat, node: target!.node });
      const panel = ui.panel(page);
      // Chips that do not fit the default view fold into "+N": show them.
      const more = panel.locator('[data-chip-more] button');
      if ((await more.count()) > 0) await more.click();
      const list = panel.getByRole('list', { name: 'Also used' });
      await list.scrollIntoViewIfNeeded();
      await expect(list).toBeVisible();
      await expect(list.getByRole('listitem')).toHaveCount(target!.items);
      for (const item of await list.getByRole('listitem').all()) await expect(item).toHaveText(/\S/);
      await expect(list.getByRole('link'), 'the tools have no page of their own: no links').toHaveCount(0);

      const box = await page.evaluate(() => {
        const row = document.querySelector('[data-detail-panel] [data-also-used]')!;
        const media = document.querySelector('[data-media-slot]')!;
        const chips = Array.from(row.querySelectorAll('li')).map((li) => li.getBoundingClientRect().toJSON());
        return { row: row.getBoundingClientRect().toJSON(), media: media.getBoundingClientRect().toJSON(), chips, vw: innerWidth };
      });
      // No chip spills out of the row; the row stays on screen and clear of the media.
      for (const c of box.chips) {
        expect(c.left).toBeGreaterThanOrEqual(box.row.left - 0.5);
        expect(c.right).toBeLessThanOrEqual(box.row.right + 0.5);
      }
      expect(box.row.right).toBeLessThanOrEqual(box.vw);
      expect(box.row.left).toBeGreaterThanOrEqual(0);
      expect(overlaps(box.row as DOMRect, box.media as DOMRect)).toBe(false);
    });

    test('"Also used" sits on a row of its own, one chip height per row, its caption on the first row', async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page);
      const problems: string[] = [];
      let checked = 0;
      for (const { cat, node } of await hardNodes(page)) {
        await dispatch(page, { t: 'cat/open', cat, node });
        const more = page.locator('[data-detail-panel] [data-chip-more] button');
        if ((await more.count()) > 0) await more.click();
        const r = await page.evaluate(() => {
          const also = document.querySelector('[data-detail-panel] [data-also-used]');
          if (!also) return null;
          const flow = also.parentElement!;
          const main = [...flow.querySelectorAll(':scope > ul > li')].map((li) => li.getBoundingClientRect());
          const chips = [...flow.querySelectorAll('li > *')].map((c) => c.getBoundingClientRect());
          // Rows: chips whose middles fall inside the row's first chip.
          const rows: DOMRect[][] = [];
          for (const c of [...chips].sort((a, b) => a.top - b.top)) {
            const row = rows.at(-1);
            if (row && c.top + c.height / 2 < row[0].bottom) row.push(c);
            else rows.push([c]);
          }
          const label = also.querySelector(':scope > span')!.getBoundingClientRect();
          const first = also.querySelector('li')!.getBoundingClientRect();
          return {
            ownLine: main.length === 0 || also.getBoundingClientRect().top >= Math.max(...main.map((m) => m.bottom)) - 0.5,
            mixedRows: rows.filter((row) => Math.max(...row.map((c) => c.height)) - Math.min(...row.map((c) => c.height)) > 0.5).length,
            labelOnFirstRow: label.top >= first.top - 0.5 && label.bottom <= first.bottom + 0.5,
          };
        });
        if (!r) continue;
        checked++;
        if (!r.ownLine || r.mixedRows > 0 || !r.labelOnFirstRow) problems.push(`${node}: ${JSON.stringify(r)}`);
      }
      expect(checked, 'skills with an "Also used" group').toBeGreaterThan(0);
      expect(problems).toEqual([]);
    });
  });
}

/**
 * Across the hard wheel, every fold is expanded with Enter. Its text and accessible name say what
 * it hides ("+N" for project or employer chips, "Also used +N" for tools, both joined by "·" when it
 * hides both); its accessible name starts with that text (label in name) and says what a press shows:
 * "+N, show N more", "Also used +N, show N more tools", "+N · Also used +M, show N more and M tools".
 * Focus lands on the first chip it shows (a project or employer chip first, else a tool), and that chip's focus ring
 * shows whole.
 */
for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(`a fold says what it hides; Enter reveals it and focuses the first revealed chip (${viewport.width}×${viewport.height})`, { tag: '@a11y' }, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await openApp(page);
    const snapshot = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[data-detail-panel]')!;
        const count = (list: string) => panel.querySelectorAll(`[data-chip-list="${list}"] > li:not([data-chip-more])`).length;
        const more = panel.querySelector<HTMLElement>('[data-chip-more] button');
        // The chip item that has focus (or holds it), as [list, index].
        const li = document.activeElement?.closest('[data-detail-panel] [data-chip-list] > li');
        return {
          chips: count('chips'),
          also: count('also'),
          fold: more && {
            text: more.textContent!.trim(),
            name: more.getAttribute('aria-label'),
            inGroup: Boolean(more.closest('[data-also-used]')),
          },
          focus: li ? [li.parentElement!.getAttribute('data-chip-list'), [...li.parentElement!.children].indexOf(li)] : null,
        };
      });
    const folds: string[] = [];
    for (const { cat, node } of await hardNodes(page)) {
      await dispatch(page, { t: 'cat/open', cat, node });
      const before = await snapshot();
      if (!before.fold) continue;
      await page.locator('[data-detail-panel] [data-chip-more] button').focus();
      await page.keyboard.press('Enter');
      await settle(page);
      const after = await snapshot();
      const chips = after.chips - before.chips;
      const tools = after.also - before.also;
      const word = tools === 1 ? 'tool' : 'tools';
      const { inGroup } = before.fold;
      const expected =
        tools === 0
          ? { text: `+${chips}`, name: `+${chips}, show ${chips} more`, inGroup: false }
          : chips === 0
            ? { text: inGroup ? `+${tools}` : `Also used +${tools}`, name: `${inGroup ? `+${tools}` : `Also used +${tools}`}, show ${tools} more ${word}`, inGroup }
            : { text: `+${chips} · Also used +${tools}`, name: `+${chips} · Also used +${tools}, show ${chips} more and ${tools} ${word}`, inGroup: false };
      expect({ ...before.fold, revealed: chips + tools > 0, focus: after.focus, folded: after.fold }, node).toEqual({
        ...expected,
        revealed: true,
        focus: chips > 0 ? ['chips', before.chips] : ['also', before.also],
        folded: null,
      });
      expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible')), `${node}: the focused chip shows its ring`).toBe(true);
      expect(await ringClipped(page), `${node}: CSS px of the focus ring clipped by the column`).toBeLessThanOrEqual(0.01);
      folds.push(node);
    }
    // The fold is exercised: some skill has more chips than its column shows.
    expect(folds.length, 'skills with a fold').toBeGreaterThan(0);
  });
}
