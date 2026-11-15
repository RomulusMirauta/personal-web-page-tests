import type { Page } from '@playwright/test';
import { dispatch, openApp, screenOrder, sectionTitleText, settle, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * Line breaks in the screens' copy: no line ends on a " · " separator, a range of figures or codes
 * ("2012–2013", "G1–G9") never splits across lines, and short copy (tile sublines, tool
 * descriptions, stat labels) never ends on a lone word.
 */

interface Break {
  where: string;
  kind: 'separator' | 'range' | 'lone word';
  line: string;
}

/** The visible lines of each text element of the region named `name`, from its characters' boxes. */
async function scan(page: Page, name: string): Promise<Break[]> {
  return page.evaluate((name) => {
    const out: Break[] = [];
    const root = [...document.querySelectorAll('section[aria-label]')].find((s) => s.getAttribute('aria-label')!.toLowerCase() === name.toLowerCase())!;
    const short = new Set(root.querySelectorAll('[class*="tileDetail"], [class*="statLabel"], [class*="toolList"] dd'));
    const linesOf = (el: Element) => {
      const lines: { top: number; text: string }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('.visually-hidden, [aria-hidden="true"]')) continue;
        for (let i = 0; i < n.textContent!.length; i++) {
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getClientRects()[0];
          if (!r) continue;
          const top = Math.round(r.top);
          const last = lines.at(-1);
          if (last && Math.abs(last.top - top) <= 3) last.text += n.textContent![i];
          else lines.push({ top, text: n.textContent![i] });
        }
      }
      // Word joiners glue a separator to its neighbour; they are not text.
      return lines.map((l) => l.text.replace(/[⁠]/g, ''));
    };
    for (const el of root.querySelectorAll('p, dd, span, li')) {
      if (el.querySelector('p, dd, li')) continue;
      const lines = linesOf(el);
      const where = `${name}: ${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
      for (let k = 0; k + 1 < lines.length; k++) {
        const a = lines[k].trimEnd();
        const b = lines[k + 1].trimStart();
        if (/[·•]$/.test(a)) out.push({ where, kind: 'separator', line: a.slice(-30) });
        if (/\d[–-]$/.test(a) && /^[A-Z]?\d/.test(b)) out.push({ where, kind: 'range', line: `${a.slice(-20)} / ${b.slice(0, 10)}` });
      }
      const last = lines.at(-1)?.trim() ?? '';
      if (short.has(el) && lines.length > 1 && last && !/\s/.test(last)) out.push({ where, kind: 'lone word', line: last });
    }
    return out;
  }, name);
}

for (const [w, h] of [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [2560, 1440],
] as const) {
  test.describe(`line breaks at ${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('no separator ends a line, ranges stay whole, no lone last word', async ({ page }) => {
      await openApp(page);
      const found: Break[] = [];
      for (const screen of (await screenOrder(page)).filter((s) => s !== 'skills')) {
        await dispatch(page, { t: 'tab/set', screen });
        await settle(page);
        await page.evaluate(() => {
          for (const a of document.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) a.finish();
        });
        found.push(...(await scan(page, await sectionTitleText(page))));
      }
      expect(found).toEqual([]);
    });
  });
}
