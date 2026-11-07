# Preview 156.0.8078.47.1：已知问题复测

日期：2026-11-02 UTC。结论仅适用于当前 Linux x64 Docker 环境。

## 结论

**156 没有解决此前的 WebGL/Vulkan 初始化失败和虚拟机标记问题，不建议直接替换现有部署。** macOS 无头场景在本次两个独立 profile 中还被 Fingerprint 标为 tampering / anti_detect_browser，而同场旧 155 没有。

字体长任务仍维持 155 的改善，未退回 154 的约 4 秒。但今天两版 IPHey 均未完成，与 10 月 15 日的 155 结果不同，原因尚未定位。

## 方法与版本

- 新版：官方 preview `156.0.8078.47.1`，Linux x64。下载通过 Ed25519 签名、SHA-256 校验，容器内 `--version` 确认。
- 对照：曾发现问题的 `155.0.8059.39.1`。**不是公告中的 stable `155.0.8059.39.2`，本次未测 .2。**
- 同一 `cloakhub:0.9.0` 镜像、宿主、出口和字体配置，只替换 binary；4 CPU 配额、2GiB shm、en-US、America/Los_Angeles，无代理。
- 专用容器、独立 profiles、单会话串行。顺序：156 r1 → 155 r1 → 155 r2 → 156 r2。
- 每轮每版 6 组：macOS 三个 seeds 有头，首个 seed 无头，Linux 和 Windows persona 各一个 seed 有头。seeds 为 20260909/10/11。
- 合计 24 组本地身份/图形探针、104 次站点观测；另跑 8 次字体探针和 4 次 IPHey 专项探针。沿用前次脚本，不注入修复补丁。

## 核心问题

| 检查 | 155.39.1 同场对照 | 156.47.1 |
|---|---|---|
| WebGL / WebGL2 | 12/12 组均无 context | **12/12 同样无 context** |
| SannySoft | 8/8 次 WebGL Vendor/Renderer 失败 | 相同 |
| Fingerprint virtual_machine | 10/12 true | 10/12 true |
| macOS 无头 tampering / anti_detect_browser | 0/2 true | **2/2 true** |
| Windows tampering / anti_detect_browser | 2/2 true | 相同 |
| macOS 字体查询耗时 | 1220–1266ms | 1208–1502ms |
| IPHey（套件 4 次 + 专项 2 次） | 0/6 完成 | 0/6 完成 |

### 图形初始化仍失败

156 日志仍报告 `Internal Vulkan error (-3)`、`eglInitialize SwANGLE failed`、`EGL_NOT_INITIALIZED` 和 GPU process 初始化失败退出。本地独立探针的 `getContext('webgl')`、`getContext('webgl2')` 返回 null，SannySoft 也报告 `Canvas has no webgl context`。

未尝试变更 GPU 后端、容器权限、依赖或挂载真实 GPU，因此只证明当前配置下问题未消失，不代表所有原生平台都会失败。虚拟机标志与此同时存在，但没有通过修复 GPU 的单变量试验证明因果关系。

### Fingerprint：macOS 无头新增阳性

| macOS 场景 | 155 ML 分数 r1 / r2 | 156 ML 分数 r1 / r2 |
|---|---|---|
| seed 0909 有头 | .0995 / .0995 | .2210 / .2210 |
| seed 0909 无头 | .6408 / .3592 | **.8060 / .8060** |
| seed 0910 有头 | .0964 / .0964 | .1782 / .1782 |
| seed 0911 有头 | .1134 / .1134 | .2272 / .2272 |

156 无头的 `tampering=true`、`anti_detect_browser=true` 两轮重复出现；有头 macOS 仍为 false。两版 macOS 和 Windows 的 virtual_machine 均为 true，Linux 为 false。所有场景 `bot=not_detected`，这不等于其他风险信号没有触发。

仅一个 macOS 无头 seed、两次重复；不能推广为所有 seed，也不能把 ML 分数当作实际封禁率。检测器、浏览器版本及服务端状态都可能参与判定，未定位具体字段。

### 字体与 IPHey

macOS 两轮探针：

- 155：1266/1220ms、1254/1220ms。
- 156：1502/1208ms、1308/1217ms。
- 两版均低于探针的 3000ms 阈值，可用字体计数均为 16。
- Linux 均约 248–265ms，可用计数为 0。这是该探针列表的结果，不表示系统没有字体。

今天两版 IPHey 都停留在占位状态，专项探针 30 秒等待均未完成，未捕获到此前的 `performance.h3` 空值错误。不能把占位的 0 分作为实际评分，也不能套用旧的字体超时归因。155 在 10 月 15 日曾完成、今天同场不完成，说明还需区分站点变化、网络与环境因素；本次未做这部分诊断。

## 其他检查

- DeviceInfo：两版各 12/12 `isBot=false`，无阳性明细。
- BrowserScan：各 4/4 Normal。
- CreepJS：均 31% like headless / 0% headless / 0% stealth。
- Rebrowser：两版都记录 mainWorldExecution、exposeFunctionLeak 两项红，测试脚本主动触发；未将其他项目一概称为通过。
- Incolumitas：共同 WEBDRIVER: FAIL。
- reCAPTCHA demo：各 2 次 0.9，不代表业务站点通过率。
- 主页面、Worker、跨源 iframe 与 HTTP UA/UA-CH 的已有一致性检查均通过；这不包含 WebGL 功能成功。

## 证据和边界

[精简结果](evidence/preview-156/results.json)包含逐组信号、surface、字体和 IPHey 专项结果；Visitor ID 只留哈希。[GPU 日志摘录](evidence/preview-156/gpu-errors.log)保留初始化错误。

本地编排和原始证据在 `.cloakhub/cloak156-evaluation/`。运行方式沿用 `lab.py start v156`、`run.py v156 <新轮次>`、`lab.py stop v156`；对照标签 v155。仅用于专用临时实例，不并行启动两版。

未测试 stable 155.39.2、152 同场对照、ARM64、原生 Windows/macOS、真实 GPU、代理、Canvas 哈希或实际业务账号。未改生产服务。本次测试容器及临时 data 已删除，binary 缓存和证据保留。
