/**
 * Toasts: V, A, P, K and D confirm themselves with a short plate centred under the footer for a
 * moment; a new one replaces it. It shows over a hidden interface too (the only feedback there)
 * without bringing it back, never takes focus or the pointer, never covers the call-to-action link or
 * a wheel node (also on the scrolling reflow layout, where it scrolls with the footer), is announced
 * once (by a status region; the plate itself is aria-hidden), and only fades (no movement under
 * reduced motion), on the main thread: beneath the wheel it composites nothing of the stage.
 */
import type { CDPSession, Page } from '@playwright/test';
import { categoryIds, dispatch, openApp, settle } from './support/app';
import { seriousFindings } from './support/axe';
import { expect, test } from './support/test';

const plate = (page: Page) => page.locator('[data-toast]');
const status = (page: Page) => page.locator('p[role="status"]');

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const rect = async (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The plate's label and key cap, as drawn (upper case). */
const shown = (page: Page) =>
  plate(page).evaluate((el) => ({
    text: (el.querySelector(':scope > span') as HTMLElement).innerText.trim(),
    cap: el.querySelector('kbd')?.textContent ?? null,
  }));

/**
 * Keeps the next toast on screen while a slow check (axe) runs: the timers the page starts while
 * `during` runs and that are due later than a frame or two (the toast's removal among them) never
 * fire. A test-only hold; the page is not used for anything timed afterwards.
 */
async function holdToastsDuring(page: Page, during: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hold?: boolean; __nativeTimeout?: typeof setTimeout };
    const native = (w.__nativeTimeout ??= window.setTimeout.bind(window));
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
      w.__hold && (ms ?? 0) > 50 ? native(() => {}, 0) : native(fn, ms, ...rest)) as typeof window.setTimeout;
    w.__hold = true;
  });
  await during();
  await page.evaluate(() => ((window as unknown as { __hold?: boolean }).__hold = false));
}
/** Stops the toast's animation half-way through its life, at full opacity (it still goes on time). */
async function freeze(page: Page): Promise<void> {
  await plate(page).evaluate((el) => {
    for (const a of el.getAnimations()) {
      a.pause();
      const end = Number(a.effect?.getComputedTiming().endTime);
      a.currentTime = Number.isFinite(end) ? end / 2 : 0;
    }
  });
}

/** The visible wheel nodes' boxes on screen (CSS px). */
const nodeBoxes = (page: Page): Promise<Box[]> =>
  page.evaluate(() => {
    const visible = new Set(window.__wheel!.geometry().nodes.filter((n) => n.visible).map((n) => n.id));
    return [...document.querySelectorAll('svg[data-active] [data-node-id]')]
      .filter((el) => visible.has(el.getAttribute('data-node-id')!))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      })
      .filter((b) => b.right > b.left && b.bottom > b.top);
  });

/** The call-to-action link in the footer. */
const CTA = 'footer[data-hud] a[target="_blank"]';

/**
 * The elements inside the stage that Chromium composites now (CDP LayerTree, read afresh): a stage
 * composited apart from the layer it sits on loses its text's subpixel anti-aliasing.
 */
async function compositedInStage(page: Page, cdp: CDPSession): Promise<string[]> {
  const tree = new Promise<{ backendNodeId?: number }[]>((resolve) => cdp.once('LayerTree.layerTreeDidChange', (e) => resolve(e.layers ?? [])));
  await cdp.send('LayerTree.enable');
  // Chromium reports its layers with the next frame it draws: a screenshot makes it draw one now.
  await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } });
  const layers = await tree;
  await cdp.send('LayerTree.disable');
  const found: string[] = [];
  for (const { backendNodeId } of layers) {
    if (!backendNodeId) continue;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    if (!object.objectId) continue;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { return this.closest?.("[data-stage]") ? `${this.localName}.${this.getAttribute("class")}${this.hasAttribute("data-stage") ? "[data-stage]" : ""}` : null; }',
      returnByValue: true,
    });
    if (typeof result.value === 'string') found.push(result.value);
  }
  return found;
}

/** WCAG contrast of two sRGB colours (0–255 channels). */
function contrast(a: number[], b: number[]): number {
  const lum = ([r, g, bl]: number[]) => {
    const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The plate's colour over black and over white (it is 96 % opaque), and its label's and cap's ink. */
const inks = (page: Page) =>
  plate(page).evaluate((el) => {
    const rgba = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const bg = rgba(getComputedStyle(el).backgroundColor);
    const a = bg[3] ?? 1;
    const over = (base: number) => bg.slice(0, 3).map((c) => c * a + base * (1 - a));
    return {
      plates: [over(0), over(255)],
      label: rgba(getComputedStyle(el.querySelector(':scope > span')!).color).slice(0, 3),
      cap: rgba(getComputedStyle(el.querySelector('kbd')!).color).slice(0, 3),
    };
  });

test.describe('toasts', () => {
  test('V shows "Sound on", then "Sound off" in its place; it goes away on its own', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await expect(plate(page)).toHaveCount(0);
    await page.keyboard.press('v');
    await expect(plate(page)).toHaveCount(1);
    expect(await shown(page)).toEqual({ text: 'SOUND ON', cap: 'V' });
    await expect(status(page)).toHaveText('Sound on');
    // Timed in the page (not across the test runner's round trips): from the key press to the plate's removal.
    await page.evaluate(() => {
      const w = window as unknown as { __toastLife?: Promise<number> };
      w.__toastLife = new Promise<number>((resolve) => {
        let start = 0;
        let seen = false;
        window.addEventListener('keydown', () => (start = performance.now()), { capture: true, once: true });
        new MutationObserver((_m, obs) => {
          const there = Boolean(document.querySelector('[data-toast]'));
          if (start && there) seen = true;
          if (seen && !there) {
            obs.disconnect();
            resolve(performance.now() - start);
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await page.keyboard.press('v');
    await expect(plate(page)).toHaveCount(1);
    expect(await shown(page)).toEqual({ text: 'SOUND OFF', cap: 'V' });
    // Gone without any input, after long enough to read (a second at least).
    await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
    const life = await page.evaluate(() => (window as unknown as { __toastLife: Promise<number> }).__toastLife);
    expect(life, 'time on screen (ms)').toBeGreaterThanOrEqual(1000);
  });

  test('P over a hidden interface shows the toast and the interface stays hidden', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const shownAt = await (async () => {
      await page.keyboard.press('v');
      await freeze(page); // at full opacity
      const b = (await rect(page, '[data-toast]'))!;
      await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
      return b;
    })();
    await page.keyboard.press('h');
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
    await page.keyboard.press('p');
    await expect(plate(page)).toHaveCount(1);
    expect((await shown(page)).text).toBe('CITY PAUSED');
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
    // The stage alone answers to [data-stage] (a strict locator), also while a toast shows.
    await expect(page.locator('[data-stage]')).toHaveCSS('visibility', 'hidden');
    expect(await page.evaluate(() => window.__site!.getState().uiHidden)).toBe(true);
    // The same place as over the interface (centred, so only the width follows the text).
    await freeze(page);
    const hidden = (await rect(page, '[data-toast]'))!;
    expect(Math.abs(hidden.top - shownAt.top)).toBeLessThan(0.5);
    expect(Math.abs(hidden.bottom - shownAt.bottom)).toBeLessThan(0.5);
    expect(Math.abs((hidden.left + hidden.right) / 2 - (shownAt.left + shownAt.right) / 2)).toBeLessThan(0.5);
    // The hint line steps aside while the toast shows, so the two never overlap.
    await expect(page.locator('[data-ui-hint]')).toHaveCSS('visibility', 'hidden');
    await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-ui-hint]')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
  });

  test('never takes focus or the pointer, and is hidden from assistive technology', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const next = page.getByRole('button', { name: /^Next section/ });
    await next.focus();
    await page.keyboard.press('a');
    await expect(plate(page)).toHaveCount(1);
    await expect(next).toBeFocused();
    expect(await plate(page).evaluate((el) => el.closest('[aria-hidden="true"]') !== null)).toBe(true);
    expect(await plate(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await plate(page).locator('a, button, [tabindex]').count()).toBe(0);
    // A click on it reaches what lies under it.
    await freeze(page);
    const box = (await rect(page, '[data-toast]'))!;
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-toast]') ?? null, [(box.left + box.right) / 2, (box.top + box.bottom) / 2]);
    expect(under).toBeNull();
    // Tab never stops on it.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[data-toast]') ?? null)).toBeNull();
    }
  });

  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ]) {
    test(`never covers the call-to-action link or a wheel node, centred under the footer (${size.width}×${size.height})`, async ({ page }) => {
      await page.setViewportSize(size);
      await openApp(page);
      await settle(page);
      await page.keyboard.press('k');
      await page.keyboard.press('k'); // keys back on: the next toasts carry their key cap
      await page.keyboard.press('a');
      await page.keyboard.press('a');
      await expect(plate(page)).toHaveCount(1);
      await freeze(page);
      const toast = (await rect(page, '[data-toast]'))!;
      const cta = (await rect(page, CTA))!;
      const hints = (await rect(page, '[aria-label="Controls"]'))!;
      const stage = (await rect(page, '[data-stage]'))!;
      expect(overlaps(toast, cta)).toBe(false);
      expect(overlaps(toast, hints)).toBe(false);
      expect(toast.top).toBeGreaterThanOrEqual(Math.max(cta.bottom, hints.bottom));
      expect(toast.bottom).toBeLessThanOrEqual(stage.bottom);
      expect(Math.abs((toast.left + toast.right) / 2 - (stage.left + stage.right) / 2)).toBeLessThan(0.5);
      // Idle hub: no node under it.
      const nodes = await nodeBoxes(page);
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.filter((n) => overlaps(n, toast))).toEqual([]);
    });
  }

  test('on the hub it lies beneath the wheel (hovered trees reach under it); elsewhere above the screens', async ({ page }) => {
    await openApp(page);
    const [first] = await categoryIds(page);
    await dispatch(page, { t: 'cat/hover', cat: first });
    await page.keyboard.press('v');
    const z = () =>
      page.evaluate(() => ({
        toast: Number(getComputedStyle(document.querySelector('[data-toast]')!.closest('[data-toast-layer]')!).zIndex),
        stage: Number(getComputedStyle(document.querySelector('[data-stage]')!).zIndex),
      }));
    let { toast, stage } = await z();
    expect(toast).toBeLessThan(stage);
    await dispatch(page, { t: 'tab/set', screen: 'experience' });
    await page.keyboard.press('v');
    ({ toast, stage } = await z());
    expect(toast).toBeGreaterThan(stage);
  });

  test('beneath the hub it composites nothing of the stage: the HUD text keeps its anti-aliasing (City off)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'reads the compositor layers over CDP');
    // City off (and the poster) composite nothing under the stage: its text is drawn with subpixel
    // anti-aliasing, and a compositor animation beneath it (opacity, translate) would make Chromium
    // composite the stage over it, in grayscale, for as long as the toast shows.
    await openApp(page, { city: 'off' });
    await settle(page);
    // The HUD's entrance animations composite their own parts while they run: let them end.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    expect(await compositedInStage(page, cdp)).toEqual([]);
    await page.keyboard.press('v');
    await expect(plate(page)).toHaveCount(1);
    // It fades on the main thread: its animation drives no compositor property.
    const animated = await plate(page).evaluate((el) => {
      const anims = el.getAnimations();
      return { count: anims.length, props: anims.flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))) };
    });
    expect(animated.count).toBeGreaterThan(0);
    expect(animated.props.filter((p) => ['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter'].includes(p))).toEqual([]);
    // Read again and again for as long as it shows (running, not paused). Each read draws a frame,
    // so the reads are spread over its life; how many fit depends on the machine's speed.
    const seen: string[] = [];
    let reads = 0;
    while ((await plate(page).count()) > 0 && reads < 30) {
      seen.push(...(await compositedInStage(page, cdp)));
      reads++;
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect([...new Set(seen)]).toEqual([]);
  });

  // A 600×330 window, close to a large desktop window at 300 % zoom: the layout stacks and scrolls.
  test.describe('reflow: the stacked stage scrolls (600×330)', () => {
    test.use({ viewport: { width: 600, height: 330 } });

    /** Scrolls the shell (the stage's scrolling parent) to `fromBottom` px above its end, or to its top. */
    const scrollShell = (page: Page, fromBottom: number | 'top') =>
      page.evaluate((d) => {
        const shell = document.querySelector('[data-stage]')!.parentElement!;
        shell.scrollTop = d === 'top' ? 0 : shell.scrollHeight - shell.clientHeight - d;
        return shell.scrollHeight - shell.clientHeight;
      }, fromBottom);

    test('off the hub it stays in its room under the call-to-action link wherever the page is scrolled', async ({ page }) => {
      await openApp(page);
      await dispatch(page, { t: 'tab/set', screen: 'experience' });
      await expect(page.locator('[data-stage]')).toHaveAttribute('data-stage', 'portrait');
      let gap: number | undefined;
      for (const fromBottom of [0, 40, 80, 120]) {
        expect(await scrollShell(page, fromBottom)).toBeGreaterThan(120);
        await page.keyboard.press('a');
        await expect(plate(page)).toHaveCount(1);
        await freeze(page);
        const toast = (await rect(page, '[data-toast]'))!;
        const cta = (await rect(page, CTA))!;
        expect(overlaps(toast, cta), `${fromBottom} px above the end`).toBe(false);
        // Under the link and scrolled with it: the same gap at every scroll position.
        expect(toast.top).toBeGreaterThanOrEqual(cta.bottom);
        gap ??= toast.top - cta.bottom;
        expect(Math.abs(toast.top - cta.bottom - gap)).toBeLessThan(0.5);
      }
    });

    test('on the hub its room is under the call-to-action link at the end of the page: out of sight at the top, in sight at the end', async ({ page }) => {
      await openApp(page);
      await settle(page);
      const { height } = page.viewportSize()!;
      /** Share of the plate inside the window. */
      const inSight = (b: Box) => Math.max(0, Math.min(b.bottom, height) - Math.max(b.top, 0)) / (b.bottom - b.top);
      for (const at of ['top', 0] as const) {
        await scrollShell(page, at);
        await page.keyboard.press('v');
        await expect(plate(page)).toHaveCount(1);
        await freeze(page);
        const toast = (await rect(page, '[data-toast]'))!;
        const cta = (await rect(page, CTA))!;
        const nodes = await nodeBoxes(page);
        expect(nodes.length).toBeGreaterThan(0);
        expect(nodes.filter((n) => overlaps(n, toast)), `scrolled to ${at}`).toEqual([]);
        expect(overlaps(toast, cta)).toBe(false);
        expect(toast.top).toBeGreaterThanOrEqual(cta.bottom);
        // Known trade-off: with the interface shown it is seen only near the end of the page (the
        // status region still says it); pinned to the window it would cover nodes or the link.
        if (at === 'top') expect(inSight(toast)).toBe(0);
        else expect(inSight(toast)).toBeGreaterThan(0.99);
      }
    });

    test('over a hidden interface it is pinned to the window, in sight at the top of the page', async ({ page }) => {
      await openApp(page);
      await settle(page);
      // Where its room is at the end of the page.
      await scrollShell(page, 0);
      await page.keyboard.press('v');
      await freeze(page);
      const atEnd = (await rect(page, '[data-toast]'))!;
      await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
      await scrollShell(page, 'top');
      await page.keyboard.press('h');
      await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
      await page.keyboard.press('p');
      await expect(plate(page)).toHaveCount(1);
      await freeze(page);
      const pinned = (await rect(page, '[data-toast]'))!;
      expect(Math.abs(pinned.top - atEnd.top)).toBeLessThan(0.5);
      expect(Math.abs(pinned.bottom - atEnd.bottom)).toBeLessThan(0.5);
      expect(pinned.bottom).toBeLessThanOrEqual(330);
      await expect(page.locator('html')).toHaveAttribute('data-ui', 'hidden');
    });
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`axe: no serious or critical findings with a toast showing, readable ≥ 4.5:1 (${theme})`, { tag: '@a11y' }, async ({ page }) => {
      await openApp(page, { theme });
      await settle(page);
      await holdToastsDuring(page, async () => {
        await page.keyboard.press('v');
        await expect(plate(page)).toHaveCount(1);
      });
      await freeze(page);
      const { plates, label, cap } = await inks(page);
      for (const p of plates) {
        expect(contrast(label, p)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(cap, p)).toBeGreaterThanOrEqual(4.5);
      }
      const found = await seriousFindings(page);
      expect(found, found.join('\n')).toEqual([]);
      await expect(plate(page)).toHaveCount(1); // axe saw it the whole time
    });
  }

  test('reduced motion: no movement, only short fades', { tag: '@a11y' }, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await settle(page);
    await page.keyboard.press('v');
    await expect(plate(page)).toHaveCount(1);
    const anims = await plate(page).evaluate((el) =>
      el.getAnimations().map((a) => {
        const effect = a.effect as KeyframeEffect;
        return { keyframes: effect.getKeyframes(), duration: Number(effect.getTiming().duration) };
      }),
    );
    expect(anims.length).toBeGreaterThan(0);
    for (const { keyframes, duration } of anims) {
      for (const k of keyframes) {
        expect(Object.keys(k).filter((p) => ['transform', 'translate', 'scale', 'rotate'].includes(p))).toEqual([]);
      }
      // Short fades: fading in and out take a small part of its life, the rest it holds still.
      const offsets = keyframes.map((k) => Number(k.computedOffset));
      const first = offsets.find((o) => o > 0)!;
      const last = offsets[offsets.length - 2];
      expect(duration).toBeGreaterThan(0);
      expect(first + (1 - last)).toBeLessThan(0.5);
    }
  });

  test('K with the keys off keeps its cap; the other toasts lose theirs', async ({ page }) => {
    await openApp(page);
    await settle(page);
    await page.keyboard.press('k');
    expect(await shown(page)).toEqual({ text: 'SHORTCUTS OFF', cap: 'K' });
    await page.getByRole('button', { name: 'Display options' }).click();
    await page.getByRole('button', { name: 'Sound' }).click();
    await expect.poll(async () => (await shown(page)).text).toBe('SOUND ON');
    expect((await shown(page)).cap).toBeNull();
  });

  test("D and the Contact screen's Download CV button confirm the PDF download; T, C and H show nothing", async ({ page }) => {
    await openApp(page);
    await settle(page);
    for (const key of ['t', 'c', 'c', 't']) {
      await page.keyboard.press(key);
      await expect(plate(page)).toHaveCount(0);
    }
    let download = page.waitForEvent('download');
    await page.keyboard.press('d');
    await download;
    expect(await shown(page)).toEqual({ text: 'DOWNLOADING CV', cap: 'D' });
    await expect(status(page)).toHaveText('Downloading CV');
    await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
    await dispatch(page, { t: 'tab/set', screen: 'contact' });
    download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download CV' }).click();
    await download;
    expect((await shown(page)).text).toBe('DOWNLOADING CV');
    await expect(plate(page)).toHaveCount(0, { timeout: 5000 });
    await page.keyboard.press('h');
    await expect(plate(page)).toHaveCount(0);
  });

  test('every D is said again: each press changes the status region, the first to the words alone', async ({ page }) => {
    await openApp(page);
    await settle(page);
    // A polite region is read only when its content changes: its text after each change.
    await status(page).evaluate((el) => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      new MutationObserver(() => w.__said.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const said = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said.slice());
    for (let i = 1; i <= 3; i++) {
      await Promise.all([page.waitForEvent('download'), page.keyboard.press('d')]);
      await expect.poll(async () => (await said()).length, { message: `D #${i} changes the status region` }).toBe(i);
    }
    // Compared as is (toHaveText would let a trailing no-break space pass): a repeat is marked by one.
    expect(await said()).toEqual(['Downloading CV', 'Downloading CV\u00A0', 'Downloading CV']);
  });
});
