import type { Page } from '@playwright/test';
import { appState, categoryIds, openApp, settle } from './support/app';
import { expect, test } from './support/test';

/**
 * Scrolling input. A touchpad flick keeps sending ever smaller wheel deltas after the finger lifts:
 * the whole flick steps one category, on the hub and over the detail text, while a new flick (once
 * the finger stopped the last one) and every mouse notch step again, and a flick the other way
 * steps back once. Off the wheel, Space pages the screen down and Shift + Space up, as on any web
 * page, and a focused control keeps its Space.
 *
 * Each synthetic event carries the time it was scheduled for, as a device stamps its events: on a
 * busy runner a late timer only delivers it late, as a busy main thread does with real input. The
 * wheel tests also run with the CPU slowed down three times (Chromium's DevTools throttling).
 */

/** A wheel delta (px) and the ms until the next one. */
type Wheel = [delta: number, gapMs: number];

/** A touchpad flick's deltas, one per 16 ms frame, decaying by `k` per frame. */
function flick(v0: number, k: number): Wheel[] {
  const events: Wheel[] = [];
  for (let v = v0; v >= 1; v *= k) events.push([Math.round(v), 16]);
  return events;
}
/** The same deltas `everyMs` apart (mouse notches). */
const notches = (deltas: number[], everyMs: number): Wheel[] => deltas.map((d) => [d, everyMs]);
/** The stream's first `ms` (the finger lands again and stops the momentum), then `gapMs` without events. */
function cut(events: Wheel[], ms: number, gapMs: number): Wheel[] {
  const kept = events.slice(0, Math.max(1, Math.floor(ms / 16)));
  kept[kept.length - 1] = [kept[kept.length - 1][0], gapMs];
  return kept;
}

/** Dispatches a vertical wheel stream in real time at a point; resolves to the number of category steps it caused. */
function wheelSteps(page: Page, events: Wheel[], at: { x: number; y: number }): Promise<number> {
  return page.evaluate(
    async ({ events, at }) => {
      const target = document.elementFromPoint(at.x, at.y)!;
      const cat = () => {
        const m = window.__site!.getState().mode;
        return m.kind === 'idle' ? null : m.cat;
      };
      let last = cat();
      let steps = 0;
      let stamp = performance.now();
      for (const [deltaY, gapMs] of events) {
        const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
        Object.defineProperty(e, 'timeStamp', { value: stamp });
        stamp += gapMs;
        target.dispatchEvent(e);
        await new Promise((r) => setTimeout(r, gapMs)); // the stream's own timing (input), not a wait
        if (cat() !== last) {
          steps++;
          last = cat();
        }
      }
      return steps;
    },
    { events, at },
  );
}

/** A smooth-scrolling wheel's detents, `everyMs` apart: a burst of eight small deltas 12 ms apart each. */
function detents(n: number, everyMs: number): Wheel[] {
  const detent: Wheel[] = [...Array<Wheel>(7).fill([12.5, 12]), [12.5, everyMs - 7 * 12]];
  return Array.from({ length: n }, () => detent).flat();
}
/** Flicks one every 600 ms, each new touch stopping the last one's momentum 80 ms before the next. */
const series = (flicks: Wheel[][]): Wheel[] =>
  flicks.flatMap((f, i) => (i < flicks.length - 1 ? cut(f, 520, 600 - (Math.floor(520 / 16) - 1) * 16) : f));

/** The pause between two flicks or bursts: input timing (the next one is a new gesture), not a wait. */
const GESTURE_PAUSE_MS = 400;

/** The detail panel's build-in is over: the engine has settled and no animation runs in the panel. */
async function panelBuiltIn(page: Page): Promise<void> {
  await page.evaluate(() => window.__wheel!.settle());
  await expect
    .poll(
      () =>
        page
          .locator('[data-detail-panel]')
          .first()
          .evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length),
      { message: "the panel's build-in has finished", intervals: [25] },
    )
    .toBe(0);
}

/** Opens the app with the CPU slowed down `rate` times (1: full speed); returns a point on the hub. */
async function openAt(page: Page, rate: number): Promise<{ x: number; y: number }> {
  await openApp(page);
  await settle(page);
  // The engine's clock back on real frames: the wheel input below runs in real time.
  await page.evaluate(() => window.__wheel!.manual(false));
  if (rate > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
  // The ring's centre, on screen.
  return page.evaluate(() => {
    const g = window.__wheel!.geometry();
    const m = (document.querySelector('svg[data-active]') as SVGSVGElement).getScreenCTM()!;
    return { x: m.a * g.center.x + m.e, y: m.d * g.center.y + m.f };
  });
}

for (const rate of [1, 3]) {
  test.describe(`wheel: one flick, one step${rate > 1 ? ` (CPU x${rate})` : ''}`, () => {
    if (rate > 1) test.slow();

    test('a touchpad flick steps one category however long its momentum runs; every mouse notch steps', async ({ page }) => {
      const hub = await openAt(page, rate);
      expect(await wheelSteps(page, flick(20, 0.9), hub)).toBe(1);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing: the next flick is a new gesture
      expect(await wheelSteps(page, flick(40, 0.93), hub)).toBe(1);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, flick(80, 0.95), hub)).toBe(1);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // Mouse notches 280 or 300 ms apart: one step each, also when they shrink as the wheel slows.
      expect(await wheelSteps(page, notches([100, 100, 100], 300), hub)).toBe(3);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, notches([120, 100, 80, 60], 280), hub)).toBe(4);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // A smooth-scrolling wheel sends each detent as a burst of small deltas: one step per detent.
      expect(await wheelSteps(page, detents(4, 300), hub)).toBe(4);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, detents(4, 220), hub)).toBe(4);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // A fast spin (a notch every 40 ms) is rate-limited, but steps more than once.
      const spin = await wheelSteps(page, notches(Array<number>(12).fill(100), 40), hub);
      expect(spin).toBeGreaterThanOrEqual(2);
      expect(spin).toBeLessThan(12);

      // Over the detail view's description text (it fits, so the wheel steps the categories there).
      const [first] = await categoryIds(page);
      await page.evaluate((cat) => window.__site!.dispatch({ t: 'cat/open', cat }), first);
      const text = page.locator('[data-detail-panel] h3 ~ p').last();
      await expect(text).toBeVisible();
      await panelBuiltIn(page);
      const box = (await text.boundingBox())!;
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, flick(40, 0.93), at)).toBe(1);
      await panelBuiltIn(page); // the step opened the next category, whose panel builds in
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, flick(80, 0.95), at)).toBe(1);
      expect((await appState(page)).mode.kind).toBe('detail');
    });

    test('a new flick steps again once the finger stopped the last one, even a weaker one; one the other way steps back once', async ({ page }) => {
      const hub = await openAt(page, rate);
      // A strong flick, then five normal ones; then six flicks of falling strength.
      expect(await wheelSteps(page, series([flick(80, 0.95), ...Array.from({ length: 5 }, () => flick(40, 0.93))]), hub)).toBe(6);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      expect(await wheelSteps(page, series([60, 55, 50, 45, 40, 35].map((v0) => flick(v0, 0.95))), hub)).toBe(6);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // 500 ms into a strong flick, the finger lands again (80 ms without events) and flicks at 90 %.
      expect(await wheelSteps(page, [...cut(flick(80, 0.95), 500, 80), ...flick(72, 0.95)], hub)).toBe(2);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // The whole tail of a strong flick, 200 ms of stillness, a normal flick.
      const tail = flick(80, 0.95);
      tail[tail.length - 1] = [tail[tail.length - 1][0], 200];
      expect(await wheelSteps(page, [...tail, ...flick(40, 0.93)], hub)).toBe(2);
      await page.waitForTimeout(GESTURE_PAUSE_MS); // input timing
      // 320 ms into a strong flick, the finger lands (40 ms without events) and flicks the other way:
      // one step each way, the second flick's own momentum is no new push.
      const back = flick(60, 0.95).map(([d, gapMs]): Wheel => [-d, gapMs]);
      expect(await wheelSteps(page, [...cut(flick(80, 0.95), 320, 40), ...back], hub)).toBe(2);
    });
  });
}

test.describe('keyboard: Space off the wheel', () => {
  test('Space pages the screen down and Shift + Space up, like PageDown / PageUp; a focused chip keeps its Space', { tag: '@a11y' }, async ({ page }) => {
    // A small landscape window: the Experience timeline (the screen's primary region) overflows.
    await page.setViewportSize({ width: 1024, height: 576 });
    await openApp(page);
    await page.keyboard.press('e');
    await expect(page).toHaveURL(/#\/experience$/);
    const timeline = page.locator('main [data-scroll][data-scroll-primary]');
    await expect(timeline).toHaveAttribute('data-scrollable', '');
    // The section key leaves focus on no control, so Space is the page's.
    expect(await page.evaluate(() => document.activeElement?.closest('button, a, input, [role="button"]') ?? null)).toBeNull();

    const top = () => timeline.evaluate((el) => el.scrollTop);
    /** scrollTop once the (smooth) scroll has stopped: unchanged for 10 frames in a row. */
    const settledTop = () =>
      timeline.evaluate(
        (el) =>
          new Promise<number>((resolve) => {
            let last = el.scrollTop;
            let still = 0;
            const tick = () => {
              if (el.scrollTop === last) still++;
              else [last, still] = [el.scrollTop, 0];
              if (still >= 10) resolve(last);
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    await page.keyboard.press('PageDown');
    await expect.poll(top).toBeGreaterThan(0);
    const paged = await settledTop();
    await page.keyboard.press('Home');
    await expect.poll(top).toBe(0);

    await page.keyboard.press('Space');
    await expect.poll(top).toBe(paged);
    await page.keyboard.press('Shift+Space');
    await expect.poll(top).toBe(0);
    expect((await appState(page)).screen).toBe('experience');

    // A focused skill chip keeps Space: it opens that skill on the wheel instead of scrolling.
    const chip = timeline.locator('a[href^="#/skills/"]').first();
    await chip.focus();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await appState(page)).mode.kind).toBe('detail');
    expect((await appState(page)).screen).toBe('skills');
  });
});
