# M4 特权模式测试环境

这里是 M4 的 podman 测试环境说明，尚未实现 fixture。目标是用 rootless podman 跑真实的
crha 非特权/特权模式、unix socket、sudo 和 sshd。

## 镜像

基于 `ubuntu:24.04`，安装 `openssh-server`、`sudo`、`ca-certificates`，并准备：

- 非特权用户 `crha`；
- 特权模式以 root 运行；
- `/run/crha/privileged.sock`：`root:crha`，0660；
- 特权状态目录：`/var/lib/crha/privileged/{used,revoked}`；
- 本地日志：`/var/log/crha/privileged.jsonl`；
- sshd 在容器内监听 `2222`（不是 22）。

目录中未来包含：

```text
server/test/m4/
  README.md
  Containerfile
  entrypoint.sh
  fixtures/        # 只放 SSH key、trust 模板；授权运行时生成
```

## 进程管理

一个容器内跑三个进程：

1. root 的 `crha privileged run`；
2. `crha` 用户的 `crha run`；
3. sshd。

不依赖 systemd；用 `entrypoint.sh` 启动并等待它们，收到 SIGTERM 时按相反顺序停止。
privileged socket 在容器内创建，不需要挂载。

## 运行方式（计划）

```bash
podman build -t crh-m4 -f server/test/m4/Containerfile server/test/m4

# crhs 在宿主机监听某个端口；容器用 host network，sshd 直接监听 2222。
podman run --rm -d --name crh-m4 --network=host \
  -e CRHS_URL=http://127.0.0.1:<crhs-port> \
  crh-m4
```

连接方向：

- **crhs 监听**，**容器内的 crha 主动连接 crhs**；
- 容器使用 host network 时，crhs 地址是 `127.0.0.1:<port>`；不用 `-p` 映射；
- SSH 节点测试是 crhs 主动连接容器内的 sshd `127.0.0.1:2222`。

rootless podman 已验证可用；`sudo` 的 setuid、socket 的 peer uid 和 sshd 需要在
fixture 建立时先做最小原型验证。

## 测试入口

`@crh/server` 的 `test:e2e` 只跑 `test/e2e`，不会包含 `test/m4`。M4 fixture 完成后应提供：

```bash
# 计划中的专用脚本（需要在 server/package.json 中新增）
CRH_TEST_PODMAN=1 pnpm --filter @crh/server test:m4
```

或在实现前临时使用：

```bash
CRH_TEST_PODMAN=1 pnpm --filter @crh/server exec vitest run test/m4
```

没有 `CRH_TEST_PODMAN=1` 时全部跳过。

## fixtures

`fixtures/` 只放：

- 测试用 SSH key；
- trust 模板 / 公钥；
- 容器配置模板。

带 `deadline` 或 `task_id` 的授权必须在测试运行时现场签发；预签授权会过期，不能作为 fixture。

覆盖范围、阶段和断言只保留在 [doc/m4.md](../../../doc/m4.md)，这里不重复维护矩阵。
