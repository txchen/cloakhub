# Obscura 源码与宣传核查

2026-11-11。本文是源码与官方基准审查；我们的实测结果见 [Obscura vs CloakBrowser](obscura-vs-cloakbrowser.md)。Obscura 固定到 [`3bae60909615ed5a2ca263a12c300a4a545ed3ce`](https://github.com/h4ckf0r0day/obscura/commit/3bae60909615ed5a2ca263a12c300a4a545ed3ce)，官方 benchmark 固定到 [`2d7bc304fbb7ebefc44f770938192e3cede87dbd`](https://github.com/h4ckf0r0day/obscura-benchmark/commit/2d7bc304fbb7ebefc44f770938192e3cede87dbd)。当日最新发布版为 [v0.2.6](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.6)，与 main 不等同；不得把 main 的改进算成 release 的实测能力。

## 判断

这是有实际工程投入的独立浏览器引擎，值得作为轻量抓取后端评估；目前没有证据支持把它视为通用 Chromium/CloakBrowser 的等价替代，更没有证据支持“全面反检测”。它的主要取舍是自行实现浏览器平台以减少资源占用，代价是 Web API、渲染和会话语义的兼容性缺口。下面把官方声称、实现事实及其适用边界分开。

## 它实际是什么

Obscura 不封装 Chromium：V8 经 `deno_core` 执行 JavaScript，Rust DOM 树配合 `bootstrap.js` 提供浏览器 API；网络默认使用 reqwest，stealth 使用 wreq；可选原生渲染器以 Taffy 为 flex/grid 基础，加入排版、字体塑形及 CPU 绘制。CDP/MCP 是其自己的协议实现。它已经有真实 screenshot、screencast、PDF 路径，不能沿用早期“完全没有渲染器”的评价；PDF 目前仍是栅格内容。[架构](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Architecture-overview.md)、[发布限制](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.6)。

CLI 的默认 Cargo features 是空集合，发布包则按后缀区分：无后缀含 render，`-stealth` 含 render+stealth，`-no-render` 两者都不含，`-no-render-stealth` 仅 stealth。运行时仍需显式 `--stealth`。不同构建的内存、速度和能力不可混算。[Cargo 配置](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-cli/Cargo.toml)、[安装文档](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Installation.md)。

## 宣传数字的边界

| 宣传或官方结果 | 核查后能成立的范围 |
| --- | --- |
| 30 MB、比 Chrome 快 9–21 倍 | benchmark 明说是 **no-render 抓取路径**、每页新启冷进程；也承认这是 Chrome 的最差情形，生产应复用 browser/tabs。不能直接套到我们的常驻 CloakBrowser 或 Obscura render+stealth。 |
| real-world 94/98，优于 Chrome 85/98 | 评分只检查退出码为 0、HTML 至少 512 字符、有非空 title。它不验证登录、交互、业务数据、截图，也不排除满足这些条件的 challenge 页面。 |
| 真实网站速度优势 | 官方该组中位数 Obscura **5.2 秒**、Chrome **2.1 秒**，并非全面更快；内存中位数报告为 64.2 MB 对 201.2 MB。 |
| WPT Core 83.3%、Relevant 86.8% | 官方报告固定的是 2026-09-11 的旧 engine commit；Full 为 67.6%。仅 classic DOM/JS testharness 路径，不跑 WPT reftest；runner 不支持的自动化类型另列 unsupported。不是完整浏览器兼容率。 |
| 33/33 obstacle course | 有固定 fixture 和断言，是有价值的回归检查；33 个小任务通过不能推导任意真实站点可用。 |

来源：[官方 benchmark README](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/README.md)、[Chrome 对比执行脚本](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/compare/head-to-head.py)、[真实网站成功判定](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/realworld/run.py#L35-L41)。以上数字是上游自报，本次源码审查未重跑。

## Stealth 到底有多少

有真实的网络层实现：wreq 明确选择 Chrome 145 / Windows emulation，改变 TLS/HTTP 表现，并启用 tracker blocklist。它不是只改 `navigator.webdriver`。[实现](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-net/src/wreq_client.rs#L213-L224)。

但官方详细文档明确排除 Cloudflare 交互挑战、Datadome/Akamai active challenges、CAPTCHA、IP 限流和被动 TCP/IP 栈指纹；换 UA 也不会更换 OS 或 TLS profile。默认稳定身份，轮换需 opt-in；时区默认 Europe/Berlin，必须与部署出口匹配。这比 README 的笼统 anti-detect 描述收敛得多。[stealth 能力与限制](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Configure-stealth-and-proxies.md)。

浏览器可观测表面仍有明显取舍：

- WebGL/WebGL2 `getContext()` 返回 `null`。源码说明旧实现曾假装创建 shader/program、但 draw 是 no-op，现在改为明确失败，避免应用选错路径。这是兼容性的诚实修正，同时意味着 GPU 指纹与 WebGL 应用不能视为 Chromium 等价。[源码](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-js/js/bootstrap.js#L17312-L17318)。
- OfflineAudioContext 的输出含模拟三角波及固定 fingerprint 求和目标，不等同于完整原生音频图计算。这能解释某些简单指纹数值“像 Chrome”，不能证明平台行为不可区分。[源码](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-js/js/bootstrap.js#L17465-L17480)。
- README 的“dispatched events trusted”不能理解为任意 JS 事件都可信。当前实现区分脚本构造的事件与引擎/CDP 标记的事件，使用 WeakSet 记录 trusted 状态。[源码](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-js/js/bootstrap.js#L11935-L11947)。
- 上游 standalone stealth benchmark 还在检查 ANGLE WebGL renderer 和 Linux stealth UA；当前 engine 已是 WebGL null、Windows Chrome145。说明基准仓库与 engine 存在版本漂移，不能拿历史“全绿”当当前反检测结论。[旧检查](https://github.com/h4ckf0r0day/obscura-benchmark/blob/2d7bc304fbb7ebefc44f770938192e3cede87dbd/stealth-bench/run.py#L590)、[当前身份](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/crates/obscura-net/src/wreq_client.rs#L60-L69)。

## 与 CloakHub 最相关的差异

CloakHub 是管理持久 CloakBrowser profile、浏览器生命周期和人工 viewer 的服务；Obscura 是另一个浏览器引擎加 CDP/MCP 服务。因此“资源更少”和“可替换我们”是两个不同问题。[CloakHub 定位](https://github.com/txchen/cloakhub/blob/b9d57bf1017fb9e5befe227231af9102997212ec/README.md)。

| 维度 | Obscura 已公开的语义 | 对我们的影响（推断） |
| --- | --- | --- |
| CDP 重新连接 | target 属于创建它的连接；另一 WebSocket 不能接管；关闭连接销毁该连接的 page/runtime | 不能直接继承我们的跨客户端持久标签页模型；短命脚本反复连接尤其需要实测 |
| 登录持久化 | cookies、localStorage 可落盘；IndexedDB 仅内存，进程重启丢失 | 仅依赖 cookie 的登录可能够用，依赖 IDB 的站点不等价 |
| 页面与 frame | iframe 有独立 realm，但 frame module scripts、iframe 内容合成仍有缺口；utility world 仍与对应 frame realm 共用 | iframe DOM 评估通过不能代表截图或隔离 world 正确 |
| Worker | classic Worker 在 page runtime 内模拟，不是独立 isolate/线程；service worker 不完整 | 后台行为与 PWA 不宜预设可用 |
| 对话框 | confirm 默认 false、prompt 默认 null、alert 非阻塞，未提供普通 CDP 可控 dialog | 需要确认弹窗的 agent 流程可能偏离 Chromium |

来源：[会话、frame、Worker、dialog 架构说明](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Architecture-overview.md)、[存储说明](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Persist-cookies-and-storage.md)、[v0.2.6 限制](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.6)。

## 验证建议与运行入口

### v0.2.6 与 main 的核对

为对应本次选用的发行二进制，额外读取了 `v0.2.6` 的源文件，确认以下问题已经存在于发布版：

- Chrome145/Windows TLS profile：[release 源码](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-net/src/wreq_client.rs#L213-L224)。
- WebGL 返回 null、音频模拟固定求和目标：[WebGL](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-js/js/bootstrap.js#L16400-L16406)、[audio](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-js/js/bootstrap.js#L16553-L16568)。
- IndexedDB 不落盘：[release 存储文档](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/docs/Persist-cookies-and-storage.md#indexeddb)。
- 不解决 active challenge/CAPTCHA：[release stealth 文档](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/docs/Configure-stealth-and-proxies.md#what-stealth-does-not-handle)。

**发布版架构文档存在过时描述，不能照抄。** 它声称全进程共用一个 isolate，且 WebSocket 关闭后 pages 留存；但同 tag 的 `server.rs` 明确每连接拥有 `CdpContext`、pages 和线程，接收通道关闭时退出循环，函数结束释放 context，连接线程再释放 LocalSet。main 文档已经更正。跨连接恢复标签页应以测试与实现为准：[release 过时文档](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/docs/Architecture-overview.md)、[连接状态所有权](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-cdp/src/server.rs#L1211-L1223)、[关闭路径](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-cdp/src/server.rs#L1291-L1297)、[context 作用域结束](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-cdp/src/server.rs#L1459-L1464)、[LocalSet 清理](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/crates/obscura-cdp/src/server.rs#L903-L920)。

另一个版本差异：v0.2.6 的架构文档仍列 child-frame CDP evaluation routing 为缺口；main 描述了后续 owning-realm 路由实现，但仍不保证 iframe 截图合成。上表的 main frame 能力不可倒推到 v0.2.6。[release frame 限制](https://github.com/h4ckf0r0day/obscura/blob/v0.2.6/docs/Architecture-overview.md#child-frames)。上表 dialog 的具体描述取自 main，本审查未逐一核实该项在 v0.2.6 的实现。

### 测试范围

优先使用我们的相同 fixture、断言和 Playwright 驱动，先测试实际业务完成，再测资源。需要单独标记不支持的 API，不能改成宽松断言以后称为通过。推荐至少覆盖 DOM/布局/截图、真实点击和表单、iframe、重新连接、cookies/localStorage/IndexedDB 重启持久化，以及本地指纹一致性。反检测应另跑相同出口的第三方 detector；页面能打开和 challenge 通过必须分开记。

v0.2.6 Linux x86_64 render+stealth 包：[固定下载](https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.6/obscura-x86_64-linux-stealth.tar.gz)，GitHub release asset 公布 SHA256 为 `ac8057374ec1b5cabb78ea2d08b2ed890d21d156a42b1ac23357fd049edc08c5`。保留 `obscura` 与 `obscura-worker` 在同一目录；Linux 需要 glibc 2.35+。服务入口为 `obscura --stealth serve --port <独立端口> --storage-dir <测试目录>`，Playwright 使用 `chromium.connectOverCDP()`。完整编译入口为 `cargo build --release -p obscura-cli --bins --features render,stealth`。[安装](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/docs/Installation.md)、[官方 Playwright 示例](https://github.com/h4ckf0r0day/obscura/blob/3bae60909615ed5a2ca263a12c300a4a545ed3ce/README.md)。

本审查的建议是：把 Obscura 当作可选轻量抓取引擎验证；在业务、持久会话和渲染验收完成前，不替换 CloakHub 的通用浏览器后端。真正值得追踪的是相同业务完成条件下的常驻性能，而不是每页重启 Chrome 的宣传比值。
