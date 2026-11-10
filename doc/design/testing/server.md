# Server tests

The server has two automated end-to-end layers and one performance layer. Unit and integration
suites live in `server/test`; the end-to-end harnesses live in `server/test/e2e` and
`server/test/system/privileged`.

## Unit and integration tests

Most of the server is covered by focused files in `server/test/*.test.ts`: protocol edges, storage,
migrations, auth, nodes, tasks, rules, approvals, privilege, sessions, scheduler and shutdown. They
run in-process by default.

- **SQLite** is `:memory:` via `openTestDb("sqlite")`.
- **PostgreSQL** is enabled by `CRH_TEST_PG_URL`. `describeBackends` runs a suite once per backend;
  the PostgreSQL run creates a schema per test database and drops it afterwards, and DDL takes a
  PostgreSQL advisory lock so parallel files do not introspect each other's schemas.
- **A live sshd** is enabled by `CRH_TEST_SSH` and `CRH_TEST_SSH_KEY` for the SSH routing and SFTP
  file suites. Everything else in the SSH area uses fakes for the `ssh2` interfaces.
- `server/vitest.setup.ts` lowers Argon2id's cost to 1024 KiB of memory, one pass and one lane;
  `test/password.test.ts` restores the production parameters where cost is the point. The login
  suites default to `captcha = "none"` through `makeApp`; `test/api-captcha.test.ts` exercises the
  Cap proof of work end to end with a low difficulty and a test solver.

```bash
pnpm --filter @crh/server test
CRH_TEST_PG_URL=postgres://crh:crh@127.0.0.1:55432/crh_test pnpm --filter @crh/server test
```

The default run is the fastest signal. The skipped count is expected: it is the PostgreSQL variant
without its URL and the SSH suites without a server.

## Server end-to-end tests

`server/test/e2e` exercises the real wire protocol: the server, the Go client and the agent runtime
are the production code, with no HTTP or protocol stubs. Only the model is fake.

| File | Covers |
|---|---|
| `agent.e2e.test.ts` | enrollment and token checks; exec (exit code, stdout/stderr, stdin, env, cwd); large-output spill; batch `text` and `status`; file write, edit, read, stat and list; timeout and cancel; offline node; crhs restart mid-task; crha crash and reconnect grace |
| `agent-session.e2e.test.ts` | yolo and ask paths; approval inside a session; storage failure and reopen; Auto Review verdicts; child sessions that can only tighten rules; quota pause and parent grant; reattach after a crhs restart |
| `crash.e2e.test.ts` | SIGKILL of a real crhs during a model stream, restart, exactly one final answer |
| `mcp.e2e.test.ts` | tool listing; exec and file tools under yolo; line paging on a real crha; `node_info`; approvals; batch as one approval; token rejection; audit events |
| `privileged.e2e.test.ts` | the mode reported in `hello`; `privileged_unsupported` for exec and file; ordinary tasks unchanged |
| `sessions-api.e2e.test.ts` | model and rule preset validation, session creation, title patch, `requestId` idempotency, exec as the session owner |
| `shutdown.e2e.test.ts` | graceful exit, open event streams and waits end, a second signal exits non-zero |

The crash and shutdown suites run crhs as a real child process, so they cannot use an in-process faux
provider. The crash suite configures an OpenAI-compatible provider that points at a scripted HTTP
server inside the test; the shutdown suite records a provider that is never called.

### Harness pieces

`server/test/e2e/harness.ts` exports:

- **`InProcessCrhs`** — the server assembled the way `src/main.ts` does it: `Cluster`, `AgentServer`,
  `TaskGroups`, `createApp`, and, when an agent directory is passed, `AgentRuntime` on durable SQLite
  plus the scheduler. It listens on a free port and can `restart()` on the same port and database,
  which is how most tests simulate a crhs restart without a process.
- **`Env`** — a whole environment: `InProcessCrhs`, a `crha.toml` written into a temporary directory,
  a real `crha` child process, enrollment, approval and the connected state. `killCrha()` and
  `destroy()` keep the child from leaking.
- **`CrhsProcess`** — a real `node src/main.ts -c <config> serve` child, used by the crash and
  shutdown suites and anything else that must be signalled.
- **`buildCrha(outDir)`** — a `go build` of `client/cmd/crha`; every e2e file builds it in
  `beforeAll`.
- **`waitFor`** and **`pkill`** — a polling helper, and a cleanup for processes orphaned by a
  SIGKILL.

The fake model is pi-ai's `fauxProvider`. Tests script it with `faux.setResponses([...])` and build
turns with `fauxAssistantMessage`, `fauxText` and `fauxToolCall`; `tokensPerSecond` slows the stream
when a test needs to observe a running turn. A session created without a title generates one at the
end of its first run, and that request takes the next answer from the same faux queue. A test that
scripts answers for a session it creates therefore titles the session, or queues the extra response.

```bash
pnpm test:e2e
pnpm --filter @crh/server exec vitest run test/e2e/crash.e2e.test.ts
```

The suite builds `crha`; Go must be on `PATH`. On a sandbox with a read-only build cache, set
`GOCACHE=/tmp/crh-go-cache` for the whole command.

### Fault injection

The e2e layer is where process and storage failures are provoked:

- **SIGKILL during a tool call**: the task stays attached; after restart the tool reattaches to the
  same Cluster task instead of starting a second one.
- **SIGKILL during a streamed model answer**: after restart the session continues and produces
  exactly one final answer.
- **Storage failure**: `agent-session.e2e.test.ts` makes one commit fail; the harness is closed and
  reopened by the same supervision path as in production.
- **crha crash or restart**: running tasks become `unknown(executor_restarted)`; a disconnect shorter
  than the grace period is recovered, a longer one becomes `unknown(connection_lost)`.

## Agent runtime tests

- **Storage conformance**: `server/test/sqlite-storage.test.ts` and
  `server/test/pg-storage.test.ts` register pi-durable's official `registerStorageConformance` suite
  against the SQLite storage opened by `openNodeSqliteStorage` and the `PgStorage` port. SQLite runs
  always; the PostgreSQL run needs `CRH_TEST_PG_URL` and uses a fresh schema.
- **Performance and memory**: `server/test/perf/agent.perf.test.ts` runs the faux model on real
  SQLite storage and checks the loose multiples described in [Server performance](#server-performance).
- **Fault injection**: the SIGKILL, storage-failure and reconnect cases are the e2e tests listed in
  [Fault injection](#fault-injection).
- **Real-model smoke**: a manual run against a cheap hosted model covers provider streaming and
  parsing paths that the faux model cannot reproduce, including provider-specific CPU cost for very
  large tool arguments. A gateway that requires an extra session header is configured through a
  custom provider's extra headers (see [Custom providers](../agent-runtime.md#custom-providers)).
  The smoke run is not in CI because it needs an external key.

## Server performance

`server/test/perf/agent.perf.test.ts` runs the agent runtime on the faux model and real SQLite
storage. It asserts loose multiples of the research baseline rather than exact timings, and it is
excluded from the regular suites because the numbers depend on the machine. The `test:perf` script
sets `NODE_OPTIONS=--expose-gc` and runs without file parallelism.

- 20 sessions × 10 turns: throughput above 15 turns/s, and the heap returns within 40 MiB of its
  starting value when garbage collection is available.
- One session × 120 turns: the late turns stay within 2.5× the early turns, or within 20 ms of them,
  whichever is looser.
- Reopening with existing sessions: under 2 s, and an old session's first turn under 1 s.

The one-long-session case creates its session with a title. Without one, title generation at the end
of the first run would take the next answer from the shared faux queue and shift every later turn.

Research baseline (SQLite, faux model, one core):

| Scenario | Result |
|---|---|
| 20 sessions × 25 turns, each turn with two tools that output 64 KiB | 146 turns/s; 74 MiB heap with the default caches, back to 24 MiB with caches off |
| One session × 300 turns, 200k window, 37 compactions | about 8 ms per turn, unchanged from start to end; heap steady around 22 MiB |
| Restart after 500 sessions | opens in 2 ms; an old session's first turn takes 12–15 ms |
| 256 KiB tool arguments streamed at 4000 tokens/s (about 18 s) | 5–7% of one core |

The conclusion is that there is no leak. The framework overhead is about 7 ms per turn, which is
negligible next to model latency. The default ten-minute context and document caches make memory
proportional to the data active in the last ten minutes, which a deployment can tune.

Measured baseline of the current suite:

| Scenario | Result |
|---|---|
| 20 sessions × 10 turns | 161 turns/s; heap 38 → 46 MiB with retention disabled |
| One session × 120 turns | 8.0 ms early mean, 10.4 ms late mean |
| Reopening with existing sessions | opens in 3 ms; an old session's first turn takes 15 ms |

These are a snapshot on one machine, not a gate. PostgreSQL storage is measured separately with the
storage benchmark shipped with pi-durable, because every commit pays a network round trip.

```bash
pnpm --filter @crh/server test:perf
```

Run it when the agent runtime, durable storage or context handling changes, and compare the printed
numbers across runs.
