# 可复用的浏览器版本评估 suite

入口：`tests/browser-evaluation/`；命令：`npm run test:browser-evaluation -- ...`。

这套 suite 固化了 152/156 两轮研究里的本地表面、性能、参数隔离、行为修复与检测页观测。**下次升级只需准备 baseline/candidate binary 并改配置里的路径和精确版本，不需要重新设计矩阵或改测试代码。** 它不启动生产 CloakHub，也不改 production launcher flags。

## 1. 固定覆盖范围

| plan | 固定内容 | 外部站点 |
|---|---|---|
| `smoke`（默认） | 第一个 persona/seed，所选模式、所有 binary；主页面/Worker/跨源 iframe、WebGL 绘制与读回、Canvas PNG、UA/UA-CH/HTTP 回显、少量请求拦截 | 无 |
| `local` | 所有配置 persona × 模式 × seeds × 轮数；以上表面、字体查询计时、200 次请求拦截、静态/动画 cgroup CPU 与帧计数 | 无 |
| `flags` | 不加图形参数、旧四项组合、四个参数逐一加入；第一个 seed、单轮，所有 persona/模式/binary | 无 |
| `features` | 弹窗阻止 on/off、最大化/越界位置；Windows persona 下 GPU vendor 简写与触控点数 | 无 |
| `detectors` | Fingerprint、SannySoft、BrowserScan、IPHey；完整配对矩阵，可在配置中缩小检测器列表 | **必须 `--external`** |
| `all` | `local` + `flags` + `features`；只有同时传 `--external` 才增加 detectors，否则在报告明确记 skipped | 默认无 |

默认三 seeds（20260909/10/11）、两轮、三个 personas（macos/windows/linux）、有头/无头。第二轮倒转 binary 顺序；全部串行，独立临时 profile，正常 `Browser.close` 释放授权。可以配置一个、两个或更多 binary；`kind: "reference"` 的普通 Chromium 不加 persona 指纹 flags，也不会为每个伪装 persona 重复运行。

**明确未覆盖**：真实 Windows/macOS 设备真实性、代理 DNS/UDP WebRTC 泄漏、真实音频设备、许可服务器故障注入、逐 CVE 审计。它们需要专门环境，不应假装已经通过。检测器网页/API 改版时仍需维护 adapter；客户端或内核不兼容时也可能需要更新依赖，但不用每个版本从零研究测什么。

## 2. 推荐：固定 Docker 实验环境

Dockerfile 固定基础镜像和 Node digest，包含 KasmVNC、既有 152 binary、系统库及 Mac 字体，使用锁定的 Playwright Core / pngjs。实验镜像刻意固定在 `cloakhub_free:0.8.4`（Bun 与 KasmVNC `Xvnc` 时代）以保持测量可比，与当前 Hub 镜像无关。实验镜像不含 key。未来只挂新的候选 binary，先不要连同 OS 镜像、字体、客户端一起升级，否则多出混杂因素。

```bash
bun install --frozen-lockfile
npm run test:browser-evaluation:unit

docker build -f tests/browser-evaluation/Dockerfile \
  -t cloakhub-browser-evaluation:local .

mkdir -p .cloakhub/browser-evaluation
cp tests/browser-evaluation/example.config.json .cloakhub/browser-evaluation/config.json
```

编辑这份配置：

- `binaries[].id`：版本标签，如 baseline/candidate，保持唯一。
- `executable`：**容器内**完整 executable 路径；挂载整个 browser directory，不只一个 chrome 文件。
- `expectedVersion`：确切 `--version` 输出版本。禁止 `latest`；启动前不匹配直接失败，不会偷偷测到另一个版本。
- `licenseKeyFile`：容器内单 key 文件路径；也可按 binary 覆盖。只接收文件路径，不接受内联 key；reference build 不注入 key。
- `personas/modes/seeds/rounds`：默认矩阵已给出，定向排查可缩小。
- `fontconfigFiles`：**按 persona 配置**。示例仅 macOS 使用 `/app/macos-fonts.conf`；Windows/Linux 不会继承这个环境变量。Windows 正式真实性对照需要合法且完整的 Windows 字体与正确 fontconfig，不能把 Mac-font 镜像当成 Windows 安装。
- `fontNotes/environmentLabel`：记录实验环境与限制。suite 同时存 `fc-list` 字体家族清单和显式 fontconfig 的 SHA-256。
- `graphics`：每个模式的统一起点。有头默认无旧四参数，无头默认仅 `--use-gl=angle`；这不是永远正确的公式，`flags` plan 会保留隔离诊断。只接受限定的图形 flags，不允许覆盖 profile/CDP 路径或注入任意启动参数。

下面的 shell function 只是缩短同一条 Docker 命令，不含凭据值：

```bash
CONFIG="$PWD/.cloakhub/browser-evaluation/config.json"
OUT="$PWD/.cloakhub/browser-evaluation/results"
CANDIDATE="$HOME/.cloakbrowser/chromium-156.0.8078.47.1-pro"
KEY_FILE="$HOME/.cloakbrowser/license.key"
mkdir -p "$OUT"
chmod 700 "$OUT"

evaluate_browser() {
  docker run --rm --user "$(id -u):$(id -g)" \
    --cpus 4 --memory 4g --shm-size 2g --security-opt label=disable \
    -v "$CONFIG:/config.json:ro" -v "$OUT:/results" \
    -v "$CANDIDATE:/binaries/candidate:ro" \
    -v "$KEY_FILE:/run/browser-license.key:ro" \
    cloakhub-browser-evaluation:local \
    --config /config.json --output /results "$@"
}

evaluate_browser --plan all --dry-run
evaluate_browser --plan smoke
evaluate_browser --plan all                     # 本地观测，不访问检测站点
evaluate_browser --plan detectors --external    # 明确允许公开检测页访问
```

每条命令等上一条退出再运行，不并行占用免费 license，也不让 CPU 测量相互污染。大量组合需要较长时间，先看 dry-run。只有一个 key 也能跑两版，因为不是同时启动。

示例 baseline 是固定镜像内由仓库分发的 **license-free 152 build**，不是官方许可的历史包。与官方 candidate 对照时，仍有 build 来源混杂；要隔离纯上游版本差异，请换成来源一致的两份 binary。

示例 baseline 已在固定镜像里；若换 baseline 或增加普通 Chromium reference，需要另外把其整个目录只读挂进容器，并在配置中填写对应路径/版本。suite **不自动下载 binary，也不绕过历史版本权限**。

不要直接套用示例的 `156...` 路径后忘记改 `expectedVersion`。新版本建议只改 candidate 的路径、标签、精确版本，保留 baseline 和环境条件；确认后再单独测新版 OS／字体／依赖环境。

`--user` 使输出归本机操作者所有；镜像源码和依赖可由非 root 读取。容器不发布端口，CDP、fixture HTTP 和 VNC 均限于内部/回环。SELinux label 隔离只对这只实验容器关闭以支持明确的只读挂载；不挂生产 profile 或宿主 GPU。

## 3. 本机运行

需要 Node（不要用 Bun 驱动 Playwright CDP）、Linux、可运行的 browser binary 和 headed 所需的 Xvnc。

```bash
npm run test:browser-evaluation -- --config /absolute/local-config.json --plan smoke
```

相对路径以 config 文件目录为基准。CDP 使用 `--remote-debugging-port=0` 和 profile 内的 `DevToolsActivePort`，避免误连别人的浏览器。这是固定测量条件，不是无自动化的真人基线：该参数可影响普通 Chromium 的 webdriver 状态，suite 显式记录 `navigator.webdriver`。不要把这种新 harness 的结果与旧固定端口脚本直接混算；版本对照应在同一 suite 构建中同时重跑两版。

默认自动管理一个未占用的 X display；显式 `display: ":99"` 则使用调用者提供的 display，不会停止它。所有 browser/profile 都由 suite 自己创建，不连接现有 Hub/profile。

### 字体是否真的生效

非 `flags` 计划会额外记录 `cases/*.json` 中的 `local.renderedFonts`：通过 CDP `CSS.getPlatformFontsForNode` 检查一段 ASCII 文本**实际使用的字体**。例如请求 Arial 却返回 Liberation Sans，就说明发生了回退；不能以 `document.fonts.check()` 返回 true 代替真实安装验证。结合 manifest 的 `fc-list` 清单、字体文件来源与哈希判断，ASCII 探针本身不是完整 Unicode 覆盖检查。

提供了两份可选的实验配置（不会自动启用，也不附带新字体）：

- `tests/browser-evaluation/windows-fonts-added.conf`：系统字体 + 挂载的真实字体。
- `tests/browser-evaluation/windows-fonts-isolated.conf`：保留系统渲染规则，仅搜索挂载的字体目录，作为隔离对照，不是 Windows 渲染真实性认证。

将有权使用的字体目录只读挂载到 `/opt/evaluation/windows-fonts/files`，再把 `fontconfigFiles.windows` 指向容器内 `/suite/tests/browser-evaluation/windows-fonts-added.conf` 或 `windows-fonts-isolated.conf`。只挂到 `/opt` 而不启用对应 fontconfig，不会自动改变系统字体组。

微软旧版 Core Fonts 不等于完整 Windows 10/11 字体集；缺 Segoe UI、Calibri 等家族时不能声称已排除字体因素。镜像再分发前还须确认字体许可，不能把字体当作项目开源代码重新授权。

### 性能范围

性能数字来自 cgroup v2 `cpu.stat`。**推荐单独 Docker 容器**；在共享宿主 cgroup 中运行会把其他进程算进去。无 cgroup 数据时 CPU 为 null，不伪造 0。CPU 时间可大于墙钟时间；比较前同时检查 frame count、CPU quota、字体和图形参数。

## 4. 产物与退出语义

每次新建 timestamp + 随机后缀的目录，绝不覆盖旧结果。默认位于被 Git 忽略的 `.cloakhub/browser-evaluation/`：

```text
<run-id>/
  manifest.json      # 精确配置、suite 源码哈希、binary 版本/哈希、字体、环境、计划、跳过项
  cases/<id>.json    # 实际 argv、局部结果、每个 detector 状态、清理结果
  results.json       # 每完成一组原子更新，保留部分运行证据
  summary.json       # 分组分母、中位 CPU、完成性和缺失数据
  report.md          # 可直接审阅的对照表，不制造“总通过率”
```

- 退出 `0`：预定观测完成，**不是“抗检测全部通过”**。VM/tampering 阳性、WebGL null 等仍然保留。
- 退出 `1`：配置/版本/启动/执行/清理错误，或只完成部分计划。
- 退出 `2`：公开检测页有 incomplete、blocked、rate_limited 或 skipped，不能按成功结果解释。
- 退出 `130`：操作者中断；写入已完成组和中断状态。
- 单组默认 300 秒 deadline。失败或强制停止后不继续启动下一组，避免占用授权或累积失控进程。
- 捕获 SIGINT/SIGTERM 后先正常关闭，必要时只终止自己创建的进程组。临时 profiles/HOME 在清理时删除；SIGKILL/宿主掉电不能保证用户态清理，仍需遵守上游 seat 释放策略。

公开站点默认每 profile 间隔 45 秒。收到 429 的站点在本 run 剩余部分停止访问，记录 skipped，不自动重试或绕过；验证码/挑战不自动解决。网页变化、授权失败、网络失败和真正检测阳性分别记录。

Fingerprint 只保存允许的布尔/数值/分类字段；不保留原始 Visitor ID、事件 ID、出口 IP、响应正文。其他检测页只提取判定，不保存整页文本、截图、cookie 或 token。key 不进入 argv、报告或日志，错误中的 key/URL 被遮蔽；私有环境变量不批量传入浏览器。

## 5. 固定升级验收清单

以后每个候选版本按以下顺序审阅，不需要重新设计测试：

1. **确认测对 binary**：版本严格匹配，记录哈希，说明来源是否相同（license-free vs 官方 build 不能冒充纯上游版本因果实验）。
2. **看 smoke / 基础能力**：WebGL/2 有无 context、像素读回/error，Worker/iframe 是否完成，基本请求拦截。
3. **排除参数干扰**：configured、clean、legacy、single-flag 结果分开；不能混入同一成功率。
4. **核对身份和 Canvas**：共有字段、HTTP 身份一致性；重复 readback；PNG 在 Node 进程外解码；hash 变化不自动等于更真实。跨源 iframe 指不同端口，不代表全部跨站隔离场景。
5. **看资源和功能**：相同工作负载的 CPU、帧数、路由请求数；弹窗、GPU 名称、触控、窗口几何。功能新能力不自动等于低风险。
6. **最后看 detector**：分别看 bot、VM、tampering、anti-detect、VPN/OS mismatch；缺失和 429 排除有效分母。先检查每个 persona 的字体条件。
7. **做有限结论**：正常 Chrome 也可在 CDP/虚拟显示环境触发信号；同一 binary 在不同 harness/时序中也可能得到不同 VM 结果（见 [156 Windows 补测及后续 macOS 冒烟](156-windows-persona.md)）。没有真实平台参照就不做真实性认证。性能、兼容性、检测风险、安全更新分开权衡。

结果模型和运行脚本属于当前 suite；`docs/evidence/152-vs-156-*` 中的脚本/JSON 是历史实验快照，不再作为新版本测试入口。

## 6. 快速测试与 CI

```bash
npm run test:browser-evaluation:unit
bun test
bun run typecheck
```

普通 `bun test` 只运行配置、矩阵、数据解析、分母/缺失处理、遮蔽与生命周期单元测试，不读取真实 key、不启动真实 browser/Xvnc、不访问 detector。现有 real-runtime 集成测试继续负责 CloakHub 本身的启动、持久化、CDP 恢复等；新 suite 负责 binary 对照，两者不能互相代替。

外部检测不加入无凭据的常规 CI，以免网站限流、license 状态或站点变化让普通代码测试随机失败。
