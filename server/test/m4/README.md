# M4 特权模式测试环境

这里是 M4 的 podman 测试环境说明，尚未实现 fixture；计划用 rootless podman 跑真实的
crha 非特权/特权模式、unix socket、sudo 和 sshd。

## 镜像

建议基于 `ubuntu:24.04`，安装：

- `openssh-server`
- `sudo`
- `ca-certificates`
- 创建非特权用户 `crha`
- 特权模式以 root 运行
- `/run/crha/privileged.sock`：`root:crha`，0660
- 特权状态目录：`/var/lib/crha/privileged/{used,revoked}`
- 本地日志：`/var/log/crha/privileged.jsonl`
- sshd 监听 2222（SSH 节点测试）

目录中未来包含：

```text
server/test/m4/
  README.md
  Containerfile
  fixtures/        # 测试用 trust、SSH key、授权
```

## 运行方式（计划）

```bash
podman build -t crh-m4 -f server/test/m4/Containerfile server/test/m4
podman run --rm -d --name crh-m4 \
  -p 2222:22 \
  -v "$PWD/.tmp/m4:/work" \
  crh-m4
```

非特权模式以 `crha` 用户启动，特权模式以 root 启动；两者通过挂载的 socket 目录通信。
crhs 在宿主机运行，使用容器映射的端口连接。

rootless podman 已验证可用；`sudo` 的 setuid、socket 的 peer uid 和 sshd 端口映射需要在
fixture 建立时先做最小原型验证。

## 测试开关

podman e2e 默认跳过：

```bash
CRH_TEST_PODMAN=1 pnpm --filter @crh/server test:e2e
```

纯 Go/TS 单测（CBOR、SSHSIG、trust 校验、路径安全、批量输出预算）不需要 podman。

## 覆盖范围

1. `forward` + crhs execute：exec/file 成功。
2. `forward` 只信任 user：crhs 无法单独提权；用户签名后成功。
3. `require-cosign`：同一 payload 缺用户签名或 crhs 联署均失败。
4. `local`：`crha approve`；未批准不执行。
5. `native`（sudo -n）、`ignore`、`reject`。
6. 吊销、一次性授权重放、used 持久化、节点重启。
7. 符号链接路径、env、prefix 规则绕过。
8. SSH ignore + 输出提示；SFTP `file.*` 仍可用。
9. TrustSummary 变化和缓存失效。
10. 批量 status/text 输出及内存上限。

完整设计见 [doc/m4.md](../../../doc/m4.md) 和 [doc/privilege.md](../../../doc/privilege.md)。
