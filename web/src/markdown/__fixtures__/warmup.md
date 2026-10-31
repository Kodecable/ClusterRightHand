# Warm-up

One short fence per language, to load every grammar chunk.

```bash
set -euo pipefail
NAMESPACE=${NAMESPACE:-prod}
kubectl -n "$NAMESPACE" rollout status deploy/api --timeout=120s
kubectl -n "$NAMESPACE" get pods -l app=api -o wide
echo "rollout of api in $NAMESPACE complete"
```

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

```ini
[api]
host = 0.0.0.0
port = 8080
log_level = info

[telemetry]
endpoint = https://otel.acme.internal:4317
sample_rate = 0.25
```

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

```ansi
[32mINFO[0m  controller  starting reconcile loop
[34mDEBUG[0m watcher     resync period 30s
[33mWARN[0m  deploy      api rollout 2/3 ready
[31mERROR[0m probe       readiness failed: connection refused
[38;5;214mTRACE[0m http        GET /healthz 200 3ms
[1;36mINFO[0m  scheduler   placed api-2 on worker-02
[31;1mFATAL[0m kubelet     node worker-03 not ready
```

```robot
START JOB scan.prod
  MOVE ARM 12 4
  IF SENSOR > 0.5 THEN
    REPORT "hot"
  END
END JOB
```
