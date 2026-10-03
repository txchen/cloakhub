# IPHey、OS/网络身份与客户端注入：后续诊断

日期：2026-10-01 UTC。前置比较：[0.8.0 vs 0.9.0 报告](free-080-vs-090-antidetection.md)。

## 结论与完成边界

1. **IPHey 的失效链路已定位并用本地探针复现：154 在当前 Mac 字体配置下出现字体查询性能退化 → 主线程长任务 → IPHey 的 3 秒采集超时 → performance 数据缺失 → 服务端空值访问异常 → 前端一直显示占位值。**
2. **不是 GPU 永远不返回，也不是 HTTP 失败或本次证据中的明确机器人封禁。** 正常 HTTP 200 掩盖了 WebSocket 中的应用错误。
3. **OS mismatch 的具体判据仍未定位。** Linux persona、匹配时区均不能消除；同出口的原生 Linux Google Chrome 控制组也触发低置信度的该信号。不能继续把它简单解释为“Linux 假扮 macOS”。
4. **客户端可观察痕迹已经分离到具体操作。** 已测的连接/locator 不触发红项；主世界被 hook 的 DOM 调用与 `exposeFunction` 分别触发对应红项。
5. **本次是诊断完成，不是默认 macOS 配置已经修好。** 没有修改生产默认 persona、删除 Mac 字体、全局禁用 WebGPU、注入伪造结果或发布新镜像。原默认场景的复现仍为红色，已保留可供后续 native 修复验收的探针。

## 1. 环境与方法

- 0.8.0 使用 GHCR 发布镜像；0.9.0 使用前次从同一 `v0.9.0` 源码构建、已经验证 binary 版本的本地 `cloakhub_free:0.9.0`。后者 image ID 为 `557062bedb86`，不是前报告中的 GHCR digest；两次调查不能混称为同一镜像字节。
- binary 分别为 `152.0.7977.82.1` 与 `154.0.8037.57.1`；Linux amd64、相同宿主机/出口、Playwright 1.63.0。
- 专用容器、独立匿名数据卷，headless、seed `20261001`；按实验单独改变 persona、timezone 或字体配置。
- 所有 profiles 在测试后删除；不使用现有账户、cookies、服务实例。
- SDK 观察、定时器扩展仅发生在专用诊断 profile 的单次响应中，不写入产品或保留为实际使用方案。

## 2. IPHey：从表象到根因链

### 2.1 稳定复现

未修改站点的原始对照：

- 0.8.0：约 10 秒显示结果，`Unreliable / 90`。
- 0.9.0：两次短复现失败，延长等待也不恢复。
- 页面无未捕获 JS exception，主要 HTTP 资源均 200。

最初按“异步 API 未返回、persona/GPU 不兼容、站点结果处理、CDP 影响”四个假设做单变量对照。对 GPU、权限、字体、媒体、UA-CH 等异步边界加观察后，GPU adapter/device 等最终都返回，因此否定了“永久等待 GPU”这一具体假设。

### 2.2 被 HTTP 检查漏掉的 WebSocket 错误

IPHey 通过 `wss://api.iphey.com` 交换采集结果：

| 观察 | 0.8.0 | 0.9.0 默认 macOS |
|---|---|---|
| WebSocket 握手/首帧 | 成功 | 成功 |
| 客户端发送采集 payload | 成功 | 成功 |
| 服务端结果 | 正常结果帧 | 54 字节文本错误 |
| 页面完成 | 是 | 否 |

错误原文：

```text
null is not an object (evaluating 'e?.performance.h3')
```

因此它不是“页面拿到了评分 0”，而是根本没拿到合法结果。前端未把该错误转换为可见失败状态，继续显示 `Temporary value`。

原样不加 instrumentation 的最终复验仍收到该错误，证明错误不是观察脚本制造的。

### 2.3 数据为什么缺失

观察当天 IPHey SDK 的采集调度逻辑，等价于：

```js
results[key] = await Promise.race([
  collector(),
  new Promise(resolve => setTimeout(() => resolve(undefined), 3000))
]);
```

实际是对多个采集器使用 `Promise.allSettled`，每项有 3 秒预算。SDK 当天 SHA-256：

```text
1d5f6a401eac12840d3af187459105d42ecef522a99ecfbba4570b6dc9abc0ac
```

默认 154/macOS 下，采集结果中反复缺失 `i5`、`i17`、`i20`、`i21`、`i28`。其中 `i28` 是含 `memory/timing/timings/h3` 的 performance 对象；旧版则有此对象，`h3=false`。

字体采集 `i2` 涉及三种同步查询。对照耗时如下（单次观测，毫秒）：

| 字体查询 | 152/macOS | 154/macOS | 154/Linux |
|---|---:|---:|---:|
| HTML 尺寸查询 `W5` | 1313 | 4991 | 574 |
| Canvas 文本测量 `Y5` | 910 | 4600 | 354 |
| CSS FontFaceSet 查询 `G5` | 835 | 4461 | 362 |

154 的 CSS 字体查询本身就超过 3 秒；它占用主线程后，多个依赖事件循环/异步事件的采集项与已到期的 timeout 竞争，最终变成缺失结果。**页面再多等 90 秒也无法恢复已经超时并上传的那一轮采集。**

### 2.4 独立最小复现：无需 IPHey、网络或其混淆代码

构造一个本地 HTML，加入 310 个 `@font-face src:local(...)`，顺序调用 `document.fonts.check`；同时测量零延时 timer 被阻塞多久。

最终保留脚本的两轮结果：

| 配置 | 第一轮 | 第二轮 | 3 秒预算 |
|---|---:|---:|---|
| 0.8.0 默认 macOS | 791ms | 687ms | 通过 |
| 0.9.0 默认 macOS | 4207ms | 4150ms | 失败 |

另一次受控实验：

| 0.9.0 配置 | 第一轮 / 第二轮 |
|---|---|
| Linux persona | 296 / 284ms |
| macOS persona，但用系统 fontconfig（排除额外 Mac 字体目录） | 320 / 306ms |

零延时 timer 的实际延迟与同步任务耗时几乎相同，确认是主线程阻塞，不只是某个计时字段变化。

两版 `macos-fonts.conf` 哈希完全相同；Mac 字体逐文件校验清单的 SHA-256 也相同。不是新版偶然打包了更多字体文件。

这把问题范围缩小到 **154 binary 与相同 Mac 字体集合/配置的组合**。还未定位到 Chromium/CloakBrowser native 函数或具体 patch 行；仓库不包含该 binary 的 native 源码。不能仅凭这组实验判断是 Chromium 上游还是 CloakBrowser patch 引入。

### 2.5 因果验证与不能采用的“修复”

| 单变量实验 | IPHey 结果 | 含义 |
|---|---|---|
| 仅把 SDK 的采集预算从 3 秒改为 15 秒 | 完成，90 / Unreliable；34 项都存在 | 超时链路得到验证；不是正式方案 |
| 新版仅改 Linux persona | 完成，90 / Unreliable | persona/字体环境影响复现 |
| 新版仅改时区到 America/Los_Angeles | 仍失败 | 时区不解释未完成 |
| 新版改 Windows persona | 完成，70 / Unreliable | 能完成不等于身份一致 |
| 新版 macOS 改系统 fontconfig | 完成，60 / Unreliable | 去掉字体只是破坏 persona 的绕行方式 |
| 新版 Linux + 匹配出口时区 | 完成，100 / Trustworthy | 本出口下的完整新 profile 配置对照 |

`Linux + America/Los_Angeles` 的最后一项已用完全不改站点的保留探针再验一次：约 7.75 秒完成，100 / Trustworthy。**不能把这个地区写死给所有部署，也不应自动把已有 Mac profile 改成 Linux。**

### 2.6 正确修复方向

- **browser/native 层：** 修复/缓存 Mac 字体匹配与查询的性能退化，在不改变 font availability 和度量值的前提下降低主线程工作量；用下方本地探针与真实站点双重验收。
- **IPHey SDK 层：** 降低同步长任务影响、合理处理超时采集项。
- **IPHey 服务端/前端：** 对缺失 `performance` 做空值保护，WebSocket 错误转换成明确 UI 失败，不能无限显示加载占位。
- **CloakHub 层：** 暂不以删除字体/伪造缺失对象/篡改第三方 SDK 为生产修复。可在新建 Linux 身份的明确需求下使用已验证的 Linux 配置，但这不是原 macOS 问题的修复。

## 3. OS/网络身份一致性：修正前一次的推测

### 3.1 单变量矩阵

Fingerprint Pro 的新一轮结果：

| 版本/persona/时区 | Bot | VPN / OS mismatch | VPN confidence | Suspect Score |
|---|---|---|---|---:|
| 0.9 macOS / UTC | not_detected | true / true | low | 4 |
| 0.9 Linux / UTC | not_detected | true / true | low | 4 |
| 0.9 macOS / America/Los_Angeles | not_detected | true / true | low | 4 |
| 0.9 Linux / America/Los_Angeles | not_detected | true / true | low | 4 |
| 0.8 Linux / UTC | not_detected | true / true | low | 4 |

这些观测均显示 `proxy=false`，`timezone_mismatch=false`，`public_vpn=false`，`relay=false`，`ml_prediction=false`。主要触发项是 `os_mismatch=true`，而不是所有 VPN 方法都认为网络可疑。

补充同出口控制组：宿主机已安装的**原生 Google Chrome 144.0.7559.96**，新临时 profile，Linux UA/平台、America/Los_Angeles。仍得到 `vpn=true / os_mismatch=true / confidence=low`。其 Playwright headless 被正常检测为 `bot=bad`，与隐身能力对比无关；这里只用它检验 OS mismatch 是否特属于 CloakBrowser/macOS persona。

**结果否定了“换 Linux persona 就能解决该信号”的简单假设。** 控制组版本、宿主网络与容器网络不完全匹配，仍不足以确定是出口历史、网络栈路径、服务端算法还是共同环境所致。未获取其服务端内部判据，不能把它当成已证实的 TCP 泄漏。

### 3.2 TLS / HTTP/2 实测

使用同一页面访问 `https://tls.peet.ws/api/all`，只保留非 IP 的指纹字段。以上五个 CloakBrowser 配置均为：

```text
HTTP: h2
JA4: t13d1517h2_8daaf6152771_cb7bf5808d99
HTTP/2 Akamai fingerprint hash: 52d84b11737d980aef856699f885ca86
```

服务端看到的 UA 与各自设置的 Chrome 版本/persona 相符。JA3 hash 在观测中变化；现代 Chrome 的 TLS 扩展顺序随机化可以导致这种情况，不能把 hash 不同直接解读为异常。

含义：本次可见的 TLS/HTTP2 摘要没有因 persona 或 152→154 明显改变。**这些摘要不包含完整 TCP/IP 指纹，也不是 Fingerprint Pro 自身链路的包级证据。** 不应据此声称已证明网络身份真实或找到 OS mismatch 原因。

### 3.3 操作建议

- 区分“服务返回的风险标志”与“实际存在 VPN/代理”；本次未配置代理，低置信度分类不是网络拓扑证明。
- 根据真实出口设置 profile 的地区/时区，不要只改 User-Agent；本次 IPHey 的地域项确实受时区影响。
- 先保留当前生产 persona。若要进一步归因，应使用已授权的另一个出口和匹配版本的原生浏览器进行 2×2 对照，并向检测服务获取判据；本次没有擅自切换网络、路由、系统 TCP 参数或采购代理。

## 4. 自动化客户端：哪些痕迹由什么操作引入

对 0.9.0、每种操作独立新 profile，在 Rebrowser 做了 8 组对照：

| 客户端/操作 | 观察到的红项 | 补充 |
|---|---|---|
| 原生 WebSocket CDP，仅导航并读取结果 | 无 | 不经过 Playwright |
| Playwright 默认 connectOverCDP | 无 | 无 expose/init |
| Playwright `noDefaults:true`（helper 使用的配置） | 无 | 非“隐身开关” |
| 普通 locator 读取 h1 | 无 | 不做额外 main-world 调用 |
| `page.evaluate(() => document.getElementsByClassName(...))` | mainWorldExecution | 调用了站点在主世界 hook 的 API |
| 同样 DOM 调用，但放到显式 CDP isolated world | 无 | 仅对该探针有效，不保证其他行为不可见 |
| `page.exposeFunction(...)` | exposeFunctionLeak | 主世界出现 `__playwright__binding__` |
| `page.addInitScript` 写入诊断 marker | 无特定红项 | marker 明确出现在主世界，仍然可被网站读取 |

特别注意：未主动触发的探针不算“全面通过”；`dummyFn` 等测试执行确认可能处于未执行状态。这里只比较相应操作是否触发目标红项。

源码审查：

- `skills/cloakhub-browser/scripts/browser.mjs` 使用 `connectOverCDP(..., {noDefaults:true})`，设置的是客户端超时与 tab helper；没有自动 `exposeFunction` 或 `addInitScript`。
- `src/` 未发现这两种主动注入调用。
- `examples/antibot-audit.mjs` 的 `exposeFunction` 与主世界 DOM 调用，是为 Rebrowser 按说明主动触发检测而写；前一次两个红项不应归罪于每次普通 helper 连接。
- 本次没有改写全局 API 的 `toString`、隐藏 binding 或伪造站点判定。只确认了痕迹来源和隔离边界。

建议：正常操作优先 locator；不需要页面→客户端回调时不使用 exposeFunction；不需要初始化逻辑时不使用 addInitScript。必须访问页面主世界对象时，明确承认该交互可能被页面观察。`noDefaults:true` 的目的是少改远端上下文默认设置，不是反检测保证。

## 5. 可重复验证与回归门槛

保留两个可独立运行的小探针：

- [font-probe.mjs](evidence/identity-diagnosis/font-probe.mjs)：本地字体长任务；不加载 IPHey、不修改第三方站点。
- [iphey-probe.mjs](evidence/identity-diagnosis/iphey-probe.mjs)：原样站点完成性与已知 WebSocket 错误；不捕获加密 payload、IP 或识别 token。

仅针对**专用临时 CloakHub**运行，它们会创建并删除自己的 profile：

```sh
CLOAKHUB_URL=http://127.0.0.1:18080 \
  node docs/evidence/identity-diagnosis/font-probe.mjs
# 0.8.0 实测 exit 0

CLOAKHUB_URL=http://127.0.0.1:18090 \
  node docs/evidence/identity-diagnosis/font-probe.mjs
# 0.9.0 默认 macOS 实测 exit 1

CLOAKHUB_URL=http://127.0.0.1:18090 \
  node docs/evidence/identity-diagnosis/iphey-probe.mjs
# 0.9.0 默认 macOS 实测 exit 1，记录 performance.h3 错误

CLOAKHUB_URL=http://127.0.0.1:18090 \
IPHEY_PLATFORM=linux IPHEY_TIMEZONE=America/Los_Angeles \
  node docs/evidence/identity-diagnosis/iphey-probe.mjs
# 本次出口实测 exit 0，100 / Trustworthy
```

退出码：0 满足条件，1 未满足条件，2 基础设施/运行错误。字体阈值默认 3000ms，可用 `FONT_TASK_LIMIT_MS` 显式调整；耗时依赖硬件/负载，比较应在相同宿主和条件下串行运行，不适合无条件加入普通单元 CI。

**原问题在 native binary/字体查询与外部站点的交界处，repo 的纯 TypeScript 单测没有正确修复接缝。** 因此保留真实浏览器回归探针，而不是加一个模拟 Promise 的单测就宣称已解决。

同时修正了前一报告附带 IPHey 复现脚本的完成判断：读取非空 `#hero-status`，不再仅匹配 `Reliable/Unreliable/Suspicious`，避免把实际 `Trustworthy` 文案误判为未完成。前一次失败样本确实为空状态，此修正不改变历史结论。

## 6. 证据与清理

[精简 results.json](evidence/identity-diagnosis/results.json) 保留：21 次 IPHey 诊断、4 组本地字体对照、6 组网络/浏览器观测、8 组客户端探针、4 项最终复验。instrumentation 的字体 timing 与缺失字段单独标记，不能把它们当无 instrumentation 的整体反检测评分。

本次保留：报告、精简 JSON、310 个字体名称的 fixture、两个小型探针。不保留 SDK 混淆代码、原始加密 payload、临时 profiles、站点截图/HTML/日志。

测试结束删除三个专用容器及其匿名数据卷、此次重新拉取的 0.8.0 镜像和 `.cloakhub/identity-diagnosis`。原服务、既有 profiles、原有本地 0.9.0 镜像保持不变。没有生产代码变更、自动迁移、提交或新版本发布。
