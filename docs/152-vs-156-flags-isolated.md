# 152 vs 156：隔离启动参数后的抗检测对照

日期：2026-11-10 UTC。范围：本机 Linux x64 Docker、macOS persona，无代理、无宿主 GPU 挂载。

**后续补测说明：** [性能、功能与普通 Chromium 参照](152-vs-156-followup.md)已确认 156 的有头 CPU、弹窗策略和部分配置行为改善。本文只评价特定检测项，不是两版综合能力排名；不能据此得出“156 没有提高”。

## 结论

**旧 CLI 参数确实放大了 156 的图形故障，但修正图形配置后，156 仍没有显示出比现有 152 更好的抗检测表现。**

- **有头模式**：去掉旧四个图形参数后，两版 WebGL、SannySoft、BrowserScan、IPHey 均正常，Fingerprint 的 bot / tampering / anti-detect 判定持平。但是 156 的 VM 标记为 6/6 true，152 为 0/6。
- **无头模式**：156 不指定图形参数时 WebGL 失败；只加 `--use-gl=angle` 可恢复 WebGL 和 IPHey。恢复后，156 仍在一个 seed 的两轮中触发 tampering / anti-detect（2/6），152 为 0/6；156 的 VM 标记仍为 6/6，152 为 0/6。
- 因此，不能继续用“156 有头 WebGL 不可用、IPHey 永远不完成”评价其本体；也不能因为修好了 WebGL，就宣布两版抗检测完全相同。
- **这份 macOS persona 检测对照不足以支持“只因抗检测更强就直接替换为 156”，尤其应保留无头场景的风险评估。** 它也不足以支持全面拒绝 156；后续已测得性能和功能收益，应分别权衡。本文没有评价安全补丁、业务兼容性或 Chromium 新功能，不建议为了检测分数无限期停留旧内核。

## 1. 构建与实验控制

| 项目 | 152 | 156 |
|---|---|---|
| binary `--version` | 152.0.7977.82.1 | 156.0.8078.47.1 |
| 来源 | `ghcr.io/txchen/cloakhub_free:0.8.4` 内置 license-free build | 官方下载器取得的 Stable build |
| binary SHA-256 | `97990530346ff97afa12fb93996659934abb6d6641714384bc126af8721141ca` | `37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a` |
| 验证 | 发布镜像 digest 固定；容器内版本和文件哈希核对 | 官方 Ed25519 / SHA-256 下载验证通过，另核对版本和文件哈希 |

**构建差异是不可消除的边界**：152 是仓库发布的 license-free build，而 156 是官方授权 build。没有取得官方原版 152 做第三组对照，因此本文证明的是这两个实际可部署 binary 的差异，不能把全部差异严格归因于上游版本号。没有修改或绕过 156 授权。

共同条件：

- 基础镜像均为 `ghcr.io/txchen/cloakhub_free:0.8.4`，镜像 index digest：`sha256:961f1ac4b12c2c15569e7765bc09cbb0ebdad77892f52496b025c67b121bec33`。
- 同一宿主、出口、系统库和镜像内 Mac 字体；`FONTCONFIG_FILE=/app/macos-fonts.conf`，文件 SHA-256：`375a1a3206f772fef17bc300a652de605e9fe0dffb95177bd40f1fbc06acb242`。
- 4 CPU 配额、4 GiB memory limit、2 GiB `/dev/shm`，KasmVNC 1366×768、24-bit；没有挂载 `/dev/dri`。
- Node 24.22.2、Playwright Core 1.64.1；直接 `spawn(binary, args)`，然后 `connectOverCDP`。**没有使用 Playwright launch 或 CloakBrowser wrapper launch**，不存在它们隐式附加的启动参数。
- 固定 macOS persona、4 hardware threads、en-US、America/Los_Angeles、1366×768 窗口；页面验证了 platform、语言、时区、CPU、屏幕和 WebGL。
- 每组新 user-data-dir，串行执行。先用独立空白页做局部探针，再关闭该页；每个检测站点使用独立标签页。同一组内共享 profile，但不做 stealth 注入、`exposeFunction` 或站点主世界初始化补丁。
- 审核 `/proc/<pid>/cmdline`：所有正式组的实际 argv 都与传入 argv 完全一致。保留完整参数在证据 JSON；未增加 `--enable-automation`、UA override 或 `--test-type`。
- 主矩阵每个 seed / 模式第一轮按 152→156，第二轮按 156→152。恢复无头图形的补充矩阵同样交错。

这不是“零 flags”测试。容器所需的 `--no-sandbox`、CDP、首次启动处理、窗口和身份参数保留且两版一致；重点隔离的是旧四个图形 flags。无法排除所有公共参数与版本的交互，也未对每个身份参数做穷举。

### 样本

- 无额外图形参数：2 版本 × 2 模式 × 3 seeds × 2 轮 = **24 组**。
- 参数拆分：2 版本 × 2 模式 × 6 配置 = **24 组局部图形探针**，单 seed、每配置一次。
- 无头只加 `--use-gl=angle`：2 版本 × 3 seeds × 2 轮 = **12 组**。
- 旧四参数有头完整站点复测：2 版本 × 1 seed = **2 组**。
- 合计 **62 组独立 profiles、152 次站点访问**；其中站点返回 429 的观测不计作检测结果。另有 2 组预跑未计入正式分母。
- seeds：20260909 / 20260910 / 20260911。重复 seed 不是独立用户样本，不能计算真实封禁概率。

## 2. 有头：排除旧图形参数后

每列 3 seeds × 2 轮，共 6 次。除非另述，下表分子都是检测阳性或成功次数。

| 检查 | 152 | 156 |
|---|---:|---:|
| WebGL / WebGL2 正常 | 6/6 | 6/6 |
| SannySoft 无 failed / warn 单元格 | 6/6 | 6/6 |
| BrowserScan Normal | 6/6 | 6/6 |
| IPHey 完成 | 6/6 | 6/6 |
| IPHey 分数 / 判定 | 全部 100 / Trustworthy | 全部 100 / Trustworthy |
| Fingerprint bot=not_detected | 6/6 | 6/6 |
| tampering / anti_detect_browser 阳性 | 0/6 | 0/6 |
| virtual_machine 阳性 | **0/6** | **6/6** |
| Suspect Score | 全部 0 | 全部 11 |

Fingerprint tampering ML 分数（两轮重复值相同）：

| seed | 152 | 156 |
|---|---:|---:|
| 20260909 | 0.0951 | 0.2101 |
| 20260910 | 0.0296 | 0.0759 |
| 20260911 | 0.0549 | 0.1436 |

这些 ML 分数不是被封概率。布尔 tampering 判定都为 false，不能只按数值差宣称显著退步。**更明确的差异是同场、图形均可用时 VM 标记仍不同**；没有定位具体判据，不能认定由 GPU、Vulkan、许可证或某个硬件字段单独造成。

## 3. 无头：必须把图形修复前后分开

### 不指定图形 flags

- 152：6/6 WebGL/2 正常，SannySoft 无失败项，IPHey 100 / Trustworthy；Fingerprint 6/6 完成、tampering 和 VM 均为 false。
- 156：6/6 WebGL/2 为 null，SannySoft 两个 WebGL 单元格失败；IPHey 6/6 在约 25 秒观测窗口结束后仍为占位状态。**不是“0 分”，也没有证明永不完成。**
- 两版 BrowserScan 均为 6/6 Normal。
- 156 的 Fingerprint 只有 3/6 返回完整信号，另 3 次出现 HTTP 429；完整的 3 次中 tampering 阳性 2 次、VM 阳性 3 次。不能把缺失结果当作通过或失败，也没有证明限流由版本造成。

### 两版都只加 `--use-gl=angle`

单参数探针发现它能恢复 156 无头 WebGL，随后另做三 seeds、两轮完整站点对照。不是只为 156 选择有利配置，两版都加相同参数。

| 检查 | 152 | 156 |
|---|---:|---:|
| WebGL / WebGL2 正常 | 6/6 | 6/6 |
| SannySoft 无 failed / warn | 6/6 | 6/6 |
| BrowserScan Normal | 6/6 | 6/6 |
| IPHey 完成，100 / Trustworthy | 6/6 | 6/6 |
| Fingerprint 完整信号 | 6/6 | 6/6 |
| bot=not_detected | 6/6 | 6/6 |
| tampering / anti_detect_browser 阳性 | **0/6** | **2/6** |
| virtual_machine 阳性 | **0/6** | **6/6** |

156 的 tampering 阳性集中于 seed 20260909，两轮均触发；不能推广成每个 seed 都会失败。

| seed | 152 ML 分数（两轮） | 156 ML 分数（两轮） | 156 tampering |
|---|---|---|---|
| 20260909 | .4059 / .4059 | .9029 / .9029 | true / true |
| 20260910 | .0169 / .0169 | .0646 / .0646 | false / false |
| 20260911 | .2454 / .4419 | .7601 / .7601 | false / false |

152 最后一组也出现 VPN / OS mismatch 阳性，Suspect Score 从其他五次的 6 变为 13；156 为 11 或 16。不能把整体 Suspect Score 的变化全部解释为 VM，或把“某一个分数更低”当成完整优劣判断。不同批次与服务端历史也可能影响结果。

**图形修复消除了 WebGL / IPHey 的差异，但没有消除 VM 标记或特定 seed 的 tampering 差异。** 这比只观察图形故障更接近用户关心的抗检测对照，但不是“所有配置因素均已排除”。

## 4. 四个图形参数的单独影响

固定 seed 20260909，每格一次局部探针；“正常”表示 WebGL 和 WebGL2 均创建成功，不代表站点全通过。

| 额外图形参数 | 152 有头 | 156 有头 | 152 无头 | 156 无头 |
|---|---|---|---|---|
| 无 | 正常 | 正常 | 正常 | null |
| `--disable-gpu` | null | null | 正常 | null |
| `--disable-dev-shm-usage` | 正常 | 正常 | 正常 | null |
| `--use-gl=angle` | 正常 | 正常 | 正常 | **正常** |
| `--use-angle=swiftshader` | 正常 | null | 正常 | null |
| 上述四项一起 | 正常 | null | 正常 | null |

参数之间存在交互：例如 152 有头单独 `--disable-gpu` 失败，但四项组合可用。因此不能简单地把组合故障归结为唯一一个 flag，或假设逐项结果可以相加；本次未穷举所有两项、三项组合。

随后用旧四参数做有头站点复测：152 的 WebGL 正常、IPHey 100 / Trustworthy；156 的 WebGL 为 null、SannySoft 两个 WebGL 单元格失败、IPHey 在约 25 秒窗口内未完成。两版 BrowserScan 仍为 Normal，Fingerprint tampering 均为 false，VM 分别为 false / true。这个单 seed 的复测与旧配置干扰方向一致，但不把它当成新的独立大样本。

## 5. 运行限制与建议

- **有头 156 候选配置**：移除旧四个图形 flags，保留正确的 Mac fontconfig。
- **无头 156 候选配置**：本环境只加 `--use-gl=angle`，不要同时照搬旧四参数组合。该配置恢复图形，不保证消除反检测风险。
- 没有修改 `src/browser-process-launcher.ts` 或生产服务默认值。参数调整应另做启动、CDP、显示与 profile 回归后再部署。
- 本次没有 Windows / Linux persona、ARM64、原生 macOS、真实 GPU、代理、真实业务账号、长期运行或行为风控测试；没有对 Canvas、Worker、iframe 或网络协议一致性做完整专项认证。
- 当前宿主与旧测试不同；IPHey 从旧报告的 Unreliable 变为 Trustworthy，不能归功于升级。结论只依赖本次同场对照。
- 初次预跑用 Bun 驱动 Playwright 时两版都在 CDP WebSocket 连接阶段超时；改用相同 Node runtime 后正式实验正常。该预跑没有有效站点结果，已排除。正式组均通过 `Browser.close` 正常退出，无强制停止。
- 检测器是外部动态服务；HTTP 429、服务端身份关联、时间变化都可能影响结果。未尝试绕过限流；恢复图形的补充批次增加组间等待，且没有把重测覆盖原始缺失记录。

## 证据

- [逐组精简结果](evidence/152-vs-156-flags-isolated/results.json)：完整 argv、实际 argv 审核、局部属性、分项判定、缺失标记及 GPU 错误摘录；不含 key、出口 IP、原始 Visitor ID 或事件 ID。
- [复现说明](evidence/152-vs-156-flags-isolated/README.md)与同目录执行脚本。
- 本地原始观测位于 `.scratch/compare-152-156/`，未纳入公共证据；预跑与正式组分开。
