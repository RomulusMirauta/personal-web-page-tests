import { openApp, settle } from './support/app';
import { expect, test } from './support/test';
import type { Page } from '@playwright/test';

/**
 * Design rules of the skill wheel that only the rendered app shows, read from computed styles:
 * - every skill is drawn in one of exactly three level looks, the strongest in the full category
 *   colour and each lower level a weaker mix of it with the page background; only the lowest level
 *   carries a dashed ring;
 * - a link (and the stub into a tree's root) takes the look of the node it leads to; in the light
 *   theme the lines and the lowest level's ring take the category colour mixed toward the text ink
 *   instead, so they keep at least 3:1 against the light background (WCAG 1.4.11);
 * - the level legend shows the same three looks, in order, one swatch per row;
 * - a node draws its hit area, its face and its icon, nothing else; icons are centred on the node
 *   and take the same share of every node.
 * Both themes are checked: the mixes go toward each theme's own background.
 */

type Rgb = [number, number, number];

interface Drawn {
  bg: Rgb;
  /** The text ink, and the share of the category colour in a light-theme line (--mix-cat-line). */
  ink: Rgb;
  lineMix: number;
  nodes: {
    id: string;
    i: string;
    visual: string;
    cat: Rgb;
    fill: Rgb;
    stroke: Rgb | null;
    dash: string;
    strokeWidth: number;
    children: string[];
    face: { r: number; rim: number; cx: number; cy: number };
    icon: { x: number; y: number; w: number; h: number };
  }[];
  links: { i: string; stroke: Rgb }[];
  stubs: { cat: Rgb; stroke: Rgb }[];
  legend: { cat: Rgb; rows: { text: string; children: number; swatchChildren: number; fill: Rgb; border: string; borderColor: Rgb }[] };
}

/** Computed colours and the node structure of the hard wheel (call settle() first). */
async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    // Computed colour → 0–255 channels: rgb() and color(srgb …) exactly, anything else through a canvas.
    const rgb = (c: string): [number, number, number] | null => {
      if (!c || c === 'none' || c === 'transparent') return null;
      const n = (c.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number);
      if (/^rgba?\(/.test(c)) return [n[0], n[1], n[2]];
      if (/^color\(srgb /.test(c)) return [n[0] * 255, n[1] * 255, n[2] * 255];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    // A custom property's value as a colour (the probe resolves var() chains and hex).
    const probe = document.createElement('span');
    document.body.append(probe);
    const resolve = (value: string) => {
      probe.style.color = value.trim();
      return rgb(getComputedStyle(probe).color)!;
    };
    const svg = document.querySelector('svg[data-active="true"]')!;
    const num = (el: Element | null, attr: string) => Number(el?.getAttribute(attr) ?? 0);
    const nodes = [...svg.querySelectorAll('[data-el="node"]')].map((n) => {
      const face = n.querySelector('[data-el="hit"] + circle')!;
      const icon = n.querySelector('use')!;
      const cs = getComputedStyle(face);
      return {
        id: n.getAttribute('data-node-id')!,
        i: n.getAttribute('data-i')!,
        visual: n.getAttribute('data-visual')!,
        cat: resolve(getComputedStyle(n).getPropertyValue('--cat')),
        fill: rgb(cs.fill)!,
        stroke: rgb(cs.stroke),
        dash: cs.strokeDasharray,
        strokeWidth: parseFloat(cs.strokeWidth) || 0,
        children: [...n.children].map((c) => `${c.tagName.toLowerCase()}${c.getAttribute('data-el') ? `.${c.getAttribute('data-el')}` : ''}`),
        face: { r: num(face, 'r'), rim: num(face, 'stroke-width'), cx: num(face, 'cx'), cy: num(face, 'cy') },
        icon: { x: num(icon, 'x'), y: num(icon, 'y'), w: num(icon, 'width'), h: num(icon, 'height') },
      };
    });
    const links = [...svg.querySelectorAll('[data-el="link"]')].map((l) => ({ i: l.getAttribute('data-i')!, stroke: rgb(getComputedStyle(l).stroke)! }));
    const stubs = [...svg.querySelectorAll('[data-el="stub"]')].map((s) => ({
      cat: resolve(getComputedStyle(s).getPropertyValue('--cat')),
      stroke: rgb(getComputedStyle(s).stroke)!,
    }));
    const legendEl = document.querySelector('[aria-label="Skill levels"]')!;
    const legend = {
      cat: resolve(getComputedStyle(legendEl).getPropertyValue('--cat')),
      rows: [...legendEl.children].map((row) => {
        const swatch = row.querySelector('[aria-hidden="true"]')!;
        const s = getComputedStyle(swatch);
        return {
          text: (row.textContent ?? '').trim(),
          children: row.children.length,
          swatchChildren: swatch.children.length,
          fill: rgb(s.backgroundColor)!,
          border: s.borderTopStyle,
          borderColor: rgb(s.borderTopColor)!,
        };
      }),
    };
    // The page background: the colour the level mixes fade toward.
    const bg = resolve('var(--c-bg)');
    const ink = resolve('var(--c-text)');
    const lineMix = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mix-cat-line')) / 100 || 0;
    probe.remove();
    return { bg, ink, lineMix, nodes, links, stubs, legend };
  });
}

/** Share of `cat` in `c` = mix(cat, bg), on the channel where the two differ most. */
function share(c: Rgb, cat: Rgb, bg: Rgb): number {
  const k = [0, 1, 2].reduce((best, i) => (Math.abs(cat[i] - bg[i]) > Math.abs(cat[best] - bg[best]) ? i : best), 0);
  return (c[k] - bg[k]) / (cat[k] - bg[k]);
}

/** Colour rounding of the browser: a mix may land a fraction of a channel step off. */
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
const sameColour = (a: Rgb, b: Rgb, tol = 0.6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** `s` of `a`, the rest `b` (color-mix in srgb). */
const mix = (a: Rgb, b: Rgb, s: number): Rgb => [0, 1, 2].map((i) => a[i] * s + b[i] * (1 - s)) as Rgb;
/** WCAG contrast of two colours. */
const contrast = (a: Rgb, b: Rgb) => {
  const lum = (c: Rgb) => c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The level looks from strongest to weakest, as the wheel names them (data-visual). */
const LOOKS = ['l3', 'l2', 'l1'] as const;

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: three level looks, each weaker one a fainter mix; links and stubs in the look of the node they lead to`, async ({ page }) => {
    await openApp(page, { theme });
    await settle(page);
    const d = await drawn(page);
    const nav = await page.evaluate(() => window.__site!.getState().nav.hard);
    const ids = nav.flatMap((c) => c.nodes.map((n) => n.id));
    const roots = nav.reduce((n, c) => n + c.nodes.filter((x) => x.parent === null).length, 0);
    expect(Math.max(...d.bg) > 128, 'the mixes go toward this theme’s background').toBe(theme === 'light');

    // Every skill of the hard wheel is drawn, in one of exactly three looks.
    expect(d.nodes.map((n) => n.id).sort(), 'the wheel draws every skill of its categories').toEqual([...ids].sort());
    expect(new Set(d.nodes.map((n) => n.visual))).toEqual(new Set(LOOKS));

    // Each look has one share of the category colour, the same on every node that wears it.
    const shares = new Map<string, number[]>();
    for (const n of d.nodes) shares.set(n.visual, [...(shares.get(n.visual) ?? []), share(n.fill, n.cat, d.bg)]);
    const look = (v: string) => {
      const s = shares.get(v)!;
      expect(Math.max(...s) - Math.min(...s), `${v}: one share on every node`).toBeLessThanOrEqual(0.02);
      return s[0];
    };
    const [strong, middle, weak] = LOOKS.map(look);
    expect(near(strong, 1), `the strongest look is the full category colour (share ${strong.toFixed(3)})`).toBe(true);
    expect(middle, 'the middle look is fainter than the strongest').toBeLessThan(strong - 0.1);
    expect(weak, 'the weakest look is fainter than the middle one').toBeLessThan(middle - 0.1);
    expect(weak, 'the weakest look still shows its category').toBeGreaterThan(0.05);

    // Only the weakest look carries a ring, dashed and drawn in its category (light: in the lines' ink).
    if (theme === 'light') expect(d.lineMix, '--mix-cat-line').toBeGreaterThan(0);
    const line = (cat: Rgb) => mix(cat, d.ink, d.lineMix);
    const rings: string[] = [];
    for (const n of d.nodes) {
      const dashed = n.dash !== 'none' && /\d/.test(n.dash);
      if (n.visual === 'l1') {
        if (!dashed || !(n.strokeWidth > 0) || !n.stroke) rings.push(`${n.id}: no dashed ring (${n.dash}, width ${n.strokeWidth})`);
        else if (theme === 'light') {
          if (!sameColour(n.stroke, line(n.cat), 1)) rings.push(`${n.id}: the ring is not in the lines' ink`);
          else if (contrast(n.stroke, d.bg) < 3) rings.push(`${n.id}: the ring at ${contrast(n.stroke, d.bg).toFixed(2)}:1`);
        } else if (!(share(n.stroke, n.cat, d.bg) > weak)) rings.push(`${n.id}: the ring is fainter than the face`);
      } else if (n.stroke !== null || dashed) {
        rings.push(`${n.id} (${n.visual}): has a ring (${n.dash})`);
      }
    }
    expect(rings, 'rings').toEqual([]);

    // A link is keyed by the node it leads to (data-i) and draws in that node's face colour; a stub
    // leads into a tree's root and draws in the full category colour. In the light theme every line
    // takes its category colour mixed toward the ink instead, at 3:1 or more.
    const byIndex = new Map(d.nodes.map((n) => [n.i, n]));
    expect(d.links, 'one link per node that is not a root').toHaveLength(d.nodes.length - roots);
    expect(d.stubs, 'one stub per tree').toHaveLength(roots);
    if (theme === 'light') {
      const badLinks = d.links
        .filter((l) => !sameColour(l.stroke, line(byIndex.get(l.i)!.cat), 1) || contrast(l.stroke, d.bg) < 3)
        .map((l) => `link to ${byIndex.get(l.i)!.id}`);
      expect(badLinks, 'light: every line in the ink, 3:1 or more').toEqual([]);
      const badStubs = d.stubs.filter((s) => !sameColour(s.stroke, line(s.cat), 1) || contrast(s.stroke, d.bg) < 3);
      expect(badStubs, 'light: every stub in the ink, 3:1 or more').toEqual([]);
    } else {
      const badLinks = d.links
        .filter((l) => !sameColour(l.stroke, byIndex.get(l.i)!.fill))
        .map((l) => `link to ${byIndex.get(l.i)!.id} (${byIndex.get(l.i)!.visual})`);
      expect(badLinks, 'a link takes the look of the node it leads to').toEqual([]);
      expect(d.stubs.map((s) => share(s.stroke, s.cat, d.bg)).filter((s) => !near(s, 1))).toEqual([]);
    }

    // The legend: three rows, strongest first, each swatch in the matching look; the last one dashed.
    expect(d.legend.rows).toHaveLength(LOOKS.length);
    for (const r of d.legend.rows) expect(r.text, 'each legend row names its level').toMatch(/\S/);
    const legendShares = d.legend.rows.map((r) => share(r.fill, d.legend.cat, d.bg));
    [strong, middle, weak].forEach((s, i) => expect(near(legendShares[i], s), `legend row ${i + 1}: ${legendShares[i].toFixed(3)} vs node ${s.toFixed(3)}`).toBe(true));
    expect(d.legend.rows.map((r) => r.border)).toEqual(['none', 'none', 'dashed']);
  });
}

test('a node draws only its hit area, face and icon; icons are centred and take one share of every node', async ({ page }) => {
  await openApp(page);
  await settle(page);
  const d = await drawn(page);
  // No extra marks (such as level pips) on the nodes.
  expect(new Set(d.nodes.map((n) => n.children.join(' ')))).toEqual(new Set(['circle.hit circle use']));
  const iconShares = new Set<string>();
  for (const n of d.nodes) {
    // The face is centred on the node; its outer edge (the ring's outer edge when it has one) is the node's size.
    const size = 2 * n.face.r + n.face.rim;
    expect([n.face.cx, n.face.cy], n.id).toEqual([0, 0]);
    expect(n.icon.w, `${n.id}: square icon`).toBeCloseTo(n.icon.h, 3);
    expect(n.icon.x + n.icon.w / 2, `${n.id}: icon centre x`).toBeCloseTo(0, 3);
    expect(n.icon.y + n.icon.h / 2, `${n.id}: icon centre y`).toBeCloseTo(0, 3);
    expect(n.icon.w, `${n.id}: icon inside the node`).toBeLessThan(size);
    iconShares.add((n.icon.w / size).toFixed(3));
  }
  expect([...iconShares], 'every icon takes the same share of its node').toHaveLength(1);
  // Each legend row: one swatch with nothing inside it, and the level name.
  expect(d.legend.rows.map((r) => [r.children, r.swatchChildren])).toEqual(d.legend.rows.map(() => [2, 0]));
});
