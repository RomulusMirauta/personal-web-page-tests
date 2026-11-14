# Test strategy

This document describes how the portfolio app is tested and where this repository fits in. The app is a
static web app (Next.js static export, React, TypeScript, a three.js background in a Web Worker). It has no
backend, so the risk is in what the browser does: animation, input, focus, layout across devices,
accessibility, print, and what the build ships.

## 1. Risks first

| Risk | Why it matters | Where it is caught |
|---|---|---|
| A visitor cannot navigate (keyboard, pointer, touch, Back) | the app is the CV; a dead end loses the reader | unit tests of the state reducer and key map; E2E journeys (`keyboard`, `history`, `back-stays`, `mobile`) |
| Focus gets lost or trapped | keyboard and screen-reader users | E2E `focus-order`, `focus-return`, `menu`, `controls` |
| Accessibility regressions | WCAG 2.2 AA is a requirement, not a goal | axe on every view, in every theme and key mode (`a11y`, `a11y-matrix`), plus targeted checks: contrast, target size, text spacing, reduced motion, forced colours |
| Layout breaks on a device the author does not own | recruiters open links on phones and small laptops | relational layout checks at many viewports (`fit`, `screens-fit`, `text-floors`, `mobile*`) |
| The page jank or animates wrongly | the animation is the product's character | motion and smoothness gates in the private harness (frame-time budgets, CPU throttling) |
| Something ships that must not | personal data, third-party assets, a weakened CSP | privacy and CSP specs here; build-output scan in the private harness |
| `/cv/` fails without JavaScript or in print | ATS crawlers, printing, slow devices | `cv`, `cv-nojs`, `cv-print` |

## 2. The pyramid

- **~1,225 unit and component tests (Vitest).** Layout maths, the state reducer and URL routes, the key map,
  content validation (strict schemas, the privacy pattern), components in jsdom. Fast and exhaustive.
- **~319 E2E tests (Playwright)** on the static build, of which this repository is the black-box subset
  that runs against production.
- **9 verification gates**, which check whole-build properties: two reproducible builds, layout geometry,
  background brightness, motion curves, frame-time smoothness, accessibility, Lighthouse (median of 3),
  legal/privacy scan of the output, and content coverage. The harness is self-tested with **planted
  defects**: it must fail on a build that is deliberately broken in a known way (a jump in an animation,
  linear easing, noise, jank, a console error), which proves the gates can actually fail.

## 3. CI tiers (deployment pipeline)

| Stage | Trigger | What runs | Budget |
|---|---|---|---|
| Commit | every push / PR | typecheck, unit tests, `@smoke` + `@critical` E2E | minutes |
| Acceptance | before a production deploy | full unit + E2E suite, all CPU threads | tens of minutes |
| Quality gates | before a release | the 9 gates (a11y, Lighthouse, smoothness, legal/privacy …) | longer |
| Production monitoring | daily schedule (this repo) | full black-box suite against the live URL, sharded | ~5 min |

In this repository `.github/workflows/e2e.yml` implements the commit tier (smoke + critical on push/PR) and
the daily production run (the full suite on 4 shards, merged into one HTML report, optionally published to
GitHub Pages). The workflow token is read-only (`permissions: contents: read`).

## 4. Making an animated app testable

The app animates nearly every state change, which is the classic source of flaky E2E tests. Instead of
sleeps and retries, the app was built to be testable:

- **A test-hook API in the production build**, installed only with `?test=1`. It exposes the app state
  (`__site.getState()`), lets a test dispatch the same intents keys and pointers produce, and exposes the
  animation engine's clock (`__wheel.manual()`, `settle()`). A test can freeze time, run every running
  transition to its end in one call, then assert on a resting page. The build under test is the build
  that is deployed; there is no special test build.
- **Deterministic flags**: a fixed random seed for the procedural background, a static poster instead of
  the live 3D scene, the intro skipped, sound and custom cursor off.
- **Wait on state, not on time.** `expect.poll` on app state and web-first assertions. The few fixed waits
  left are input timing under test (e.g. two key presses 50 ms apart) or short negative windows ("this key
  must *not* do anything"), each commented.
- **URL settling**: the app writes its route to the URL and repairs a write the framework router reverts,
  so tests wait until the hash *holds still* on the expected value instead of reading it once.

## 5. Selectors and content robustness

- Roles and accessible names first (`getByRole`), a few data attributes second, kept in one place
  (`e2e/support/app.ts`).
- Nothing content-specific is hard-coded: the section order comes from the header, categories and skills
  from the app state, skill titles from the page. The suite survives a content update.
- Layout checks assert **relations**, not pixels: inside the viewport, no overlap, text above a 12 px
  floor, targets of at least 24 px (WCAG 2.5.8), a centred title, a line that does not end on a separator.
  Pixel-exact screenshot baselines exist in the private suite only, where the rendering environment is fixed.

## 6. Accessibility

- axe-core with WCAG 2.0/2.1/2.2 A and AA tags on every view: each screen, both wheels, a category's
  detail view, hover, menus, the intro, `/cv/`. Serious and critical results fail the test, including
  results axe leaves for review. Key rules must actually run (a rule that silently stops running would hide
  a regression). Known findings live in an allow-list that fails once the finding disappears.
- The same scan across the light and dark themes, keyboard-hint modes and laptop sizes (`a11y-matrix`).
- Beyond axe: focus order and focus return after every close, visible focus, accessible names vs visible
  labels, Chromium's own accessibility tree (over CDP), contrast computed from the rendered colours, text
  spacing (WCAG 1.4.12), forced colours, reduced motion, high zoom levels.

## 7. Privacy and security

- A **phone-number pattern** with an adversarial corpus (`unit/phone-pattern.spec.ts`): every spelling
  people use must match, and look-alikes in minified code and SVG path data must not. Every sample is
  built from zero digits at runtime, so no number is ever written into the repository.
- `privacy.spec.ts` applies it to the visible text, HTML, JSON-LD and vCard of every public page.
- `csp.spec.ts` checks the live Content-Security-Policy (header and meta): `default-src 'self'`,
  `object-src 'none'`, no `unsafe-eval`, only the expected analytics hosts, framing denied, and no
  policy violation while a visitor uses every screen.

## 8. Flakiness policy

- A new or changed spec must pass `--repeat-each=3` on 8 parallel workers before it is merged.
- Locally a failure is a failure (no retries). CI retries once, and the retry is reported as flaky.
- Traces, screenshots and videos are kept for every failure (`retain-on-failure`) and land in the HTML report.
- A flaky test is fixed or removed, never left in place.

## 9. What is not in this repository, and why

- Unit and component tests: they import the application's source.
- Pixel-baseline screenshot tests and GPU (WebGL) tests: they need a fixed rendering environment.
- The verification harness (motion, geometry and smoothness gates): it needs the build output and the
  design specification, which stay private.
