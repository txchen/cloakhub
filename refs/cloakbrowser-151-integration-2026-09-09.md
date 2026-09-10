# CloakBrowser 151 与多 key 接入验证

日期：2026-09-09。Linux amd64，本地构建，未发布版本。

默认 Docker 浏览器改为 `151.0.7922.108.4`，实际 CDP 版本为
`151.0.7922.108`。保留 Linux / headed / 1366×768 / 4 CPU 默认设置和内核生成的 UA。
客户端、profile API、CDP 地址和鉴权方式不变。部署方法见
[151 与多 key 配置](../docs/cloakbrowser-151.md)。

## 实现与验证范围

- key 支持只读文件、JSON 环境变量，以及既有单 key 环境变量/文件；重复 key 去重。
- 从官方 session/count 读取额度；本地启动预约串行化，每个进程只注入选中的 key。
- 实例实际退出才释放预约。启动失败清理预约，进程被请求 kill 但还没退出时不会提前释放。
- 额度满或不可查询时不按无限额度处理；上游仍负责最终校验，Hub 不能保证其他主机不会竞争同一额度。
- 正常退出保留 Browser.close；76/77/78 的授权退出原因在 CDP 就绪前后都可记录。
- Docker 不内置浏览器或 key，通过官方 0.5.10 wrapper 下载并验证签名/校验和。
  缓存指定版本，不自动更新；免费 key 下载结果与 pin 不符时拒绝启动。
- 去掉下载器不需要的 Python Playwright 及其依赖，保留 httpx、cryptography、字体和图形环境。

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| TypeScript typecheck | 通过 | 最终代码 |
| 常规测试 | 193 通过，10 个可选真实测试跳过，0 失败 | 包括 key 配置、分配、重复 key、并发预约、失败清理和迟到的授权拒绝 |
| 三 key 并发 | 通过 | 受控 quota/process 测试；三把单名额 key 只允许三个本地预约，第四个拒绝 |
| 真实 Hub/UI E2E | 11/11 | 初始完整依赖镜像；UI、CDP、VNC、代理、存储、休眠、容器重启 |
| 最终精简镜像真实 runtime 测试 | 9/9 | WebGL/WebGL2、CDP、鉴权、headed/headless、停止和持久化恢复 |
| 精简镜像空缓存下载 | 通过 | 无 Python Playwright；从官方渠道取得指定 151 构建 |
| 离线复用缓存 | 通过 | network=none 运行安装器返回既有指定二进制；正常 Hub/浏览器授权仍需联网 |
| 缺少 key / 错误版本 pin | 明确拒绝 | 缺 key 不下载；免费 key 忽略 pin 后返回的其他构建不被默默采用 |
| 146→151 | 通过 | 独立 profile 的 cookie、localStorage、seed 保留 |
| 从完整备份恢复到 146 | 通过 | 在独立恢复目录验证同样的数据保留，没有用 146 打开升级后的目录 |

仅有 **一把真实、单名额 key**；没有实测三把真实 key 同时占用上游名额。
三个 key 的测试证明 Hub 本地分配和并发控制，实际额度取决于各 key 的有效权益。

最初使用普通宿主用户复制备份时，root-owned 文件读失败，产生的不完整备份无法恢复
localStorage；改为停机后使用能读取全部文件的 `cp -a`，并确认每步成功后，升级和恢复
验证均通过。部署文档因此明确要求检查备份完整性和文件权限。未验证真实用户的所有
扩展、登录数据或任意旧版本的跨版本迁移。

## 镜像体积

以下为 containerd image store 的两种口径，均为 Linux amd64 实测：

| 镜像 | 压缩内容 | 展开的镜像层 | 浏览器缓存 |
| --- | ---: | ---: | ---: |
| 已发布 0.5.0，包含 146 | 648.6 MiB | 1,988.7 MiB | 已在镜像内 |
| 151 初版，含完整 Python 依赖 | 301.0 MiB | 857.0 MiB | 另约 745 MiB |
| 151 精简版，仅下载器依赖 | **253.1 MiB** | **718.5 MiB** | 另约 745 MiB |

去掉不用的 Python Playwright 等依赖，减少约 **47.9 MiB 压缩内容、138.5 MiB 展开层**。
剩余较大的层包括 Chromium 图形库与字体、KasmVNC 与 Mesa 依赖、Bun、Python/Debian 基础层。
为了保持已验证的浏览器指纹和 WebGL 环境，这次没有删字体或图形库。

此前将 `docker image inspect .Size` 解释成展开体积是不正确的：本机该字段是压缩内容。
`docker image ls` 的 DISK USAGE 还包括展开快照，精简版约 1.02 GB；另加数据卷浏览器。
不同镜像之间共享层，不能把每个镜像的显示体积直接相加作为增量磁盘占用。

## 精简后检测网站复测

使用最终精简镜像，默认 Linux/headed、seed `20260909`，同一出口：

| 网站/指标 | 结果 |
| --- | --- |
| Fingerprint tampering | false |
| Fingerprint anti_detect_browser | false |
| Fingerprint tampering_ml_score | 0 |
| deviceandbrowserinfo isBot | false，所有 details 项均为 false |

这两项关键结果与此前 151 测试一致。Fingerprint 仍给出低置信度 VPN 标记，不能把本次
结果概括为所有信号都无异常；公开测试页通过也不等于所有网站都会通过。

ARM64 的官方版本接口返回同一 `151.0.7922.108.4`，但本次未在 ARM64 上构建或运行。

## 证据

- [E2E 11 项结果](cloakbrowser-151-integration-2026-09-09/e2e.json)
- [初次安装与拒绝路径](cloakbrowser-151-integration-2026-09-09/installation.json)
- [精简版下载与缓存复用](cloakbrowser-151-integration-2026-09-09/slim-installation.json)
- [镜像原始字节数和 image ID](cloakbrowser-151-integration-2026-09-09/image-sizes.json)
- [迁移及恢复结果](cloakbrowser-151-integration-2026-09-09/migration.json)
- [精简版检测指标](cloakbrowser-151-integration-2026-09-09/slim-antibot.json)
- [结束清理与名额归还](cloakbrowser-151-integration-2026-09-09/cleanup.json)

完整本地日志、截图及可复现脚本位于被 Git 忽略的
`.cloakhub/cloak151-keys-implementation/`。仓库证据只保留必要结果，不包含实际 key、
管理 token 或出口 IP。
