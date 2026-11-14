/**
 * The Controls screen: ? or F1 opens a modal list of every key, like a help screen; Esc, ? or F1
 * close it and focus returns. Plus two more keys: F (full screen) and D (download the CV, as
 * Profile's Download CV button does).
 */
import type { Page } from '@playwright/test';
import { arcPoint, categoryIds, dispatch, expectHashSettles, openApp, settle } from './support/app';
import { finishAnimations, seriousFindings } from './support/axe';
import { expect, test } from './support/test';
import type { Action } from './support/types';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Controls' });
const menuTrigger = (page: Page) => page.getByRole('button', { name: 'Display options' });
const state = (page: Page) => page.evaluate(() => window.__site!.getState());
/** Describes the focused element (tag, name), to check where focus went back to. */
const activeName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null);
/** Where the app is: what input behind the screen must not change while it is open. */
const where = (page: Page) =>
  page.evaluate(() => {
    const s = window.__site!.getState();
    return { screen: s.screen, wheel: s.wheel, mode: s.mode, controls: s.controls };
  });
/** Two frames: a leaked wheel step or swipe has reached the store by then (both dispatch at once). */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
/** Rendered font size (CSS px on screen) of the smallest of these elements: the frame draws the plate at the stage's scale. */
const smallestText = (page: Page, selector: string) =>
  dialog(page).evaluate((el, s) => {
    const scale = new DOMMatrixReadOnly(getComputedStyle(el.parentElement!).transform).a;
    const sizes = [...el.querySelectorAll<HTMLElement>(s)].map((e) => parseFloat(getComputedStyle(e).fontSize) * scale);
    return sizes.length ? Math.min(...sizes) : 0;
  }, selector);

/**
 * What would be cut off or run into its neighbour: a sideways overflow of the panel or the page, a
 * cap outside its row's key cell (either side: the caps are right-aligned), a label wider than its own.
 */
const clipping = (page: Page) =>
  dialog(page).evaluate((el) => ({
    sideways: el.scrollWidth - el.clientWidth,
    docSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    capsOutside: [...el.querySelectorAll('dt kbd')].filter((k) => {
      const cap = k.getBoundingClientRect();
      const cell = k.closest('dt')!.getBoundingClientRect();
      return cap.left < cell.left - 0.5 || cap.right > cell.right + 0.5;
    }).length,
    labelsOutside: [...el.querySelectorAll('dd')].filter((d) => d.scrollWidth > d.clientWidth + 1).length,
  }));
const NO_CLIPPING = { sideways: 0, docSideways: 0, capsOutside: 0, labelsOutside: 0 };

interface RowLines {
  id: string;
  label: string[];
  note: string[];
}

/** Each row's label and note as they break into lines: the text of each line, from its characters' boxes. */
const lineBreaks = (page: Page): Promise<RowLines[]> =>
  dialog(page).evaluate((el) => {
    const lines = (host: Element, skip?: Element | null) => {
      const out: string[] = [];
      let top = -Infinity;
      const range = document.createRange();
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (skip?.contains(node)) continue;
        for (let i = 0; i < node.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const box = [...range.getClientRects()].find((r) => r.width > 0);
          if (box && box.top > top + box.height / 2) {
            out.push('');
            top = box.top;
          }
          if (out.length) out[out.length - 1] += node.data[i];
        }
      }
      // No-break spaces read as spaces.
      return out.map((l) => l.replace(/\s+/g, ' ').trim());
    };
    return [...el.querySelectorAll<HTMLElement>('[data-row]')].map((row) => {
      const dd = row.querySelector('dd')!;
      const note = dd.querySelector('[class*="note"]');
      return { id: row.dataset.row!, label: lines(dd, note), note: note ? lines(note) : [] };
    });
  });

/**
 * What reads badly where labels and notes wrap: a choice split across lines (the words on either side
 * of a label's dot; a short choice, "off", goes with the word before the dot), a line starting with
 * the dot, an arrow cut off from its word, one word alone on the last line (an arrow is no word).
 */
function wrapProblems(rows: RowLines[]): string[] {
  const words = (line: string) => line.replace(/[←→↑↓·+]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  const out: string[] = [];
  for (const { id, label, note } of rows) {
    for (const [what, lines] of [
      ['label', label],
      ['note', note],
    ] as const) {
      const shown = `${id} ${what}: ${lines.join(' / ')}`;
      if (lines.length > 1 && words(lines[lines.length - 1]) < 2) out.push(`one word alone on the last line, ${shown}`);
      if (lines.slice(1).some((l) => l.startsWith('·'))) out.push(`a line starts with the dot, ${shown}`);
      if (lines.slice(0, -1).some((l) => /[←→↑↓]$/.test(l))) out.push(`an arrow cut off from its word, ${shown}`);
    }
    const text = label.join(' ');
    const at = text.indexOf(' · ');
    if (at < 0) continue;
    const [before, after] = [text.slice(0, at), text.slice(at + 3)];
    const choices = after.length > 3 ? [before, after] : [`${before.split(' ').pop()} · ${after}`];
    for (const c of choices) if (!label.some((l) => l.includes(c))) out.push(`"${c}" split, ${id} label: ${label.join(' / ')}`);
  }
  return out;
}

/**
 * A one-finger sideways swipe on what is at (x, y): touch events that bubble up to the shell's swipe
 * listener. False where the desktop engine makes no touch events (Firefox has no TouchEvent, WebKit
 * no Touch constructor): the listener is the same script there, which Chromium covers.
 */
async function swipe(page: Page, x: number, y: number, dx: number): Promise<boolean> {
  return page.evaluate(
    async ({ x, y, dx }) => {
      const target = document.elementFromPoint(x, y)!;
      const touch = (cx: number) => new Touch({ identifier: 1, target, clientX: cx, clientY: y });
      try {
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)], changedTouches: [touch(x)] }));
      } catch {
        return false;
      }
      await new Promise((r) => setTimeout(r, 120));
      target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x + dx)] }));
      return true;
    },
    { x, y, dx },
  );
}

/** Wait until the stage has faded out (visibility hidden: it takes no hit tests). */
async function hide(page: Page): Promise<void> {
  await page.keyboard.press('h');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-stage]')!).visibility)).toBe('hidden');
}

test.describe('Controls screen (? / F1)', () => {
  test('? opens it as a modal dialog over an inert stage; Esc closes it and focus returns', { tag: ['@a11y', '@critical'] }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    await menuTrigger(page).focus();
    await page.keyboard.press('Shift+Slash'); // "?" on a US layout
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(dialog(page)).toBeFocused();
    await expect(page.locator('[data-stage]')).toHaveAttribute('inert', '');
    // The stage stays in sight behind it (inert, not hidden as under the intro).
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-stage]')!).visibility)).toBe('visible');
    // Tab stays inside (its Close button), and the shortcuts behind it wait (Q would switch sections).
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('q');
    expect((await state(page)).screen).toBe('skills');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('[data-stage]')).not.toHaveAttribute('inert', '');
    expect(await activeName(page)).toBe('Display options');
    // The menu did not open from getting focus back.
    await expect(menuTrigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('F1 opens and closes it and never reaches the browser (no help page); other F-keys pass through', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      const seen: Record<string, boolean> = {};
      (window as unknown as { __prevented: Record<string, boolean> }).__prevented = seen;
      window.addEventListener('keydown', (e) => (seen[e.key] = e.defaultPrevented));
    });
    await page.keyboard.press('F1');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('F1');
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press('F2');
    const prevented = await page.evaluate(() => (window as unknown as { __prevented: Record<string, boolean> }).__prevented);
    expect(prevented).toEqual({ F1: true, F2: false });
    expect(page.context().pages()).toHaveLength(1);
  });

  test('is modal for the mouse wheel, the pointer and touch swipes: nothing behind it changes (hub, skill tree, Profile)', async ({ page, browserName }) => {
    await openApp(page);
    const [first] = await categoryIds(page);
    const views: [string, Action[]][] = [
      ['hub', []],
      ['tree', [{ t: 'cat/open', cat: first }]],
      ['profile', [{ t: 'tab/set', screen: 'profile' }]],
    ];
    for (const [view, setup] of views) {
      await openApp(page);
      await settle(page);
      if (setup.length) await dispatch(page, ...setup);
      // The hub's arcs, where the wheel's window-level pointer input would hover and open them.
      const arcs = view === 'hub' ? await Promise.all((await categoryIds(page)).slice(0, 3).map((id) => arcPoint(page, id))) : [];
      await page.mouse.move(5, 5);
      await page.keyboard.press('F1');
      await expect(dialog(page)).toBeVisible();
      const before = await where(page);
      expect(before.controls).toBe(true);
      const box = (await dialog(page).boundingBox())!;
      const still = async (what: string) => {
        await frames(page);
        expect(await where(page), `${view}: ${what}`).toEqual(before);
        await expect(dialog(page), `${view}: ${what}`).toBeVisible();
      };
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(250); // the wheel's notch stepper reads real time between notches: a pause makes each notch count
      }
      await still('vertical wheel');
      await page.mouse.wheel(400, 0); // a sideways trackpad swipe
      await still('horizontal wheel');
      if (await swipe(page, box.x + box.width / 2, box.y + box.height / 2, 300)) await still('touch swipe');
      else expect(browserName, 'only Chromium makes touch events on the desktop').not.toBe('chromium');
      for (const p of arcs) {
        expect(p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height, 'the arc lies under the plate').toBe(true);
        await page.mouse.move(p.x - 30, p.y - 30);
        await page.mouse.move(p.x, p.y, { steps: 6 });
        await still('pointer over an arc');
        await page.mouse.click(p.x, p.y); // on the plate: no backdrop click, so it stays open
        await still('click over an arc');
      }
    }
  });

  test('small windows (640×360, 600×900): fewer columns at the text floors, nothing cut off; where it scrolls, the wheel scrolls the panel itself, nothing behind it', async ({ page }) => {
    for (const { scrolls, ...viewport } of [
      { width: 640, height: 360, scrolls: true },
      // Portrait: two columns fit it whole.
      { width: 600, height: 900, scrolls: false },
    ]) {
      const tag = `${viewport.width}×${viewport.height}`;
      await page.setViewportSize(viewport);
      await openApp(page);
      await page.keyboard.press('F1');
      await expect(dialog(page)).toBeVisible();
      await finishAnimations(page);
      const before = await where(page);
      const overflow = await dialog(page).evaluate((el) => el.scrollHeight - el.clientHeight);
      if (scrolls) expect(overflow, tag).toBeGreaterThan(50);
      else expect(overflow, tag).toBeLessThanOrEqual(1);
      // Its text floors take fewer columns here, not a sideways overflow.
      expect(await clipping(page), tag).toEqual(NO_CLIPPING);
      expect(await smallestText(page, 'dt kbd'), tag).toBeGreaterThanOrEqual(12 - 0.05);
      // Labels and notes wrap here, but cleanly.
      expect(wrapProblems(await lineBreaks(page)), tag).toEqual([]);
      if (!scrolls) continue;
      const box = (await dialog(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await expect.poll(() => dialog(page).evaluate((el) => el.scrollTop), tag).toBeGreaterThan(0);
      expect(await where(page), tag).toEqual(before);
    }
  });

  test('lists every key group, with key caps, and fits the stage at 1920×1080, 1366×768, 1280×720 and 1024×768 (no clipping, no sideways scroll, text floors, clean line breaks)', async ({ page }) => {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      await openApp(page);
      await page.keyboard.press('F1');
      await expect(dialog(page)).toBeVisible();
      await finishAnimations(page);
      // Grouped under headings, each group with its rows.
      expect(await dialog(page).getByRole('heading', { level: 3 }).count(), `${viewport.width}×${viewport.height}`).toBeGreaterThan(1);
      const m = await dialog(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll('[data-row]')].map((row) => row.getBoundingClientRect());
        return {
          box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          overflowY: el.scrollHeight - el.clientHeight,
          rowsOutside: rows.filter((b) => b.left < r.left || b.right > r.right).length,
          rows: rows.length,
          caps: el.querySelectorAll('dt kbd').length,
        };
      });
      const tag = `${viewport.width}×${viewport.height}`;
      expect(m.box.left, tag).toBeGreaterThanOrEqual(0);
      expect(m.box.top, tag).toBeGreaterThanOrEqual(0);
      expect(m.box.right, tag).toBeLessThanOrEqual(viewport.width);
      expect(m.box.bottom, tag).toBeLessThanOrEqual(viewport.height);
      expect(await clipping(page), tag).toEqual(NO_CLIPPING);
      expect(m.rowsOutside, tag).toBe(0);
      // Everything fits without scrolling at these sizes (it would scroll inside, not clip, if not).
      expect(m.overflowY, tag).toBeLessThanOrEqual(1);
      expect(m.rows, tag).toBeGreaterThan(0);
      expect(m.caps, tag).toBeGreaterThanOrEqual(m.rows);
      // A 12 px floor for every text, the key caps included, also on smaller windows.
      expect(await smallestText(page, 'dt kbd'), tag).toBeGreaterThanOrEqual(12 - 0.05);
      expect(await smallestText(page, 'h3, dd, dd span'), tag).toBeGreaterThanOrEqual(12 - 0.05);
      // Every label on one line from 1280×720 up (each row's caps take only their own width); where
      // labels or notes wrap, no choice splits, no arrow leaves its word, no word ends one alone.
      const breaks = await lineBreaks(page);
      if (viewport.width >= 1280) expect(breaks.filter((r) => r.label.length > 1).map((r) => `${r.id}: ${r.label.join(' / ')}`), tag).toEqual([]);
      expect(wrapProblems(breaks), tag).toEqual([]);
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`axe: no serious or critical findings with the screen open (${theme})`, { tag: '@a11y' }, async ({ page }) => {
      await openApp(page, { theme });
      await page.keyboard.press('F1');
      await expect(dialog(page)).toBeVisible();
      await finishAnimations(page);
      const found = await seriousFindings(page);
      expect(found, found.join('\n')).toEqual([]);
    });
  }

  test('keys off: the screen says so and names K, F1 still opens it, ? does not', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('k');
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
    await page.keyboard.press('Shift+Slash');
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press('F1');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(/single-key shortcuts are off/i);
    // K works from inside it too: the notice goes, the letters light up.
    await page.keyboard.press('k');
    await expect(dialog(page).locator('[data-keys-off]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('hidden interface: ? and F1 show it over the city alone; closing it (key or click) leaves the interface hidden', async ({ page }) => {
    await openApp(page);
    await hide(page);
    await page.keyboard.press('Shift+Slash');
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
    await expect(page.locator('[data-ui-hint]')).toHaveCount(0); // its "press Esc" hint would mislead now
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect((await state(page)).uiHidden).toBe(true);
    await page.keyboard.press('F1');
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(40, 40); // a click anywhere: back to the city alone
    await expect(dialog(page)).toHaveCount(0);
    expect((await state(page)).uiHidden).toBe(true);
    // F works while hidden too, and keeps it hidden.
    await page.evaluate(() => {
      (window as unknown as { __fs: number }).__fs = 0;
      document.documentElement.requestFullscreen = () => {
        (window as unknown as { __fs: number }).__fs++;
        return Promise.resolve();
      };
    });
    await page.keyboard.press('f');
    expect(await page.evaluate(() => (window as unknown as { __fs: number }).__fs)).toBe(1);
    expect((await state(page)).uiHidden).toBe(true);
  });

  test('the Display options menu has a Controls row (last): it opens the screen, and focus comes back to the trigger', async ({ page }) => {
    await openApp(page);
    await menuTrigger(page).click();
    const rows = page.getByRole('list', { name: 'Display options' }).getByRole('listitem');
    await expect(rows.last()).toContainText('Controls');
    await page.getByRole('button', { name: 'Controls' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(menuTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(menuTrigger(page)).toBeFocused();
  });
});

test.describe('F full screen, D download CV', () => {
  test('F asks for full screen, and F again leaves it', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      const w = window as unknown as { __calls: string[] };
      w.__calls = [];
      let full: Element | null = null;
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
      document.documentElement.requestFullscreen = () => {
        w.__calls.push('request');
        full = document.documentElement;
        return Promise.resolve();
      };
      document.exitFullscreen = () => {
        w.__calls.push('exit');
        full = null;
        return Promise.resolve();
      };
    });
    await page.keyboard.press('f');
    await page.keyboard.press('f');
    expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual(['request', 'exit']);
    // Keys off: F is just a key.
    await page.keyboard.press('k');
    await page.keyboard.press('f');
    expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toHaveLength(2);
  });

  test('D downloads the CV from any screen, the same file as Profile’s Download CV button', async ({ page }) => {
    await openApp(page);
    expect((await state(page)).screen).toBe('skills');
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('d')]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    await dispatch(page, { t: 'tab/set', screen: 'profile' });
    const button = page.getByRole('link', { name: /download cv/i });
    const href = await button.getAttribute('href');
    expect(new URL(download.url()).pathname).toBe(new URL(href!, page.url()).pathname);
    // The button names its key while the single-key shortcuts are on, and not once K turned them off.
    await expect(button).toHaveAttribute('aria-keyshortcuts', 'D');
    await page.keyboard.press('k');
    await expect(page.locator('html')).toHaveAttribute('data-shortcuts', 'off');
    await expect(button).not.toHaveAttribute('aria-keyshortcuts');
    await page.keyboard.press('k');
    await expect(button).toHaveAttribute('aria-keyshortcuts', 'D');
  });

  test('D on the hub opens nothing: a category hovered with the keys stays hovered', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const before = await where(page);
    const hash = await page.evaluate(() => location.hash);
    expect(before.mode.kind).toBe('hover');
    // The download clicks a link of its own, which a click on empty stage space (it opens the hovered
    // category) must not be taken for.
    await Promise.all([page.waitForEvent('download'), page.keyboard.press('d')]);
    await frames(page);
    expect(await where(page)).toEqual(before);
    await expectHashSettles(page, hash);
  });
});
