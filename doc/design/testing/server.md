# Server tests

## Unit and integration tests

`server/test/*.test.ts` covers the server in-process. Suites written with `describeBackends` run once
on SQLite and, when `CRH_TEST_PG_URL` is set, once on PostgreSQL. SSH code is tested against fakes of
the `ssh2` interfaces, plus a live sshd when `CRH_TEST_SSH` is set.

Tests lower Argon2id's cost to keep them fast; the password tests restore the production parameters
where cost is what they test. Login tests disable the captcha except in the captcha suite.

## Server end-to-end tests

`server/test/e2e` runs the real server, the real Go client and the real agent runtime, with no HTTP or
protocol stubs. Only the model is fake (pi-ai's faux provider). It covers enrollment, every task kind,
large output, batches, timeouts and cancellation, offline nodes, approvals, Auto Review, subagents,
quotas, MCP, the privileged modes as reported by crha, and shutdown.

The harness (`server/test/e2e/harness.ts`) assembles crhs in-process the way `main.ts` does and can
restart it on the same database, which is how most tests simulate a crhs restart. Tests that must kill
or signal crhs run it as a real child process.

### Fault injection

The end-to-end layer provokes the failures that matter for durability:

- crhs killed during a tool call: after restart, the tool reattaches to the same task instead of
  running the command again;
- crhs killed while a model answer streams: after restart, the session produces exactly one final
  answer;
- a failed storage commit: the agent runtime is reopened through the same path as in production;
- crha restarted or disconnected: tasks become `unknown`, or recover if the disconnect is shorter than
  the grace period.

## Agent runtime tests

- **Storage conformance.** pi-durable's official storage conformance suite runs against the SQLite
  storage and against the PostgreSQL port.
- **Performance.** See [Server performance](#server-performance).
- **Fault injection.** See [Fault injection](#fault-injection).
- **Real models.** A manual run against an inexpensive hosted model covers provider streaming and
  parsing that the fake model cannot reproduce. It is not in CI because it needs an API key.

## Server performance

`server/test/perf` runs the agent runtime with the fake model on real SQLite storage. It asserts loose
multiples rather than exact timings, because the numbers depend on the machine:

- many sessions in parallel keep a minimum throughput, and the heap returns close to its starting size;
- a long session's late turns are not much slower than its early turns;
- reopening with existing sessions is fast, and so is an old session's first turn.

On a development machine the framework overhead is under 10 ms per turn, negligible next to model
latency, with no growth over long sessions and no leak. PostgreSQL storage is measured separately with
pi-durable's storage benchmark, because each commit there pays a network round trip.

Run it when the agent runtime, durable storage or context handling changes, and compare the printed
numbers with earlier runs.
