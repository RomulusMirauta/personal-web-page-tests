# Playwright E2E suite for a portfolio app

<p><br><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fromulus-mirauta.goatcounter.com%2Fcounter%2FTOTAL.json%3Fstart%3Dweek&amp;query=%24.count&amp;label=Views%20per%20week&amp;color=1f6f5c&amp;labelColor=232826&amp;cacheSeconds=600" alt="Views per week" width="174"> <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fromulus-mirauta.goatcounter.com%2Fcounter%2FTOTAL.json%3Fstart%3Dmonth&amp;query=%24.count&amp;label=per%20month&amp;color=1f6f5c&amp;labelColor=232826&amp;cacheSeconds=600" alt="per month" width="130"> <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fromulus-mirauta.goatcounter.com%2Fcounter%2FTOTAL.json%3Fstart%3Dyear&amp;query=%24.count&amp;label=per%20year&amp;color=1f6f5c&amp;labelColor=232826&amp;cacheSeconds=600" alt="per year" width="116"> <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fromulus-mirauta.goatcounter.com%2Fcounter%2FTOTAL.json&amp;query=%24.count&amp;label=total&amp;color=1f6f5c&amp;labelColor=232826&amp;cacheSeconds=600" alt="total" width="84"><br><br></p>

Black-box end-to-end tests for my portfolio app, **[romulus-mirauta.vercel.app](https://romulus-mirauta.vercel.app)**:
an animated, keyboard-first "business card" whose landing page is a radial skill wheel, with Profile, Contact,
QA Lab, Experience, Education and Projects screens and a printable, no-JavaScript `/cv/` page.

The app's source is private. This repository is the **E2E layer** of its test suite, ported so that it runs
against the production URL on its own, without any application code. It runs every day in GitHub Actions.

| | |
|---|---|
| Tests | **444** Playwright tests in 49 spec files (385 desktop, 59 phone) + 31 unit tests |
| Run time | ~3 min for the full suite against production locally on 8 workers; ~4 min on CI (4 shards) |
| Browsers | Chromium desktop 1920×1080 · Chromium phone 411×776 @ DPR 2.625, touch |
| Tiers | `@smoke` 12 · `@critical` 67 · `@a11y` 122 · `@mobile` 40 |

## The full suite (private repo), in numbers

| Layer | Size | What it covers |
|---|---|---|
| Unit / component (Vitest) | ~1,350 tests | pure layout and state logic, content validation, components in jsdom |
| E2E (Playwright) | ~650 test runs | user journeys on the static build, white-box helpers included; **this repo is a black-box port of most of them, running against production** |
| Verification gates | 9 gates | build-level checks no single test can make (below) |

The nine gates of the verification harness, one line each:

1. **Build**: two clean builds, output scan, lint, typecheck, unit and E2E suites.
2. **Geometry**: the rendered layout matches its specification within tolerances; every target ≥ 24 px.
3. **Background**: the animated background stays within its brightness band behind the UI.
4. **Motion**: transition timing curves match the motion specification; no frame jumps.
5. **Smoothness**: frame-time and long-animation-frame budgets at 60 Hz and with a 4× CPU slowdown.
6. **Accessibility**: axe with no serious/critical issue on every screen, keyboard-only flow, reduced motion, `/cv/` without JS.
7. **Lighthouse**: median of 3 runs; performance ≥ 90, the other categories at 100.
8. **Legal / privacy**: no third-party names or assets shipped, no phone number anywhere.
9. **Content**: schema validation, CV coverage, content budget.

## Test strategy, in short

- **Pyramid.** Most logic is proven by fast unit tests; E2E covers what only a real browser shows:
  focus, history, layout, touch, print, CSP, accessibility.
- **Risk-based CI tiers.** `@smoke` + `@critical` on every push and pull request (~1 min). The full suite
  before every production deploy (private repo) and on a daily schedule against production (here).
- **Parallel by default.** Tests are independent (`fullyParallel`) and use every CPU thread locally; CI shards
  the full suite over 4 runners and merges one HTML report.
- **Deterministic animation.** The production build ships a tiny test-hook API, active only with `?test=1`.
  It exposes the app state and a **manual animation clock**, so a test runs a transition to its end in one
  call instead of sleeping, and waits on state instead of time.
- **No flaky tests.** Before it was added here, every spec passed 3 repeated local runs on 8 workers. A flaky test gets
  fixed or dropped. CI retries once, and Playwright reports the retry as *flaky*, so it is visible.
- **Content-robust.** Section order, categories and skills are read from the live page, so a content update
  does not break the suite.
- **No analytics pollution.** Every browser context blocks the analytics hosts (`e2e/support/test.ts`), so
  test runs never count as visits.

More detail: [docs/test-strategy.md](docs/test-strategy.md).

## What is tested

| Area | Specs |
|---|---|
| Smoke and core journeys | `smoke`, `intro`, `keyboard`, `history`, `history-origin`, `back-stays`, `chips` |
| Accessibility | `a11y`, `a11y-matrix` (themes × key modes × laptop sizes), `wheel-a11y`, `focus-order`, `focus-return`, `naming`, `screen-names`, `reduced-motion`, `light-theme`, `text-floors` |
| Screens and widgets | `contact-education`, `experience`, `projects`, `detail`, `spec-card`, `player-card`, `also-used`, `menu`, `controls`, `toasts`, `hidden-ui`, `prefs`, `theme-live` |
| Pointer and touch | `pointer-intent`, `hub-aim`, `hints`, `scroll-input`, `scroll-areas`, `mobile`, `mobile-polish` |
| Layout fit | `fit`, `screens-fit`, `line-breaks`, `header`, `header-dots`, `design-rules` |
| CV, security, privacy | `cv`, `cv-nojs`, `cv-print`, `csp`, `not-found`, `privacy` |

## Run it

```bash
npm ci
npx playwright install chromium

npm test                       # full suite against production
npm run test:smoke             # @smoke only
npm run test:critical          # @smoke + @critical (the CI tier for pushes)
npm run test:a11y              # accessibility checks
npm run test:unit              # unit tests of the suite's own helpers (no browser)
npx playwright test --project=phone-chromium
BASE_URL=https://<preview>.vercel.app npm test   # any other deployment
npm run report                 # open the last HTML report
```

## Structure

```
playwright.config.ts      projects, tiers, reporters, traces on failure, retries on CI only
e2e/support/test.ts       the suite's test(): blocks analytics in every context
e2e/support/app.ts        openApp / dispatch / settle, roles-first locators, hash-route helpers
e2e/support/types.ts      local types of the test-hook API (no app code imported)
e2e/support/axe.ts        axe scan: serious + critical, required rules, known-finding allow-list
e2e/support/privacy.ts    phone-number pattern used by the privacy specs
e2e/support/png.ts        tiny PNG decoder for pixel checks on screenshots
e2e/*.spec.ts             the specs
unit/                     unit tests of the helpers (the privacy pattern's corpus)
.github/workflows/e2e.yml smoke on push/PR, full suite daily (sharded), HTML report artifact
```

Projects: `desktop-chromium` runs everything except `@mobile`; `phone-chromium` runs `@mobile` plus the
device-independent `@all-devices` checks. The phone viewport is the space a real phone browser leaves for
the page (with its address and navigation bars), not the full screen size.

## License

The test code is MIT-licensed (see [LICENSE](LICENSE)). The app under test, its content and its design
are **not** covered by that license and are not part of this repository.
