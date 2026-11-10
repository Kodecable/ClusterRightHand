# WebUI tests

The WebUI has a Vitest unit and component suite and four Playwright configurations. The suites
answer different questions:

| Suite | Config | Question it answers |
|---|---|---|
| `web/src/**/*.test.{ts,tsx}` | `web/vitest.config.ts` | Does this component or pure function behave? |
| `web/e2e` | `web/playwright.config.ts` | Does the real app work against the real server and a real node? |
| `web/e2e-mock` | `web/e2e-mock/playwright.config.ts` | Does the UI render, scroll and lay out correctly with scripted data? |
| `web/e2e-mock/perf` | `web/e2e-mock/perf/playwright.config.ts` | Did rendering performance regress? |
| `web/e2e-mock/review` | `web/e2e-mock/review/playwright.config.ts` | What do the pages look like in a visual review? (no assertions) |

## Unit and component tests

`web/vitest.config.ts` uses jsdom, the Lingui macro transform, the `@` alias and
`src/test/setup.ts`. `css: false` keeps Tailwind out of unit tests, and `restoreMocks` is on. The
suite covers pure logic (session state, list patches, formatting, quotas, URLs, task forms, schedule
forms, authorization helpers) and components with Testing Library (`task-result`, approval and
authorization cards, data table, dialogs, quota card, status badge, `SafeMarkdown`).

```bash
pnpm --filter @crh/web test
pnpm --filter @crh/web exec vitest run src/features/sessions/transcript-row.test.tsx
```

`pnpm --filter @crh/web test` runs Vitest and then `i18n:check`, which fails when a Chinese catalog
is missing a message. The PO files are the source of truth; the Lingui Vite plugin turns them into
runtime catalogs for the build, so no separate compile step runs before the tests.

## Real-backend end-to-end tests

`web/playwright.config.ts` runs `web/e2e` against an in-process crhs from
`server/test/e2e/harness.ts`, serving the built `web/dist`. `e2e/global-setup.ts` builds the WebUI
with `vite build` and `crha` with `go build` once per run; `e2e/fixtures.ts` starts the server and
logs a test administrator in. CI builds `web/dist` before this job, but the global setup builds it
again, so a local run does not need a separate build.

Options, set with `test.use({ ... })`:

- `withNode: true` — enroll, approve and connect a real `crha` child process.
- `withAgent: true` — run the agent runtime with the faux model; the test scripts its answers with
  `crhs.faux.setResponses`.
- `streamRate` — tokens per second for the faux stream, so a test can observe a running turn.

The suite covers login and logout, password change, deep links, enrollment and fingerprint approval,
running and cancelling tasks, batch execution, sessions with streaming and approvals, task pages, the
SSH wizard, sharing, the session list and history, legacy hash links, children, and schedules.
Selectors use `getByRole`, `getByLabel` and `getByText`, plus a few `getByTestId` hooks, not CSS.

```bash
pnpm test:ui
pnpm --filter @crh/web exec playwright test e2e/sessions.spec.ts
CRH_CHROMIUM=/usr/bin/chromium pnpm test:ui
```

The SSH wizard spec needs an sshd whose host key can be probed without authentication:

```bash
CRH_TEST_SSH_JUMP=127.0.0.1:52222 pnpm --filter @crh/web test:ui
```

Without it, the spec is skipped.

## Mock end-to-end tests

`web/e2e-mock/playwright.config.ts` builds the WebUI and serves it with `vite preview` on port 4173
through its `webServer` entry, so no prior build is needed. It intercepts `/api` through
`e2e-mock/helpers.ts`, so every page can be driven with controlled data. It covers pages the
real-backend suite does not re-check (audit filtering, tables on narrow screens, composer footer
measurements, the children tree, theme and language switching, keyboard navigation, scroll
behaviour) and the parts that are hard to make deterministic with a real server.

```bash
pnpm --filter @crh/web test:ui:mock
pnpm --filter @crh/web exec playwright test --config e2e-mock/playwright.config.ts e2e-mock/session-list.spec.ts
```

## WebUI performance

`web/e2e-mock/perf/playwright.config.ts` uses its own preview server on port 4174, one worker and a
30-minute timeout. It measures medians of three runs at 1× and 4× CPU throttling (CDP
`Emulation.setCPUThrottlingRate`): first render of a 100k-session list, scroll frame gaps, prepend
anchor drift over 20k messages, streaming at 300 and 1,500 characters per second, Stop latency, the
completion frame and main-thread busy time.

The targets these runs check are listed in
[WebUI design: Performance targets](../webui.md#performance-targets).

```bash
pnpm --filter @crh/web test:perf
PERF_RUNS=1 PERF_STREAM_SCALE=0.1 pnpm --filter @crh/web test:perf   # quick smoke run
```

`PERF_RUNS` sets the number of repetitions per metric and `PERF_STREAM_SCALE` scales the streamed
text; the full run uses 3 and 1. The current numbers and the definition of every metric are in
`web/e2e-mock/perf/RESULTS.md`; raw runs are in `results.json` next to it. This suite is not in CI
and is machine-dependent; treat it as a regression guard, not a gate.

Measured baseline against the mocked API (50 ms per response, Chromium, median of three runs):

| Metric | 1× | 4× |
|---|---|---|
| Entry JavaScript (gzip) | 136 kB | — |
| Session list, first render (strict timing) | 214 ms | 488 ms |
| 20k messages: drift when older history is prepended | 0.3 px | 0.3 px |
| Streaming 100K at 1,500 characters/s: Stop p95 | 2.9 ms | 8.7 ms |
| The same stream: frame at completion | 100 ms | 383 ms |

## Visual review screenshots

`web/e2e-mock/review/` renders the pages in four variants: light desktop English, dark desktop
English, light phone English, and dark desktop Chinese. The session page has its own light and dark
desktop and phone shots. The suite writes screenshots and does not assert. `shots.spec.ts` writes
under `web/e2e-mock/review/shots`; `session-shots.spec.ts` honours `CRH_SHOT_DIR` to write outside
the repository.

```bash
CRH_SHOT_DIR=/tmp/crh-shots pnpm --filter @crh/web exec playwright test --config e2e-mock/review/playwright.config.ts
```

## Limits

- Chromium only. No Firefox or WebKit run exists.
- No visual regression comparison: fonts and rendering differ across machines, so a person reviews
  the screenshots.
- No automated accessibility audit; the role and label selectors give some incidental coverage.
- The real-backend suite builds `web/dist` every run; it does not reuse a stale build.
- The SSH wizard spec needs an external sshd and is skipped without `CRH_TEST_SSH_JUMP`.
- The performance suite is machine-dependent and not in CI.
