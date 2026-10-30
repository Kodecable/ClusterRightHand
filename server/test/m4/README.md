# M4 特权模式测试环境

这里是 M4 的 podman 端到端矩阵（[doc/m4.md](../../../doc/m4.md) 的「podman e2e」1–11 项）：
真实 `crha run`（uid 998）、真实 `crha privileged run`（root，unix socket）、真实
sudo / doas / sshd，对端是本进程内的 crhs（`server/test/e2e/harness.ts` 的 `InProcessCrhs`）。

## 文件

```text
server/test/m4/
  README.md
  Containerfile        # ubuntu:24.04 + sudo/opendoas/openssh-server/crha 用户
  entrypoint.sh        # 启动/停止三个进程，等待 .ready
  m4ctl.sh             # 容器内的进程控制（启动、停止、重启、SIGHUP、清状态）
  fixtures/sshd_config # 容器内 sshd 的完整配置（2222，仅回环）
  harness.ts           # podman 容器 + crhs 节点 + 授权签名的辅助代码
  native.test.ts       # 项 1、2
  forward.test.ts      # 项 3–8、10
  ssh.test.ts          # 项 9
  groups.test.ts       # 项 11
```

`fixtures/` 只有静态配置；带 `deadline` / `task_id` 的授权都在测试运行时现场签发。

## 镜像与 crha

`ubuntu:24.04`，安装 `openssh-server`、`sudo`、`opendoas`、`ca-certificates`、`util-linux`，
建 uid/gid 998 的 `crha` 用户，写死 sudoers / doas 规则：

```text
crha ALL=(root) NOPASSWD: /usr/local/bin/crha privileged stdio
permit nopass crha as root cmd /usr/local/bin/crha args privileged stdio
```

镜像**不编译 Go**：测试在宿主机用 `CGO_ENABLED=0 go build` 生成静态 crha，再以只读方式挂到
`/usr/local/bin/crha`，所以 sudoers 规则里的路径就是最终路径。镜像 tag 是 Containerfile、
entrypoint、m4ctl 和 sshd 配置的 SHA-256 前缀，改了任何一个都会重建一次；构建结果保留在本地。

每个测试还挂载：

| 宿主机              | 容器内                        | 用途                                                 |
| ------------------- | ----------------------------- | ---------------------------------------------------- |
| `<临时目录>/config` | `/etc/crha`                   | `crha.toml`、`privileged.toml`、`.ready`，测试直接改 |
| `<临时目录>/ssh`    | `/opt/m4/ssh`（只读）         | sshd 主机密钥、`authorized_keys`                     |
| crha 二进制         | `/usr/local/bin/crha`（只读） | 两种模式共用的同一个二进制                           |

节点状态（身份密钥、`used`、`revoked`、输出、日志）留在容器里，所以重启特权模式不会丢。

## 进程管理

不依赖 systemd。`entrypoint.sh` 先起 sshd，然后等测试写完 `/etc/crha/.ready`
（即 `crha enroll` 已生成身份、`privileged.toml` 已写好），再依次启动 root 的
`crha privileged run` 和 uid 998 的 `crha run`；收到 SIGTERM 时按相反顺序停止。

测试用 `podman exec /usr/local/bin/m4ctl.sh …` 单独控制进程，支持：

```text
start-priv | stop-priv | restart-priv | hup-priv
start-crha | stop-crha | restart-crha
start-sshd | stop-sshd | start-all | stop-all
reset-priv-state     # 删掉 used / revoked，回到干净的授权状态
wait-priv-socket | status
```

容器用 `--network=host`：容器里的 crha 主动连 `127.0.0.1:<crhs 端口>`，crhs 主动连容器里的
sshd。sshd 端口默认 2222，测试会先找一个空闲端口，通过 `M4_SSH_PORT` 传给容器，避免和宿主机
上别的 sshd 抢端口。不需要 sshd 的容器以 `M4_NO_SSHD=1` 启动。

## 运行方式

```bash
# 全部矩阵（需要 rootless podman 和 go）
CRH_TEST_PODMAN=1 GOCACHE=$PWD/.gocache pnpm --filter @crh/server test:m4

# 单文件
CRH_TEST_PODMAN=1 pnpm --filter @crh/server exec vitest run test/m4/forward.test.ts
```

没有 `CRH_TEST_PODMAN=1`（或 podman 不可用）时全部跳过；`pnpm --filter @crh/server test` 与
`test:e2e` 通过 `--exclude 'test/m4/**'` / 只跑 `test/e2e` 排除这里。四个文件串行执行
（`--no-file-parallelism`），一次完整的运行约一分钟，镜像已构建时更短。

每个文件自己起容器、enroll 节点、approve；`afterAll` 删除容器。测试镜像本身保留。

## 覆盖

| 矩阵项                                                                                                           | 测试                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1 native（sudo / doas）exec、file、取消、超时、工具不可用                                                        | `native.test.ts` "native with sudo" / "native with doas" |
| 2 ignore / reject                                                                                                | `native.test.ts` "ignore" / "reject"                     |
| 3 forward + crhs execute：exec / file                                                                            | `forward.test.ts` "item 3"                               |
| 4 只信任 user：crhs 不能单独提权，用户签名后成功                                                                 | "item 4"                                                 |
| 5 require-cosign：用户签名 + crhs 联署                                                                           | "item 5"                                                 |
| 6 local：`crha pending/approve/deny`、等待期间断线、特权模式重启后重新登记、crhs 被拒后回退 local（attempt + 1） | "item 6"                                                 |
| 7 吊销、一次性授权重放、used 持久化、特权模式重启                                                                | "item 7"                                                 |
| 8 符号链接、未规范化路径、env、prefix / shell 绕过                                                               | "item 8"                                                 |
| 9 SSH 忽略特权 + 输出提示、SFTP file 任务                                                                        | `ssh.test.ts`                                            |
| 10 TrustSummary 变化、等待期间 digest 变化、特权模式不可达 `privileged_unavailable`                              | `forward.test.ts` "item 10"                              |
| 11 任务组：一个签名覆盖多个节点、部分被拒只重签该节点、只剩 local 时直接失败                                     | `groups.test.ts`                                         |

用户的 SSH 签名一律由宿主上真实的 `crha grant --payload … --key … --yes` 产生（`ssh-keygen`
可用），再 `POST /api/authorizations`；WebAuthn 只通过 API 层单测覆盖，没有真实认证器。

两处需要人为制造失败才能覆盖的回退路径：

- **crhs 签名被 crha 拒绝**：crhs 信任项 `max_ttl = "1ms"`、`clock_skew = "0s"`；创建任务时
  SIGSTOP 特权模式 300 ms 再 SIGCONT，授权到节点时已过期（`authorization_expired`，第 4 步），
  crhs 用 attempt + 1 回退到 local。
- **任务组里只有一个节点被拒**：给 B 的 `privileged.toml` 写一个不是 crhs 节点 id 的
  `node_id`，共享 payload 的 `nodes` 按 crhs 记录的真实 id 构造，A 接受而 B 在第四步被拒
  （`authorization_invalid`）；B 单独以 attempt + 1 等待，修好 `node_id` 后只重签 B 的那份。

覆盖范围、阶段和断言只在 [doc/m4.md](../../../doc/m4.md) 维护，这里不重复矩阵定义。
