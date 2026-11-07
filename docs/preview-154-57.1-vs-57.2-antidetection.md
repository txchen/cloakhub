# CloakBrowser preview 154.0.8037.57.1 vs 57.2：反检测实测比较

测试日期：2026-10-06（UTC），57.2 于当日 18:00 UTC 发布后约 1.5 小时开始。前置报告：[0.8.0 vs 0.9.0](free-080-vs-090-antidetection.md)、[IPHey 与 OS mismatch 诊断](identity-diagnosis-20261001.md)。

## 结论

**在本次测试范围内，57.2 的反检测结果与 57.1 没有可区分的差异。** 所有公开检测页的判定逐项相同；本地探针读到的指纹表面（UA/UA-CH、GPU、字体度量、Canvas 哈希、窗口尺寸）在同 seed 下逐字节一致。57.2 没有修复已知的两个问题：

- **IPHey 仍然无法完成**（16/16 次停留在占位值），服务端仍返回 `null is not an object (evaluating 'e?.performance.h3')`。
- **macOS persona 的字体查询长任务仍然存在**：310 个字体的 `document.fonts.check` 在 57.2 上为 4.3–6.0 秒，57.1 为 5.2–7.3 秒，两者都超过 IPHey 的 3 秒采集窗口。范围重叠，不能据此认定 57.2 更快。

上游 changelog 对 57.2 的描述是：GPU-less Linux 有头模式 CPU 显著降低、代理处理更安全、license 连接更耐心并新增 `--license-route`、Windows persona 系统/代码字体默认对齐真实 Windows。这些主要是性能、连接和 Windows 字体方面的改动，不是针对本次检测项的反检测改动。本次在可测到的范围内也没有观察到这些变化的效果，见第 5 节。

**建议：** 不必为了反检测立即切到 57.2，也没有发现需要回避 57.2 的回归。

## 1. 对照条件

| 项目 | 57.1 | 57.2 |
|---|---|---|
| binary `--version` | CloakBrowser 154.0.8037.57.1 | CloakBrowser 154.0.8037.57.2 |
| CDP 版本 / UA-CH 完整版本 | 154.0.8037.57 / 154.0.8037.58 | 相同 |
| 来源 | 9 月 30 日经官方签名校验的缓存 | 当日官方下载器 `downloadProBinary`，Ed25519 + SHA-256 校验通过 |
| 解压体积 | 795,009,230 bytes | 794,960,350 bytes |

- 两个 binary 都以只读方式挂载进同一镜像 `cloakhub:0.9.0`，通过 `CLOAKHUB_BROWSER_BIN` 指定。两组只换 binary，Hub、字体、fontconfig 完全相同。
- Linux amd64 宿主、同一直连出口、无代理；容器限 4 CPU、`/dev/shm` 2GiB；默认 `en-US`、`America/Los_Angeles`。
- 付费 key 只有单会话，所有浏览器串行运行。**配对顺序：r1 先 57.1 后 57.2，r2 先 57.2 后 57.1**，用来抵消外部检测服务随时间漂移的影响。
- 每轮每个版本跑 6 组公开站点，每组新建 profile：
  - macOS seed 20260909 有头，9 个站点；
  - macOS seed 20260910、20260911 有头，DeviceInfo + Fingerprint；
  - macOS seed 20260909 无头，7 个站点；
  - Linux、Windows persona seed 20260909 有头，SannySoft + DeviceInfo + Fingerprint。

  合计 2 版本 × 2 轮 × 26 = **104 次站点观测**。
- 附加探针：
  - 字体长任务探针 2 版本 × 2 轮 × 2 persona；
  - IPHey 完成性探针 4 次；
  - Canvas/身份探针 8 个 profile，每版 4 个，其中 seed 20261001 的 2 个 profile 额外跑 IPHey，最长等 90 秒；
  - 有头 CPU 探针每版 2 次。

## 2. 检测结果总表

每个格子覆盖两轮。除注明外，两版结果逐项相同。

| 检测 | 57.1 | 57.2 | 说明 |
|---|---|---|---|
| SannySoft（mac 有头/无头、Linux、Windows） | 8/8 无失败行 | 8/8 无失败行 | 持平 |
| DeviceAndBrowserInfo（全部 6 组） | 12/12 `isBot=false`，无阳性明细 | 相同 | 持平 |
| BrowserScan（mac 有头/无头） | 4/4 `Normal` | 4/4 `Normal` | 持平 |
| CreepJS（mac 有头/无头） | 31% like headless / 0% headless / 0% stealth；字体 2/51 | 相同 | 共享弱信号未变 |
| Rebrowser（mac 有头/无头） | 10 项中 2 红：`mainWorldExecution`、`exposeFunctionLeak` | 相同 | 两项红由测试刻意触发 |
| Incolumitas（mac 有头） | fpscanner `WEBDRIVER: FAIL` | 相同 | 共同问题，未归因 |
| reCAPTCHA v3 demo | 2/2 score 0.9 | 2/2 score 0.9 | 持平 |
| IPHey（站点套件 + 探针） | 0/8 完成 | 0/8 完成 | 未修复 |
| Fingerprint Pro `bot`（全部 6 组） | 12/12 `not_detected` | 12/12 `not_detected` | 持平 |

### Fingerprint Pro 细项

`tampering_ml_score` 各轮取值：

| 组 | 57.1 r1 / r2 | 57.2 r1 / r2 |
|---|---|---|
| macOS 20260909 有头 | 0.0973 / 0.0973 | 0.1853 / 0.0973 |
| macOS 20260909 无头 | 0.2809 / 0.2809 | 0.6015 / 0.2809 |
| macOS 20260910 有头 | 0.0299 / 0.0299 | 0.0299 / 0.0299 |
| macOS 20260911 有头 | 0.0535 / 0.0535 | 0.0537 / 0.0535 |
| Linux 20260909 有头 | 0 / 0 | 0 / 0 |
| Windows 20260909 有头 | **0.9997 / 0.9997** | **0.9997 / 0.9998** |

- 57.2 r1 的两个较高值（0.1853、0.6015）出现在同一轮，那一轮 `vpn_confidence=high`。57.2 r2 回到与 57.1 完全相同的 0.0973 / 0.2809。分数随网络侧信号变化，**不能当作 57.2 的回归**。
- 其余组两版的值在小数点后 4 位上相同。这说明 Fingerprint 看到的浏览器表面没有变化，与第 3 节的本地探针一致。
- `vpn` / `os_mismatch` 在两版中都会翻转，与版本无关：
  - 57.1 r1 全部 false，57.1 r2 全部 true（low）；
  - 57.2 两轮 true / false 混合。
  这与[前次诊断](identity-diagnosis-20261001.md)一致：该信号由出口/网络侧决定，不是 persona 版本决定的。`Suspect Score` 随之在 0 和 4 之间变化。

### Windows persona：两版都被判为 tampering / anti-detect

Windows persona 在两版中每次都是：

- `tampering=true`
- `anti_detect_browser=true`
- `tampering_ml_score≈0.9997`
- `Suspect Score` 8–12

9 月 30 日 57.1 的旧数据（3 个 seed）也是同样结果。57.2 changelog 声称 Windows 系统/代码字体默认对齐真实 Windows，但本机实测：

- 容器内 `fc-list` 没有 Segoe/Calibri/Consolas。
- Windows persona 下 `Segoe UI`、`Calibri` 的 canvas 度量与 `monospace` 回退值相同（1080.0）。
- 两版字体度量哈希相同（`fd8774cd07254ee0`）。

**在没有 Windows 字体的 Linux 容器里，57.2 没有改变可观察的 Windows 字体表面**，也没有改变 Fingerprint 的判定。这不能推广到装了 Windows 字体或运行在原生 Windows 上的情况。CloakHub 默认用 macOS persona，不受此影响；但不要在当前镜像里使用 Windows persona。

### 可关联性

同 persona、同 seed 的两版得到相同的 Visitor ID 哈希，例如 macOS 20260909 有头为 `cd9a037cf1af476f`。另外，**macOS seed 20260909 与 20260911 也被识别成同一个 Visitor ID**，且 `visitor_found=true`。换 seed 不保证在 Fingerprint Pro 处切断关联。这一点两版相同，结合同出口和服务端历史，不能全归因于浏览器。

## 3. 本地指纹表面：同 seed 逐字节一致

`audit.mjs` 本地探针覆盖 24 个 profile，`canvas-probe` 覆盖 8 个 profile，每个版本各占一半：

- **身份一致性**：每个 profile 都检查主页面、Dedicated Worker、跨源 iframe 和 HTTP 头之间的一致性，共 12 项。项目包括 UA、platform、UA-CH 高熵值（architecture、bitness、platformVersion、fullVersionList）、HTTP `Sec-CH-UA-*`、语言、CPU、时区。两版全部通过。
- **WebGL / WebGL2**：都能创建 context 并 `readPixels`，读到 `[64,128,191,255]`，`getError()=0`。
- **同 seed / persona / 模式下两版逐项相同**：UA、UA-CH 完整版本 `154.0.8037.58`、platformVersion、GPU renderer、12 种字体的 canvas 度量、screen/window 尺寸。
- **Canvas 文本哈希**两版相同，并且与 10 月 1 日 0.8.0/0.9.0 报告中的值相同：

| seed / 模式 | 哈希前 16 位（两版相同） |
|---|---|
| 20261001 有头 | 493f4f97cf16cee1 |
| 20261001 无头 | 4c2b84da3dccbbeb |
| 20261002 有头 | 83bd2e121a945b9d |
| 20261002 无头 | 14386d8b2fa293fc |

升级到 57.2 不会改变已有 profile 的指纹，也就不会切断与旧会话的关联。

**两版共同的小瑕疵：** Linux persona 的 `navigator.languages` 为 `["en-US","en-GB","en-US","en"]`，`en-US` 重复；而 HTTP `Accept-Language` 为 `en-US,en-GB;q=0.9,en;q=0.8`。主页面与 Worker 一致，所以没有触发上面的一致性检查，但重复项本身是可被检测的异常值。macOS persona 为正常的 `["en-US","en"]`。

## 4. IPHey 与字体长任务

字体探针：310 个 `@font-face src:local(...)`，跑两轮 `document.fonts.check`，下表为 taskMs，阈值 3000ms：

| persona | 57.1 r1 | 57.1 r2 | 57.2 r1 | 57.2 r2 |
|---|---|---|---|---|
| macOS | 7277 / 5212 | 6481 / 6401 | 6026 / 6026 | 4421 / 4305 |
| Linux | 308 / 315 | 516 / 432 | 436 / 434 | 348 / 304 |

- 两版 macOS 都失败，Linux 都通过。可用字体数也相同（macOS 17，Linux 2）。
- 本次 57.1 的数值高于 10 月 1 日记录的约 4.2 秒。同主机不同时段的波动已经超过两版之间的差距，所以**没有证据显示 57.2 修复或缓解了这个问题**。
- IPHey 在两版中都是 WebSocket 正常收发，但服务端报 `e?.performance.h3` 空值错误，页面停留在 `Temporary value`。这与[诊断报告](identity-diagnosis-20261001.md)中的失效链路一致：字体长任务导致采集超时，performance 数据缺失，服务端空值异常。

## 5. 有头 CPU（changelog 声称的主要改动）

macOS persona 有头模式，容器 cgroup `usage_usec` 增量，单位为单核百分比，每阶段 3 × 20 秒：

| 场景 | 57.1 两次 | 57.2 两次 |
|---|---|---|
| 静态页空闲 | 0.5–1.3% | 0.5–1.9% |
| 800×500 canvas rAF 动画 | 42.2%、30.4%（均值） | 32.9%、39.0%（均值） |
| 动画帧率 | 60.4 fps | 60.4–60.6 fps |

- 两版区间重叠，**在这个负载下没有观察到 CPU 下降**。
- 上游所说的场景可能是窗口合成、视频或其他负载，本次没有覆盖，因此不否定上游声明。
- 本测试只有 2 次样本，不足以给出性能结论。

## 6. 限制

- 仅 Linux amd64、单一出口、无代理；未测 ARM64、原生 macOS/Windows、带 Windows 字体的镜像。
- 未测 57.2 的代理改动和 `--license-route`、`--fingerprint-transparent-proxy`、Cloudflare/真实业务站点、TLS/HTTP2 指纹。
- 外部站点结果相关性强，不是独立样本；ML 分数只是单次观测，没有统计显著性。
- "未被这些页面判为 bot" 不等于真实站点不拦截。

## 7. 证据与复现

- 精简结果：[results.json](evidence/preview-154-571-vs-572/results.json)。包含 104 次站点观测的解析值、所有探针结果和每步退出码。Visitor ID 只保留 SHA-256 前 16 位，不含 IP、key 或 token。
- CPU 探针：[cpu-probe.mjs](evidence/preview-154-571-vs-572/cpu-probe.mjs)。
- 其余探针使用仓库已有脚本：
  - [antibot-audit.mjs](../examples/antibot-audit.mjs)
  - [font-probe.mjs](evidence/identity-diagnosis/font-probe.mjs)
  - [iphey-probe.mjs](evidence/identity-diagnosis/iphey-probe.mjs)
  - [probe.mjs](evidence/free-080-vs-090/probe.mjs)：改为从环境变量读取 Hub 地址和 token。
- 原始日志、HTML 摘录、截图和编排脚本（`lab.py`、`run.py`、`post.sh`、`summarize.py`）保留在被忽略的本地目录 `.cloakhub/cloak154-572-evaluation/`。

## 8. 清理

- 两个测试容器 `cloakhub-572eval-v571/v572` 已删除，它们的 `/data`（profiles、license HOME）和含 admin token 的 env 文件已删除。
- 现有服务 `cloakhub-cloakhub-free-1` 未改动。
- 57.2 binary 保留在 `.cloakhub/cloak154-572-evaluation/cache/`（约 760MB），供后续复测；不需要时可以直接删除。
