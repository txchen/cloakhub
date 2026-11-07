# Preview 155.0.8059.39.1 反检测实测

日期：2026-10-15 UTC。对照为同场运行的 154.0.8037.57.2，不是历史站点分数。

## 结论

**当前 CloakHub Docker 环境不建议直接升级到 155。** IPHey 完成性改善，但 WebGL/WebGL2 全部不可用，Fingerprint 的虚拟机标志也更频繁出现。不能将其描述为反检测全面增强。

## 方法

- Linux x64，同宿主、同出口、无代理；同一 `cloakhub:0.9.0` 镜像，只替换官方 binary。155 下载经过 Ed25519 签名和 SHA-256 校验，容器内 `--version` 确认版本。
- 独立临时容器和 profiles，不访问生产用户数据；4 CPU 配额、2 GiB shm、en-US、America/Los_Angeles、相同 Mac 字体。
- 单 license 会话，串行顺序：155 r1 → 154 r1 → 154 r2 → 155 r2。
- 每轮每版：macOS 三个 seed 有头、其中一个 seed 无头，以及 Linux/Windows persona 各一个 seed 有头。seed 为 20260909/10/11。
- 24 组 profile，104 次公开站点观测；另有 8 次字体探针、4 次 IPHey 专项探针。所有执行步骤完成；154 的字体/IPHey 非零退出码表示探针检测到旧问题，不是遗漏测试。

## 结果

| 项目 | 154.57.2 | 155.39.1 |
|---|---|---|
| 本地 WebGL / WebGL2 | 12/12 可用，readPixels 正常 | **12/12 均返回 null** |
| SannySoft（每版 8 次） | 无失败行 | 每次 WebGL Vendor/Renderer 失败：Canvas has no webgl context |
| DeviceInfo（每版 12 次） | isBot=false | 相同 |
| BrowserScan（每版 4 次） | Normal | 相同 |
| CreepJS（每版 4 次） | 31% like headless、0% headless、0% stealth | 相同 |
| Rebrowser（每版 4 次） | mainWorldExecution / exposeFunctionLeak 两红 | 相同；测试主动触发 |
| Incolumitas（每版 2 次） | WEBDRIVER: FAIL | 相同 |
| reCAPTCHA demo（每版 2 次） | 0.9 | 相同；不是业务站点通过率 |
| Fingerprint bot（每版 12 次） | not_detected | 相同 |
| Fingerprint virtual_machine | 0/12 true | **8/12 true** |
| IPHey（每版套件 4 次 + 专项 2 次） | 0/6 完成 | **6/6 完成：90 / Unreliable** |

### WebGL 回归证据

155 容器日志重复报告 `Internal Vulkan error (-3)`、`eglInitialize SwANGLE failed`、`EGL_NOT_INITIALIZED`，以及 GPU process 初始化失败退出。本地探针与 SannySoft 都确认没有可用 context，不只是 GPU 名称字段变化。154 相同容器配置能创建 WebGL/WebGL2 并读回 `[64,128,191,255]`、error=0。

这是 **155 与当前容器图形环境的兼容性回归**。尚未定位 Vulkan 初始化失败的底层原因，也未测试其他 GPU 后端、真实 GPU、原生系统。不能推广为所有平台上的 155 都不支持 WebGL。

### Fingerprint

155 的 VM 标志：macOS 6/8、Windows 2/2、Linux 0/2；154 均 false。它与图形异常同时出现，但没有通过单变量恢复 GPU 来证明因果关系。

macOS tampering_ml_score：

| 场景 | 154 r1 / r2 | 155 r1 / r2 |
|---|---|---|
| seed 0909 有头 | .0973 / .0973 | .1786 / .0995 |
| seed 0909 无头 | .2809 / .2809 | .3592 / .3592 |
| seed 0910 有头 | .0299 / .0299 | .0964 / .0964 |
| seed 0911 有头 | .0535 / .0535 | .1134 / .1134 |

两版 macOS 的 tampering 和 anti_detect_browser 布尔值仍为 false。ML 数值不是被封概率，不据此估算业务风险提升比例。

Windows persona 两版仍为 tampering=true、anti_detect_browser=true，ML 约 .9997–.9998。镜像并非完整 Windows 字体环境，本测试未证明具体触发原因。VPN/OS mismatch 仍有波动，未定位服务端判据，不能断言由某个网络层字段决定。

### 字体与 IPHey

310 个字体 local/check 查询，两个独立 profile 各跑两遍：

| persona | 154 r1；r2（ms） | 155 r1；r2（ms） |
|---|---|---|
| macOS | 4312/4182；4225/4204 | 1264/1186；1411/1267 |
| Linux | 339/304；305/294 | 291/260；264/277 |

155 macOS 探针降到 3 秒阈值以内，IPHey 不再卡占位；专项探针也不再收到 `e?.performance.h3` 空值错误。不过结果依然是 **Unreliable**，不是可信身份通过。

可用字体计数同时改变：macOS 17→16，Linux 2→0。因此不能称为“保持字体行为不变的纯性能优化”，也不能仅凭计时认定旧根因已完全修复。这里没有用该探针证明具体 native 修改。

## 身份一致性与范围

24 组主页面/Worker/跨源 iframe/HTTP UA 和 UA-CH 比较均通过。身份一致不等于图形功能正常；探针确实记录了 155 的 null context，不能把脚本退出码 0 当作所有功能通过。

未额外运行 Canvas 哈希、CPU、代理、真实账号风控、ARM64 或原生 macOS/Windows 测试。当前建议是保留 154，先定位 155 的 Vulkan/SwANGLE 初始化失败，再复测；未修改生产设置或发布镜像。

## 证据与复现

- [精简结果](evidence/preview-155/results.json)：104 次观测解析值、字体/IPHey 探针和本地 surface；visitor ID 只留哈希，不含 key、token 或出口 IP。
- [GPU 错误摘录](evidence/preview-155/gpu-errors.log)。
- 本地 `.cloakhub/cloak155-evaluation/` 保留编排脚本和原始结果。复用 `examples/antibot-audit.mjs` 与 `docs/evidence/identity-diagnosis/` 的字体/IPHey 探针。
- 启动：`python3 .cloakhub/cloak155-evaluation/lab.py start v155`；测试：`python3 .cloakhub/cloak155-evaluation/run.py v155 <新的轮次名>`；停止：同 lab.py 的 `stop v155`。对照标签为 v154。勿并发运行两版。
- 测试结束删除本次两个容器和临时 data；binary 缓存、证据及原有生产服务保留。
