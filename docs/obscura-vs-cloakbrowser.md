# Obscura v0.2.6 vs CloakBrowser 156：源码核查与同套探针实测

日期：2026-11-11 UTC。

## 结论

**Obscura 有真正的独立引擎和轻量抓取价值，但当前不适合直接替换 CloakHub 的浏览器后端。“CDP 可连接、内置 stealth”远不足以代表完整 Chromium 兼容或可靠反检测。**

我们下载了官方 v0.2.6 的 render 默认版和 render+stealth 版，校验 GitHub release 的 SHA-256，并复用本仓库 browser-evaluation 的原有测试探针。测试暴露了 Worker 隔离、跨源 frame/CDP 和多客户端页面共享上的兼容性问题。与此同时，Canvas 导出与基本请求拦截确实可用；不能把它简单说成假浏览器。

## 宣传需要怎样理解

官方独立 benchmark 的 30 MB、9–21 倍提速来自 **no-render 抓取路径及每页冷启动 Chrome**；作者自己注明这是 Chrome 的最差场景，生产应复用浏览器。我们现有持久 browser/profile 的工作负载不符合该前提。官方真实网站测试的“成功”仅要求退出成功、HTML 至少 512 字符和非空 title，不验证业务内容或反爬挑战；该组上游自报中位加载时间反而是 Obscura 5.2 秒、Chrome 2.1 秒。[官方基准说明与结果](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/README.md)、[成功判定代码](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/realworld/run.py#L35-L41)。

stealth 确实有 TLS/HTTP emulation，不只修改 webdriver；但官方明确不解决 Cloudflare 交互挑战、Datadome/Akamai active challenges 和 CAPTCHA。v0.2.6 也明确列出 service workers、原生媒体和部分 Web API 不完整，PDF 是栅格输出。[stealth 限制](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/docs/Configure-stealth-and-proxies.md#what-stealth-does-not-handle)、[发布说明](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.6)。

详细实现、WPT 口径、基准漂移和 release 文档错误见 [源码报告](obscura-source-review.md)。

## 测试方法与边界

- Obscura：官方 v0.2.6 Linux x86_64 两个含渲染构建；stealth 组额外启用运行时 `--stealth`。
- 对照：仓库现有 license-free CloakBrowser `156.0.8078.47.1`，不是官方 licensed 原包。原包不注入 key 的启动退出 77 单独存档，不计入能力对比。
- 同一个固定 Docker 实验镜像，4 CPU、4 GiB RAM、2 GiB shm，headless，无宿主 GPU；Playwright 版本、镜像 ID、二进制及 suite 哈希见 [manifest](evidence/obscura-comparison/manifest.json)。
- 复用未修改的 `startFixtures`、`surface`、`summarizeSurface`、`measureLocal`、`runDetectors`。原 CLI 硬编码 Chromium 的版本格式/启动参数/DevToolsActivePort，故用独立 runner 适配 Obscura 的 readiness JSON。没有修改生产配置或原 suite。
- 原 smoke 先完整尝试；失败后分项收集。smoke 上限 50 秒，单独 frame 上限 30 秒。缺失/超时不改成通过。
- 原检测器首次运行因 Obscura 缺少 `Page.bringToFront` 全部报协议错误。补测只对其 headless 页面将该方法设为空操作，保持原 parser、等待时间、信号白名单；这种补测不表示原客户端完全兼容。
- CloakBrowser 固定 Linux persona/seed，Obscura 默认选择身份；字体是固定 Linux 容器里的字体，不是真 Windows 环境。这是所选产品配置的比较，不能将全部差异归因于内核。
- 本轮没有测 CPU、内存峰值、吞吐、完整真实业务站点、持久存储重启或挑战通过率；不据此确认或否定性能倍数。

## 本地能力实测

| 项目 | Obscura 默认 | Obscura stealth | CloakBrowser 156 |
| --- | --- | --- | --- |
| 原 suite smoke | frame 阶段超时 | frame 阶段超时，两次复现 | 完成全部采集 |
| 主页面 Canvas 重复读回差异 | 0 字节 | 0 字节 | 0 字节 |
| PNG 解码 vs 直接读回差异 | 0 字节 | 0 字节 | 10 字节 |
| Worker 中 document / window | object / object | object / object | undefined / undefined |
| Worker 中 importScripts | undefined | undefined | function |
| WebGL / WebGL2 | null / null | null / null | null / null |
| 独立跨源 iframe evaluate | 30 秒超时 | 30 秒超时，两次复现 | 完成 |
| 诊断请求拦截 | 8/8 | 8/8 | 8/8 |
| 第二个 CDP 连接可见页面 | 0 | 0 | 2，能读到第一连接设置的标记 |

上表是观测，不是总体通过率。Canvas 导出一致不证明像素渲染与 Chrome 一致；字体与 textWidth 也不同。CloakBrowser 的 10 字节差异保留为异常，没有把“smoke 完成”解释为所有断言通过。无 GPU 容器里两种引擎都没有 WebGL context，本轮不能据此声称只有 Obscura 渲染失败；Obscura 在源码层明确不实现 WebGL，是另一项独立证据。

## 检测页实测

以下 Obscura 两列使用已声明的 bringToFront 适配；CloakBrowser 使用原 adapter。每组单次有效外部观测，同一出口，不是大样本反检测成功率。

| 项目 | Obscura 默认 | Obscura stealth | CloakBrowser 156 |
| --- | --- | --- | --- |
| SannySoft 失败/警告单元格数 | 4 | 4 | 2 |
| BrowserScan | 未产生完整判定 | 未产生完整判定 | Normal |
| Fingerprint bot | not_detected | not_detected | not_detected |
| Fingerprint tampering | **true** | **true** | false |
| Fingerprint anti_detect_browser | false | **true** | false |
| Fingerprint virtual_machine | false | false | false |
| Fingerprint tampering_ml_score | 0 | 0.9999 | 0 |
| Fingerprint suspect_score | 28 | 22 | 7 |
| VPN / OS mismatch | true / true | true / true | true / true |
| IPHey | Temporary value，未完成 | Temporary value，未完成 | Temporary value，未完成 |

**本轮三个引擎配置都没有被 Fingerprint 判成 bot，但 Obscura 两种配置都被报 tampering；stealth 还被明确报 anti-detect browser。** 这不能推导所有网站都会拦截它，也不能用 bot=not_detected 宣称它已经“过了 Fingerprint”。默认版 anti_detect_browser=false 而 stealth=true 只是这一轮观测，不证明开启 stealth 在所有场景都会更差。

SannySoft 的共同两项是 WebGL context 缺失。Obscura 另外出现 `0x0` 和 `WARN` 单元格，且 pageerror 报 `navigator.getUserMedia is not a function`。此处只保留原 parser 的单元格结果，不凭字符串猜测所有子项的具体原因。BrowserScan 未完成、IPHey 占位值都不算通过，也不算有可靠的最终失败分数。

原始数据：[默认](evidence/obscura-comparison/default-adapted.json)、[stealth](evidence/obscura-comparison/stealth-adapted.json)、[CloakBrowser](evidence/obscura-comparison/cloak-r1.json)。

## 对 CloakHub 的实际影响

Worker 能返回一份指纹 JSON，不等于它运行在合规的 Worker realm 中。独立诊断检查 `typeof document/window/importScripts`，可区分真正的 Worker 与页面内模拟；这也解释了为什么原 surface 的 Worker 路径可能产生看似一致的 Canvas 结果。

第二个 CDP 连接能否看到第一个客户端留下的页面，直接影响我们短命 agent 脚本、持续页面和多客户端协作的语义。这个测试使用同时存在的第二条连接；不把它冒充完整的重启恢复测试。源码也表明 Obscura 页面按连接持有，不能把单连接抓取的成功推广为共享浏览器会话成功。

对于新建、独立的文本抓取后端，Obscura 值得继续用真实业务样本评估。验收必须检查实际提取字段、交互完成和错误率，再以复用浏览器的 CloakBrowser 为对照测吞吐/RSS；不要用返回 HTML/title 代替任务成功。对于 CloakHub 当前的持久 profile、CDP 多客户端、完整交互需求，保留 CloakBrowser。

## 复现与原始证据

[runner、操作说明及全部 JSON](evidence/obscura-comparison/README.md)。观测完成状态与功能通过分开记录；外部 detector 无结果不进入通过分母。测试只使用临时 profile/storage，未触碰生产会话。新增文档与 evidence，未提交或部署。原 suite 单元测试 **30/30 通过**，runner 语法检查及 diff whitespace 检查通过。
