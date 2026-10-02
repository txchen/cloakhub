# Lightpanda 1.0 vs CloakBrowser 154：反检测实测

日期：2026-10-02 UTC。

## 结论

**以“像正常用户浏览器、运行反检测页面”的目标衡量，本轮 CloakBrowser 明显胜出。Lightpanda 1.0 不是 CloakBrowser 的反检测替代品。**

Lightpanda 的定位是轻量自动化/数据提取引擎：没有图形渲染管线，直接报告 `Lightpanda/1.0` 身份。官网 1.0 文章主要讲标准兼容性、安全和资源效率，不是承诺隐身。文章的“约 Chrome 80% WPT 子测试数”不等于 80% 反检测通过率，其中约 115 万子测试来自 encoding 套件。

本轮没有测 CPU、内存、吞吐，不能据此验证官网的性能倍数，也不能说 CloakBrowser 在所有用途都更强。

## 环境和方法

- 官方 GitHub release `1.0.0` 的 Linux x86_64 binary，下载大小 188,268,424 bytes，`lightpanda version` 输出 `1.0.0`。
- SHA256：`aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3`，与 GitHub release API 的 asset digest 一致。
- 对照：本地 `cloakhub_free:0.9.0` 镜像，binary 为 `CloakBrowser 154.0.8037.57.1`。本次不是重新拉取正式 GHCR 镜像。
- 本地镜像 ID：`sha256:557062bedb866a4e7710b2f8207494bc32bcba6a7470f2a64ccf98d7de6355ea`。
- 同一 Linux amd64 宿主机和直接网络出口，无代理或额外 stealth 注入。CloakBrowser 在独立临时容器里运行，未使用现有用户 profiles；容器已删除。
- Playwright 1.63.0，通过 CDP 连接。全部 headless。
- 三组：Lightpanda 默认；Lightpanda 开启 iframe/worker/stylesheet/image 子资源；CloakBrowser 默认指纹身份，seed `20261002`。
- 每站启动新的 Lightpanda 进程或新的 CloakHub profile。3 组 × 9 站 = **27 次正式观测**，此前另有一次 SannySoft 连接试跑。
- 沿用 `examples/antibot-audit.mjs` 的九个 URL、导航超时、12–20 秒等稳定等待及 Rebrowser 操作；单独 runner 避免截图/WebGL 缺失中断整套采集，每站外部上限 110 秒。
- 两种产品默认身份不同：Lightpanda 为 Linux / America/Los_Angeles / 1920×1080；CloakBrowser 为 macOS / UTC / 1366×768。这是默认产品对比，不是严格匹配身份的内核因果实验。
- 单轮、小样本、固定观察窗口；未完成不是永久不兼容，更不是反检测通过。没有执行 incolumitas 的行为挑战。

## 实测结果

| 检测页 | Lightpanda 默认 | Lightpanda 开子资源 | CloakBrowser 154 |
|---|---|---|---|
| SannySoft | 6 行失败标记 | 7 行失败标记 | 0 行失败标记 |
| DeviceAndBrowserInfo | 没有生成 isBot 判定 | 同左 | `isBot=false`，22 个明细均 false |
| BrowserScan | 页面存在，无最终判定 | 同左 | `Normal` |
| CreepJS | body 文本为空，无有效结果 | `Computing...`、全零占位 | 31% like headless / 0% headless / 0% stealth |
| Rebrowser | dummyFn 未定义，结果表为空 | 同左 | 8 绿、2 红 |
| incolumitas | 旧检测 4 FAIL，新检测不完整 | 同样 4 FAIL，Worker 检查有结果 | 旧检测 1 FAIL，新检测 9 项 OK |
| Fingerprint Pro | `Client timeout` | `bad request` | Bot/Tampering 未检测；Suspect Score 4；VPN / OS mismatch |
| IPHey | Playwright 对话框协议错误，进程退出 | 同左 | 停留 Temporary value，未完成 |
| reCAPTCHA v3 demo | 无真实验证结果，读取到隐藏示例值 | 停留 execute 阶段，无结果 | `success=true`，score 0.9 |

**不把这张表混成一个总通过率。** 很多项目是兼容性未完成，Rebrowser 还明确说明只针对 Chromium 浏览器设计。

### SannySoft：不是仅仅 webdriver=false 就能隐身

Lightpanda 两组共同失败的六行：

1. Chrome 对象缺失。
2. Plugins Length 为 0。
3. PluginArray 类型检查失败。
4. WebGL Vendor 无 context。
5. WebGL Renderer 无 context。
6. CHR_MEMORY 失败。

开启 image 后，Broken Image Dimensions 为 `0x0`，增加一行失败。官方 CLI help 明确说明 image 只读响应头，不解码，所以图片自然尺寸仍为 0。默认组该行空白，不应视作通过。

本地采集还确认：`navigator.webdriver=false`、UA 为 `Lightpanda/1.0`、plugins 为空、WebGL 为 null、全局 `outerWidth` 不存在。空白 canvas 返回固定的 1×1 PNG。后者只是默认空 canvas 的观测，不声称已证明所有绘图输出都相同。

这些信号足以说明它不以伪装正常 Chrome 为目标；但 Chrome-specific 检查报错也不能泛化为对所有浏览器都成立的“机器人判决”。

### 未完成的检测绝不能算通过

- CreepJS 开子资源后显示 `0% headless`，但同时 `FP ID: Computing...`、Fuzzy 全零、各项为空。这是初始模板，不是反检测成绩。
- Lightpanda 服务日志记录了 CreepJS 的 SVG API、字体字段、`outerHeight` 等错误；Playwright 的 pageerror 数组为空不代表引擎没有错误。
- Rebrowser 在第一步 `window.dummyFn()` 就报 TypeError，因此没有继续执行 exposeFunction 等探针。不能比较成 Lightpanda 0 红、CloakBrowser 2 红。
- reCAPTCHA 默认组读取出的 `abc123`、`{"json": "from-backend"}` 来自 HTML 中 `class="step3 hidden"` 等静态占位。不开 stylesheet 时隐藏文本也可能被 innerText 读出，不是真 token 或成功验证。
- Fingerprint 的 timeout/bad request 不足以判为“服务端检测到 bot”；本轮没有确定其根因。
- IPHey 的 Lightpanda 客户端退出原因是 `Page.handleJavaScriptDialog: No dialog is showing`，属于观察到的 CDP/客户端兼容性错误，不是网站机器人评分。

### CloakBrowser 也不是全绿

- Rebrowser 的两项红是按测试要求主动触发的 mainWorldExecution 和 Playwright exposeFunctionLeak。
- incolumitas 旧 fpscanner 的 `WEBDRIVER` 项 FAIL，即使 navigator.webdriver 实测为 false。不同检测器的启发式并不一致。
- Fingerprint Pro 能关联既有 Visitor ID，并报 VPN / OS mismatch。未检测到 bot 不等于不可跟踪。
- IPHey 仍未完成，页面初始 0 分不能当作有效分数。
- reCAPTCHA 0.9 只属于本轮公开 demo 样本；页面自身说明它不是对 Google 账号或真实流量的普遍评分。

## 选型建议

- **反检测、完整网页交互、需要真实渲染/截图：保留 CloakBrowser。**
- **获准抓取的文本提取、预渲染、批量 agent 阅读：Lightpanda 值得作为独立轻量后端评估。** 应单独测试业务网页兼容性和实际资源节省。
- 不建议直接替换 CloakHub 内核；Lightpanda 没有真实页面图形渲染，现有 VNC/截图等使用方式不是等价迁移。CDP 能连接不代表所有 Playwright 行为都兼容。

## 复现与证据

测试未安装到系统 PATH。测试进程和临时容器已停止/删除；归档后清理下载的 binary 和本机原始采集，仅保留仓库内脱敏证据及 runner。复测时先重新下载：

```bash
mkdir -p .cloakhub/lightpanda-1.0
curl -fL https://github.com/lightpanda-io/browser/releases/download/1.0.0/lightpanda-x86_64-linux \
  -o .cloakhub/lightpanda-1.0/lightpanda
echo 'aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3  .cloakhub/lightpanda-1.0/lightpanda' | sha256sum -c -
chmod +x .cloakhub/lightpanda-1.0/lightpanda

# 默认组；另一个终端运行下面的 node 命令
.cloakhub/lightpanda-1.0/lightpanda serve --host 127.0.0.1 --port 9223
AUDIT_CDP=ws://127.0.0.1:9223 timeout 110 \
  node examples/lightpanda-audit.mjs lightpanda-default sannysoft

# 子资源组启动参数
.cloakhub/lightpanda-1.0/lightpanda serve --host 127.0.0.1 --port 9224 \
  --load-resources iframe --load-resources worker \
  --load-resources stylesheet --load-resources image

# 对照组：AUDIT_HUB 必须是无鉴权的独立测试实例，不是日常用户服务
AUDIT_HUB=http://127.0.0.1:7799 timeout 110 \
  node examples/lightpanda-audit.mjs cloak154 sannysoft
```

- Runner：[`../examples/lightpanda-audit.mjs`](../examples/lightpanda-audit.mjs)，已通过 `node --check`，并实际执行上述 27 次观测。
- 脱敏结果摘录：[`evidence/lightpanda-1.0/results.json`](evidence/lightpanda-1.0/results.json)。
- 同目录保存 runner 和 Lightpanda 引擎日志，包括 IPHey 进程异常。
- 本机完整 JSON/HTML 原位于 `.cloakhub/lightpanda-1.0/results/`，可能含出口 IP、Visitor ID、短期验证码 token，归档后清理，不公开提交。
- 临时批量调度脚本也随工作目录清理；逐站复测使用仓库内 runner。

资料：
- https://lightpanda.io/blog/posts/lightpanda-1-0
- https://github.com/lightpanda-io/browser/releases/tag/1.0.0
- https://api.github.com/repos/lightpanda-io/browser/releases/tags/1.0.0
- 下载后实际执行的 `lightpanda serve --help`。
