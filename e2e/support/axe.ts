/**
 * Shared axe-core scan for the accessibility specs. A scan passes when it reports no serious or
 * critical result, whether a violation or a result axe leaves for manual review.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { categoryIds, dispatch, screenOrder, settle } from './app';
import { expect } from './test';
import type { Action } from './types';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Rules that must run on every screen: a rule that silently stops running would hide regressions. */
const REQUIRED_RULES = ['label-content-name-mismatch', 'color-contrast', 'button-name', 'aria-hidden-focus'];
/**
 * "Needs review" results axe cannot settle from the DOM. color-contrast lands here for text drawn
 * over the animated background, images and gradients: deciding those needs pixel measurement, so
 * they are out of scope here. Every other serious or critical result counts.
 */
const INCOMPLETE_OUT_OF_SCOPE = new Set(['color-contrast']);

/**
 * A known finding that is tracked, not yet fixed: a node counts as known only when the rule and kind
 * match and its element matches `selector`. A scan told to expect one fails once it no longer shows
 * up, so the entry is removed together with the fix.
 */
export interface KnownFinding {
  id: string;
  rule: string;
  kind: 'violation' | 'needs review';
  selector: string;
}

type Result = { id: string; impact?: string | null; help: string; nodes: { target: unknown[] }[] };

/** Every serious or critical axe result on the page, one line each (empty: the scan passes). */
export async function seriousFindings(page: Page, known: readonly KnownFinding[] = []): Promise<string[]> {
  // Legacy mode runs axe in the page itself: the same results in a fraction of the time. It skips
  // cross-origin frames, and the app has none (its CSP would block them).
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).setLegacyMode().analyze();
  const ran = new Set([...results.passes, ...results.violations, ...results.incomplete, ...results.inapplicable].map((r) => r.id));
  const missing = REQUIRED_RULES.filter((id) => !ran.has(id));
  const serious = (r: Result) => r.impact === 'serious' || r.impact === 'critical';
  const seen = new Set<string>();
  /** The result without the nodes a known finding covers. */
  const unknownNodes = async (r: Result, kind: KnownFinding['kind']): Promise<Result> => {
    const entries = known.filter((k) => k.rule === r.id && k.kind === kind);
    if (!entries.length) return r;
    const covered = await page.evaluate(
      ({ targets, selectors }) =>
        targets.map((t) => {
          const el = t.length === 1 && typeof t[0] === 'string' ? document.querySelector(t[0]) : null;
          return selectors.findIndex((s) => el?.matches(s));
        }),
      { targets: r.nodes.map((n) => n.target), selectors: entries.map((k) => k.selector) },
    );
    for (const i of covered) if (i >= 0) seen.add(entries[i].id);
    return { ...r, nodes: r.nodes.filter((_n, i) => covered[i] < 0) };
  };
  const line = (kind: string) => (r: Result) =>
    `${r.id} (${r.impact}, ${kind}): ${r.help} — ${r.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' | ')}`;
  const violations = await Promise.all((results.violations as Result[]).filter(serious).map((r) => unknownNodes(r, 'violation')));
  const review = await Promise.all(
    (results.incomplete as Result[]).filter((r) => serious(r) && !INCOMPLETE_OUT_OF_SCOPE.has(r.id)).map((r) => unknownNodes(r, 'needs review')),
  );
  return [
    ...missing.map((id) => `${id}: rule did not run`),
    ...violations.filter((r) => r.nodes.length).map(line('violation')),
    ...review.filter((r) => r.nodes.length).map(line('needs review')),
    ...known.filter((k) => !seen.has(k.id)).map((k) => `${k.id} (${k.rule} on ${k.selector}) no longer shows up: remove it from the known findings`),
  ];
}

export interface AxeView {
  name: string;
  /** Actions that reach the view from the Skills screen, given the hard and soft category ids. */
  actions: (hard: string[], soft: string[]) => Action[];
}

/** The skill-wheel views, each reached from the Skills screen (openApp first). */
const WHEEL_VIEWS: readonly AxeView[] = [
  { name: 'skills wheel', actions: () => [] },
  { name: 'category hover', actions: (hard) => [{ t: 'cat/hover', cat: hard[0] }] },
  { name: 'category detail', actions: (hard) => [{ t: 'cat/open', cat: hard[0] }] },
  { name: 'soft-skills wheel', actions: () => [{ t: 'wheel/set', wheel: 'soft' }] },
  { name: 'soft-skills detail', actions: (_h, soft) => [{ t: 'wheel/set', wheel: 'soft' }, { t: 'cat/open', cat: soft[0] }] },
];

/**
 * Every view to scan: the wheel views plus one per other screen, read from the app's header so a
 * new section is scanned without a change here. Call on the Skills screen, right after openApp.
 */
export async function axeViews(page: Page): Promise<AxeView[]> {
  const screens = (await screenOrder(page)).filter((s) => s !== 'skills');
  return [...WHEEL_VIEWS, ...screens.map((screen) => ({ name: `${screen} screen`, actions: (): Action[] => [{ t: 'tab/set', screen }] }))];
}

/** Reach a view from the Skills screen and bring it to rest, as a visitor sees it once it has opened. */
export async function showView(page: Page, view: AxeView): Promise<void> {
  await dispatch(page, ...view.actions(await categoryIds(page, 'hard'), await categoryIds(page, 'soft')));
  await settle(page);
  await finishAnimations(page);
  expect(await page.evaluate(() => window.__wheel!.settle(0).settled), 'the wheel is at rest when axe scans').toBe(true);
}

/**
 * Jump every running finite CSS animation and transition to its end, let the page paint, and fail if
 * one still runs. Text in the middle of a fade-in has a low opacity that axe skips, so scanning a view
 * mid-entrance would check only part of it, more or less depending on timing.
 */
export async function finishAnimations(page: Page): Promise<void> {
  const running = await page.evaluate(async () => {
    const live = () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
    for (let round = 0; round < 3 && live().length; round++) {
      for (const a of live()) {
        try {
          a.finish();
        } catch {
          // It cannot end (zero playback rate): the check below names it.
        }
      }
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
    return live().map((a) => (a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : 'animation'));
  });
  expect(running, 'CSS animations still running when axe scans').toEqual([]);
}

/** Open the Display options menu over the resting wheel, its rows faded in. */
export async function openDisplayOptions(page: Page): Promise<void> {
  await settle(page);
  await page.getByRole('button', { name: 'Display options' }).click();
  await expect(page.getByRole('list', { name: 'Display options' })).not.toHaveAttribute('inert', '');
  await finishAnimations(page);
}
