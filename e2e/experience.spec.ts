import AxeBuilder from '@axe-core/playwright';
import { appPath, dispatch, settle } from './support/app';
import { expect, newContext, test } from './support/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

/**
 * The Experience screen: employer links are 24 CSS px targets on laptop viewports without changing
 * the look; summaries are plain, selectable text, and a cut one has a "More"/"Less" button whose
 * label sits on the summary's last line, in one place for the whole screen, at its column's right
 * edge; the "In numbers" values stay whole at high browser zoom; app re-renders do not rebuild the
 * screen's size observers; an employer chip of the skill detail view brings that employer into view.
 */
const REGION = 'section[aria-label="Experience"]';
/** The work timeline's scroll area. */
const TIMELINE = `${REGION} [data-scroll][data-scroll-primary]`;
/** WCAG 2.2 target size (minimum), with a hair of rounding. */
const TARGET_PX = 24 - 0.1;
/** A touch screen as the browser reports it. */
const TOUCH = { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } as const;

/** Entries slide in (CSS): measure once they rest. */
async function entriesAtRest(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

async function openExperience(page: Page): Promise<void> {
  await page.goto(appPath());
  await page.waitForFunction(() => Boolean(window.__site && window.__wheel));
  await page.evaluate(() => window.__site!.ready);
  await dispatch(page, { t: 'tab/set', screen: 'experience' });
  await settle(page);
  await entriesAtRest(page);
  // The web font decides which summaries are cut: measure with it.
  await page.evaluate(() => document.fonts.ready);
}

/** A page in a context of its own (a viewport or device other than the project's). */
async function pageWith(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const ctx = await newContext(browser, options);
  return ctx.newPage();
}

interface Toggle {
  kind: string;
  label: string;
  /** Beside the summary's last visible line (else under the summary). */
  beside: boolean;
  /** Label baseline minus the last visible line's baseline, CSS px (beside only). */
  baseline: number | null;
  height: number;
  /** From the button's right edge to its column's (the entry's) right edge, CSS px. */
  rightGap: number;
  /** A shown word of the summary is wider than the summary (it would spill out or be broken). */
  cutWord: boolean;
}

/** Every summary's "More"/"Less" button on the screen and where it sits. */
async function toggles(page: Page): Promise<Toggle[]> {
  return page.evaluate((root) => {
    // A font's rendered descent: a text box's bottom minus the bottom of a zero-height inline-block,
    // which sits on the baseline. Layout rounds the font's metrics, so a fixed share of the font
    // size would be off by up to half a pixel.
    const descent = (el: Element) => {
      const cs = getComputedStyle(el);
      const copy = document.createElement('span');
      copy.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal';
      Object.assign(copy.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle });
      const text = document.createTextNode('Mg');
      const mark = document.createElement('i');
      mark.style.cssText = 'display:inline-block;width:0;height:0';
      copy.append(text, mark);
      el.closest('li')!.append(copy);
      const range = document.createRange();
      range.selectNodeContents(text);
      const d = range.getBoundingClientRect().bottom - mark.getBoundingClientRect().bottom;
      copy.remove();
      return d;
    };
    return [...document.querySelectorAll<HTMLElement>(`${root} li[data-kind]`)].flatMap((li) => {
      const p = li.querySelector<HTMLElement>('p[id]');
      const button = li.querySelector('button[aria-controls]');
      if (!p || !button) return [];
      const box = p.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(p);
      const last = [...text.getClientRects()].filter((r) => r.top < box.bottom - 1).at(-1)!;
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let label = walker.nextNode();
      while (label && !label.textContent!.trim()) label = walker.nextNode();
      const labelRange = document.createRange();
      labelRange.selectNodeContents(label!);
      const b = button.getBoundingClientRect();
      const beside = b.top < box.bottom - 1;
      // Without the break-word safety net, a shown word wider than the summary would spill out of
      // its line (lines past the cut are hidden, so their words do not count).
      p.style.overflowWrap = 'normal';
      const cutWord = [...text.getClientRects()].some((r) => r.top < box.bottom - 1 && r.right > box.right + 1);
      p.style.overflowWrap = '';
      return [
        {
          kind: li.dataset.kind!,
          label: label!.textContent!.trim(),
          beside,
          baseline: beside ? labelRange.getBoundingClientRect().bottom - descent(label!.parentElement!) - (last.bottom - descent(p)) : null,
          height: b.height,
          rightGap: li.getBoundingClientRect().right - b.right,
          cutWord,
        },
      ];
    });
  }, REGION);
}

async function expandAll(page: Page): Promise<void> {
  await page.evaluate((root) => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(`${root} button[aria-controls][aria-expanded="false"]`)) b.click();
  }, REGION);
  await expect(page.locator(`${REGION} button[aria-controls][aria-expanded="false"]`)).toHaveCount(0);
}

for (const [w, h] of [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
] as const) {
  test(`employer links meet the 24 px target size at ${w}×${h}`, { tag: '@a11y' }, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openExperience(page);
    const axe = await new AxeBuilder({ page }).include(REGION).withRules(['target-size']).analyze();
    const found = axe.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary}`));
    expect(found, found.join('\n')).toEqual([]);
    // The employer links (the skill chips are in-app links with a hit area of their own).
    const links = await page.evaluate((root) => {
      return [...document.querySelectorAll<HTMLElement>(`${root} a:not([href^="#"])`)].map((a) => {
        const box = a.getBoundingClientRect();
        const row = a.parentElement!;
        const range = document.createRange();
        range.selectNodeContents(a.firstChild!);
        const before = { row: row.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON() };
        // The same row without the hit area: nothing may move (the look is unchanged).
        a.style.padding = '0';
        a.style.margin = '0';
        const plain = { row: row.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON() };
        a.style.padding = '';
        a.style.margin = '';
        return { name: a.textContent!.trim(), w: box.width, h: box.height, moved: JSON.stringify(before) !== JSON.stringify(plain) };
      });
    }, REGION);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.h, `${l.name} height`).toBeGreaterThanOrEqual(TARGET_PX);
      expect(l.w, `${l.name} width`).toBeGreaterThanOrEqual(TARGET_PX);
      expect(l.moved, `${l.name}: the hit area moves the row`).toBe(false);
    }
    // The whole box takes the click: its top and bottom edges hit the link, not the text around it.
    const hits = await page.evaluate((root) => {
      return [...document.querySelectorAll(`${root} a:not([href^="#"])`)].flatMap((a) => {
        const b = a.getBoundingClientRect();
        const x = b.left + b.width / 2;
        return [b.top + 1, b.bottom - 1].map((y) => document.elementFromPoint(x, y)?.closest('a') === a);
      });
    }, REGION);
    expect(hits.every(Boolean), JSON.stringify(hits)).toBe(true);
  });
}

test('summary text is selectable and a cut summary has a More/Less control', async ({ browser }) => {
  const page = await pageWith(browser, { viewport: { width: 1920, height: 1080 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await openExperience(page);
  const region = page.locator(REGION);

  // A "More" button follows exactly the summaries whose visible lines hide text.
  const facts = await page.evaluate((root) => {
    return [...document.querySelectorAll(`${root} li[data-kind] p[id]`)].map((p) => {
      const next = p.nextElementSibling;
      return {
        cut: p.scrollHeight > p.clientHeight + 1,
        more: next?.tagName === 'BUTTON' && next.getAttribute('aria-controls') === p.id,
      };
    });
  }, REGION);
  expect(facts.length).toBeGreaterThan(0);
  for (const f of facts) expect(f.more).toBe(f.cut);
  test.skip(!facts.some((f) => f.cut), 'no summary is cut at this size');

  // A drag across a summary selects its text and leaves the entry as it was.
  const summary = region.locator('li[data-kind] p[id]').first();
  const box = (await summary.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 4, { steps: 8 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.length).toBeGreaterThan(10);
  expect((await summary.textContent())!).toContain(selected.trim());
  expect(await region.locator('[aria-expanded="true"]').count()).toBe(0);
  // Ctrl+C copies it (and is not taken for the single-key C shortcut).
  const city = await page.evaluate(() => window.__site!.getState().cityShown);
  await page.keyboard.press('Control+C');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  expect(await page.evaluate(() => window.__site!.getState().cityShown)).toBe(city);

  // "More" shows the whole summary; "Less" cuts it again.
  const id = (await region.getByRole('button', { name: 'More', exact: true }).first().getAttribute('aria-controls'))!;
  const text = page.locator(`p[id="${id}"]`);
  const toggle = page.locator(`button[aria-controls="${id}"]`);
  await expect(toggle).toHaveAccessibleName('More');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Less');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => text.evaluate((p) => p.scrollHeight <= p.clientHeight + 1)).toBe(true);
  await toggle.press('Enter');
  await expect(toggle).toHaveAccessibleName('More');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => text.evaluate((p) => p.scrollHeight > p.clientHeight + 1)).toBe(true);
  await page.context().close();
});

// The label shares the summary's last line: the same baseline, also on touch screens, where the
// button is a 24 CSS px target.
for (const [name, options] of [
  ['1920×1080', { viewport: { width: 1920, height: 1080 } }],
  ['1366×768', { viewport: { width: 1366, height: 768 } }],
  ['a 915×412 touch screen', { viewport: { width: 915, height: 412 }, ...TOUCH }],
] as const) {
  test(`the More/Less label sits on the summary's last line at ${name}`, async ({ browser }) => {
    const page = await pageWith(browser, options);
    await openExperience(page);
    const coarse = await page.evaluate(() => document.documentElement.dataset.pointer === 'coarse');
    expect(coarse).toBe('hasTouch' in options);
    // The content decides which summaries are cut: a size where none is has nothing to check.
    test.skip((await toggles(page)).length === 0, 'no summary is cut at this size');
    for (const state of ['collapsed', 'expanded'] as const) {
      if (state === 'expanded') await expandAll(page);
      for (const t of (await toggles(page)).filter((x) => x.beside)) {
        expect(Math.abs(t.baseline!), `${t.kind} "${t.label}" (${state}): label baseline − line baseline = ${t.baseline!.toFixed(2)} px`).toBeLessThanOrEqual(0.5);
        if (coarse) expect(t.height, `${t.kind} "${t.label}" (${state}) height`).toBeGreaterThanOrEqual(TARGET_PX);
      }
    }
    await page.context().close();
  });
}

// "More" sits in one place for the whole screen (beside the last line everywhere, or under the
// summary everywhere), at its column's right edge, and the summary keeps whole words.
for (const [name, options] of [
  ['1920×1080', { viewport: { width: 1920, height: 1080 } }],
  ['1366×768', { viewport: { width: 1366, height: 768 } }],
  ['1024×768', { viewport: { width: 1024, height: 768 } }],
  ['a 915×412 touch screen', { viewport: { width: 915, height: 412 }, ...TOUCH }],
  ['640×360 (a laptop at 200 % zoom)', { viewport: { width: 640, height: 360 } }],
] as const) {
  test(`every More sits in one place, at the column's right edge, at ${name}`, async ({ browser }) => {
    const page = await pageWith(browser, options);
    await openExperience(page);
    const collapsed = await toggles(page);
    test.skip(collapsed.length === 0, 'no summary is cut at this size');
    expect(new Set(collapsed.map((t) => t.beside)).size, `one place for all: ${collapsed.map((t) => `${t.kind} ${t.beside ? 'beside' : 'under'}`).join(', ')}`).toBe(1);
    for (const t of collapsed) {
      expect(Math.abs(t.rightGap), `${t.kind} "${t.label}" right edge`).toBeLessThanOrEqual(0.5);
      expect(t.cutWord, `${t.kind} summary keeps whole words`).toBe(false);
    }
    await expandAll(page);
    for (const t of await toggles(page)) {
      expect(Math.abs(t.rightGap), `${t.kind} "${t.label}" right edge (expanded)`).toBeLessThanOrEqual(0.5);
      expect(t.cutWord, `${t.kind} summary keeps whole words (expanded)`).toBe(false);
    }
    await page.context().close();
  });
}

// 640×360 … 720×405: 1280×720 … 1440×810 windows at 200 % browser zoom.
for (const [w, h] of [
  [640, 360],
  [683, 384],
  [720, 405],
] as const) {
  test(`"In numbers" values are not clipped at high browser zoom (${w}×${h})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openExperience(page);
    const values = await page.evaluate((root) => {
      return [...document.querySelectorAll(`${root} li > [class*="statValue"]`)].map((value) => {
        const area = value.closest('[data-scroll]')!.getBoundingClientRect();
        const v = value.getBoundingClientRect();
        const r = value.parentElement!.getBoundingClientRect();
        // Past the scroll area that clips it, or past its own row.
        const past = Math.max(v.right - area.right, area.left - v.left, v.right - r.right);
        return { text: value.textContent!.trim(), cut: past > 0.5 || value.scrollWidth > value.clientWidth + 1 };
      });
    }, REGION);
    expect(values.length, '"In numbers" values').toBeGreaterThan(0);
    expect(values.filter((v) => v.cut)).toEqual([]);
  });
}

test('sound and theme toggles create no new size observers on Experience', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __observers: number };
    w.__observers = 0;
    const Native = window.ResizeObserver;
    window.ResizeObserver = class extends Native {
      constructor(cb: ResizeObserverCallback) {
        super(cb);
        w.__observers++;
      }
    };
  });
  await openExperience(page);
  const count = () => page.evaluate(() => (window as unknown as { __observers: number }).__observers);
  const before = await count();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  for (let i = 0; i < 10; i++) await page.keyboard.press('v');
  await page.keyboard.press('t');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? '')).not.toBe(theme);
  await page.keyboard.press('t');
  await settle(page);
  expect(await count()).toBe(before);
});

/** Scroll the timeline to its end and let the area record the place (its scroll listener runs on the next frame). */
async function scrollTimelineToEnd(page: Page): Promise<number> {
  const top = await page.locator(TIMELINE).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  return top;
}

/** Whether an entry lies whole inside the timeline's visible box. */
function entryInView(page: Page, id: string) {
  return page.evaluate(
    ({ id, timeline }) => {
      const area = document.querySelector<HTMLElement>(timeline)!;
      const entry = area.querySelector(`[data-entry="${CSS.escape(id)}"]`)!.getBoundingClientRect();
      const box = area.getBoundingClientRect();
      return { top: entry.top >= box.top - 0.5, bottom: entry.bottom <= box.bottom + 0.5 };
    },
    { id, timeline: TIMELINE },
  );
}

/** Small viewports show a few of the detail panel's links and a "+N" button: show them all. */
async function allPanelLinks(page: Page): Promise<void> {
  for (const more of await page.locator('[data-detail-panel]').getByRole('button', { name: /^Show \d+ more$/ }).all()) await more.click();
}

for (const [w, h] of [
  // Sizes where the work timeline scrolls.
  [1366, 768],
  [1280, 720],
] as const) {
  test(`an employer chip of a skill brings that employer into view at ${w}×${h}`, { tag: '@critical' }, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: w, height: h });
    await openExperience(page);
    // Employer chips of the detail panel, collected from the skills that have them.
    const jobs = await page.evaluate(() => window.__site!.getState().nav.hard.flatMap((c) => c.nodes.map((n) => ({ cat: c.id, node: n.id }))));
    const targets = new Map<string, { cat: string; node: string; org: string }>();
    for (const { cat, node } of jobs) {
      await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'cat/open', cat, node });
      await allPanelLinks(page);
      for (const link of await page.locator('[data-detail-panel] a[aria-label$="on the Experience tab"]').all()) {
        const org = (await link.getAttribute('aria-label'))!.replace(/^Show (.+) on the Experience tab$/, '$1');
        if (!targets.has(org)) targets.set(org, { cat, node, org });
      }
      if (targets.size >= 4) break;
    }
    expect(targets.size, 'employer chips').toBeGreaterThan(1);
    for (const { cat, node, org } of targets.values()) {
      // Experience scrolled to its end (the place the tab remembers), then the skill's employer chip.
      await dispatch(page, { t: 'tab/set', screen: 'experience' });
      await settle(page);
      await entriesAtRest(page);
      await scrollTimelineToEnd(page);
      await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'cat/open', cat, node });
      await allPanelLinks(page);
      await page.locator('[data-detail-panel]').getByRole('link', { name: `Show ${org} on the Experience tab`, exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__site!.getState().screen)).toBe('experience');
      await settle(page);
      await entriesAtRest(page);
      const id = await page.evaluate((org) => {
        const entry = [...document.querySelectorAll('li[data-entry]')].find((li) => li.textContent!.includes(org));
        return entry?.getAttribute('data-entry') ?? null;
      }, org);
      expect(id, org).not.toBeNull();
      // The reveal may scroll smoothly: wait for the entry to come to rest in view.
      await expect.poll(() => entryInView(page, id!), { message: `${org} at ${w}×${h}` }).toEqual({ top: true, bottom: true });
    }
    // A plain tab switch keeps the remembered position (no reveal is pending).
    const end = await scrollTimelineToEnd(page);
    await dispatch(page, { t: 'tab/set', screen: 'skills' }, { t: 'tab/set', screen: 'experience' });
    await settle(page);
    expect(await page.locator(TIMELINE).evaluate((el) => el.scrollTop)).toBe(end);
  });
}
