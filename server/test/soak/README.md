# Soak / resource test

`server/test/soak/run.ts` is a **standalone Node script**, not a vitest test. It drives the real crhs agent runtime
and real crha nodes through a long synthetic workload and records memory and disk usage over time
(`samples.csv`, `summary.md`). It exists to answer the question a unit test cannot: does crhs or crha grow over a
long session workload?

## How it runs

```bash
CRH_TEST_PODMAN=1 GOCACHE=/tmp/crh-gocache \
  npm_config_manage_package_manager_versions=false pnpm --filter @crh/server soak

# or, from server/:
CRH_TEST_PODMAN=1 GOCACHE=/tmp/crh-gocache \
  npm_config_manage_package_manager_versions=false pnpm soak
```

Podman, Go and Node >= 24 are required. The script fails with an explicit message when podman is unavailable or
`CRH_TEST_PODMAN=1` is not set. The first run builds the static `crha` binary and the privileged system-test image
(`server/test/system/privileged/Containerfile`); later runs reuse the image. Containers are removed at the end and on
SIGINT/SIGTERM. `OUT_DIR` is kept.

## Architecture: two processes on purpose

- **Parent (this script)** builds the image, creates the podman nodes, samples, and writes the CSV/summary. It never
  runs the agent runtime.
- **Child (`child.ts`)** contains the real crhs assembly from `main.ts` (AgentRuntime, Cluster, AgentServer,
  TaskGroups, Scheduler, real HTTP/WS server) **and** the workload driver. It also owns the file-backed databases.

The split is what makes the crhs RSS number meaningful: the process is "crhs + the thin workload driver", not
"crhs + driver + orchestrator". The caveat remains that the driver itself (the faux model's response factory and the
session loop) lives in the crhs process and contributes some memory; the clean-room alternative would move the
driver out, but then driving sessions through the HTTP API would add a third process and a different bottleneck.

The shared `server/test/e2e/harness.ts` opens SQLite with `:memory:`. Rather than change that fixture, the soak wraps
the same production components locally (`crhs.ts`) and opens the crhs database and the pi-durable storage as files in
`OUT_DIR/crhs/db/crhs.sqlite` and `OUT_DIR/crhs/durable/durable.sqlite`. Both are real SQLite/WAL files and are
measured.

## What one run does

1. Builds the real static `crha` and the podman image.
2. Starts the crhs child and waits for its HTTP server.
3. Creates `NODES` real containers with `crha run` and `crha privileged run` in **forward** mode. Each node trusts
   crhs's authorization key (`role = "crhs"`, `kinds = ["execute"]`, generous `allow` rules, no `deny`), so privileged
   tasks are self-signed by crhs and need no human signature.
4. Runs `SESSIONS` sessions with `CONCURRENCY` sessions side by side; each session runs `TURNS` turns sequentially.
   Sessions use the **yolo** preset (no approval waits) and no token quota.
5. Every turn the faux model replies with `TOOLS_PER_TURN` real `exec` tool calls, targets spread round-robin over the
   nodes. A `PRIV_RATIO` share is marked privileged, a `BIG_OUTPUT_RATIO` share prints 64 KiB (more than the 50 KiB
   that makes crha spill output to its output dir); the rest prints `OUTPUT_BYTES`.
6. After the tool batch, the faux model replies with a short final text. pi-durable's automatic context compaction is
   left at its defaults; compaction summarization requests are recognized from the summarization system prompt and
   answered with a short summary.
7. The parent samples every `SAMPLE_SECONDS` and at the end.

The faux model is a **response factory**, not a fixed script: every queued response decides from the request's own
transcript (the last user input, the tool results, or the compaction prompt). Concurrent sessions therefore cannot
consume each other's scripted responses, and the queue is kept topped up.

**Throughput and latency depend on `OUT_DIR`'s filesystem.** The crhs databases live in `OUT_DIR`, so their commits,
WAL growth and checkpoint fsyncs go to that filesystem, even with `synchronous = NORMAL`: a tmpfs `OUT_DIR` and one on
a real disk differ several-fold. Compare runs only with `OUT_DIR` on the same filesystem.

## Output

`OUT_DIR` (default: a fresh `crh-soak-*` directory under the system temp dir) contains:

| File          | Contents                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `samples.csv` | one row per sample: time, elapsed, turns, tool calls, failed tasks, crhs RSS and V8 heap, crhs db/WAL, durable dir, row counts, p50/p95 turn latency, and per-node RSS/disk/used-list columns  |
| `summary.md`  | totals, throughput, peak/final RSS, disk sizes, bytes per tool call, RSS slopes over the last half of the run, observed tool-call parallelism, warnings, failures                              |
| `params.json` | the exact parameters used                                                                                                                                                                      |
| `child.log`   | the child's stdout/stderr; `[crhs]` console lines are child messages                                                                                                                           |
| `crhs/`       | the file-backed crhs database and durable storage                                                                                                                                              |
| `bin/crha`    | the static crha binary built for the containers                                                                                                                                                |
| `pprof/`      | `PPROF=1` only: per-node Go heap profiles and MemStats text (`node-N/{run,priv}-heap-<pct>.{pb.gz,txt}`); the debug sockets live in a separate short-lived directory under the system temp dir |

Node columns are `node_<n>_rss_run_kb`, `node_<n>_rss_priv_kb`, `node_<n>_state_kb`, `node_<n>_output_kb`,
`node_<n>_log_kb`, `node_<n>_used_lines`, where `n` is 1-based. With `PPROF=1` each node also gets
`node_<n>_run_heap_alloc_kb`, `node_<n>_run_heap_inuse_kb`, `node_<n>_run_heap_released_kb`, `node_<n>_run_sys_kb`
and the same four with `priv_` for `crha privileged run`, from the latest `?debug=1` fetch (no forced GC). A periodic
sample whose stats request fails writes no row at all; a node whose `podman exec` fails leaves that node's columns
empty, and a failed periodic pprof fetch leaves its heap columns empty. Both cases are warnings, not failures.

`summary.md` includes a simple linear regression of RSS on turns done over the last half of the run, reported as
MiB per 1000 turns. A positive slope is steady growth; compare it with the noise between samples before treating it as
a leak.

## Exit codes

| Code  | Meaning                                                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | The workload finished and the run has no real failures. Warnings may still be listed.                                                                                                                                                                                        |
| `1`   | A real failure: a workload failure or failed task, the crhs child crashing or the workload not finishing, the final sample/stats still missing after retries, a requested pprof point still missing after retries, a container setup error, or an error writing the summary. |
| `2`   | Invalid parameters.                                                                                                                                                                                                                                                          |
| `130` | Interrupted by SIGINT/SIGTERM.                                                                                                                                                                                                                                               |

Transient orchestration problems are **warnings**: a periodic stats request that times out, a `podman exec`/`du`/`ps`
hiccup on one node, a periodic pprof fetch, or a failure to remove a container at teardown. The affected sample (or
node columns) is skipped, or the container is left in place; the warning is counted under `## Warnings` in
`summary.md`, and the run continues. Warnings never change the exit code; `## Warnings` is separate from `## Failures`.
The final stats request and the final requested pprof points are retried a few times, because their result is the
measurement; only a miss that survives the retries fails the run.

The exit-code rule is a pure function in `outcome.ts`; its self-check runs without podman:

```bash
cd server && node test/soak/outcome.ts
```

## Parameters

Every parameter is settable through the environment or a CLI flag (CLI wins). Defaults are the owner's first run.

| Environment            | Flag                 | Default          | Meaning                                                      |
| ---------------------- | -------------------- | ---------------- | ------------------------------------------------------------ |
| `SESSIONS`             | `--sessions`         | `50`             | sessions in total                                            |
| `CONCURRENCY`          | `--concurrency`      | `2`              | sessions running side by side                                |
| `TURNS`                | `--turns`            | `200`            | turns per session                                            |
| `TOOLS_PER_TURN`       | `--tools-per-turn`   | `20`             | tool calls per turn's assistant message                      |
| `NODES`                | `--nodes`            | `4`              | real crha containers (forward mode)                          |
| `PRIV_RATIO`           | `--priv-ratio`       | `0.1`            | share of privileged tool calls                               |
| `OUTPUT_BYTES`         | `--output-bytes`     | `200`            | stdout bytes of a normal tool call                           |
| `BIG_OUTPUT_RATIO`     | `--big-output-ratio` | `0.01`           | share printing 64 KiB (> the 50 KiB spill threshold)         |
| `SAMPLE_SECONDS`       | `--sample-seconds`   | `15`             | sampling interval                                            |
| `PPROF`                | `--pprof`            | `0` (off)        | build crha with `-tags pprof` and capture Go heap profiles   |
| `PPROF_POINTS`         | `--pprof-points`     | `0.1,0.5,1.0`    | fractions of all tool calls at which to capture a heap point |
| `OUT_DIR`              | `--out-dir`          | new under `/tmp` | output directory                                             |
| `TURN_TIMEOUT_SECONDS` | `--turn-timeout`     | `900`            | a turn slower than this is aborted and counted as a failure  |
| `CONTEXT_WINDOW`       | `--context-window`   | `128000`         | faux model context window; compaction is not disabled        |

`--help` prints the same table.

A small smoke run (one image build aside):

```bash
SESSIONS=3 CONCURRENCY=2 TURNS=3 TOOLS_PER_TURN=5 NODES=2 SAMPLE_SECONDS=5 \
  CRH_TEST_PODMAN=1 GOCACHE=/tmp/crh-gocache \
  npm_config_manage_package_manager_versions=false pnpm --filter @crh/server soak
```

## pprof profiling (PPROF=1)

Setting `PPROF=1` makes the parent build crha with `-tags pprof` and pass `--pprof-listen` to both
processes of every node. It answers whether RSS growth is retained memory or Go's runtime holding
released pages: the heap profile says what is allocated, `runtime.MemStats` says how much the runtime
has returned to the OS.

```bash
PPROF=1 SESSIONS=20 CONCURRENCY=2 TURNS=50 TOOLS_PER_TURN=10 NODES=2 SAMPLE_SECONDS=15 \
  CRH_TEST_PODMAN=1 GOCACHE=/tmp/crh-gocache \
  npm_config_manage_package_manager_versions=false pnpm --filter @crh/server soak
```

How it works:

1. Each node gets a short host directory `$TMPDIR/crh-pp-<random>/node-N`, bind-mounted at
   `/pprof` (`PPROF=1` only; one `fs.mkdtemp` root per run under `os.tmpdir()`, one subdirectory
   per node). The container environment `CRHA_RUN_ARGS` / `CRHA_PRIV_ARGS` makes `privctl.sh`
   append `--pprof-listen unix:/pprof/run.sock` and `--pprof-listen unix:/pprof/priv.sock` at
   every start site. Only the sockets live there; the captured heap profiles are written by the
   parent to `OUT_DIR/pprof/node-N`, which is not mounted.
2. `PPROF_POINTS` is a comma-separated list of fractions of the **total** tool calls
   (`SESSIONS * TURNS * TOOLS_PER_TURN`). `0.1,0.5,1.0` means "once 10 %, then 50 %, then 100 % of the
   calls are done". Point `1.0` is taken after the workload finishes and before teardown. The parent
   checks the points when it samples, so a point can be captured somewhat later than its exact
   fraction; at the end any still-missing points are captured while the containers are still up.
3. At each point, for every node and both processes, the parent requests
   `/debug/pprof/heap?gc=1` (a forced GC), then saves `/debug/pprof/heap` as
   `node-N/{run,priv}-heap-<pct>.pb.gz` and `/debug/pprof/heap?debug=1` as `...-heap-<pct>.txt`.
   `<pct>` is the point as a whole percentage (`0.1` → `10`, `1.0` → `100`). The text tail contains
   `runtime.MemStats` (`HeapAlloc`, `HeapInuse`, `HeapReleased`, `HeapSys`, `Sys`, `NumGC`).
4. Between points, every sample fetches `?debug=1` (without a forced GC) for the CSV columns.

The sockets cannot live under `OUT_DIR`: a unix socket address must fit in `sun_path` (108 bytes
on Linux, including the terminating NUL), and `OUT_DIR` can be arbitrarily long. With a long
`OUT_DIR` every capture would fail with `connect EINVAL` late in the run. The harness therefore keeps
the sockets in the short temp directory and, at setup before any container is created, checks that
the longest host socket path is shorter than 104 bytes; a path that does not fit (for example with
a very long `TMPDIR`) fails the run immediately with a clear error. The socket directory is
removed at teardown; a removal failure is reported as a warning.

Every capture is fetched from the host with Node's `http.get({ socketPath })`; no curl and no
`podman exec` is used for the profiles (`podman exec` is still used for RSS and the socket chmod).

**Socket permissions.** The container's root maps to the host user under rootless podman, but
`crha run` runs as uid 998, which maps to a subordinate host uid. `crha` creates its debug sockets
mode 0600, so the host parent could not connect to the uid-998 socket; and uid 998 could not even
create it in a root-owned directory. The parent therefore makes `crh-pp-<random>/node-N` mode 0777
(the `crh-pp-*` root only contains those directories) and, after the node starts, runs `chmod 0666`
on the two debug sockets **inside** the container as root (root has `CAP_FOWNER` over the
subordinate uid there). The sockets are debug-only and the directory exists only for the run; do
not copy this pattern into production.
A setup that already maps uid 998 to the host user (`--userns=keep-id`) or runs podman as root still
works: the chmod only widens an already-accessible socket.

`summary.md` gets a `## pprof` section with the capture table (HeapAlloc / HeapInuse / HeapReleased /
Sys / RSS per point, node and process), the list of files, and exact absolute-path commands:

```sh
go tool pprof -top -base '/…/pprof/node-1/run-heap-10.pb.gz' '/…/pprof/node-1/run-heap-100.pb.gz'
go tool pprof -top -base '/…/pprof/node-1/priv-heap-10.pb.gz' '/…/pprof/node-1/priv-heap-100.pb.gz'
```

`-base` subtracts the first profile, so the lines are what was still allocated at the later point but
not at the earlier one. A growing `HeapAlloc`/`HeapInuse` alongside a flat `HeapReleased` is a leak
candidate; flat `HeapAlloc` with growing `Sys` and `HeapIdle` is the runtime holding pages. The same
profiles also open in `go tool pprof` interactively (`-sample_index=inuse_space` is the default for
heap profiles).

`PPROF=1` makes the parent issue one `heap?gc=1`, one binary, and one text request per process per
point; forced GCs briefly pause a process, so keep `PPROF_POINTS` short on timing-sensitive runs.
Profiling does not change task execution or output; it is off by default and the default CSV and
summary do not change.

## Caveats

- **crhs RSS includes the driver.** See the architecture note. The child also hosts the real HTTP/WS server the nodes
  connect to, which is part of crhs anyway.
- **The model is faux.** It is pi-ai's faux provider with a context-deciding factory. There is no network, no real token
  latency, and no real model memory. Token counts are estimates from message text, so compaction timing is synthetic
  but the compaction path itself (summarization request, summary placement, entry growth) is the real one.
- **Podman only.** Rootless podman, `--network=host`, uid 998 and the container image are assumed. The image is built
  from `server/test/system/privileged/`; see [its README](../system/privileged/README.md).
- **Disk sizes include WAL.** crhs db and WAL are reported separately, and the durable directory sums its files. The
  node `state_dir` already contains the output dir; the summary's bytes-per-call avoids counting it twice.
- **`tasks_failed`** counts tasks whose state is `failed`, that timed out, or that exited non-zero. A failed turn is also
  recorded in the child's failure list and makes the script exit `1`. Transient sampling warnings (a stats timeout, one
  node's exec hiccup, a periodic pprof fetch) do not.
- **Tool-call parallelism** is observed from the task rows' created/dispatched/finished timestamps: in a parallel round
  every call's task exists before the first task finishes. The default pi-durable `toolExecution` is `parallel`; the
  observation is only sampled (first turns and every tenth turn, up to 60 rounds) to keep the measurement cheap.
- **One node exec per sample per node** (`podman exec` with a small shell script) means a sample is not free; with
  `SAMPLE_SECONDS=5` the sampler itself is a measurable load. Use 15 s or more for real runs.
- **The image is left in podman's image store** by the fixture, as the system tests also do. Containers are removed.
  If a container's creation is interrupted, the parent removes everything matching its `crh-priv-<pid>-` prefix.

## Expected duration

The default run is 10,000 turns and 200,000 real exec tasks (plus privileged ones). That is deliberately a long soak:
expect **tens of minutes to a few hours**, dominated by real container task execution and SQLite commits, not by the
faux model. The measured smoke rate extrapolates to about 25 minutes for 200,000 calls, but the full run also grows
the session context (compaction calls), the SQLite files and the node output, so treat that as a lower bound. The first
run also pays for the `crha` build and the image build; podman setup dominates a small smoke.

A measured 3x3x5 smoke (two nodes, 5 s sampling) completed 9 turns and 45 real tool calls in 0.34 s of workload time
(about 26.8 turns/s and 134 tool calls/s on this machine), with zero failures and the containers removed. The workload
was shorter than the sample interval, so that run produced only the initial and final samples and the summary reports
the RSS slopes as n/a; a run of a few minutes is needed before the slope means anything.

Use a smaller `SESSIONS`/`TURNS` first to check that the trust setup and podman prefix work, then run the defaults
overnight. The script keeps `OUT_DIR` even when interrupted; a partial `summary.md` says so.
