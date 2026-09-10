# Bun 下载器与无 Python 镜像验证

2026-09-09，Linux amd64，本地镜像 `cloakhub:151-bun`；未发布。
本记录接续 [151 与多 key 接入](cloakbrowser-151-integration-2026-09-09.md)。

## 实现

- 使用固定版本的官方 npm 包 `cloakbrowser@0.5.10`，由 Bun 调用公开的 `ensureBinary` API。
- 官方 JS 实现通过 Node 兼容的 crypto API 验证 Ed25519 签名、签名清单中的版本和归档 SHA256。
  没有自行重写校验算法，也没有跳过上游校验。
- 删除 Python 安装脚本、Python 基础镜像和 pip 依赖，最终基础镜像为 Debian bookworm slim。
- `bun install --production --omit=peer` 排除自动化客户端 peer 依赖。只用 `--production` 时，
  Bun 会保留开发锁文件中已解析的 `playwright-core`，所以需要明确排除 peer。
- 实测生产镜像没有 Python、pip、Node、Playwright 或 Puppeteer；Bun 为 1.3.14。
  测试机上的 Playwright 客户端是外部测试工具，不是生产镜像依赖。
- `CLOAKHUB_BROWSER_INSTALLER=bun` 启用托管安装；显式二进制路径仍覆盖下载器。
- 使用 `flock` 锁住同一缓存目录，兼容旧 Python 安装器的同名锁。指定版本的旧缓存可以直接复用。
- 下载和解压在临时目录进行，只有验证成功且实际版本符合 pin 才原子移动到正式缓存。
  中断的解压不会因为已有 `chrome` 文件就被当成完成安装。免费 key 返回其他版本时拒绝采用。
- 下载器在独立 Bun 子进程中运行，清除镜像/二进制/更新/校验覆盖环境变量。
  key 不进入命令行，原始上游日志和错误不进入 API 或结果协议。

## 验证

- TypeScript 类型检查通过。
- 常规测试：203 通过，10 个可选真实测试跳过，0 失败。
- 新增测试覆盖旧缓存复用、完整目录发布、失败不发布半成品、版本替换拒绝、跨进程锁等待。
- 使用真实官方签名清单进行离线测试：合法 Ed25519 签名通过；修改清单、错误签名、
  版本不符、归档 SHA256 不符均被官方 JS 校验器拒绝。
- 从空缓存实际下载并启动 `151.0.7922.108.4`；CDP 报告 `151.0.7922.108`。
- 在 `--network none` 容器中，Bun 安装器成功复用先前 Python 下载的缓存，不需要再次下载。
- 没有 key 的全新容器明确拒绝启动，不回退到 146。
- 新镜像真实 runtime 测试：9/9，包括 WebGL/WebGL2 实际绘制、headed/headless、CDP 恢复和停止。
- 新镜像真实 UI/CDP E2E：11/11，包括表单、iframe、弹窗、上传下载、VNC 鼠标与剪贴板、
  代理、单名额容量、休眠恢复、存储持久化和容器重启。

这次没有改变浏览器版本、默认 fingerprint 参数、字体或图形库。没有重新做全套公开
反检测网站比较；先前的结果和限制仍应参考原始比较报告。ARM64 未在本机运行验证。

## 镜像体积

| Linux amd64 镜像 | 压缩内容 | 展开镜像层 |
| --- | ---: | ---: |
| 上一版：Python，仅下载器依赖 | 253.1 MiB | 718.5 MiB |
| 当前：Bun + 官方 JS 下载器 | **231.8 MiB** | **651.2 MiB** |
| 减少 | 21.2 MiB | 67.3 MiB |

浏览器缓存另约 745 MiB；它不在镜像内。压缩内容来自本机 containerd image store 的
`docker image inspect .Size`，展开层大小来自 Docker image history API。Docker 显示的
总磁盘占用可能同时包含压缩内容和展开快照，不能把不同口径混用。

证据：

- [测试汇总与名额归还](cloakbrowser-bun-installer-2026-09-09/verification.json)
- [安装与运行时清单](cloakbrowser-bun-installer-2026-09-09/installation.json)
- [完整 E2E 结果](cloakbrowser-bun-installer-2026-09-09/e2e.json)
- [原始字节数与镜像 ID](cloakbrowser-bun-installer-2026-09-09/image-sizes.json)

测试脚本和完整日志保留在 `.cloakhub/cloak151-bun-installer/`，不含任何新增的生产部署。
