import { dispatch, openApp, settle } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * The spec card (the detail view's media slot for skills without their own image) across screen
 * sizes: its labels stay legible (12 CSS px at least) and a step below their values, fact groups
 * stay visibly apart, a short fact block sits centred, a wrapped project name reads as one item and
 * stays inside the card, and on a phone every card keeps its facts inside its border and clear of
 * its category tag.
 */

/** A generic legibility floor for small print, in CSS px. */
const MIN_TEXT_PX = 12;

type Where = { wheel: 'hard' | 'soft'; cat: string; node: string };

async function openNode(page: Page, w: Where): Promise<void> {
  await dispatch(page, { t: 'wheel/set', wheel: w.wheel }, { t: 'cat/open', cat: w.cat, node: w.node });
  await settle(page);
  // Finish the entrance fades so the card is checked at rest.
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  });
}

async function nodesOf(page: Page, wheel: 'hard' | 'soft'): Promise<Where[]> {
  return page.evaluate((w) => window.__site!.getState().nav[w].flatMap((c) => c.nodes.map((n) => ({ wheel: w, cat: c.id, node: n.id }))), wheel);
}

/** The first skill of each hard category that has a spec card with facts. */
async function sampleCards(page: Page): Promise<Where[]> {
  const out: Where[] = [];
  for (const w of await nodesOf(page, 'hard')) {
    if (out.some((o) => o.cat === w.cat)) continue;
    await openNode(page, w);
    if ((await page.locator('[data-media-slot] [data-spec-card] dl > div').count()) > 0) out.push(w);
  }
  return out;
}

/** Card metrics in CSS px; text rects, so line-height does not count. */
function cardMetrics(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-media-slot] [data-spec-card]')!;
    const k = card.getBoundingClientRect().width / (card as HTMLElement).offsetWidth;
    const text = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
      return {
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        right: Math.max(...rects.map((r) => r.right)),
      };
    };
    // Rendered font size: the computed size times the stage's scale (the stage is scaled with a transform).
    const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize) * k;
    const groups = [...card.querySelectorAll('dl > div')];
    const box = card.getBoundingClientRect();
    const glyph = card.querySelector('[data-visual]')!.getBoundingClientRect();
    const right = Math.max(...[...card.querySelectorAll('dt, dd')].map((el) => text(el).right));
    return {
      labels: groups.map((g) => size(g.querySelector('dt')!)),
      values: groups.map((g) => size(g.querySelector('dd')!)),
      captionGaps: groups.map((g) => text(g.querySelector('dd')!).top - text(g.querySelector('dt')!).bottom),
      groupGaps: groups.slice(1).map((g, i) => text(g.querySelector('dt')!).top - text(groups[i].querySelector('dd')!).bottom),
      // The empty space left of the glyph and right of the facts, as shares of the card's width.
      sides: [(glyph.left - box.left) / box.width, (box.right - right) / box.width],
    };
  });
}

for (const [w, h] of [
  [1366, 768],
  [1280, 720],
] as const) {
  test.describe(`spec card at ${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('labels stay legible and a step below their values; fact groups stay apart', async ({ page }) => {
      test.setTimeout(90_000);
      await openApp(page);
      const sample = await sampleCards(page);
      expect(sample.length, 'spec cards with facts').toBeGreaterThan(0);
      for (const node of sample) {
        await openNode(page, node);
        const m = await cardMetrics(page);
        for (const px of m.labels) expect(px, `${node.node}: label CSS px`).toBeGreaterThanOrEqual(MIN_TEXT_PX - 0.05);
        m.labels.forEach((label, i) => expect(label, `${node.node}: label smaller than its value`).toBeLessThan(m.values[i]));
        const caption = Math.max(...m.captionGaps);
        for (const g of m.captionGaps) expect(g, `${node.node}: caption above its value`).toBeGreaterThanOrEqual(0);
        // Groups read as groups: the space between two facts is larger than inside one.
        for (const g of m.groupGaps) expect(g, `${node.node}: gap between facts vs caption gap`).toBeGreaterThan(caption);
        // Two facts: the block sits centred (the same space on both sides, within a few % of the card).
        if (m.groupGaps.length === 1) expect(Math.abs(m.sides[0] - m.sides[1]), `${node.node}: side spaces`).toBeLessThanOrEqual(0.2);
      }
    });
  });
}

for (const [w, h] of [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [960, 540],
] as const) {
  test.describe(`spec card project names at ${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('a wrapped project name reads as one item and stays inside the card', async ({ page }) => {
      test.setTimeout(120_000);
      await openApp(page);
      const problems: string[] = [];
      let cards = 0;
      for (const node of await nodesOf(page, 'hard')) {
        await openNode(page, node);
        if ((await page.locator('[data-media-slot] [data-project-name]').count()) === 0) continue;
        cards++;
        const names = await page.evaluate(() => {
          const card = document.querySelector('[data-media-slot] [data-spec-card]')!;
          const cs = getComputedStyle(card);
          const box = card.getBoundingClientRect();
          const k = box.width / (card as HTMLElement).offsetWidth;
          // The card's content box: what its border and padding leave (the names must stay in it).
          const content = {
            left: box.left + (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * k,
            right: box.right - (parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight)) * k,
          };
          const els = [...document.querySelectorAll('[data-media-slot] [data-project-name]')];
          // An em on screen (the stage's scale applied, like the text boxes below).
          const em = (els.length ? parseFloat(getComputedStyle(els[0]).fontSize) : 16) * k;
          const charRects = (el: Element) => {
            const out: { top: number; left: number; right: number; ch: string }[] = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              for (let i = 0; i < n.textContent!.length; i++) {
                const range = document.createRange();
                range.setStart(n, i);
                range.setEnd(n, i + 1);
                const r = range.getClientRects()[0];
                if (r && r.width > 0) out.push({ top: Math.round(r.top), left: r.left, right: r.right, ch: n.textContent![i] });
              }
            }
            return out;
          };
          return els.map((el) => {
            const chars = charRects(el);
            const lines: { top: number; left: number; text: string }[] = [];
            for (const c of chars) {
              const line = lines.find((l) => Math.abs(l.top - c.top) <= 3);
              if (line) {
                line.text += c.ch;
                line.left = Math.min(line.left, c.left);
              } else lines.push({ top: c.top, left: c.left, text: c.ch });
            }
            lines.sort((a, b) => a.top - b.top);
            const r = el.getBoundingClientRect();
            const more = el.querySelector('[data-more]')?.getBoundingClientRect();
            const right = Math.max(...chars.map((c) => c.right));
            return {
              name: el.textContent!,
              // One marker per name, so a wrapped name does not read as two; its next lines start
              // where its text does, after the marker.
              marked: getComputedStyle(el, '::before').content !== 'none' && parseFloat(getComputedStyle(el, '::before').borderTopWidth) > 0,
              aligned: lines.slice(1).every((l) => Math.abs(l.left - lines[0].left) <= 0.15 * em),
              hyphenBreak: lines.slice(0, -1).some((l) => /-$/.test(l.text.trim())),
              // The name's box stays in the card's content box; text running past it is cut there
              // (with an ellipsis) rather than by the card's edge.
              inside:
                r.left >= content.left - 0.5 &&
                r.right <= content.right + 0.5 &&
                (right <= r.right + 0.5 || getComputedStyle(el).overflowX === 'hidden'),
              // A "+N" after the last name shown is never cut.
              moreShown: !more || (more.left >= r.left - 0.5 && more.right <= r.right + 0.5),
            };
          });
        });
        for (const n of names) {
          if (!n.marked || !n.aligned || n.hyphenBreak || !n.inside || !n.moreShown) problems.push(`${node.node}: ${JSON.stringify(n)}`);
        }
      }
      expect(cards, 'spec cards that list projects').toBeGreaterThan(0);
      expect(problems, `project names at ${w}×${h}`).toEqual([]);
    });
  });
}

test.describe('spec card on a phone', { tag: '@mobile' }, () => {
  test('every card keeps its facts clear of the tag and inside the card, each project name whole', async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page);
    await page.evaluate(() => document.fonts.ready);
    const problems: string[] = [];
    let cards = 0;
    for (const wheel of ['hard', 'soft'] as const) {
      for (const node of await nodesOf(page, wheel)) {
        await openNode(page, node);
        const m = await page.evaluate((id) => {
          const card = document.querySelector<HTMLElement>(`[data-media-slot="${id}"] [data-spec-card]`);
          const facts = card?.querySelectorAll('dt, dd') ?? [];
          // A node with its own image or video, or a card without facts.
          if (!card || facts.length === 0) return null;
          const box = card.getBoundingClientRect();
          const k = box.width / card.offsetWidth;
          const cs = getComputedStyle(card);
          const inner = { right: box.right - parseFloat(cs.borderRightWidth) * k, bottom: box.bottom - parseFloat(cs.borderBottomWidth) * k };
          // The category tag: the card's only span child.
          const tag = card.querySelector(':scope > span')?.getBoundingClientRect();
          const textRects = (el: Element) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return [...range.getClientRects()].filter((r) => r.width > 0.5);
          };
          const rects = [...facts].flatMap(textRects);
          return {
            underTag: Boolean(tag) && rects.some((r) => r.left < tag!.right && r.right > tag!.left && r.top < tag!.bottom && r.bottom > tag!.top),
            pastBottom: Math.max(...rects.map((r) => r.bottom)) - inner.bottom,
            pastRight: Math.max(...rects.map((r) => r.right)) - inner.right,
            // Text running past its name's box ends in an ellipsis there.
            cutNames: [...card.querySelectorAll('[data-project-name]')]
              .filter((name) => Math.max(...textRects(name).map((r) => r.right)) > name.getBoundingClientRect().right + 0.5)
              .map((name) => name.textContent!.trim()),
          };
        }, node.node);
        if (!m) continue;
        cards++;
        if (m.underTag) problems.push(`${wheel}:${node.node}: text under the tag`);
        if (m.pastBottom > 0.5) problems.push(`${wheel}:${node.node}: ${m.pastBottom.toFixed(1)} px past the card's bottom`);
        if (m.pastRight > 0.5) problems.push(`${wheel}:${node.node}: ${m.pastRight.toFixed(1)} px past the card's right edge`);
        for (const name of m.cutNames) problems.push(`${wheel}:${node.node}: "${name}" cut by an ellipsis`);
      }
      await dispatch(page, { t: 'back' });
    }
    expect(problems, 'spec cards on a phone').toEqual([]);
    expect(cards, 'cards with facts').toBeGreaterThan(0);
  });
});
