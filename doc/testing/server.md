# Server tests

The server has two automated end-to-end layers and one performance layer. The unit/integration suites live
next to the code in `server/test`; the e2e harnesses live in `server/test/e2e` and
`server/test/system/privileged`.

## Unit and integration (Vitest)

Most of the server is covered by focused files in `server/test/*.test.ts`: protocol edges, storage,
migrations, auth, nodes, tasks, rules, approvals, privilege, sessions, scheduler, shutdown. They run
in-process by default.

- **SQLite** is `:memory:` via `openTestDb("sqlite")`.
- **PostgreSQL** is enabled by `CRH_TEST_PG_URL`. `describeBackends` runs a suite once per backend; the PG
  run creates a schema per test file and drops it afterwards, and DDL takes a PostgreSQL advisory lock so
  parallel files do not introspect each other's schemas.
- **A live sshd** is enabled by `CRH_TEST_SSH` + `CRH_TEST_SSH_KEY` for the SSH routing and SFTP file
  suites. Everything else in the SSH area uses fakes for the `ssh2` interfaces.
- `server/vitest.setup.ts` lowers Argon2id's cost; `test/password.test.ts` restores the production parameters
  where cost is the point. The login suites default to `captcha = "none"`; `test/api-captcha.test.ts` exercises
  the Cap proof of work end to end with a test solver.

```bash
pnpm --filter @crh/server test
CRH_TEST_PG_URL=postgres://crh:crh@127.0.0.1:55432/crh_test pnpm --filter @crh/server test
```

The default run is the fastest signal: 68 files, about 770 executed tests. The skipped count is expected;
it is the PostgreSQL variant without its URL and the SSH suites without a server.

## Server e2e (real crha, in-process crhs)

`server/test/e2e` exercises the real wire protocol: the server, the Go client, and the agent runtime are
the production code, with no HTTP or protocol stubs. Only the model is fake.

| File | Covers |
|---|---|
| `agent.e2e.test.ts` | enrollment and token checks; exec (exit code, stdout/stderr, stdin, env, cwd); large-output spill; batch `text`/`status`; file write/edit/read/stat/list; timeout and cancel; offline node; crhs restart mid-task; crha crash and reconnect grace |
| `agent-session.e2e.test.ts` | yolo and ask paths; approval inside a session; storage failure and reopen; Auto Review verdicts; child sessions that can only tighten rules; quota pause and parent grant; reattach after a crhs restart |
| `crash.e2e.test.ts` | SIGKILL of a real crhs during a model stream, restart, one final answer |
| `mcp.e2e.test.ts` | tool listing; exec and file tools under yolo; line paging on a real crha; `node_info`; approvals; batch as one approval; token rejection; audit events |
| `privileged.e2e.test.ts` | the mode reported in `hello`; `privileged_unsupported` for exec and file; ordinary tasks unchanged |
| `sessions-api.e2e.test.ts` | model and rule preset validation, session creation, title patch, `requestId` idempotency, exec as the session owner |
| `shutdown.e2e.test.ts` | graceful exit, open event streams and waits end, second signal exits non-zero |

### Harness pieces

`server/test/e2e/harness.ts` exports:

- **`InProcessCrhs`** — the server assembled the way `src/main.ts` does it: `Cluster`, `AgentServer`,
  `TaskGroups`, `createApp`, and, when an agent directory is passed, `AgentRuntime` on durable SQLite plus
  the scheduler. It listens on a free port and can `restart()` on the same port and database, which is how
  the tests simulate a crhs restart without a process.
- **`Env`** — a whole environment: `InProcessCrhs`, a `crha.toml` written into a temporary directory, a real
  `crha` child process, enrollment, approval and the connected state. `killCrha()` and `destroy()` keep the
  child from leaking.
- **`CrhsProcess`** — a real `node src/main.ts -c <config> serve` child, used only by the crash suite and
  anything else that must be signalled.
- **`buildCrha(outDir)`** — `go build` of `client/cmd/crha`; every e2e file builds it in `beforeAll`.
- **`waitFor`** and **`pkill`** — polling helper, and a cleanup for processes orphaned by a SIGKILL.

The fake model is pi-ai's `fauxProvider`. Tests script it with `faux.setResponses([...])` and build turns
with `fauxAssistantMessage`, `fauxText` and `fauxToolCall`; `tokensPerSecond` slows the stream when a test
needs to observe a running turn.

```bash
pnpm test:e2e
pnpm --filter @crh/server exec vitest run test/e2e/crash.e2e.test.ts
```

The suite builds `crha`; Go must be on `PATH`. On a sandbox with a read-only build cache, set
`GOCACHE=/tmp/crh-gocache` for the whole command.

### Fault injection

The e2e layer is where process and storage failures are provoked:

- **SIGKILL during a tool call**: the task stays attached; after restart the tool reattaches to the same
  Cluster task instead of starting a second one.
- **SIGKILL during a streamed model answer**: after restart the session continues and produces exactly one
  final answer.
- **Storage failure**: `agent-session.e2e.test.ts` makes one commit fail; the harness is closed and
  reopened by the same supervision path as in production.
- **crha crash or restart**: running tasks become `unknown(executor_restarted)`; a disconnect shorter than
  the grace period is recovered, a longer one becomes `unknown(connection_lost)`.

## Performance

`server/test/perf/agent.perf.test.ts` runs the agent runtime on the faux model and real SQLite storage. It
asserts loose multiples of the research baseline rather than exact timings:

- 20 sessions × 10 turns: throughput above 15 turns/s and the heap returns within 40 MiB of the baseline.
- One session × 120 turns: the late turns stay within 2.5× the early turns.
- Reopening with existing sessions: under 2 s, and an old session's first turn under 1 s.

```bash
pnpm --filter @crh/server test:perf
```

It is excluded from the regular suites because the numbers depend on the machine. Run it when the agent
runtime, durable storage, or context handling changes, and compare the printed numbers with the previous
run.
