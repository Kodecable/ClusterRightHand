# Metrics

crhs collects a small, fixed set of host metrics from every node, stores them in its database at
decreasing resolution, and shows them on the node pages and to agents. This document covers what is
collected, how crhs pulls it, how values are computed and stored, and how the data is read.

Monitoring, deciding whether a node is healthy and sending an agent when it is not, is a separate design
that reads this data. Nothing here raises an alert.

The metric set, the series semantics and the levels follow litesrvmon. The difference is the direction:
crhs pulls, so crha keeps no sampling state and SSH nodes are covered by the same code.

## Scope

- Every approved crha node and every SSH node, while `metrics.enabled` is on. A pending node, or a node
  connected only for its upgrade ([Upgrade-only connections](protocol.md#upgrade-only-connections)),
  is sampled as `up` only.
- Host metrics only: CPU, load, memory, swap, the configured filesystems, network traffic, uptime and
  reachability. No per-process metrics, no custom metrics, no logs.
- Collection is system work, not an agent action: no rules, approvals, tasks or audit events.
- No export. A Prometheus endpoint can come later.

## Metrics

| Series | Kind | Unit | Source |
|---|---|---|---|
| `up` | gauge | 0 or 1 | Whether the sample succeeded |
| `uptime` | gauge | seconds | `/proc/uptime` |
| `cpu.total` | gauge | ratio 0–1 | `/proc/stat` `cpu` line, between two samples |
| `cpu.core.<n>` | gauge | ratio 0–1 | `/proc/stat` `cpu<n>` lines, between two samples |
| `load.1`, `load.5`, `load.15` | gauge | load | `/proc/loadavg` |
| `mem.total_bytes`, `mem.available_bytes`, `mem.cached_bytes`, `mem.free_bytes` | gauge | bytes | `/proc/meminfo` |
| `swap.total_bytes`, `swap.free_bytes` | gauge | bytes | `/proc/meminfo` |
| `disk.<name>.total_bytes`, `disk.<name>.used_bytes` | gauge | bytes | `statfs` of the filesystem |
| `net.rx_bytes_per_sec`, `net.tx_bytes_per_sec` | gauge | bytes/s | The selected interfaces, between two samples |
| `net.rx_bytes`, `net.tx_bytes`, `net.rx_packets`, `net.tx_packets` | delta | bytes, packets | The selected interfaces, between two samples |

- **A missing value is not zero.** A field the node could not read is absent from the sample, and the
  series has no observation for that sample.
- **Gauges** are what one sample observed. **Deltas** are what a counter advanced since the previous
  sample; they sum across a bucket.
- `up` is written for every attempt, so availability is the average of `up` over any range.

## Collection

crhs pulls every node once per interval (`metrics.interval`, default 60 seconds). The interval divides
a minute, so time splits into slots that never straddle a level-1 bucket. Each node has a fixed offset
in the first half of the slot, from a hash of its id, so a large cluster is not polled in one burst;
the offset is fixed, not random per sample, so a node's samples stay one interval apart. One timer ticks
every second and starts the samples that are due.

A sample belongs to its slot, not to the moment its answer arrives: it is stored at the slot's start on
crhs's clock, so a slow answer or a late tick never moves it into the next bucket, and every level-1
bucket of a reachable node holds `60 / interval` samples. A slot whose sample has not started by the
slot's end (crhs was stalled or stopped) is skipped: it leaves a gap, never two samples in one slot and
never `up = 0`. Node clocks are never used. Rates divide by the time between the two samples' answers on
crhs's monotonic clock, so they stay right however the slots were timed. A step of crhs's wall clock can
still skip a slot or fill one twice; there is nothing to correct it against.

The first sample has nothing to compute a rate or delta from. So crhs takes a baseline sample, used only
for its counters and never stored, when it starts and whenever a crha node connects, which includes
the reconnect after a reboot; the node's first stored sample then already has `cpu.total` and the
network rates.

### Availability

`up = 0` means that crhs could not get a sample from the node during the whole slot, never that one
attempt failed. A sample's deadline is the end of its slot, so the second half of the slot is left for
waiting and retrying:

- A crha node that is not connected when its sample is due is waited for until the deadline, and a
  request ended by the connection closing is sent again on the new connection.
- A pooled SSH connection found dead is replaced once, as for a task, and a channel the server refuses
  (its session limit is taken by tasks) is asked for again until the deadline.
- crha never answers `metrics.collect` with an error for a source it cannot read: that is a missing
  field ([crha nodes](#crha-nodes)). An error answer is a bug; it counts as a failed sample and is
  logged.
- An SSH node, or a connected crha node, that gives no sample by the deadline writes `up = 0` and
  nothing else.

A crha node still disconnected at the deadline is decided by the reconnect grace
([Reconnect](execution.md#reconnect)), because crha reconnects with backoff after any break, including a
crhs restart:

- While the grace runs, its slots get no row. A node not yet connected since crhs started is treated the
  same, its disconnect counted from the start.
- When the node is back within the grace with the same `bootId`, the host was up and only crha could not
  be reached: those slots stay without rows, a gap rather than downtime.
- When it is back with a new `bootId`, the host rebooted; when the grace runs out, the host is down or
  cut off. Either way the slots since the disconnect are written `up = 0` at that moment, and in the
  second case later slots too, as they pass.

So a node that answers within its slot is never recorded as down, and a crha upgrade or a crhs restart
leaves gaps, not downtime. A connection that died silently looks connected until the heartbeat closes
it ([Client connection lifecycle](execution.md#client-connection-lifecycle)); its slots fail at their
deadlines and are `up = 0`, which is right, because nothing reaches the node.

### crha nodes

crhs sends `metrics.collect`, an optional command of protocol minor 2, negotiated by intersection
([Version negotiation](protocol.md#version-negotiation)); a node that does not offer it is sampled as
`up` only, from its connection state. crhs sends it only on a full connection, never on a restricted
one ([Restricted connections](protocol.md#restricted-connections)). crha reads the sources and answers
with raw values; it computes no rates and keeps nothing between samples but the `statfs` calls still
blocked. The answer is a map with snake_case keys; every key is optional, and an absent key means crha
could not read that source:

| Field | Value |
|---|---|
| `boot_id` | Text: `/proc/sys/kernel/random/boot_id` |
| `uptime_sec` | Integer seconds: `/proc/uptime` |
| `cpu` | `[total, cores]`: `total` is `[busy, total]` jiffies of the `cpu` line, and each core is `[index, busy, total]` for its `cpu<n>` line |
| `loads` | `[l1, l5, l15]` in thousandths (1.23 is 1230): the profile has no floats, and `/proc/loadavg` prints two decimals |
| `memory` | `[totalBytes, availableBytes, cachedBytes, freeBytes]` from `/proc/meminfo` |
| `swap` | `[totalBytes, freeBytes]` from `/proc/meminfo` |
| `disks` | `["ok", [name, path, totalBytes, usedBytes]]` per configured filesystem, or `["error", [name, path, error]]` for one that failed |
| `interfaces` | `[name, rxBytes, txBytes, rxPackets, txPackets]` per selected interface |

Counters are unsigned 64-bit integers, so a byte or packet counter that passes 2^53 keeps its exact
value instead of being rounded; `uptime_sec`, core indexes and the load thousandths use the smaller
protocol integer. Each field is optional, so a node that cannot read one source still answers with
the rest. The `statfs` calls run concurrently under one 2-second deadline: one that blocks (a hung
network mount) is reported as that disk's error, so one mount cannot time out the whole sample. A
blocked call cannot be cancelled and holds a thread, so crha starts no second call for that path while
it is blocked: later samples report the disk as still blocked since the call started, until it returns.

The filesystems and interfaces are crha configuration (`[metrics]` in `crha.toml`), because only the node
knows which of its mounts and links matter:

- `disks`: a list of `{ name, path }`. The name is the series identity: 1–64 characters of
  `[A-Za-z0-9_-]`, unique, at most 64 entries. Absent means `[{ name = "root", path = "/" }]`; an empty
  list collects no filesystem.
- `interfaces`: a list of names. Empty or absent selects every interface except loopback (`lo`, `lo<n>`),
  tunnels (`tun*`, `tap*`, `wg*`, `utun*`) and host-local virtual and bridge interfaces (`docker*`,
  `veth*`, `br-*`, `virbr*`, `lxc*`, `cni*`, `flannel*`, `cali*`, `vxlan*`, `kube-*`). Traffic through a
  bridge is also counted on the veth or physical side, so including them would count it twice, and a
  veth's teardown would make the sum fall.
- Both keys are optional and new; a `crha.toml` without them keeps working
  ([Compatibility](compatibility.md#configuration)).

### SSH nodes

crhs runs one fixed, read-only script on the node's pooled SSH connection
([SSH execution](execution.md#ssh-execution)) and parses its output into the same fields. The script is
not a task: it has no task row, output storage or process-group wrapper, and the channel is closed at
the sample timeout. Sampling keeps the pooled connection open; a node that cannot be reached is dialled
again at its next sample, not sooner.

SSH nodes have no configuration: the script reports the root filesystem as `root` and the interface of
the default route, the first one in `/proc/net/route` with destination `00000000` that is not loopback.
The script uses only `cat`, `df -P -B1 /` and the shell. A node where it fails is sampled as `up = 0`,
and crhs logs the reason when a node's sampling starts or stops failing, not on every sample.

## Computation

crhs keeps, per node, the previous raw value of every counter, keyed by its own identity: the `cpu` line,
each core by index, each interface by name. Every rate and delta comes from one counter's own previous
value:

- **A new counter** (a new core, interface or filesystem, or any counter in the first sample a crhs
  process takes of a node, normally the baseline) only records its starting value; that sample has no
  delta or rate for it.
- **A counter that went backwards** (an interface reset, a core taken offline and back) records the new
  value as its start, and that sample has no delta for it. A negative delta is never stored.
- **A missing counter** keeps its previous value, so the next sample that has it computes from there.
- **A new `bootId`** clears every previous value of the node: counters restart at boot.
- `cpu.total` and `cpu.core.<n>` are `Δbusy / Δtotal` between two samples. The `cpu` line counts the
  online cores only, so a core going offline can make it fall; that sample has no `cpu.total`.
- Network deltas are summed over the selected interfaces after each interface's own delta, so an
  interface appearing does not count its whole history as one minute's traffic, and one disappearing
  does not make the total fall. Each interface's rate is its delta divided by the time since its own
  previous counters on crhs's monotonic clock, so a sample that missed it does not double its rate; the
  node's rates are the sum.

The previous values live in memory. The baseline sample ([Collection](#collection)) restores them after
a crhs restart or a node reboot, before the node's next slot; only an SSH node whose baseline fails loses
that one slot's deltas and rates.

### Series changes

- A filesystem is identified by its configured name, not its device or path: replacing a disk or moving
  the mount under the same name continues the series; renaming starts a new one.
- A core is identified by its index; a resized VM gains or stops series.
- Network traffic is one aggregate whatever the interfaces, so its series never change.
- A series that stops receiving values keeps its stored buckets until retention removes them. Nothing is
  backfilled: a bucket a series was absent from has no row.

## Storage

Two tables, created by a migration on SQLite and PostgreSQL:

- `metric_series`: `id`, `node_id`, `name`, `kind` (`gauge` or `delta`), `first_seen_at`, `last_seen_at`;
  unique on `(node_id, name)`. Deleting a node deletes its series and their buckets. `last_seen_at` is
  written at most once per level-2 bucket, so the WebUI can mark a stopped series without a write per
  sample.
- `metric_buckets`: `series_id`, `level`, `bucket_start`, `count`, `sum`, `min`, `max`, `last`; primary
  key `(series_id, level, bucket_start)`, and an index on `(level, bucket_start)` for retention. For a
  delta, `sum` is the total and `min`/`max` the smallest and largest single delta.

Each value is written into the current bucket of every level it is kept at: `count` and `sum` add,
`min` and `max` compare, `last` is replaced. There is no rollup job, so every level is current as soon as
a sample is written, and a crash cannot leave a level half folded. crhs buffers the samples and writes
them every 5 seconds in one transaction, and once more at shutdown; a crash loses at most those seconds.

A flush resolves and inserts series and upserts the buckets in multi-row statements, so its cost follows
the number of chunks rather than of series. The transaction first drops the samples of nodes deleted since
they were recorded, because their series cascaded away. A failed flush clears the series id cache and
retries once; samples that fail a second time are dropped and logged. At most 200,000 values are buffered:
past that, the oldest samples are dropped and the count is logged at the next flush.

| Level | Bucket | Retention (default) | Setting |
|---|---|---|---|
| 1 | 1 minute | 24 hours | `metrics.retention.l1` |
| 2 | 5 minutes | 7 days | `metrics.retention.l2` |
| 3 | 1 hour | 30 days | `metrics.retention.l3` |
| 4 | 1 day | 365 days | `metrics.retention.l4` |

`cpu.core.<n>` is kept at level 1 only; levels 2–4 hold `cpu.total`. Per-core history past a day is rarely
read and grows with the core count.

The hourly retention sweep ([Retention](data-model.md#retention)) deletes, in batches, the buckets that
ended longer ago than their level's retention, and the series that have no buckets left. A bucket is
always whole: the sweep never trims one.

### Size

Measured with a node of 8 cores, 3 filesystems and the aggregate network (33 series), every level full:

| | SQLite | PostgreSQL |
|---|---|---|
| Per node | ~6.7 MB | ~14 MB |
| 100 nodes | ~0.67 GB | ~1.4 GB |
| 500 nodes | ~3.4 GB | ~7 GB |

Each extra filesystem adds about 0.4 MB per node on SQLite. More cores add only to level 1. The interval
changes the number of pulls and each bucket's `count`, not the stored size: it is at most a minute, so
every level-1 bucket is filled. With every level written at
once, 100 nodes upsert about 9,000 rows a minute in 12 transactions.

## Reading

- **API.** `GET /api/nodes/:id/metrics?series=…&from=…&to=…` returns the buckets of the coarsest level
  whose retention covers `from` and whose bucket gives at least 200 points in the range, or a level the
  caller names. Users see the metrics of the nodes they have node access to; administrators see every
  node's.
- **Latest sample.** crhs keeps each node's latest sample in memory, and the node list returns its CPU
  and memory figures and time from there, without reading buckets. After a restart a node has none until
  its first sample.
- **WebUI.** The node page shows CPU, load, memory, filesystems, network and availability charts for
  1 hour, 24 hours, 7 days, 30 days or 365 days, and the node list a small CPU and memory figure from the
  latest sample. A series that stopped is drawn up to its last value, with its last-seen time.
- **Agent tool.** `node_metrics(node, series, range)` returns, per series, the minimum, average, maximum
  and last value over the range and at most 60 points. It reads stored data, so like `node_info` it
  needs node access and no rule decision.

## Settings

System settings, in a `metrics` group:

| Setting | Default |
|---|---|
| `metrics.enabled` | on |
| `metrics.interval` | 60 seconds; 15, 20, 30 or 60 |
| `metrics.retention.l1` … `l4` | As in [Storage](#storage); each at least 10 buckets of its level, and each level at least as long as the one before it |

Turning collection off stops the pulls; stored data stays until retention removes it. A changed interval
applies from the next tick. Shortening a retention takes effect at the next sweep.

## Limits

At most 1024 cores, 64 filesystems and 256 interfaces per sample. crha drops the rest before answering,
and crhs refuses an answer beyond them as malformed. These also bound a node's series.

## Documents that change with this design

- [Protocol](protocol.md): minor 2 and the optional `metrics.collect` command.
- [Execution plane](execution.md): the SSH metrics script on the pooled connection.
- [Data model](data-model.md): `metric_series`, `metric_buckets` and their retention.
- [Agent runtime](agent-runtime.md): `node_metrics`.
- [Access control](access-control.md): metrics follow node access.
- [WebUI](webui.md): the node page charts and the node list figures.
- [Architecture](architecture.md): metrics leave the "not implemented" list; monitoring and alerting
  stay.
- [Compatibility](compatibility.md): nothing new; the tables come by an appended migration and the
  `crha.toml` keys are optional.
- [crha configuration](../guide/reference/crha-config.md), [crhs configuration](../guide/reference/crhs-config.md)
  and the [WebUI guide](../guide/webui.md): `[metrics]`, the settings and the charts, when they are
  implemented.
