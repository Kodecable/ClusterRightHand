# ClusterRightHand incident brief — doc-20k

This brief was assembled automatically from the **ops agent** transcript, the *incident*
channel and the `kubectl` audit log. Start with [the runbook][runbook] and the
[dashboards][dashboards]; the raw export is linked in [the incident log][incident-log].

## Summary

**Observation 1.** The restart count on `worker-01` stayed above target for *7 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-01` and scaled the deployment after 5 attempts. The root cause was a misconfigured probe, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

**Observation 2.** The queue depth on `worker-02` stayed above target for *23 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-02` and scaled the deployment after 2 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

Overview of the rollout
=======================

**Observation 3.** The restart count on `etcd-0` stayed above target for *29 minutes*; the on-call rotated through `kubectl -n prod describe pod/etcd-0` and rotated the certificate after 6 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

What changed
------------

**Observation 4.** The queue depth on `worker-03` stayed above target for *25 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-03` and rolled back the image after 5 attempts. The root cause was a misconfigured probe, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

### Lists

- controller loop
  - reconcile every 30s
  - resync every 5m
    - *deep* nesting level three
    - second item at level three
- watcher
  1. list pods
  2. watch events
  3. record metrics

- [x] drain worker-03
- [x] verify pod disruption budgets
- [ ] re-run the canary

> The agent decided to halt the rollout after **two** failed health checks.
>
> > Nested quote: the on-call confirmed the pause at 14:02 UTC.


### Tables

## Signals

| Service | Replicas | Ready |
| --- | ---: | :---: |
| api | 3 | yes |
| worker | 5 | yes |
| ingest | 2 | no |

| Metric | p50 | p95 | p99 |
| --- | --- | --- | --- |
| `http_request_duration_seconds` | 0.04 | 0.31 | 1.82 |
| `queue_wait_seconds` | 0.01 | 0.09 | 0.44 |
| `etcd_disk_wal_fsync_seconds` | 0.002 | 0.011 | 0.061 |
| `kubelet_pod_start_seconds` | 0.8 | 2.4 | 7.9 |

### Wide table

| zone | region | node | pods | cpu | mem | disk | net | p99 | errors | restarts | age |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eu-west-1a | eu-west | worker-01 | 42 | 61% | 74% | 12% | 340 Mbps | 0.21s | 0 | 0 | 42d |
| eu-west-1b | eu-west | worker-02 | 38 | 58% | 69% | 9% | 210 Mbps | 0.19s | 1 | 0 | 42d |
| eu-west-1c | eu-west | worker-03 | 51 | 77% | 81% | 31% | 120 Mbps | 1.94s | 14 | 3 | 11d |
| us-east-1a | us-east | worker-04 | 33 | 44% | 52% | 6% | 470 Mbps | 0.12s | 0 | 0 | 42d |
| us-east-1b | us-east | worker-05 | 29 | 39% | 47% | 5% | 390 Mbps | 0.11s | 0 | 0 | 42d |


## Code samples

#### bash

```bash
set -euo pipefail
NAMESPACE=${NAMESPACE:-prod}
kubectl -n "$NAMESPACE" rollout status deploy/api --timeout=120s
kubectl -n "$NAMESPACE" get pods -l app=api -o wide
echo "rollout of api in $NAMESPACE complete"
```

#### shellsession

```shellsession
$ kubectl get nodes
NAME        STATUS   ROLES    AGE   VERSION
worker-01   Ready    <none>   42d   v1.32.4
worker-02   Ready    <none>   42d   v1.32.4
$ kubectl describe node worker-01 | head -4
Name:               worker-01
Roles:              <none>
Labels:             kubernetes.io/hostname=worker-01
```

#### json

```json
{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": "api", "namespace": "prod" },
  "spec": {
    "replicas": 3,
    "template": {
      "spec": { "containers": [{ "name": "api", "image": "ghcr.io/acme/api:1.4.2" }] }
    }
  }
}
```

#### yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 3
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
```

#### diff

```diff
--- a/deploy/api.yaml
+++ b/deploy/api.yaml
@@ -12,7 +12,7 @@ spec:
   replicas: 3
-  image: ghcr.io/acme/api:1.4.1
+  image: ghcr.io/acme/api:1.4.2
   resources:
     limits: { cpu: 500m, memory: 512Mi }
```

#### ini

```ini
[api]
host = 0.0.0.0
port = 8080
log_level = info

[telemetry]
endpoint = https://otel.acme.internal:4317
sample_rate = 0.25
```

#### toml

```toml
[service]
name = "api"
port = 8080

[limits]
cpu = "500m"
memory = "512Mi"

[[probes]]
path = "/healthz"
period = "10s"
```

#### dockerfile

```dockerfile
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
FROM node:26-alpine
COPY --from=build /app/dist /app/dist
CMD ["node", "dist/server.js"]
```

#### python

```python
import json
import os
from pathlib import Path

def load_manifest(path: str) -> dict:
    data = json.loads(Path(path).read_text())
    data.setdefault("replicas", 3)
    return data

if __name__ == "__main__":
    print(load_manifest(os.environ["MANIFEST"]))
```

#### go

```go
package main

import "fmt"

func main() {
	pods := []string{"api-0", "api-1", "api-2"}
	for i, pod := range pods {
		fmt.Printf("%d: %s ready\n", i, pod)
	}
}
```

#### typescript

```typescript
type Rollout = { name: string; replicas: number; image: string };

export async function rollout(deploy: Rollout): Promise<void> {
  const res = await fetch(`/api/v1/deployments/${deploy.name}`, {
    method: "PATCH",
    body: JSON.stringify({ replicas: deploy.replicas, image: deploy.image }),
  });
  if (!res.ok) throw new Error(`rollout failed: ${res.status}`);
}
```

#### javascript

```javascript
const poll = async (url, tries = 5) => {
  for (let i = 0; i < tries; i += 1) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out");
};
```

#### sql

```sql
SELECT d.name,
       count(*) FILTER (WHERE p.phase = 'Running') AS running,
       max(p.restart_count) AS restarts
FROM deployments d
JOIN pods p ON p.deployment_id = d.id
WHERE d.namespace = 'prod'
GROUP BY d.name
ORDER BY restarts DESC;
```

#### nginx

```nginx
upstream api {
  server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
  server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
}

server {
  listen 443 ssl http2;
  server_name api.acme.internal;
  location / { proxy_pass http://api; proxy_read_timeout 60s; }
}
```

#### ansi

```ansi
[32mINFO[0m  controller  starting reconcile loop
[34mDEBUG[0m watcher     resync period 30s
[33mWARN[0m  deploy      api rollout 2/3 ready
[31mERROR[0m probe       readiness failed: connection refused
[38;5;214mTRACE[0m http        GET /healthz 200 3ms
[1;36mINFO[0m  scheduler   placed api-2 on worker-02
[31;1mFATAL[0m kubelet     node worker-03 not ready
```

#### unknown language (robot)

```robot
START JOB scan.prod
  MOVE ARM 12 4
  IF SENSOR > 0.5 THEN
    REPORT "hot"
  END
END JOB
```

## Generated tuning module

The scheduler ships a 380-line generated constants file:

```python
# generated tuning constants for the scheduler (do not edit)
TUNE_0001 = 1
TUNE_0002 = 2
TUNE_0003 = 3
TUNE_0004 = 4
TUNE_0005 = 5
TUNE_0006 = 6
TUNE_0007 = 7
TUNE_0008 = 8
TUNE_0009 = 9
TUNE_0010 = 10
TUNE_0011 = 11
TUNE_0012 = 12
TUNE_0013 = 13
TUNE_0014 = 14
TUNE_0015 = 15
TUNE_0016 = 16
TUNE_0017 = 17
TUNE_0018 = 18
TUNE_0019 = 19
TUNE_0020 = 20
TUNE_0021 = 21
TUNE_0022 = 22
TUNE_0023 = 23
TUNE_0024 = 24
TUNE_0025 = 25
TUNE_0026 = 26
TUNE_0027 = 27
TUNE_0028 = 28
TUNE_0029 = 29
TUNE_0030 = 30
TUNE_0031 = 31
TUNE_0032 = 32
TUNE_0033 = 33
TUNE_0034 = 34
TUNE_0035 = 35
TUNE_0036 = 36
TUNE_0037 = 37
TUNE_0038 = 38
TUNE_0039 = 39
TUNE_0040 = 40
TUNE_0041 = 41
TUNE_0042 = 42
TUNE_0043 = 43
TUNE_0044 = 44
TUNE_0045 = 45
TUNE_0046 = 46
TUNE_0047 = 47
TUNE_0048 = 48
TUNE_0049 = 49
TUNE_0050 = 50
TUNE_0051 = 51
TUNE_0052 = 52
TUNE_0053 = 53
TUNE_0054 = 54
TUNE_0055 = 55
TUNE_0056 = 56
TUNE_0057 = 57
TUNE_0058 = 58
TUNE_0059 = 59
TUNE_0060 = 60
TUNE_0061 = 61
TUNE_0062 = 62
TUNE_0063 = 63
TUNE_0064 = 64
TUNE_0065 = 65
TUNE_0066 = 66
TUNE_0067 = 67
TUNE_0068 = 68
TUNE_0069 = 69
TUNE_0070 = 70
TUNE_0071 = 71
TUNE_0072 = 72
TUNE_0073 = 73
TUNE_0074 = 74
TUNE_0075 = 75
TUNE_0076 = 76
TUNE_0077 = 77
TUNE_0078 = 78
TUNE_0079 = 79
TUNE_0080 = 80
TUNE_0081 = 81
TUNE_0082 = 82
TUNE_0083 = 83
TUNE_0084 = 84
TUNE_0085 = 85
TUNE_0086 = 86
TUNE_0087 = 87
TUNE_0088 = 88
TUNE_0089 = 89
TUNE_0090 = 90
TUNE_0091 = 91
TUNE_0092 = 92
TUNE_0093 = 93
TUNE_0094 = 94
TUNE_0095 = 95
TUNE_0096 = 96
TUNE_0097 = 0
TUNE_0098 = 1
TUNE_0099 = 2
TUNE_0100 = 3
TUNE_0101 = 4
TUNE_0102 = 5
TUNE_0103 = 6
TUNE_0104 = 7
TUNE_0105 = 8
TUNE_0106 = 9
TUNE_0107 = 10
TUNE_0108 = 11
TUNE_0109 = 12
TUNE_0110 = 13
TUNE_0111 = 14
TUNE_0112 = 15
TUNE_0113 = 16
TUNE_0114 = 17
TUNE_0115 = 18
TUNE_0116 = 19
TUNE_0117 = 20
TUNE_0118 = 21
TUNE_0119 = 22
TUNE_0120 = 23
TUNE_0121 = 24
TUNE_0122 = 25
TUNE_0123 = 26
TUNE_0124 = 27
TUNE_0125 = 28
TUNE_0126 = 29
TUNE_0127 = 30
TUNE_0128 = 31
TUNE_0129 = 32
TUNE_0130 = 33
TUNE_0131 = 34
TUNE_0132 = 35
TUNE_0133 = 36
TUNE_0134 = 37
TUNE_0135 = 38
TUNE_0136 = 39
TUNE_0137 = 40
TUNE_0138 = 41
TUNE_0139 = 42
TUNE_0140 = 43
TUNE_0141 = 44
TUNE_0142 = 45
TUNE_0143 = 46
TUNE_0144 = 47
TUNE_0145 = 48
TUNE_0146 = 49
TUNE_0147 = 50
TUNE_0148 = 51
TUNE_0149 = 52
TUNE_0150 = 53
TUNE_0151 = 54
TUNE_0152 = 55
TUNE_0153 = 56
TUNE_0154 = 57
TUNE_0155 = 58
TUNE_0156 = 59
TUNE_0157 = 60
TUNE_0158 = 61
TUNE_0159 = 62
TUNE_0160 = 63
TUNE_0161 = 64
TUNE_0162 = 65
TUNE_0163 = 66
TUNE_0164 = 67
TUNE_0165 = 68
TUNE_0166 = 69
TUNE_0167 = 70
TUNE_0168 = 71
TUNE_0169 = 72
TUNE_0170 = 73
TUNE_0171 = 74
TUNE_0172 = 75
TUNE_0173 = 76
TUNE_0174 = 77
TUNE_0175 = 78
TUNE_0176 = 79
TUNE_0177 = 80
TUNE_0178 = 81
TUNE_0179 = 82
TUNE_0180 = 83
TUNE_0181 = 84
TUNE_0182 = 85
TUNE_0183 = 86
TUNE_0184 = 87
TUNE_0185 = 88
TUNE_0186 = 89
TUNE_0187 = 90
TUNE_0188 = 91
TUNE_0189 = 92
TUNE_0190 = 93
TUNE_0191 = 94
TUNE_0192 = 95
TUNE_0193 = 96
TUNE_0194 = 0
TUNE_0195 = 1
TUNE_0196 = 2
TUNE_0197 = 3
TUNE_0198 = 4
TUNE_0199 = 5
TUNE_0200 = 6
TUNE_0201 = 7
TUNE_0202 = 8
TUNE_0203 = 9
TUNE_0204 = 10
TUNE_0205 = 11
TUNE_0206 = 12
TUNE_0207 = 13
TUNE_0208 = 14
TUNE_0209 = 15
TUNE_0210 = 16
TUNE_0211 = 17
TUNE_0212 = 18
TUNE_0213 = 19
TUNE_0214 = 20
TUNE_0215 = 21
TUNE_0216 = 22
TUNE_0217 = 23
TUNE_0218 = 24
TUNE_0219 = 25
TUNE_0220 = 26
TUNE_0221 = 27
TUNE_0222 = 28
TUNE_0223 = 29
TUNE_0224 = 30
TUNE_0225 = 31
TUNE_0226 = 32
TUNE_0227 = 33
TUNE_0228 = 34
TUNE_0229 = 35
TUNE_0230 = 36
TUNE_0231 = 37
TUNE_0232 = 38
TUNE_0233 = 39
TUNE_0234 = 40
TUNE_0235 = 41
TUNE_0236 = 42
TUNE_0237 = 43
TUNE_0238 = 44
TUNE_0239 = 45
TUNE_0240 = 46
TUNE_0241 = 47
TUNE_0242 = 48
TUNE_0243 = 49
TUNE_0244 = 50
TUNE_0245 = 51
TUNE_0246 = 52
TUNE_0247 = 53
TUNE_0248 = 54
TUNE_0249 = 55
TUNE_0250 = 56
TUNE_0251 = 57
TUNE_0252 = 58
TUNE_0253 = 59
TUNE_0254 = 60
TUNE_0255 = 61
TUNE_0256 = 62
TUNE_0257 = 63
TUNE_0258 = 64
TUNE_0259 = 65
TUNE_0260 = 66
TUNE_0261 = 67
TUNE_0262 = 68
TUNE_0263 = 69
TUNE_0264 = 70
TUNE_0265 = 71
TUNE_0266 = 72
TUNE_0267 = 73
TUNE_0268 = 74
TUNE_0269 = 75
TUNE_0270 = 76
TUNE_0271 = 77
TUNE_0272 = 78
TUNE_0273 = 79
TUNE_0274 = 80
TUNE_0275 = 81
TUNE_0276 = 82
TUNE_0277 = 83
TUNE_0278 = 84
TUNE_0279 = 85
TUNE_0280 = 86
TUNE_0281 = 87
TUNE_0282 = 88
TUNE_0283 = 89
TUNE_0284 = 90
TUNE_0285 = 91
TUNE_0286 = 92
TUNE_0287 = 93
TUNE_0288 = 94
TUNE_0289 = 95
TUNE_0290 = 96
TUNE_0291 = 0
TUNE_0292 = 1
TUNE_0293 = 2
TUNE_0294 = 3
TUNE_0295 = 4
TUNE_0296 = 5
TUNE_0297 = 6
TUNE_0298 = 7
TUNE_0299 = 8
TUNE_0300 = 9
TUNE_0301 = 10
TUNE_0302 = 11
TUNE_0303 = 12
TUNE_0304 = 13
TUNE_0305 = 14
TUNE_0306 = 15
TUNE_0307 = 16
TUNE_0308 = 17
TUNE_0309 = 18
TUNE_0310 = 19
TUNE_0311 = 20
TUNE_0312 = 21
TUNE_0313 = 22
TUNE_0314 = 23
TUNE_0315 = 24
TUNE_0316 = 25
TUNE_0317 = 26
TUNE_0318 = 27
TUNE_0319 = 28
TUNE_0320 = 29
TUNE_0321 = 30
TUNE_0322 = 31
TUNE_0323 = 32
TUNE_0324 = 33
TUNE_0325 = 34
TUNE_0326 = 35
TUNE_0327 = 36
TUNE_0328 = 37
TUNE_0329 = 38
TUNE_0330 = 39
TUNE_0331 = 40
TUNE_0332 = 41
TUNE_0333 = 42
TUNE_0334 = 43
TUNE_0335 = 44
TUNE_0336 = 45
TUNE_0337 = 46
TUNE_0338 = 47
TUNE_0339 = 48
TUNE_0340 = 49
TUNE_0341 = 50
TUNE_0342 = 51
TUNE_0343 = 52
TUNE_0344 = 53
TUNE_0345 = 54
TUNE_0346 = 55
TUNE_0347 = 56
TUNE_0348 = 57
TUNE_0349 = 58
TUNE_0350 = 59
TUNE_0351 = 60
TUNE_0352 = 61
TUNE_0353 = 62
TUNE_0354 = 63
TUNE_0355 = 64
TUNE_0356 = 65
TUNE_0357 = 66
TUNE_0358 = 67
TUNE_0359 = 68
TUNE_0360 = 69
TUNE_0361 = 70
TUNE_0362 = 71
TUNE_0363 = 72
TUNE_0364 = 73
TUNE_0365 = 74
TUNE_0366 = 75
TUNE_0367 = 76
TUNE_0368 = 77
TUNE_0369 = 78
TUNE_0370 = 79
TUNE_0371 = 80
TUNE_0372 = 81
TUNE_0373 = 82
TUNE_0374 = 83
TUNE_0375 = 84
TUNE_0376 = 85
TUNE_0377 = 86
TUNE_0378 = 87
TUNE_0379 = 88
TUNE_0380 = 89
```
## Observation 10
**Observation 10.** The p99 latency on `ingress-7f9c` stayed above target for *15 minutes*; the on-call rotated through `kubectl -n prod describe pod/ingress-7f9c` and scaled the deployment after 6 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 11.** The error rate on `worker-01` stayed above target for *36 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-01` and rotated the certificate after 4 attempts. The root cause was a misconfigured probe, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

## Observation 11
**Observation 11.** The p99 latency on `api-1` stayed above target for *16 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and scaled the deployment after 4 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 12.** The error rate on `api-1` stayed above target for *53 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and rolled back the image after 6 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

## Observation 12
**Observation 12.** The CPU saturation on `ingress-7f9c` stayed above target for *52 minutes*; the on-call rotated through `kubectl -n prod describe pod/ingress-7f9c` and rolled back the image after 4 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 13.** The p99 latency on `worker-03` stayed above target for *3 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-03` and drained the node after 5 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
- first check: `kubectl get events -A --field-selector reason=FailedMount`
- second check: dashboards for **error rate**
  - nested: compare against the 7 day baseline
  - nested: confirm the rollout window
1. capture the evidence bundle
2. page the service owner
3. open an incident in the tracker

> scaled the deployment while the error rate was still elevated.
>
> The follow-up ticket references [the dashboard][dashboards].

- [x] confirm the alert fired
- [x] attach `journalctl -u kubelet --since -15min`
- [ ] write the postmortem


## Observation 13
**Observation 13.** The error rate on `api-1` stayed above target for *26 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and drained the node after 7 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 14.** The memory pressure on `etcd-0` stayed above target for *18 minutes*; the on-call rotated through `kubectl -n prod describe pod/etcd-0` and drained the node after 3 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

## Observation 14
**Observation 14.** The error rate on `worker-01` stayed above target for *55 minutes*; the on-call rotated through `kubectl -n prod describe pod/worker-01` and replayed the event log after 6 attempts. The root cause was an OOM kill, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 15.** The CPU saturation on `api-0` stayed above target for *15 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-0` and replayed the event log after 3 attempts. The root cause was a partial write, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

## Observation 15
**Observation 15.** The memory pressure on `ingress-7f9c` stayed above target for *29 minutes*; the on-call rotated through `kubectl -n prod describe pod/ingress-7f9c` and rotated the certificate after 2 attempts. The root cause was a noisy neighbour, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 16.** The p99 latency on `ingress-7f9c` stayed above target for *50 minutes*; the on-call rotated through `kubectl -n prod describe pod/ingress-7f9c` and drained the node after 3 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
- first check: `kubectl get events -A --field-selector reason=FailedMount`
- second check: dashboards for **memory pressure**
  - nested: compare against the 7 day baseline
  - nested: confirm the rollout window
1. capture the evidence bundle
2. page the service owner
3. open an incident in the tracker

> drained the node while the error rate was still elevated.
>
> The follow-up ticket references [the dashboard][dashboards].


## Observation 16
**Observation 16.** The queue depth on `etcd-0` stayed above target for *49 minutes*; the on-call rotated through `kubectl -n prod describe pod/etcd-0` and replayed the event log after 2 attempts. The root cause was a noisy neighbour, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 17.** The p99 latency on `api-1` stayed above target for *35 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and drained the node after 7 attempts. The root cause was a misconfigured probe, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
- [x] confirm the alert fired
- [x] attach `journalctl -u kubelet --since -15min`
- [ ] write the postmortem


## Observation 17
**Observation 17.** The queue depth on `api-1` stayed above target for *3 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and rotated the certificate after 4 attempts. The root cause was a partial write, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.
**Observation 18.** The memory pressure on `api-1` stayed above target for *15 minutes*; the on-call rotated through `kubectl -n prod describe pod/api-1` and rotated the certificate after 6 attempts. The root cause was a stale leader lease, and the rollback was verified with [the runbook][runbook] plus `curl -fsS http://127.0.0.1:9000/healthz`.

## References

The links below use reference-style syntax and their definitions live at the very end of
the document, exactly as an LLM that emits "sources" last would produce them. See
[the runbook][runbook], [the dashboards][dashboards] and [the incident log][incident-log].

[runbook]: https://runbooks.acme.internal/clusterright/hand
[dashboards]: https://grafana.acme.internal/d/clusterright/rollout
[incident-log]: https://incidents.acme.internal/INC-4127
