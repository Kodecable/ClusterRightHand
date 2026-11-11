# WebUI tests

| Suite | Question it answers |
|---|---|
| Unit and component tests (`web/src/**/*.test.*`) | Does this component or function behave? |
| Real-backend end-to-end (`web/e2e`) | Does the app work against a real server and node? |
| Mock end-to-end (`web/e2e-mock`) | Does the UI render, scroll and lay out correctly with controlled data? |
| Performance (`web/e2e-mock/perf`) | Did rendering performance regress? |
| Review screenshots (`web/e2e-mock/review`) | What do the pages look like? (no assertions) |

## Unit and component tests

Vitest with jsdom and Testing Library. The web test script also checks that the Chinese catalog has
every message.

## Real-backend end-to-end tests

Playwright runs against an in-process crhs from the server end-to-end harness, serving the built WebUI.
A test can ask for a real enrolled crha node and for the agent runtime with a scripted fake model.
Selectors use roles, labels and text, with a few test ids, never CSS.

## Mock end-to-end tests

The built WebUI runs against a mocked API, so every page can be driven with controlled data. This covers
what is hard to make deterministic with a real server: narrow-screen layouts, composer measurements,
scrolling, theme and language switching, keyboard navigation.

## WebUI performance

The performance suite measures, at normal speed and under 4× CPU throttling, the first render of a
100,000-session list, scroll smoothness, the reading-position drift when older history loads, streaming
cost and Stop latency. The targets are in [Performance targets](../webui.md#performance-targets), and the
latest results with metric definitions are in `web/e2e-mock/perf/RESULTS.md`. It is machine-dependent and
not in CI; treat it as a regression check.

## Limits

- Chromium only.
- No automatic visual comparison, because rendering differs between machines; a person reviews the
  screenshots.
- No automated accessibility audit beyond what role-based selectors cover.
