import type { Page } from '@playwright/test';
import { appState, arcPoint, categoryIds, dispatch, expectMode, openApp, screenOrder, sectionNames, settle } from './support/app';
import { decode } from './support/png';
import { expect, newContext, test } from './support/test';

/**
 * The header's page dots: one per section (per category in the detail view), each a named button
 * that takes the pointer straight there. They are not Tab stops (Q and E cover the keyboard), the
 * current one follows the screen, they never overlap the title, and where a dot would be smaller
 * than a 24 px target they are drawn only, without a button.
 */
const dots = (page: Page) => page.locator('header[data-hud] ol li');
const dotButton = (page: Page, i: number) => dots(page).nth(i).getByRole('button');

/** Index of the dot marked current. */
const activeDot = (page: Page) => dots(page).evaluateAll((els) => els.findIndex((el) => el.hasAttribute('data-active')));

test.describe('header dots', () => {
  test('one named dot per section; a dot click goes there', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const screens = await screenOrder(page);
    const names = await sectionNames(page);
    await expect(dots(page)).toHaveCount(screens.length);
    for (const [i, name] of names.entries()) {
      expect(name, `dot ${i + 1} has a name`).toBeTruthy();
      await expect(dotButton(page, i)).toHaveAccessibleName(name);
      await expect(dotButton(page, i)).toHaveAttribute('tabindex', '-1');
    }
    const start = screens.indexOf('skills');
    await expect(dotButton(page, start)).toHaveAttribute('aria-current', 'true');

    for (const i of [0, screens.length - 1, start]) {
      await dotButton(page, i).click();
      await expect.poll(async () => (await appState(page)).screen).toBe(screens[i]);
      // Skills is the home screen: its URL may carry no hash at all.
      await expect(page).toHaveURL(screens[i] === 'skills' ? /^[^#]*(#\/skills)?$/ : new RegExp(`#/${screens[i]}$`));
      await expect(dots(page).nth(i)).toHaveAttribute('data-active', '');
      await expect(dotButton(page, i)).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('header[data-hud] ol [aria-current="true"]')).toHaveCount(1);
    }
  });

  test('in the detail view: one dot per category; a dot opens its category', { tag: '@critical' }, async ({ page }) => {
    await openApp(page);
    const cats = await categoryIds(page);
    await dispatch(page, { t: 'cat/open', cat: cats[0] });
    await expect(dots(page)).toHaveCount(cats.length);
    const target = cats.length - 1;
    // Named after its category: the title it leads to.
    const name = await dotButton(page, target).getAttribute('title');
    expect(name).toBeTruthy();
    await dotButton(page, target).click();
    await expectMode(page, 'detail', cats[target]);
    await expect(page.locator('header[data-hud] h2')).toHaveText(name!);
    await expect(page).toHaveURL(new RegExp(`#/skills/${cats[target]}/`));
    await expect(dotButton(page, target)).toHaveAttribute('aria-current', 'true');
  });

  test('the current dot follows the screen through Q / E, wrapping around', async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    const n = screens.length;
    let i = screens.indexOf('skills');
    expect(await activeDot(page)).toBe(i);
    for (let step = 0; step < n; step++) {
      await page.keyboard.press('e');
      i = (i + 1) % n;
      await expect.poll(async () => (await appState(page)).screen).toBe(screens[i]);
      await expect.poll(() => activeDot(page)).toBe(i);
    }
    await page.keyboard.press('q');
    i = (i - 1 + n) % n;
    await expect.poll(() => activeDot(page)).toBe(i);
  });

  test('the dots are not Tab stops', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inDots = await page.evaluate(() => Boolean(document.activeElement?.closest('header[data-hud] ol')));
      expect(inDots, `Tab stop ${i + 1}`).toBe(false);
    }
  });

  test('at rest the dots form one evenly spaced row, centred over the title and clear of it', async ({ page }) => {
    await openApp(page);
    await settle(page);
    const { boxes, title } = await page.evaluate(() => ({
      boxes: [...document.querySelectorAll('header[data-hud] ol li')].map((li) => li.getBoundingClientRect().toJSON() as DOMRect),
      title: document.querySelector('header[data-hud] h2')!.getBoundingClientRect().toJSON() as DOMRect,
    }));
    expect(boxes.length).toBeGreaterThan(1);
    const cx = boxes.map((b) => b.left + b.width / 2);
    const cy = boxes.map((b) => b.top + b.height / 2);
    for (const y of cy) expect(Math.abs(y - cy[0]), 'one row').toBeLessThanOrEqual(0.5);
    const step = cx[1] - cx[0];
    expect(step).toBeGreaterThan(0);
    for (let i = 1; i < cx.length; i++) expect(Math.abs(cx[i] - cx[i - 1] - step), `even spacing at dot ${i + 1}`).toBeLessThanOrEqual(0.5);
    const rowCentre = (cx[0] + cx.at(-1)!) / 2;
    expect(Math.abs(rowCentre - (title.left + title.right) / 2), 'row centred over the title').toBeLessThanOrEqual(1);
    expect(Math.max(...boxes.map((b) => b.bottom)), 'the row ends above the title').toBeLessThanOrEqual(title.top + 0.5);
  });

  test('a clicked dot keeps no focus: Enter on a hovered category opens it, and Esc never lands on a dot', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    const screens = await screenOrder(page);
    const skills = screens.indexOf('skills');
    for (const from of screens.filter((s) => s !== 'skills').slice(0, 2)) {
      await dispatch(page, { t: 'tab/set', screen: from });
      await settle(page);
      await dotButton(page, skills).click();
      await expect.poll(async () => (await appState(page)).screen).toBe('skills');
      await settle(page);
      const inDots = () => page.evaluate(() => Boolean(document.activeElement?.closest('header[data-hud] ol')));
      expect(await inDots(), `from ${from}: the clicked dot took focus`).toBe(false);
      const [cat] = await categoryIds(page);
      const p = await arcPoint(page, cat);
      await page.mouse.move(p.x, p.y, { steps: 4 });
      await expectMode(page, 'hover', cat);
      await page.keyboard.press('Enter');
      await expectMode(page, 'detail', cat);
      await settle(page);
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await appState(page)).mode.kind).not.toBe('detail');
      expect(await inDots(), `from ${from}: focus after Esc`).toBe(false);
      await page.mouse.move(5, 540);
    }
  });

  test('each dot is announced once in Chromium: its title is the name, no description repeats it', { tag: '@a11y' }, async ({ page }) => {
    await openApp(page);
    await settle(page);
    const names = await sectionNames(page);
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'header[data-hud] ol button' });
    const read: { role: string; name: string; description: string }[] = [];
    for (const nodeId of nodeIds) {
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const n = nodes[0];
      read.push({ role: String(n.role?.value), name: String(n.name?.value ?? ''), description: String(n.description?.value ?? '') });
    }
    await cdp.detach();
    expect(read).toEqual(names.map((name) => ({ role: 'button', name, description: '' })));
  });

  test('under forced colours every dot paints, the current one in Highlight', { tag: '@a11y' }, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    for (const theme of ['dark', 'light'] as const) {
      await openApp(page, { theme });
      await settle(page);
      const { dots: centres, colours } = await page.evaluate(() => {
        const rgba = (c: string) => {
          const [r, g, b, a = 1] = (c.match(/[\d.]+/g) ?? []).map(Number);
          return [r, g, b, a];
        };
        // Resolved where the dots are drawn (their colour scheme picks the palette's side).
        const probe = document.createElement('span');
        document.querySelector('header[data-hud] ol li')!.append(probe);
        const system = (c: string) => {
          probe.style.color = c;
          return rgba(getComputedStyle(probe).color);
        };
        // A system colour may resolve translucent: Linux Chromium's forced-colours Highlight is
        // rgba(0, 230, 255, 0.8), painted over Canvas. Windows' palette is opaque.
        const canvas = system('Canvas').slice(0, 3);
        const painted = (c: string) => {
          const [r, g, b, a] = system(c);
          return [r, g, b].map((v, k) => Math.round(v * a + canvas[k] * (1 - a)));
        };
        const colours = { text: painted('CanvasText'), highlight: painted('Highlight') };
        probe.remove();
        return {
          colours,
          dots: [...document.querySelectorAll('header[data-hud] ol li')].map((li) => {
            const r = li.getBoundingClientRect();
            return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, active: li.hasAttribute('data-active') };
          }),
        };
      });
      const shot = decode(await page.screenshot());
      const px = (x: number, y: number) => {
        const i = (Math.round(y) * shot.width + Math.round(x)) * 4;
        return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
      };
      const near = (a: number[], b: number[]) => a.every((v, k) => Math.abs(v - b[k]) <= 8);
      for (const [i, dot] of centres.entries()) {
        const fill = px(dot.x, dot.y);
        expect(near(fill, dot.active ? colours.highlight : colours.text), `${theme}: dot ${i + 1} fill ${fill}`).toBe(true);
      }
    }
  });

  test('dots are 24 px targets, or drawn only (no button) where they would be smaller', { tag: ['@a11y', '@all-devices'] }, async ({ page }) => {
    const check = async (what: string) => {
      await openApp(page);
      await settle(page);
      const r = await page.evaluate(() => {
        const ol = document.querySelector('header[data-hud] ol')!;
        return {
          items: ol.querySelectorAll('li').length,
          hidden: ol.getAttribute('aria-hidden'),
          buttons: [...ol.querySelectorAll('button')].map((b) => {
            const box = b.getBoundingClientRect();
            return Math.min(box.width, box.height);
          }),
        };
      });
      expect(r.items, `${what}: dots drawn`).toBeGreaterThan(1);
      if (r.buttons.length === 0) {
        expect(r.hidden, `${what}: drawn-only dots are hidden from assistive tech`).toBe('true');
      } else {
        expect(r.buttons.length, `${what}: every dot is a button`).toBe(r.items);
        for (const size of r.buttons) expect(size, `${what}: dot target size (WCAG 2.5.8)`).toBeGreaterThanOrEqual(24);
      }
      return r.buttons.length > 0;
    };
    await check('as opened');
    // On the desktop, also a laptop window, where the stage is smaller.
    if (!test.info().project.use.isMobile) {
      await page.setViewportSize({ width: 1366, height: 768 });
      await check('1366×768');
      await page.setViewportSize({ width: 1920, height: 1080 });
      expect(await check('back at 1920×1080'), 'buttons again at full size').toBe(true);
    }
  });
});

test.describe('dots clear the title at 250 % and 300 % zoom', { tag: '@a11y' }, () => {
  // A 1920×1080 window at 250 % / 300 % browser zoom.
  for (const z of [
    { zoom: 250, width: 768, height: 432 },
    { zoom: 300, width: 640, height: 360 },
  ]) {
    test(`at ${z.zoom} %`, async ({ browser }) => {
      const context = await newContext(browser, { viewport: { width: z.width, height: z.height }, deviceScaleFactor: z.zoom / 100 });
      try {
        const page = await context.newPage();
        await openApp(page);
        await page.evaluate(() => document.fonts.ready);
        const screens = await screenOrder(page);
        const [, third] = await categoryIds(page);
        const views = [
          ...screens.map((screen) => ({ name: screen, actions: [{ t: 'tab/set' as const, screen }] })),
          { name: 'detail', actions: [{ t: 'tab/set' as const, screen: 'skills' }, { t: 'cat/open' as const, cat: third }] },
        ];
        for (const v of views) {
          await dispatch(page, ...v.actions);
          const { dotsBottom, titleTop } = await page.evaluate(() => {
            const lis = [...document.querySelectorAll('header[data-hud] ol li')].map((li) => li.getBoundingClientRect());
            return {
              dotsBottom: Math.max(...lis.map((r) => r.bottom)),
              titleTop: document.querySelector('header[data-hud] h2')!.getBoundingClientRect().top,
            };
          });
          expect(titleTop - dotsBottom, `${v.name}: dots bottom ${dotsBottom.toFixed(2)} vs title top ${titleTop.toFixed(2)}`).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await context.close();
      }
    });
  }
});
