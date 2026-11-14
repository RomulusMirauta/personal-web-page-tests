import { appPath, appState, dispatch, openApp, screenOrder } from './support/app';
import { expect, newContext, test } from './support/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The name card at the top left: it shows the whole name at every size and browser zoom, never
 * covers the header's section switcher or the screen below it, no line ends in a separator, its
 * accessible name starts with the visible initials and stays the same folded or unfolded, it keeps
 * every line whole under WCAG 1.4.12 text spacing, and Esc folds it when the visitor opened it.
 */

/** Desktop and laptop windows; 720×405 … 640×360 are 1440×810 … 1280×720 windows at 200 % zoom. */
const LANDSCAPE = [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [1024, 768],
  [960, 540],
  [720, 405],
  [640, 360],
] as const;

const card = (page: Page) => page.locator('button:has([data-card-panel])');

async function openAt(browser: Browser, w: number, h: number): Promise<Page> {
  const ctx = await newContext(browser, { viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(appPath());
  await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
  await page.evaluate(() => window.__site!.ready);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

interface CardLine {
  text: string;
  /** Laid out (a compact layout drops lines with display: none). */
  shown: boolean;
  wide: number;
  ellipsis: boolean;
  /** Text of each visual row. */
  rows: string[];
}

/** The panel's lines, and the boxes it must stay clear of (viewport px). */
async function measure(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-card-panel]')!;
    const p = panel.getBoundingClientRect();
    const band = document.querySelector('header[data-hud] nav')!.getBoundingClientRect();
    const rowsOf = (el: Element): string[] => {
      const rows: string[] = [];
      let top: number | null = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (let i = 0; i < node.data.length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getClientRects()[0];
          if (!r) continue;
          if (top === null || Math.abs(r.top - top) > 2) {
            rows.push('');
            top = r.top;
          }
          rows[rows.length - 1] += node.data[i];
        }
      }
      return rows.map((row) => row.trimEnd());
    };
    const lines = [...panel.children].map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.textContent ?? '',
        shown: cs.display !== 'none',
        wide: el.scrollWidth - el.clientWidth,
        ellipsis: cs.textOverflow === 'ellipsis',
        rows: cs.display === 'none' ? [] : rowsOf(el),
      };
    });
    // The screen below the header: the active screen's region (the wheel's own screen has none).
    const screen = document.querySelector('section[aria-label][data-hud="true"]')?.getBoundingClientRect() ?? null;
    return {
      lines,
      panel: { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
      band: { left: band.left, top: band.top, bottom: band.bottom },
      screen: screen && { top: screen.top, left: screen.left, right: screen.right, bottom: screen.bottom },
    };
  });
}

test.describe('the name is never cut', () => {
  for (const [w, h] of LANDSCAPE) {
    test(`${w}×${h}`, async ({ browser }) => {
      const page = await openAt(browser, w, h);
      const m = await measure(page);
      const [name, role] = m.lines as CardLine[];
      expect(name.shown).toBe(true);
      expect(name.rows.join(' ')).toBe(name.text);
      // Every line that is laid out is whole: no overflow, no ellipsis (a compact layout drops a line instead).
      for (const line of m.lines as CardLine[]) {
        if (!line.shown) continue;
        expect({ text: line.text, wide: line.wide, ellipsis: line.ellipsis }).toEqual({ text: line.text, wide: 0, ellipsis: false });
      }
      if (role?.shown) expect(role.rows.join(' ')).toBe(role.text);
      await page.context().close();
    });
  }
});

test.describe('the unfolded card clears the section switcher and the screen below it', () => {
  for (const [w, h] of LANDSCAPE) {
    test(`${w}×${h}`, async ({ browser }) => {
      const page = await openAt(browser, w, h);
      await expect(card(page)).toHaveAttribute('data-expanded', '');
      const screens = (await screenOrder(page)).filter((s) => s !== 'skills');
      for (const screen of screens) {
        await dispatch(page, { t: 'tab/set', screen });
        const m = await measure(page);
        expect(m.screen, `${screen}: its region is on screen`).not.toBeNull();
        // Beside the section switcher, to its left.
        if (m.panel.bottom > m.band.top && m.panel.top < m.band.bottom) expect(m.panel.right, `${screen}: panel right vs switcher`).toBeLessThanOrEqual(m.band.left + 0.5);
        // Above the screen's content wherever the two share columns.
        if (m.screen && m.panel.right > m.screen.left && m.panel.left < m.screen.right) {
          expect(m.panel.bottom, `${screen}: panel bottom vs screen top`).toBeLessThanOrEqual(m.screen.top + 0.5);
        }
      }
      await page.context().close();
    });
  }
});

test('no row of the card ends with a separator', async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h] of LANDSCAPE) {
    const page = await openAt(browser, w, h);
    const rows = ((await measure(page)).lines as CardLine[]).flatMap((l) => l.rows);
    expect(rows.filter((r) => /[·•|,]$/.test(r)), `${w}×${h}: ${rows.join(' / ')}`).toEqual([]);
    await page.context().close();
  }
});

test('the card refits when the window is resized (no reload)', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openApp(page);
  const full = await card(page).getAttribute('data-fit');
  expect(full, 'the card reports how it fits').not.toBeNull();
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(card(page)).not.toHaveAttribute('data-fit', full!);
  const small = await measure(page);
  for (const line of small.lines) if (line.shown) expect(line.wide, `${line.text} whole after the resize`).toBe(0);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(card(page)).toHaveAttribute('data-fit', full!);
});

test.describe('WCAG 1.4.12 text spacing keeps all of the card’s text', { tag: '@a11y' }, () => {
  /** The 1.4.12 metrics, as a user style sheet or bookmarklet sets them. */
  const SPACING = '*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}';
  /** Each line of the unfolded panel: shown, and whole (no text past the panel). */
  const lines = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-card-panel] > *')].map((el) => ({
        text: el.textContent!.trim(),
        shown: getComputedStyle(el).display !== 'none',
        whole: el.scrollWidth <= el.clientWidth,
      })),
    );

  for (const [w, h] of [
    [1920, 1080],
    [1366, 768],
    [2560, 1440],
  ] as const) {
    test(`${w}×${h}: spacing set after load and at load`, async ({ browser }) => {
      const page = await openAt(browser, w, h);
      await expect(card(page)).toHaveAttribute('data-expanded', '');
      const plain = await lines(page);
      expect(plain.filter((l) => l.shown).length, JSON.stringify(plain)).toBeGreaterThanOrEqual(2);
      // Every line shown without the spacing is still shown, and whole, with it.
      await page.addStyleTag({ content: SPACING });
      await expect.poll(async () => (await lines(page)).map((l) => l.shown && l.whole)).toEqual(plain.map((l) => l.shown));
      await page.context().close();

      const early = await newContext(browser, { viewport: { width: w, height: h } });
      const loaded = await early.newPage();
      await loaded.addInitScript((css) => {
        document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: css })));
      }, SPACING);
      await loaded.goto(appPath());
      await loaded.waitForFunction(() => Boolean(window.__site && window.__wheel));
      await loaded.evaluate(() => document.fonts.ready);
      await expect.poll(async () => (await lines(loaded)).map((l) => l.shown && l.whole)).toEqual(plain.map((l) => l.shown));
      await early.close();
    });
  }

  test('R folds and unfolds the card under the spacing, every line shown and whole', async ({ browser }) => {
    const page = await openAt(browser, 1920, 1080);
    await expect(card(page)).toHaveAttribute('data-expanded', '');
    const plain = await lines(page);
    await page.addStyleTag({ content: SPACING });
    await page.keyboard.press('r');
    await expect(card(page)).not.toHaveAttribute('data-expanded');
    await page.keyboard.press('r');
    await expect(card(page)).toHaveAttribute('data-expanded', '');
    await expect.poll(async () => (await lines(page)).map((l) => l.shown && l.whole)).toEqual(plain.map((l) => l.shown));
    // The shortcut leaves focus where it was.
    await expect(card(page)).not.toBeFocused();
    await page.context().close();
  });
});

test.describe('accessible name and Esc', () => {
  test('the name starts with the visible initials, then the name and title, and stays the same folded and unfolded', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    const button = card(page);
    await expect(button).toHaveAttribute('data-expanded', '');
    // Read what the card shows: its initials and its lines (the title is content, not pinned here).
    const shown = await button.evaluate((el) => ({
      initials: (el.querySelector('[aria-hidden="true"]')?.textContent ?? '').trim(),
      lines: [...el.querySelectorAll('[data-card-panel] > *')].map((l) => (l.textContent ?? '').trim()).filter(Boolean),
    }));
    expect(shown.initials, 'the card shows initials').toMatch(/\S/);
    expect(shown.lines.length, 'the card shows a name and a title').toBeGreaterThanOrEqual(2);
    const unfolded = (await button.getAttribute('aria-label')) ?? '';
    // Label in name (WCAG 2.5.3): the visible initials start it, followed by the name and the title.
    expect(unfolded.startsWith(shown.initials), unfolded).toBe(true);
    for (const line of shown.lines.slice(0, 2)) expect(unfolded, `the name includes "${line}"`).toContain(line);
    // A click folds it: only the initials show, and the name stays the same.
    await button.click();
    await expect(button).not.toHaveAttribute('data-expanded');
    await expect(button).not.toHaveAttribute('title');
    expect(await button.getAttribute('aria-label')).toBe(unfolded);
    // Keyboard focus unfolds it again, with the same name.
    await button.evaluate((el) => (el as HTMLElement).blur());
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('data-expanded', '');
    expect(await button.getAttribute('aria-label')).toBe(unfolded);
    await expect(button).toHaveAccessibleName(unfolded);
  });

  test('Esc folds a hovered card wherever focus is, and means "back" again once it is folded', async ({ page }) => {
    await openApp(page);
    const button = card(page);
    // Fold it, then leave the card unfocused.
    await button.click();
    await button.evaluate((el) => (el as HTMLElement).blur());
    await dispatch(page, { t: 'cat/open', cat: await page.evaluate(() => window.__site!.getState().nav.hard[0].id) });
    expect((await appState(page)).mode.kind).toBe('detail');
    // Away (an empty spot at the left edge) and back: a fresh mouse hover.
    const vp = page.viewportSize()!;
    await page.mouse.move(5, vp.height / 2);
    await button.hover();
    await expect(button).toHaveAttribute('data-expanded', '');
    await page.keyboard.press('Escape');
    await expect(button).not.toHaveAttribute('data-expanded');
    expect((await appState(page)).mode.kind).toBe('detail');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).mode.kind).not.toBe('detail');
    await expect(button).not.toHaveAttribute('data-expanded');
  });

  test('Esc folds a keyboard-focused card and leaves the view alone', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    const button = card(page);
    await button.click();
    const vp = page.viewportSize()!;
    await page.mouse.move(5, vp.height / 2);
    await button.evaluate((el) => (el as HTMLElement).blur());
    await button.focus();
    await expect(button).toHaveAttribute('data-expanded', '');
    const before = await appState(page);
    await page.keyboard.press('Escape');
    await expect(button).not.toHaveAttribute('data-expanded');
    expect(await appState(page)).toEqual(before);
  });
});
