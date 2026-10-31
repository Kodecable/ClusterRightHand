# WebUI performance results

Medians of three runs on Chromium against the mocked API (50 ms per response),
at 1× and 4× CPU throttling (`Emulation.setCPUThrottlingRate` via CDP).
Regenerate with `pnpm --filter @crh/web test:perf`; raw medians and notes are in
[results.json](results.json).

| metric                                       | 1×       | 4×       | target                              |
| -------------------------------------------- | -------- | -------- | ----------------------------------- |
| entry bundle, gzip                           | 131.8 kB | —        | ≤ 250 kB                            |
| list 100k: first render, wall                | 272.7 ms | 551.5 ms | report both                         |
| list 100k: first render, after list response | 27.2 ms  | 99.3 ms  | < 200 ms at 4× (excl. mock latency) |
| list 100k: first render, minus 50 ms mock    | 222.7 ms | 501.5 ms | < 200 ms at 4×                      |
| list 100k: scroll 10 s, p95 frame gap        | 16.7 ms  | 33.3 ms  | no visible jank                     |
| transcript 20k: DOM node spread              | 61       | 61       | flat                                |
| transcript 20k: prepend anchor drift         | 0.3 px   | 0.3 px   | ≤ 2 px                              |
| transcript 20k: scroll, p95 frame gap        | 16.7 ms  | 16.7 ms  | no visible jank                     |
| transcript 20k: scroll, worst frame          | 16.8 ms  | 16.8 ms  |                                     |
| stream 1,500 c/s 100K: Stop p95              | 2.9 ms   | 8.7 ms   | < 100 ms at 4×                      |
| stream 1,500 c/s 100K: Stop max              | 2.9 ms   | 8.7 ms   |                                     |
| stream 1,500 c/s 100K: worst frame           | 150.1 ms | 683.4 ms |                                     |
| stream 1,500 c/s 100K: main-thread busy      | 10.1 %   | 27 %     |                                     |
| stream 300 c/s 30K: Stop p95                 | 3.1 ms   | 7.3 ms   | < 100 ms at 4×                      |
| stream 300 c/s 30K: Stop max                 | 3.1 ms   | 7.3 ms   |                                     |
| stream 300 c/s 30K: worst frame              | 100 ms   | 399.9 ms |                                     |
| stream 300 c/s 30K: main-thread busy         | 8.5 %    | 20.7 %   |                                     |


Notes:
- `first render, wall` is the browser's time from navigation to the first painted session row,
  so it includes the mocked responses. `after list response` runs from the end of the cursor
  response to that paint; `minus 50 ms mock` subtracts one mocked response from the wall time.
- Streaming: the full SafeMarkdown `doc-100k` fixture at 1,500 chars/s, and its first 30K
  characters at 300 chars/s (the brief's allowed variant; 100K at 300 chars/s is ~5.5 min
  per run). Stop latency is the Event Timing input delay (`processingStart - startTime`),
  with clicks spread over the stream.
- `main-thread busy` is CDP `Performance.getMetrics` TaskDuration divided by the streaming
  wall time. `worst frame` is the largest rAF gap while streaming.
- Transcript scrolling reports the p95 frame gap and the worst frame per run; all raw
  per-run numbers are in results.json.
