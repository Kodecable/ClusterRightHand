# WebUI performance results

Medians of three runs on Chromium against the mocked API (50 ms per response),
at 1× and 4× CPU throttling (`Emulation.setCPUThrottlingRate` via CDP).
Regenerate with `pnpm --filter @crh/web test:perf`; raw medians and notes are in
[results.json](results.json).

| metric                                       | 1×       | 4×       | target                              |
| -------------------------------------------- | -------- | -------- | ----------------------------------- |
| entry bundle, gzip                           | 108.8 kB | —        | ≤ 250 kB                            |
| list 100k: first render, wall                | 224.8 ms | 551.3 ms | report both                         |
| list 100k: first render, after list response | 53.6 ms  | 251.9 ms | < 200 ms at 4× (excl. mock latency) |
| list 100k: first render, minus 50 ms mock    | 174.8 ms | 501.3 ms | < 200 ms at 4×                      |
| list 100k: scroll 10 s, p95 frame gap        | 16.7 ms  | 16.7 ms  | no visible jank                     |
| transcript 20k: DOM node spread              | 96       | 96       | flat                                |
| transcript 20k: prepend anchor drift         | 0.3 px   | 0.3 px   | ≤ 2 px                              |
| transcript 20k: scroll, p95 frame gap        | 16.7 ms  | 16.8 ms  | no visible jank                     |
| transcript 20k: scroll, worst frame          | 16.8 ms  | 16.8 ms  |                                     |
| transcript 100K: remount, worst frame        | 66.7 ms  | 266.7 ms | regression guard (was 667 ms)       |
| stream 1,500 c/s 100K: Stop p95              | 3.7 ms   | 9.8 ms   | < 100 ms at 4×                      |
| stream 1,500 c/s 100K: Stop max              | 3.7 ms   | 9.8 ms   |                                     |
| stream 1,500 c/s 100K: worst frame           | 116.6 ms | 616.6 ms |                                     |
| stream 1,500 c/s 100K: completion frame      | 116.6 ms | 433.3 ms | not the worst frame                 |
| stream 1,500 c/s 100K: main-thread busy      | 10.1 %   | 27.5 %   |                                     |
| stream 300 c/s 30K: Stop p95                 | 3.2 ms   | 7.6 ms   | < 100 ms at 4×                      |
| stream 300 c/s 30K: Stop max                 | 3.2 ms   | 7.6 ms   |                                     |
| stream 300 c/s 30K: worst frame              | 50 ms    | 250 ms   |                                     |
| stream 300 c/s 30K: completion frame         | 16.8 ms  | 116.6 ms | not the worst frame                 |
| stream 300 c/s 30K: main-thread busy         | 7.9 %    | 20.5 %   |                                     |


Notes:
- `first render, wall` is the browser's time from navigation to the first painted session row,
  so it includes the mocked responses and all of startup. The row is detected on one animation
  frame and the time is taken on the next one, so the paint has happened; the note also lists the
  Performance API window of every startup request (html, entry chunk, locale catalog, /api/me,
  sessions layout and index chunks, first list page, models). `after list response` runs from the
  end of the cursor response to that paint; `minus 50 ms mock` subtracts one mocked response. The
  first list page is requested as soon as auth resolves, so on the mocked run the response lands
  before the shell has rendered and `after list response` also covers the remaining startup
  render; the strict wall time is the headline number.
- Streaming: the full SafeMarkdown `doc-100k` fixture at 1,500 chars/s, and its first 30K
  characters at 300 chars/s (the brief's allowed variant; 100K at 300 chars/s is ~5.5 min
  per run). Stop latency is the Event Timing input delay (`processingStart - startTime`),
  with clicks spread over the stream.
- `main-thread busy` is CDP `Performance.getMetrics` TaskDuration divided by the streaming
  wall time. `worst frame` is the largest rAF gap while streaming; `completion frame` is the
  largest gap in the two seconds after the final `message_end`, i.e. the transition from the
  incremental streamed render to the committed message.
- `transcript 100K: remount` scrolls a completed 100K message out of and back into the virtual
  window and reports the worst frame of that scroll.
- Transcript scrolling reports the p95 frame gap and the worst frame per run; all raw
  per-run numbers are in results.json.
