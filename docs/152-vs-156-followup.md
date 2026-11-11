# 152 → 156 补测：已确认的改善、未确认的改进与检测风险

日期：2026-11-10 UTC。接续[启动参数隔离对照](152-vs-156-flags-isolated.md)。

后续已将测试收敛为[可复用 suite](browser-evaluation.md)。[Windows 补测及新 suite 的单次 macOS 冒烟](156-windows-persona.md)出现 VM=false；新旧 harness／时间等条件不同，尚未定位原因。以下保留本批次的真实观察，不把 VM 判定当成 binary 的永久属性，也不把跨批次样本混算。

## 结论先行

**“156 没有提高”不成立。** 上一轮检测页对照不足以衡量全部收益；本轮已确认有头软件渲染 CPU 大幅下降，以及弹窗策略、GPU vendor 简写规范化、触控配置、最大化窗口行为的变化。与此同时，先前观测到的 Fingerprint 风险信号不能因为这些收益而被抹去。

应分别评价：

1. **性能与功能**：本次有可复现的正向证据。
2. **身份／行为一致性**：部分具体修正已复现，但不等于所有检测器上的综合胜出。
3. **外部检测器**：原有 VM / 特定 seed 无头 tampering 风险仍需单独判断；它们不是通用“真假浏览器”真值。
4. **安全更新**：156 基于更新的 Chromium；本次未做精确 CVE 对照，不能据检测分数判断哪个版本更安全。

## 1. 官方声明的范围

以下为官方发布说明，不是全部都已被本次实验验证：

| 版本 | 官方声明 | 本次处理 |
|---|---|---|
| [154.0.8037.57.2][154b]（Linux） | GPU-less / Docker 有头 CPU 降低 3–6 倍；代理特殊字符与失败关闭处理；许可重试；Windows persona 字体和硬件匹配 | 测 CPU；其他保留为来源声明，不挪用成 Mac persona 抗检测实测 |
| [155.0.8059.39.1][155a] | Canvas 导出、图形和网络计时改进；透明代理的 DoH 经代理传输；ARM 架构报告 | 测本地 Canvas 和上下文一致性；未测网络代理／ARM |
| [155.0.8059.39.2][155b]（Linux） | 请求拦截不再随机导致网络进程崩溃；GPU vendor 简写展开；窗口位置、音频采样率、许可可靠性改进 | 测有界请求拦截、vendor、窗口；未做音频设备或许可故障注入 |
| [156.0.8078.47.1][156] | 最大化窗口几何；Canvas（含 Worker）；`geoip=True` 下 UDP-capable SOCKS5 的 WebRTC 传输；保持弹窗阻止；新的 max-touch-points flag | 测窗口、Canvas／Worker、弹窗和触控；WebRTC 传输未测 |

公开 release/tag 调查没有找到 153 的对应发布条目，不能虚构一个 153 改进阶段。154 的说明把前一个 Linux Stable 指向 `152.0.7977.82.2`；本项目现有对照是 `.82.1`，两者也不能混称。[154a]

“macOS persona on Linux”和“运行在 macOS 上的 binary”不同。Windows 字体扩充、ARM 宿主修复不能算作本次 Linux x64 / macOS persona 的已证实收益。

## 2. 实验条件与方法

- 沿用前一轮相同的 `cloakhub_free:0.8.4` 基础镜像、Mac 字体/fontconfig、Node 24.22.2、Playwright Core 1.64.1、4 CPU / 4 GiB / 2 GiB shm、KasmVNC；不挂真实 GPU。
- 152：镜像内 license-free `152.0.7977.82.1`；156：官方 Stable `156.0.8078.47.1`。仍然存在构建来源混杂，不能把全部差异严格归因于版本号。
- 增加普通 **Chrome for Testing 156.0.8078.4**，由 Playwright 官方下载渠道取得，作为同环境参考。它不是同补丁版本，不是真实 Mac，也不是无自动化的真人基线。
- 直接启动 binary + CDP，记录实际 argv。两版有头不加旧四个图形 flags；无头只加 `--use-gl=angle`。不复用用户 profiles。
- 本地服务器提供主页面、不同端口的跨源 iframe、dedicated Worker、请求回显、动画和弹窗页面。Canvas 像素、PNG 数据在进程中比较后仅保留哈希与差异计数。
- 性能／表面主矩阵：2 版本 × 2 模式 × 3 seeds × 2 轮 = **24 组**；第二轮倒转版本顺序。seed 为 20260909 / 20260910 / 20260911。
- 另有 22 组 flag/geometry 控制和 8 组外部检测器参照，总计 **54 组正式 profiles**。额外控制组不是三 seeds 两轮矩阵；各自是明确标注的单配置观察，不能当成统计总体。
- 性能使用容器 cgroup v2 `cpu.stat usage_usec`，包含浏览器、GPU 子进程、Xvnc、Node 和本地服务器。是**容器整体 CPU 时间**，不是只取浏览器主进程，也不是墙钟耗时。

## 3. 已确认：有头软件渲染 CPU 显著下降

本地固定 800×600 的 2D Canvas 动画，每帧背景填充和 50 次矩形绘制。先预热 1.5 秒，再观测约 5 秒；两版均使用相同程序，不以降低帧数换取省 CPU。

| 模式／版本 | 5 秒窗口 CPU 时间中位数 | 六次范围 | rAF 绘制计数范围 |
|---|---:|---:|---:|
| 152 有头 | **8.140 秒** | 7.825–8.287 秒 | 300–301 |
| 156 有头 | **1.099 秒** | 1.024–1.219 秒 | 300–301 |
| 152 无头 | 19.935 秒 | 8.065–20.014 秒 | 291–301 |
| 156 无头 | 19.961 秒 | 6.805–19.990 秒 | 292–300 |

有头中位数相差约 **7.4 倍，156 的 CPU 时间下降约 86.5%**。多核 CPU 时间可以大于 5 秒墙钟，4 CPU 配额下上限约为 20 CPU 秒。rAF 次数不是独立测得的物理显示呈现帧数。

这个改善在三个 seeds 和两轮中都出现，方向与官方对 GPU-less 有头环境的声明一致。[154b] 但官方“3–6 倍”的对照是 154.57.1→154.57.2，未公布同一工作负载；**不能把我们测得的 7.4 倍称为精确复现官方倍率**。

无头没有同样的整体收益，且部分 seeds 接近 CPU 配额上限。因此不推广为“所有场景都快 7 倍”，也不把性能改善直接当作降低被检测概率。

## 4. 已确认的行为和配置变化

### 4.1 自动化参数不再关闭弹窗阻止

本地页面在加载 700ms 后自行 `window.open()`，没有点击、用户手势，也不是在 Playwright `evaluate` 调用里直接打开，以避免自动化调用的 user-gesture 语义污染结果。

| 浏览器 | 默认 | 加 `--disable-popup-blocking` |
|---|---|---|
| 152 | 阻止 | **允许** |
| 156 | 阻止 | **仍阻止** |
| 普通 Chrome 156 | 阻止 | 允许 |

这支持 156 发布说明中的特定行为改变：即使自动化要求禁用，仍保留普通浏览器默认弹窗限制。[156] **不是说普通 Chrome 带这个 flag 的行为与 156 相同**。它可能减少因常用自动化参数而出现的行为差异，也可能影响依赖无手势弹窗的脚本；本次没有证明它改变任何商业检测器分数。

### 4.2 GPU vendor 简写被展开

Windows persona、同 seed、只加 `--fingerprint-gpu-vendor=intel`：

- 152 的 WebGL unmasked vendor：`intel`。
- 156：`Google Inc. (Intel)`。

这是官方 155.39.2 提到的具体修复的可观测复现。[155b] 默认不传此 flag 时，152 本来也可以返回正常 vendor；**不能扩大成“152 所有默认 GPU 身份都错”**。

### 4.3 触控配置新增能力

Windows persona，加 `--fingerprint-max-touch-points=5`：

- 152：`navigator.maxTouchPoints === 0`，本次未生效。
- 156：值为 `5`。

证明新增配置能力可用。[156] 不等于普通 Mac 应该配置触控，更不等于触控身份整体已被认证。

### 4.4 最大化几何有变化，但不是完整真实 Mac 认证

不传窗口大小／位置，仅加 `--start-maximized`，有头 macOS persona：

| 字段 | 152 | 156 |
|---|---:|---:|
| screenX / screenY | 139 / 33 | 0 / 33 |
| outerWidth / outerHeight | 1050 / 735 | **1366 / 735** |
| innerWidth / innerHeight | 1050 / 627 | **1366 / 614** |
| available work area | 1366 × 735 | 1366 × 735 |

156 的页面可见窗口填满了声明的工作区，viewport 也较短，符合发布说明描述的方向。[156] 固定 1366×768 窗口组及无头最大化组，两版没有同样的差异。

这个容器没有完整桌面窗口管理器。CDP `windowState` 中 156 仍为 `normal`；152 有头及普通 Chrome 有头也没有得到真正的 WM maximized 状态。**测到的是窗口几何实现改变，不是确认它在真实 macOS 上每个字段都正确。**

另测启动位置 4000,3000：两版页面报告都已落在声明的工作区以内，没有在该案例中发现 156 独有的改进。不能把发布声明反向当作“152 一定存在这个缺陷”的证明。

## 5. 本轮没有证明改善的项目

### Canvas、Worker、iframe、请求身份

24 组中：

- 主页面、dedicated Worker、跨源 iframe 的共有 navigator/UA-CH 字段一致；HTTP 回显 UA、platform、architecture 与页面值一致。
- 主页面与 Worker／iframe 的 Canvas 原始像素哈希、PNG 解码像素哈希一致，重复读取稳定。
- 配对同 seed、同模式时，本例的两版 Canvas 结果也一致，未测出新版收益。
- **两版的 `getImageData` 与进程外解码 PNG 之间都有 10–12 个字节差异**（76,800 字节像素数组），普通 Chrome 参考样本为 0。PNG 在 Node/pngjs 中解码，避免了“解码后再用浏览器 Canvas 读取”二次注入的干扰。

这只是固定图形／英文文本样本，不覆盖全部颜色空间、emoji、字体、导出格式、WebGPU、SharedWorker 或 ServiceWorker。字节差异是共享观测，不自动等同于安全缺陷；更不能用它解释“只有 156 出现 VM 标记”，因为这份测试中两版相同。

### 请求拦截稳定性

每个主矩阵 profile 200 个本地请求，8 并发分批，用 `page.route` + `route.fetch` + `fulfill` 改写响应。两版分别 **2,400 / 2,400** 请求成功，没有观测到浏览器退出或路由失败。

这没有复现 152 的随机崩溃，也就没有独立证明 156 的崩溃修复收益。只能说两版均通过本工作负载。测试没有作为代理路径验证：`route.fetch` 使用 Playwright 自己的请求客户端，不能据此证明浏览器代理无泄漏。

### 字体与代理等

- 本轮 `document.fonts.check` 小样本未形成新版稳定性能优势；不存在字体的 check 也可能为 true，结果不是已安装字体数量。
- SOCKS5 WebRTC UDP、透明代理 DoH、44.1/96kHz 实际音频设备、Windows 真实字体覆盖、许可故障恢复和逐 CVE 安全审计没有执行。对应内容仍是有来源的厂商声明，不列为已验证收益。
- 没有真实 Mac/实体用户设备参照；普通 Linux Chrome 的结果不能充当 macOS 字段真值。

## 6. 外部检测器与 VM 定位

固定 seed 20260909，增加低频外部检测器对照；以下每行一次，不代替前一轮的重复矩阵。8 次均取得完整响应，无 HTTP 429。

| 对照 | WebGL | bot | tampering | anti_detect_browser | VM |
|---|---|---|---|---|---|
| 152 / macOS / 有头 | 正常 | not_detected | false | false | false |
| 156 / macOS / 有头 | 正常 | not_detected | false | false | **true** |
| 152 / Linux / 有头 | 正常 | not_detected | true | true | false |
| 156 / Linux / 有头 | 正常 | not_detected | true | true | false |
| 普通 Chrome / 有头 / 默认图形路径 | null | not_detected | true | false | false |
| 普通 Chrome / 无头 / 基础 ANGLE 参数 | null | bad | true | false | false |
| 普通 Chrome / 有头 / 显式 SwiftShader 尝试 | null | not_detected | true | true | false |
| 普通 Chrome / 无头 / 显式 SwiftShader 尝试 | null | bad | true | false | false |

解释和限制：

1. **VM 差异在有头 macOS persona 再次出现，而 156 Linux persona 没有出现。** 这支持优先排查版本与 persona 的交互，而不是“这台 Docker 宿主一定被判为 VM”。但 persona 一次改变多个表面，未定位具体字段或检测规则。
2. Linux persona 仍刻意保留相同 Mac fontconfig，以控制配置变量；两版 tampering 都是 true。**这不是推荐 Linux 部署配置，也不是“改成 Linux 就全部通过”的证据。**
3. 普通 Chrome 在 CDP 驱动、虚拟显示环境里也被标 tampering。默认参考组的 anti_detect_browser 是 false，而 developer_tools 为 true；不能把它与 CloakBrowser 某个 seed 的 ML 阳性当成同一个机制。显式 SwiftShader 有头尝试甚至出现 anti_detect_browser=true，说明该字段也不是“是否运行反检测改版 binary”的字面真值。
4. 普通 Chrome 的 WebGL 在默认设置下失败；随后显式加 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` **仍未恢复**，日志同样为 Vulkan initialization / EGL_NOT_INITIALIZED。这个失败本身不能一概归因于 CloakBrowser patch；也意味着这里**没有获得图形正常的普通 Chrome 或真实 Mac 基线**。不能据此声称 156 的全部图形数据更真实。
5. 本批次所有外部组都出现 VPN / OS mismatch 信号，连普通 Chrome 也有；152 macOS 的 Suspect Score 已不同于早先批次。服务端、时序、出口或其他状态未被完全隔离，所以不拿总分变化直接归因于升级。
6. Canvas、Worker、iframe 的本例结果两版一致；这份共同结果不能解释差异。**VM 的内部根因和此前特定无头 seed 的 tampering 根因仍未找到。** 更细的 WebGPU、原生 Mac 表面和检测器输入差异需要后续专门实验，不能现在宣称修复。

实际缩小了排查范围，但没有获得一个“关闭某 flag 就能清除 VM”的配方。

## 7. 如何据此做升级决策

**不应把上一轮“156 在部分检测项上没有占优”升级为“156 没有任何价值”。** 对 GPU-less、有头、长时间运行的场景，CPU 改善很可能是实际部署收益，值得在隔离环境继续验证；对依赖新代理能力或特定配置修复的场景，也有具体评估理由。

另一方面，若业务特别受 Fingerprint 的 VM / anti-detect 信号影响，前一轮已复现的差异仍是升级风险，不能用 CPU 提升抵销。正确决策是按实际业务权衡**资源、功能、检测信号与安全更新**，而不是给版本排一个单一总名次。

没有修改生产 launcher、默认 flags 或部署镜像。完整证据与复现脚本位于 [evidence/152-vs-156-followup](evidence/152-vs-156-followup/README.md)。

[154a]: https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v154.0.8037.57.1-pro
[154b]: https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v154.0.8037.57.2-pro
[155a]: https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v155.0.8059.39.1-pro
[155b]: https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v155.0.8059.39.2-pro
[156]: https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v156.0.8078.47.1-pro
