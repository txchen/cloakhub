# 156 Windows persona：补字体后的配对对照

日期：2026-11-10 UTC。接续 [Windows persona 补测](156-windows-persona.md)。

## 结论

**真实补入 34 个字体文件后，tampering / anti_detect_browser 仍然全部为 true（不利信号）。** 排除 Linux/Mac 字体、只开放这套字体后，也没有消除标记；后续校正通用字体的强绑定默认值，同样没有消除。

能确认的是：**本次补充的核心字体不足以解决问题**，不是“字体根本没装上”。但本次仍缺 Segoe UI、Calibri、Cambria、Consolas 等现代 Windows 家族，使用的 Core Fonts 版本也较旧，**不能声称完整补齐 Windows 10/11 字体，更不能据此排除字体因素**。

因此没有修改生产镜像，也没有把字体二进制提交到仓库或发布为镜像。

## 1. 补了什么，如何确认

下载微软旧版 Core Fonts 的 11 个原始安装包，以 Debian `ttf-mscorefonts-installer 3.8.1` 中的 SHA-256 清单逐一核对后解包；没有执行 EXE。另复用仓库已有的 Tahoma regular/bold、Microsoft Sans Serif 和 Wingdings 文件。共 34 个真实字体文件、14 个 family entries，没有改字体名称或用兼容字体冒充。

主要家族包括 Arial、Arial Black、Times New Roman、Courier New、Verdana、Georgia、Trebuchet MS、Comic Sans MS、Impact、Andale Mono、Tahoma、Microsoft Sans Serif、Webdings、Wingdings。

证据中保留了每个字体文件的哈希、来源、安装包校验清单以及 fontconfig 配置，不包含字体二进制。Core Fonts 自带 EULA；字体保留各自的许可，不能因为本地可测试就默认允许随产品镜像再分发。

套件增加了 `local.renderedFonts` 探针：用 CDP `CSS.getPlatformFontsForNode` 读取一段 ASCII 文本实际采用的字体，不以 `document.fonts.check()` 的 true 判断安装成功。

| 请求字体 | 原系统 | 系统 + 新字体 | 仅新字体 | 仅新字体 + 强默认绑定 |
|---|---|---|---|---|
| Arial | Liberation Sans | **Arial** | **Arial** | **Arial** |
| Tahoma | Nimbus Mono PS | **Tahoma** | **Tahoma** | **Tahoma** |
| Segoe UI | Nimbus Mono PS | Andale Mono | Andale Mono | Courier New |
| Calibri | Nimbus Mono PS | Andale Mono | Andale Mono | Courier New |
| Liberation Sans | Liberation Sans | Liberation Sans | Arial | Arial |

这里的探针明确设置了 `monospace` 作为回退；表格不是所有网页默认字体的描述。它确认了：Arial/Tahoma 的补充确实被浏览器采用，而 Segoe UI/Calibri 仍发生回退。字体清单也确认隔离组没有继续暴露原来的 Linux 字体集合。

## 2. 对照设计

- 官方 `156.0.8078.47.1`；三组 binary、suite 构建与 Docker image ID 完全相同。
- 同一 Linux x64 实验镜像；4 CPU、4 GiB RAM、2 GiB shm、无 GPU；Windows persona、en-US、America/Los_Angeles。
- 固定 seed **20260909**，有头/无头各跑两次，共 **12 个新 profile**。
- 有头无旧图形参数；无头仅 `--use-gl=angle`。核验实际 argv。
- 顺序：第一轮 system → added → only；第二轮 only → added → system。每组内有头、无头串行运行。
- 每个模式之间至少 45 秒，组间也等待 45 秒；只访问 Fingerprint。没有同时运行别的浏览器矩阵。
- 每个组使用独立临时 HOME/profile。三组都挂载同一字体目录，但原系统组的 fontconfig 不搜索该目录。

三种条件：

1. **system**：原系统 fontconfig，29 个 family entries。
2. **added**：保留系统配置，增加真实字体目录，43 个 entries。
3. **only**：保留系统 fontconfig 渲染规则，使用 `reset-dirs` 限制字体搜索目录，并提供通用字体别名，14 个 entries。它是字体隔离对照，不是原生 Windows 的 DirectWrite/ClearType 环境。

额外做了 **4 个后续案例（defaults）**：保持同样的 34 个文件和系统渲染规则，仅将通用字体别名设为 `binding="strong"`。原因是普通弱别名并未保证实际默认值：`fc-match` 原来仍将 monospace / sans-serif 选为 Andale Mono / Verdana。强绑定后变为 Courier New / Arial，serif 为 Times New Roman；浏览器探针也确认 monospace 回退改为 Courier New。它没有给缺失的 Segoe UI 等字体伪造别名。

这 4 个案例使用同一 binary、image 和 suite-source hash，但在原 12 个案例之后运行，不冒充四组完全交错的实验。总计 **16 次观测**，仍然只是固定 seed 的小样本机制排查，不是三个 seed 的完整版本评估，也不是 16 个独立真实设备。

## 3. 实际结果

| 条件 | 完整结果 | VM=true | tampering=true | anti_detect_browser=true | bot=not_detected |
|---|---:|---:|---:|---:|---:|
| 原系统字体 | 4/4 | 0/4 | **4/4** | **4/4** | 4/4 |
| 系统 + 34 个真实字体文件 | 4/4 | 0/4 | **4/4** | **4/4** | 4/4 |
| 仅这 34 个真实字体文件 | 4/4 | 0/4 | **4/4** | **4/4** | 4/4 |
| 仅新字体 + 强默认绑定（后续对照） | 4/4 | 0/4 | **4/4** | **4/4** | 4/4 |

没有 HTTP 429、缺失结果、启动失败或强制关闭。四组 tampering ML 数值分别为 0.9995、0.9998、0.9996、0.9962，均在各自四次观测中重复。它们不是封禁概率；不把如此微小的分数差异解读为变好或变坏。

## 4. 对 Docker 的实际含义

从技术上，**字体文件 + persona 专用 fontconfig 的方案有效**：字体确实被浏览器使用，所以将来可以用 Docker COPY 或只读挂载提供字体。

但目前没有证据支持“把这 34 个文件加进生产镜像，就能消除 Windows persona 的 tampering”。不能因为安装动作成功就宣称抗检测修复成功。

下一步需要一份**有权用于此环境的、来源明确的现代 Windows 字体集**（例如对应 Windows 版本的 Fonts 目录或压缩包），覆盖 Segoe UI、Calibri、Cambria、Consolas 等家族与必要字重，再重复同一对照。只有完整条件得到改善，才值得进一步验证多 seed，并决定是否更新生产镜像及字体再分发方案。即使字体完整，Linux 上的渲染栈也不自动等同于原生 Windows。

## 5. 复用与证据

- [完整证据与重放说明](evidence/156-windows-fonts/README.md)
- [聚合结果](evidence/156-windows-fonts/summary.json)
- [来源、镜像与源码指纹](evidence/156-windows-fonts/provenance.json)
- [逐字体文件哈希](evidence/156-windows-fonts/font-files.json)

新增的实际用字探针位于 `tests/browser-evaluation/fonts.mjs`，已接入 suite 的非 `flags` 计划。两份可选配置位于 `tests/browser-evaluation/windows-fonts-added.conf` 和 `windows-fonts-isolated.conf`（后者使用强默认绑定），均不会自动启用；生产 Dockerfile 和 persona 默认值保持不变。
