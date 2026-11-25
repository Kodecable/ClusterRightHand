# README screenshots

Regenerates the images the READMEs show: `doc/images/hero.*.png` (the desktop session with a phone
signing on top), `node-metrics.*.png` (db-1's Metrics tab over the last hour) and `node-trust.*.png`, in
English and Chinese.

```sh
node scripts/readme-shots/run.mjs            # shots in the printed work dir, nothing in the repo changes
node scripts/readme-shots/run.mjs --write    # also copy them into doc/images
node scripts/readme-shots/run.mjs --locale zh-CN --keep   # one locale, leave the cluster running
node scripts/readme-shots/run.mjs --down /tmp/crh-readme-shots-XXXX   # remove a kept cluster
```

It needs podman, go, openssl, ssh-keygen, sqlite3 and the web workspace's Playwright Chromium.

For each locale it starts a throwaway cluster on its own podman network: crhs from this checkout, three
crha nodes (web-1, db-1, app-1) and an SSH node (ssh-1) on the privileged system suite's image, and a
scripted model. Nothing needs a real model or the demo cluster:

- `fake-model.mjs` answers Chat Completions requests from a script, chosen by the first user message and
  the number of tool calls so far, so each run tells the same story in the right language. The commands
  themselves run on the real nodes.
- `cluster.mjs` sets crhs up (a generated admin password, sign-in without the proof of work, the
  account language, a 15-second metrics interval), registers a generated SSH signing key and enrolls the
  nodes. db-1 trusts only the admin, so its privileged command waits for a signature. Once every node has
  two real metrics samples and a real network rate (the network series only appear with the second full
  sample), it seeds the history described below. After the restart it waits for three distinct minute
  buckets of samples per node, so the first post-restart rate is never the chart's newest point.
- `seed-metrics.ts` fills the hour the Metrics tab shows before the cluster existed. `cluster.mjs` stops
  crhs, runs it in the same image with the same mounts, and starts crhs again. It opens the same SQLite
  database with the server's storage layer and calls `MetricsStore.record` for each of the 65 minutes
  before the first real slot, then flushes. The values follow the node's real latest sample (memory,
  swap and disk totals, uptime counting back from the real value) and are deterministic from the node
  name: CPU with two spikes, load smoothed from it, drifting memory and disk usage, a network baseline of
  tens of KiB/s with three bursts, and `up = 1` every minute. A slot that already holds a real sample is
  never written. The synthetic part is only the history older than the cluster's first real sample; crhs
  restarts afterwards and real collection continues to its right.
- `shoot.mjs` registers a Passkey on a Chromium virtual authenticator, adds it to db-1's trust, runs the
  two sessions (approving ordinary commands as they come) and takes the session, node-trust and
  node-metrics desktop shots and the phone shot.
- `compose.mjs` lays the desktop session and phone shots out as the hero image.

The scripts are a tool for the README, not part of the product or CI: when the UI changes, adjust the
selectors in `shoot.mjs` and the transcript in `fake-model.mjs`.
