import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { appPath, categoryIds, dispatch, openApp, screenOrder, sectionNames, ui } from './support/app';
import { expect, test } from './support/test';

/**
 * Focus and reading order follow the layout, and every view has its own title: the top-left player
 * card comes first, then the header, the top-right Display options trigger, the screen and the
 * footer; the card and the menu sit in named landmarks; document.title names the view
 * ("<view> · <name>").
 */

type Stop = { name: string; cat: string | null; inMenuRows: boolean; landmark: string | null; tag: string };

/** What has focus, as a Tab stop: its name, its category arc, whether it is a menu row, its landmark. */
const stop = (page: Page): Promise<Stop | null> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const lm = el.closest('header, footer, main, nav, aside, section[aria-label], [role="region"], [role="complementary"]');
    return {
      name: `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.replace(/\s+/g, ' ').trim(),
      cat: el.hasAttribute('data-node-id') ? null : el.getAttribute('data-cat-id'),
      inMenuRows: el.closest('ul[aria-label="Display options"]') !== null,
      landmark: lm ? `${lm.tagName.toLowerCase()}${lm.getAttribute('aria-label') ? `[${lm.getAttribute('aria-label')}]` : ''}` : null,
      tag: el.tagName.toLowerCase(),
    };
  });

/** One label per stop, in the layout's terms (names include the key caps' letters: "QPrevious section…"). */
function label(s: Stop): string {
  if (s.cat) return 'wheel';
  if (s.landmark === 'aside[Player card]') return 'card';
  if (/display options/i.test(s.name)) return 'menu';
  if (/previous section/i.test(s.name)) return 'previous';
  if (/next section/i.test(s.name)) return 'next';
  if (/soft skills/i.test(s.name)) return 'soft skills';
  if (/select$/i.test(s.name)) return 'select';
  if (s.landmark === 'footer') return 'footer';
  return s.name;
}

/** Tab from the top of the page until focus leaves the page (or comes round to the first stop again). */
async function tabWalk(page: Page, max = 40): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await stop(page);
    if (!s || (stops.length > 0 && s.name === stops[0].name && s.landmark === stops[0].landmark)) return stops;
    stops.push(s);
  }
  throw new Error(`Tab never left the page: ${stops.map(label).join(' → ')}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('focus and reading order follow the layout', () => {
  test('Tab order follows the layout: card first, the menu trigger after the header, the footer last', { tag: ['@a11y', '@critical'] }, async ({ page }) => {
    await openApp(page);
    const stops = await tabWalk(page);
    // Every stop sits in a landmark.
    for (const s of stops) expect(s.landmark, `${label(s)} is inside a landmark`).not.toBeNull();
    // ENTER · Select may unfold while the wheel's arc holds the hover; it folds once focus leaves it.
    const order = stops.filter((s) => !s.inMenuRows).map(label).filter((l) => l !== 'select');
    expect(order.slice(0, 6)).toEqual(['card', 'previous', 'next', 'menu', 'wheel', 'soft skills']);
    // Whatever follows the wheel switch belongs to the footer.
    for (const l of order.slice(6)) expect(l, 'stops after the wheel switch are in the footer').toBe('footer');
    expect(stops[0].landmark).toBe('aside[Player card]');
    expect(stops.find((s) => label(s) === 'menu')?.landmark).toBe('section[Display options]');
  });

  test('the player card is inside a landmark: axe "region" is clean with the card focused', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    const card = page.getByRole('complementary', { name: 'Player card' }).getByRole('button');
    await expect(card).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(card).toBeFocused();
    await expect(card).toHaveAttribute('aria-expanded', 'true');
    const results = await new AxeBuilder({ page }).withRules(['region']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    // The Display options menu sits in a landmark of its own, outside the footer.
    const trigger = page.getByRole('button', { name: 'Display options' });
    await expect(page.getByRole('region', { name: 'Display options' }).getByRole('button', { name: 'Display options' })).toHaveCount(1);
    await expect(ui.hud(page).getByRole('button', { name: 'Display options' })).toHaveCount(0);
    expect(await trigger.evaluate((el) => el.closest('footer') === null)).toBe(true);
  });

  test('the corners paint in order: the menu above the header and the footer, the card above the menu', async ({ page }) => {
    await openApp(page);
    const z = await page.evaluate(() => {
      const of = (selector: string) => Number(getComputedStyle(document.querySelector(selector)!).zIndex);
      return { header: of('header[data-hud]'), footer: of('footer[data-hud]'), menu: of('[data-hud="menu"]'), card: of('[data-hud="card"]') };
    });
    expect(z.menu, JSON.stringify(z)).toBeGreaterThan(Math.max(z.header, z.footer));
    expect(z.card, JSON.stringify(z)).toBeGreaterThan(z.menu);
  });
});

test.describe('document.title names the view', { tag: '@a11y' }, () => {
  test('document.title follows hub, tab, soft and detail views; the prerendered page keeps its own title', async ({ page }) => {
    await openApp(page);
    const hubTitle = await page.title();
    expect(hubTitle).toMatch(/^Skills · .+$/);
    const name = hubTitle.slice('Skills · '.length);
    const suffix = ` · ${escapeRe(name)}$`;

    // The prerendered HTML carries a descriptive title that starts with the name.
    const html = await (await page.request.get(appPath())).text();
    expect(html).toMatch(new RegExp(`<title>${escapeRe(name)} — [^<]+</title>`));

    // E through every section and round to Skills again: each title names its section.
    const screens = await screenOrder(page);
    const names = await sectionNames(page);
    const start = screens.indexOf('skills');
    for (let step = 1; step <= screens.length; step++) {
      const i = (start + step) % screens.length;
      await page.keyboard.press('e');
      await expect(page).toHaveTitle(new RegExp(`^${escapeRe(names[i])}${suffix}`, 'i'));
    }
    await expect(page).toHaveTitle(hubTitle);

    await dispatch(page, { t: 'wheel/set', wheel: 'soft' });
    await expect(page).toHaveTitle(new RegExp(`^Soft skills${suffix}`, 'i'));

    for (const wheel of ['soft', 'hard'] as const) {
      const [cat] = await categoryIds(page, wheel);
      await dispatch(page, { t: 'wheel/set', wheel }, { t: 'cat/open', cat });
      // "<skill> · <category>": the panel's heading and the header's category title.
      const node = (await page.locator('[data-detail-panel] h3').first().textContent())!.trim();
      const category = (await ui.sectionTitle(page).or(ui.categoryNav(page).getByRole('heading')).first().textContent())!.trim();
      await expect(page).toHaveTitle(`${node} · ${category} · ${name}`);
    }
  });
});
