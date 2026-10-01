# CloakBrowser 154 preview 与 152 stable 对照测试

测试日期：2026-09-30，America/Los_Angeles；原始日志为 2026-10-01 UTC。

## 结论

**154 现在可以用同一个 key 正常下载、验证并启动。** 在 Linux x64 / Mac persona 的本轮功能、CDP、持久化、VNC、语言与多 seed 检测中，整体表现接近 152，没有观察到明确的抗检测提升。

需要保留三个问题：154 在 Iphey 两次未完成检测、同日 152 可以完成；Windows persona 的 Fingerprint tampering 标记仍存在；透明代理仍失败。Iphey 是本轮新增的疑似兼容性差异，尚未定位原因。因此本报告支持继续隔离试用 154，不支持仅凭这些结果替换现有稳定环境。生产容器和默认版本没有改动。

## 下载问题已解除

本次使用**同一个 key、Node.js v24.13.0、cloakbrowser 0.5.11**，全新缓存、preview 渠道、无版本 pin，成功下载 `154.0.8037.57.1`，Ed25519 签名和 SHA-256 校验通过。实际启动后 CDP 返回 `Chrome/154.0.8037.57`、V8 `15.4.80.11`。正常关闭后授权占用恢复 0/1。

本次未修改 SDK、key 或套餐。与[9 月 29 日的请求记录](cloakbrowser-sdk-download-analysis.md)相比，官方渠道接口的返回值发生了变化。可以确认下载阻塞已解除；无法据此追溯发布方具体改了哪项配置。

| 官方平台标签 | stable | preview | preview 回退 |
| --- | --- | --- | --- |
| linux-x64 | 152.0.7977.82.2 | 154.0.8037.57.1 | 否 |
| linux-arm64 | 152.0.7977.82.2 | 154.0.8037.57.1 | 否 |
| windows-x64 | 152.0.7977.82.1 | 154.0.8037.57.1 | 否 |
| darwin-arm64 | 151.0.7922.108.3 | 154.0.8037.57.1 | 否 |
| darwin-x64 | 151.0.7922.108.3 | 154.0.8037.57.1 | 否 |

数据来自 [stable 接口](https://cloakbrowser.dev/api/download/version)、[preview 接口](https://cloakbrowser.dev/api/download/version?channel=preview)，请求携带对应的 `X-Platform`。表格是发布元数据；**实际下载和运行仅覆盖 Linux x64**，不代表已测试 Windows/macOS 原生构建。

## 环境与对照方法

使用与 152 测试相同的 `cloakhub:mac-preview` 字体基础镜像，镜像 ID `sha256:bbe4e5b481ffb2da5baf157700368c8515e52c6f41288e4dbcfbda01b07fb61e`；只读挂载同一项目代码 `a16ded148ce2c7438ed3baa37db82279ca8f2e15`。4 CPU 配额、2 GiB shared memory、en-US、America/Los_Angeles，同一主机网络，无业务账号或检测站代理。

固定 seed 为 20260909、20260910、20260911。主要配置是 Linux 容器中的 Mac persona + headed，另测 Linux/Windows persona 和 Mac headless。所有浏览器串行运行，避免一会话 key 的并发干扰。沿用旧检测脚本；结果目录区分版本，禁止覆盖旧证据。

152 的完整功能/九站基线来自 9 月 29 日；本轮额外在同一天重跑 152 的三个 Mac seed，使用 Device & Browser Info 和 Fingerprint 与 154 对照。顺序为先 154、后 152，不是随机交错的大样本实验。对于检测模型的分数，只报告观察值，不解释为真实业务网站的封禁率。

## 功能与兼容性

154 已通过以下浏览器操作：

- Mac 身份与中文、重音字符、emoji 输入；iframe 点击、弹窗、上传下载。
- 两个 CDP 客户端共享 profile。
- 正常停止/自动唤醒后保留 cookies、localStorage、IndexedDB。
- 正常停止后重启容器，保留身份、cookies、localStorage。
- 五次连续停止/唤醒；headless Mac 身份与 Helvetica Neue 字体加载。
- OfflineAudioContext 44,100 样本有限且非静音；OffscreenCanvas WebGL2 可用；WebGPU adapter 可获取。
- H.264、VP9、AAC、Opus 的能力声明均为 `probably`，storage quota 为 10 GiB。

字体 CSS `local()` 仍为 18/20，未加载的是 Menlo、Comic Sans MS，与 152 相同。字体家族可发现性、CSS local 加载、真实字形/字重一致性是不同检查，不能以任一项代表完整原生 Mac 字体一致性。

codec 检查没有进行长视频实际解码，WebGPU 检查不代表性能压测。

## 身份、语言与渲染一致性

七组 headed 配置（Mac 三个 seed、Windows 三个 seed、Linux 一个 seed）各 12 项，共 **84/84 一致性检查通过**，涵盖主页面/Worker/跨域 iframe 的 UA、platform、UA-CH、语言、CPU、时区，以及 HTTP UA 和完整版本 Client Hints。headless 另有检测站测试，但未计入这 84 项。

对应 seed 的 WebGL/WebGL2 固定像素探针、抽样字体宽度、screen 和 window 数值与 152 完全相同。这只能说明所测探针一致，不能证明完整渲染行为相同。

`zh-CN + Asia/Shanghai` 和 `de-DE + Europe/Berlin` 均通过主页面、Worker、iframe、Accept-Language 一致性，以及 DOM/UTF-8/Blob 文本往返、NFC、家庭 emoji 字素分段检查。152 也已通过这些检查，未发现新增优势或回归。

## 自动化、VNC 与代理

真实浏览器集成测试：**10 pass、0 fail、42 assertions，54.69 秒**，覆盖 CDP 与 runtime 两个测试文件。VNC 鼠标和中文剪贴板通过；UI 默认创建 Mac persona，Linux persona 无法加载私有 Mac 字体，隔离检查通过。

| 代理检查 | 152 | 154 |
| --- | --- | --- |
| 普通 HTTP 代理：本地 HTTP/HTTPS 共 12 次导航 | 通过 | 通过 |
| 普通 HTTP 代理：公网 example.com，HTTPS/HTTP/HTTPS | 三次 200 | 三次 200 |
| 透明代理：本地测试域名 | ERR_NAME_NOT_RESOLVED | 同样失败 |
| 透明代理：公网 HTTPS | ERR_PROXY_CONNECTION_FAILED | 同样失败 |

本地 HTTPS fixture 使用自签名证书并显式忽略证书错误；公网 HTTPS 检查没有这一设置。透明代理失败不能算成 154 新回归，也不能认为已修复；未证明故障来自浏览器还是当前代理集成。

## 九个检测站的主配置结果

Mac persona、headed、seed 20260909。152 为 9/29 完整基线；下文另列同日重复对照。

| 检测站 | 152 | 154 |
| --- | --- | --- |
| Sannysoft | 无失败行 | 无失败行 |
| Device & Browser Info | isBot=false | isBot=false |
| Fingerprint | bot=not_detected，tampering=false | 相同；分数 0.0967 → 0.0973 |
| BrowserScan | Normal | Normal |
| reCAPTCHA v3 示例 | success=true，0.9 | success=true，0.9 |
| Rebrowser | mainWorldExecution、exposeFunctionLeak 两项红 | 相同 |
| CreepJS | 31% like headless、0% headless、0% stealth | 相同；字体 2/51 |
| Incolumitas | 新测试 9 OK；旧 fpscanner WEBDRIVER=FAIL | 相同 |
| Iphey | 100 / Trustworthy | 首轮仍为 Temporary value，不能评分；补测见下文 |

Rebrowser 脚本主动触发主世界执行及 exposeFunction，因此红项表明这些调用可被观察到。Incolumitas 行为分数仍为占位符，未完成交互挑战，不能声称行为检测通过。reCAPTCHA 示例站分数不能代表实际业务站通过率。

## Iphey 加载差异：待定位

154 首次在固定等待窗口内未完成，随后新建同 seed 的 Mac headed profile，延长等待至 60 秒，仍停在 `Temporary value`，没有真实 verdict。紧接着使用 152 新 profile，得到 **100 / Trustworthy**。

两次定向补测均 HTTP 200、无 requestfailed；154 的占位 0 分已从汇总中排除。首轮亦无页面 JavaScript error。该差异值得作为疑似 154 兼容性问题跟进，但两次失败不能证明反爬封禁，也尚未排除站点时序或随机性；未定位到具体脚本或浏览器功能。不能将 154 的 Iphey 项判为通过，亦不能写成真实得分 0。

## Fingerprint 多 seed 对照

以下为 tampering ML 原始分数，**不是封禁概率**。所有配置的 bot 均为 `not_detected`，Device & Browser Info 均为 `isBot=false`。154 的四组 Sannysoft（Mac/Linux/Windows headed、Mac headless）均无失败行。

| 配置/seed | 152 9/29 | 152 同日重跑 | 154 | 154 tampering | 154 anti_detect_browser |
| --- | --- | --- | --- | --- | --- |
| headless_20260909 | 0.2714 | 未测 | 0.2809 | false | false |
| linux_20260909 | 0 | 未测 | 0 | false | false |
| macos_20260909 | 0.0967 | 0.0967 | 0.0973 | false | false |
| macos_20260910 | 0.03 | 0.03 | 0.0299 | false | false |
| macos_20260911 | 0.0541 | 0.0541 | 0.0535 | false | false |
| windows_20260909 | 0.9998 | 未测 | 0.9998 | true | true |
| windows_20260910 | 0.9999 | 未测 | 0.9999 | true | true |
| windows_20260911 | 0.9998 | 未测 | 0.9996 | true | true |

154 的 Mac headed 三组 anomaly_score=0，Linux=0.0046，Windows 三组=0.0515，Mac headless=0。Windows persona 的高分和 tampering/anti_detect_browser 标记在两个版本中均存在。当前镜像的官方字体检查为 Windows 默认字体 0/8、Office 字体 0/10；这是重要混杂因素，不能用这组结果判断原生 Windows 构建。

154 除第一个 Mac seed 外，其余七组均出现 vpn=true、os_mismatch=true；Windows 置信度 high，其余 low。**同日重跑 152 的三个 Mac seed 也全部出现这两个标记、置信度 low**，而前一天三个都为 false。该变化并非 154 独有，当前数据不能归因于版本回归；也无法确定是检测模型、网络识别或其他因素导致。

154 主矩阵共 26 次访问，主文档均 HTTP 200，无页面 JavaScript error 或导航异常。记录到 158 个子请求失败，其中 141 个 ERR_ABORTED、9 个 ERR_FAILED、6 个 ORB、1 个 CSP、1 个 DNS 错误，涉及广告/分析域名以及检测探针等；因此不声称所有网络请求均成功。同日 152 补跑 6 次，Iphey 另行重测。

## 大小与停止后重连计时

| 指标 | 152.0.7977.82.2（9/29） | 154.0.8037.57.1（9/30） |
| --- | --- | --- |
| 浏览器目录逻辑 bytes | 787,871,822 | 795,009,230 |
| 五次重连并加载本地页，ms | 4749 / 4817 / 4972 / 6232 / 5264 | 5416 / 5578 / 5703 / 5753 / 5846 |
| 中位数 | 4972 ms | 5703 ms |
| 当次容器内存采样 | 283.9 MiB | 293.4 MiB |

154 目录增加 7,137,408 bytes，约 6.81 MiB。计时包含 Hub、授权往返、浏览器启动和页面加载；两个小样本跨日，主机负载与网络延迟未控制。154 本组中位数较高，但不足以确认性能回归，也不能声称新版本更快。

## 范围与证据

未测试原生 Windows/macOS、Linux ARM64、真实业务账号、代理供应商成功率、跨主机 cookie 迁移、旧 profile 升级/降级、长时间压力、主进程硬崩溃或真实 Mac/Windows 硬件对照。正常停止、重启和恢复与硬崩溃恢复不能混为一谈。

证据根目录为 `.cloakhub/cloak154-evaluation/`：

- `recheck-20260930/versions.json`、`availability-all.json`：当前各平台渠道。
- `recheck-20260930/node-launch.log`、`node-launch-result.json`：真实下载校验与启动。
- `preview/results/`：154 各 persona、seed 的页面 JSON、文本、HTML、截图和跨上下文 surface。
- `preview/workflow.json`、`preview/extra.json`：功能及能力检查。
- `preview/real-tests.log`、`viewer.json`、`ui-and-isolation.json`、`proxy.json`、`proxy-public.json`：集成、交互及代理记录。
- `language-probe-preview.json`：两种 locale 的跨上下文与文本检查。
- `paired-20260930/stable/results/`：同日 152 Mac 对照。
- `recheck-20260930/iphey-retry/`：Iphey 加载完成条件重测。

原始页面可能含出口 IP 和访问者标识，仅保存在本机忽略目录；报告不包含 key、管理 token 或签名下载 URL。

## 收尾

所有脚本步骤退出码为 0（不代表代理等子检查全通过，失败项已在上文单列）。154 的 20 个、152 的 23 个测试 profiles 均已停止；两个测试容器内未残留浏览器/显示进程，容器均已停止。授权占用恢复 **0/1**，记录在 `recheck-20260930/cleanup.json`。现有生产容器未变更。
