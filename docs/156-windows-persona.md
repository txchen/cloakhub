# 156 Windows persona：VM 与字体条件补测

日期：2026-11-10 UTC。使用新加入的[可复用版本评估 suite](browser-evaluation.md)，不是继续修改历史临时脚本。

后续已做[真实字体补充与隔离对照](156-windows-fonts.md)：补入 34 个字体文件并确认浏览器实际使用后，tampering / anti-detect 仍为 true；但 Segoe UI、Calibri 等现代字体仍缺失，不能据此排除完整字体条件的影响。

## 结论

**本机 Linux Docker 下，156 的 Windows persona 本次没有触发 VM 标记；但所有样本都触发 tampering / anti_detect_browser。不能据此推荐“换 Windows persona 就更好”。**

这里测的是 Linux binary 的 Windows persona，不是原生 Windows 上的 CloakBrowser，也不是字体完整的 Windows 环境。

## 主矩阵

- 官方 `156.0.8078.47.1`，binary SHA-256：`37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a`。
- 固定 `cloakhub_free:0.8.4` 实验基础镜像、Node 24.22.2、Playwright Core 1.64.1、4 CPU、4 GiB memory、2 GiB shm、无 GPU 挂载。
- Windows persona；seeds 20260909 / 20260910 / 20260911；有头、无头各两轮，每组独立新 profile，串行、正常关闭。
- 有头不加旧四图形 flags；无头只加 `--use-gl=angle`。直接启动 binary + CDP，核对实际 argv。
- 使用**系统 fontconfig**，没有把 Mac fontconfig 默默应用到 Windows。
- 本次只访问 Fingerprint demo，组间至少 45 秒；本地还记录 WebGL、Canvas、Worker/iframe 和 HTTP 身份，未把其他公开站点算作已测。

| 检查 | 有头，6 次 | 无头，6 次 |
|---|---:|---:|
| Fingerprint 完整结果 | 6/6 | 6/6 |
| bot = not_detected | 6/6 | 6/6 |
| **virtual_machine = true** | **0/6** | **0/6** |
| **tampering = true** | **6/6** | **6/6** |
| **anti_detect_browser = true** | **6/6** | **6/6** |
| WebGL / WebGL2 可用 | 6/6 | 6/6 |

没有 HTTP 429、授权失败或强制停止。ML 分数不解释为真实封禁概率。

### 字体限制

`fc-list` 记录到 29 个 family entries；没有 Arial、Segoe UI、Calibri 等常见 Windows 家族。这个镜像不是完整 Windows 字体安装。

因此 tampering 的阳性不能直接推广为“正确配齐 Windows 字体后也一样”。缺字体是需要控制的因素，但本次没有合法完整 Windows 字体组，**没有证明它是阳性的唯一原因**。

## 字体配置敏感性对照

固定 seed 20260909，在同一个实验镜像中只把 Windows persona 的 `FONTCONFIG_FILE` 改为 `/app/macos-fonts.conf`，分别跑一次有头和无头。该配置只是对照，不是推荐方案。

| 检查 | 有头 | 无头 |
|---|---|---|
| virtual_machine | false | false |
| tampering | true | true |
| anti_detect_browser | true | true |
| bot | not_detected | not_detected |

此时可见 family entries 增至 63，但仍不是完整 Windows 字体环境。两次观察里没有消除 tampering，VM 也没有变为 true。主矩阵的 12 次和该单 seed 对照的 2 次分开记录，不混成大样本统计。

## 与 macOS 结果的关系

[前一轮同宿主的 macOS persona 对照](152-vs-156-followup.md)中，156 的 VM 标记反复为 true；本次 Windows persona 为 false。这说明不能把“156 macOS 上出现 VM”推广成“156 所有人格、模式或部署环境都出现 VM”。

**还出现了一条不同于旧批次的新观察**：完成套件后，用官方 156、Mac 字体、有头 macOS persona、seed 20260909 做了一次四站点 adapter 冒烟校验。Fingerprint 返回 VM=false、tampering=false、anti_detect_browser=false；另外三站也完整返回（SannySoft 无失败行、BrowserScan Normal、IPHey 100/Trustworthy）。[该单次记录也完整保留](evidence/156-windows-persona/macos-suite-smoke/report.md)，没有因其与旧结果不同而丢弃。

这不是旧矩阵的严格复现：新 suite 的 CDP 端口策略、私有 HOME／环境隔离、探针流程及观测时间等与旧临时脚本不同，且这一 macOS 样本来自较后的 suite 构建。**没有定位是哪个因素导致变化，也不据一次样本推翻旧批次的重复结果。**

因此当前数据既不能支持“156 必然触发 VM”，也不能支持“换 Windows persona 就能解决 VM”。每次升级应在同一套件构建、环境、字体条件下重跑 baseline/candidate，而不是拿旧报告的分数作为永久基准；Windows 的 tampering / anti-detect 阳性也不能忽略。

## 证据与复用

- [系统字体主矩阵](evidence/156-windows-persona/system-fonts/report.md)，及同目录 manifest/results/summary。
- [Mac 字体配置敏感性对照](evidence/156-windows-persona/mac-font-control/report.md)。
- [后续单次 macOS adapter 冒烟](evidence/156-windows-persona/macos-suite-smoke/report.md)，与 Windows 两组分开计数。
- [证据说明](evidence/156-windows-persona/README.md)。

复测只需把 suite 配置设为：单个 156 binary、`personas: ["windows"]`、`modes: ["headed", "headless"]`、三 seeds、两轮、`detectors: ["fingerprint"]`，然后执行 `--plan detectors --external`。以后候选版本沿用相同配置，替换 binary 路径与精确版本即可。

所有测试容器/profile 为专用临时资源；没有修改生产 launcher、字体或 profile 默认值。
