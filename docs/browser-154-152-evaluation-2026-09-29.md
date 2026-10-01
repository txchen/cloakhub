# CloakBrowser 154 preview / 152 stable 验证报告

> **2026-09-30 21:10 PDT 更新：下载阻塞已解除。** 官方 Linux preview 现返回 `154.0.8037.57.1`，stable 返回 `152.0.7977.82.2`。使用同一个 key、Node.js SDK 0.5.11、全新缓存、无 pin，已成功下载 154 并通过签名/SHA-256 校验，实际启动 CDP 版本 `Chrome/154.0.8037.57`。以下“154 尚未取得”的内容是 9 月 29 日历史观察，不再代表当前状态。新证据见 `.cloakhub/cloak154-evaluation/recheck-20260930/`。

测试日期：2026-09-29（America/Los_Angeles）。原始日志使用 UTC。

**当前结论：152.0.7977.82.2 在本项目的 Linux + Mac persona 配置下可用，未观察到基础功能故障，主要抗检测结果与此前 .82.1 相近。Windows persona 被 Fingerprint 判为 tampering/anti-detect；透明代理模式仍不可用。154 的清单已发布，但使用现有 key 的官方入口返回旧包，因此 154 尚未实测，不能作升级推荐。**

公告来自用户收到的邮件，没有附原文链接。本次没有把无法取得 154 解释成 154 引擎本身有问题，也没有把公开 demo 结果解释成所有网站的通过率。

**邮件补充后的复核：已隔离安装最新 wrapper 0.5.11，使用全新缓存、设置 preview 并去掉版本 pin，仍取得 152.0.7977.82.2，未取得 154。官方新增字体诊断确认 Mac 配置 20/20，Windows persona 默认环境为 0/8 Windows 必需字体。详细复核见下节。**

**再次深入排查：154 清单的 HTTP `Last-Modified` 为 2026-09-28 05:28:59 UTC，签名文件为同日 05:29:01 UTC，与邮件所述昨天发布相符。应区分“发布材料已经存在”与“当前 key 的官方渠道能下载到正确包”。本次只能证实后者仍失败，不能断言 154 尚未发布或所有用户都下载不到。**

## 分发路径深入诊断（16:02–16:05 UTC）

另见[SDK 下载源码与实际请求跟踪](cloakbrowser-sdk-download-analysis.md)：16:19 UTC 直接跟踪原版 Node.js SDK 的 preview、preview + 154 pin、stable 三种调用。确认版本查询阶段服务器已经返回 152，SDK 按该返回值下载；免费 key 的精确 pin 会在客户端被清除，但 preview 参数仍正确到达版本查询接口。

### Node.js 公开 launch 入口复核（16:17 UTC）

按用户要求改用 **Node.js v24.13.0 + npm cloakbrowser 0.5.11**，调用 `await launch({licenseKey: key, releaseChannel: 'preview', headless: true, args: ['--no-sandbox']})`，同时设置环境变量 preview。使用全新 `node-launch-cache/`，没有版本 pin、自动更新覆盖或本地二进制路径覆盖。

官方下载完成并通过 Ed25519/SHA-256 校验，目录仍为 `chromium-152.0.7977.82.2-pro`。随后浏览器实际启动成功，`browser.version()` 返回 `152.0.7977.82`，CDP product 为 `Chrome/152.0.7977.82`。与 Python 实际 launch 结果一致。正常关闭后授权占用 0/1。脚本和结果为 `distribution-debug/node-launch.mjs`、`node-launch-result.json`；启动过程没有使用 Python SDK。

### 邮件原始 launch 路径复核（16:13 UTC）

再次按邮件同时设置 `CLOAKBROWSER_RELEASE_CHANNEL=preview` 并调用 Python 0.5.11 的 `launch(license_key=key, release_channel='preview')`。仅额外指定服务器运行所需的 headless 和 `--no-sandbox`，使用全新 `email-launch-cache/`；没有版本 pin、没有关闭自动更新，也没有指定本地浏览器路径。

浏览器成功启动：下载目录为 `chromium-152.0.7977.82.2-pro`，`browser.version` 为 `152.0.7977.82`，CDP `Browser.getVersion.product` 为 `Chrome/152.0.7977.82`。这补上了前面 `ensure_binary` 下载验证与邮件公开 `launch()` 入口之间的实际启动验证，结果仍不是 154。正常关闭后授权占用 0/1。完整脚本及结果为 `distribution-debug/email-launch.py`、`email-launch-result.json`。

使用 `diagnosing-bugs` 的最小复现流程，直接用 Node fetch 请求 `/api/download/latest?channel=preview`，携带现有 key 和 `X-Platform: linux-x64`，关闭自动重定向，断言返回的路径应包含 `154.0.8037.57.1`。两次运行均 HTTP 302 指向 `chromium-v152.0.7977.82.2`，精确断言失败；整个复现约一秒，不启动浏览器。脚本保存在 `distribution-debug/repro.mjs`。

| 假设/控制变量 | 实验 | 结果与能得出的结论 |
| --- | --- | --- |
| JavaScript wrapper 实现问题 | Python 0.5.11、独立新缓存、无 pin、preview，真实下载并校验 | 仍为 .82.2；不是仅 JavaScript 实现才出现 |
| 本地版本缓存或镜像覆盖 | 直接 HTTP 请求；确认 HTTP/HTTPS/ALL_PROXY、版本 pin、下载镜像等相关环境未设置 | 直接接口也返回旧版，本地安装缓存不能解释此响应 |
| key 改变版本查询 | `/api/download/version?channel=preview` 有/无 Authorization 对照 | 两者均返回 .82.2，因此公开渠道元数据本身也有此问题；没有付费 key 对照，不能排除付费显式下载另有路径 |
| 主域名与 www 的路由不同 | `cloakbrowser.dev` 和 `www.cloakbrowser.dev` 的版本查询及带 key 下载 | 相同旧版结果 |
| 缓存或个别边缘节点 | 随机查询参数、Cache-Control/Pragma no-cache；捕获 WAW、PDX 响应 | 仍为旧版，CF-Cache-Status=DYNAMIC；未覆盖全球节点，不能证明所有区域相同 |
| preview 参数或平台问题 | 官方 JS/Python 源码核对；Linux、Windows、macOS 元数据对照 | Linux preview=.82.2；Windows/macOS preview 回退到各自旧 stable；与两种 wrapper 的官方参数一致 |
| 认证根本没有生效 | 相同下载入口不带 key | 返回 HTTP 401 Missing license key；带 key 为签名 R2 重定向，说明不是请求完全未认证 |
| 可从公开 release 目录直接取包 | 携带同一 key 请求 154 的归档路径 | HTTP 403；签名清单和签名则 HTTP 200，不绕过授权或完整性校验 |

Python 独立实验实际调用 `ensure_binary(license_key=key, release_channel='preview')`，返回 `chromium-152.0.7977.82.2-pro/chrome`，并解析出 `requested_channel=preview, resolved_channel=preview, fallback=False`。这不是只读源码推断。

最后一次直接下载复现时间为 **2026-09-29 16:04:52 UTC**，CF-Ray 为 `a42c39e58910c063-WAW`。禁缓存版本查询也获得 PDX 的 `a42c36b46e695ef5-PDX`，仍返回 .82.2。154 的公开清单和签名分别显示 9 月 28 日修改时间，且此前已通过官方固定公钥的 Ed25519 验证。

目前最符合证据的解释是服务端渠道解析/分发状态与已上传的发布材料不一致；**这是推断，不是已经看到服务端代码并定位到某一行**。没有足够依据把问题归结为用户操作、key 无效或 154 引擎故障。项目没有这个远端映射的控制权，本轮没有可实施的本地源码修复；保留仍会失败的最小复现及脱敏材料供发布方核对，没有向发布方发消息。

诊断文件位于 `.cloakhub/cloak154-evaluation/distribution-debug/`：`probes.json`、`artifacts.json`、`python-result.json`、两次 `repro-*.json`，以及可转发的 `vendor-report.md`。日志不包含 key 或带签名参数的下载链接。仅下载/请求接口，没有启动新浏览器会话或改动生产服务。

## 邮件补充后的 0.5.11 复核

### 公开社区反馈核查

2026-09-29 检索官方仓库 issues（含正文/评论及关闭项）、discussions、Manager 仓库，以及公开网页。没有找到专门报告“154.0.8037.57.1 已公告进入 preview，但无 pin 的 preview 仍取得 152”的帖子或官方确认。检索不到不代表没有私人支持工单或尚未被索引的反馈。

- [#491，维护者 8 月 7 日回复](https://github.com/CloakHQ/CloakBrowser/issues/491#issuecomment-5219155597)：用户请求 148 却被重定向到 150，导致 checksum mismatch。维护者确认免费 key 不支持旧版 pin，服务器回退到 stable，而 wrapper 仍用指定版本清单校验；建议取消 pin、使用 preview。这与本次强制版本请求的校验失败相似，但不能解释我们无 pin 的 preview 结果。
- [#471，维护者 9 月 20 日回复](https://github.com/CloakHQ/CloakBrowser/issues/471#issuecomment-5752378979)：明确区分“构建已经存在”和“进入公开渠道”；当时 .82.2 可由付费 key 显式获取，免费 key 要等其进入 preview。证明发布材料存在与免费渠道可取得不必同时发生，但不能据此断言 154 当前采取相同状态。
- [#547，维护者 9 月 16 日回复](https://github.com/CloakHQ/CloakBrowser/issues/547#issuecomment-5700982325)：明确说明有效免费 GitHub key 可以使用 preview，直接下载使用 `?channel=preview`。因此不能把本次无 pin preview 拿旧版简单解释成“免费 key 无权使用 preview”。

当前精确问题仍缺少外部同类反馈确认；上述均为相关历史行为，不是本次 154 故障的官方确认。

用户补充了完整邮件：要求 wrapper 0.5.11，通过 `CLOAKBROWSER_RELEASE_CHANNEL=preview` 或 `release_channel=preview` 选择 preview；明确精确版本 pin 仅适用于付费 key。邮件还说明 Linux .82.2 对语言原生路径、渲染一致性和文本处理进行了更新。

在 `.cloakhub/cloak154-evaluation/wrapper-0511/` 独立安装 npm `cloakbrowser@0.5.11`，没有修改项目 `package.json`、锁文件或现有服务。清除继承的 `CLOAKBROWSER_*` 环境，指定全新 `cache-0511/`，设置 preview，再调用 `ensureBinary(key, undefined, 'preview')`，**没有版本 pin**。2026-09-29 15:56:57 UTC 的结果仍是 `chromium-152.0.7977.82.2-pro/chrome`，签名和 SHA-256 校验通过，154 精确匹配检查为 false。

这排除了“本次仅仅因为使用旧 wrapper 或旧本地浏览器缓存而拿错版本”的解释。该结果仍不足以判断所有地区的发布状态，也不表示免费 key 不支持 preview；它证明本机使用该 key 和官方渠道实际得到的仍是 .82.2。免费 key 的精确 pin 限制也与邮件一致，后续验证应以无 pin 的 preview 路径为主。

将两版 wrapper 下载解压后的 .82.2 目录逐项比较：**各 671 个文件/符号链接，全部内容 SHA-256/链接目标一致，差异 0**。因此下文原有 152 浏览器测试仍然针对同一份二进制，无需因 wrapper 升级而重复整套检测。目录比较没有声称两个 wrapper 的 JavaScript 实现完全相同。

### 官方新增字体诊断

在同一测试镜像中运行 0.5.11 的 `cloakbrowser info --quick --json`：

| fontconfig 环境 | macos | windows | office |
| --- | --- | --- | --- |
| Mac profile 使用的 `/app/macos-fonts.conf` | **20/20** | 1/8 | 0/10 |
| Linux/Windows persona 的默认环境 | 0/20 | **0/8** | 0/10 |

CLI 没有 persona 参数，会同时统计三套字体，应该按实际 persona 读取对应项。Mac 配置的 Windows 字体不全并不意味着 Mac 字体诊断失败；Office 字体是补充项。Windows persona 的 0/8 则是明确的配置缺口，与其高 tampering 分数相关联的合理排查方向，但本次没有做“补齐字体前后”的因果对照，不能声称已证明告警只由字体导致。

官方的 20/20 通过 `fc-list` 统计 family，不会验证所有 CSS `local()`、字重、字形或文本度量，因此与下文 CSS `local()` 18/20 的结果不矛盾。

### 针对邮件语言/文本声明的补测

在已验证的 .82.2 原版浏览器上另建两个 Mac headed profile：`zh-CN + Asia/Shanghai`、`de-DE + Europe/Berlin`。两组均通过：

- `navigator.language`、`navigator.languages[0]` 与指定 locale 一致；主线程、Worker、跨源 iframe 的语言列表和时区一致。
- HTTP `Accept-Language` 首项与指定 locale 一致。
- 含中文、组合重音、emoji、补充平面字符和 ZWJ 家庭 emoji 的文本，通过 UTF-8 编解码、DOM textContent、Blob.text() 往返。
- NFC 归一化正确；家庭 emoji 在 `Intl.Segmenter` 中为一个 grapheme。

这是兼容性冒烟检查，未对邮件中未公开的底层补丁作覆盖证明，也没有同期旧版对照来证实修复前后差异。第一次辅助脚本用了含大写字母的 profile ID，被 Hub 校验拒绝；改成合法小写 ID 后运行通过，该次脚本问题不计为浏览器语言故障。

## 发布与下载核验

本次目标是公告中的 preview `154.0.8037.57.1` 和 Linux stable `152.0.7977.82.2`。**必须按实际下载、签名和运行版本识别测试对象，不能只按渠道名识别。**

本次初始核查发现官方渠道接口和公告不一致；15:52:53 UTC（08:52:53 PDT）再次核查 Linux x64，结果仍未改变：

| 平台请求头 `X-Platform` | stable 接口 | preview 接口 | preview 回退 |
| --- | --- | --- | --- |
| linux-x64 | 152.0.7977.82.1 | 152.0.7977.82.2 | 否 |
| linux-arm64 | 152.0.7977.82.1 | 152.0.7977.82.2 | 否 |
| windows-x64 | 152.0.7977.82.1 | 152.0.7977.82.1 | 是 |
| darwin-arm64 | 151.0.7922.108.3 | 151.0.7922.108.3 | 是 |
| darwin-x64 | 151.0.7922.108.3 | 151.0.7922.108.3 | 是 |

来源：[stable 版本接口](https://cloakbrowser.dev/api/download/version)、[preview 版本接口](https://cloakbrowser.dev/api/download/version?channel=preview)。请求携带上述平台头；普通请求，以及带随机查询参数和 `Cache-Control: no-cache` 的请求，均得到上述结果。后者响应为 `CF-Cache-Status: DYNAMIC`，有当次服务器时间。不能据此断言全球所有节点状态相同，也不能断言发布方还没有上传构建。初次探测还使用了 `win32-x64`，随后按官方 wrapper 的正确标签 `windows-x64` 重测；本表只采用正确标签结果。

使用本机 `~/.cloakbrowser/license.key`，官方 `cloakbrowser@0.5.10` 将 key 识别为 free 方案。没有修改 key、授权、浏览器二进制或校验逻辑。

| 请求 | 实际结果 |
| --- | --- |
| `ensureBinary(key, '154.0.8037.57.1', 'preview')`，新缓存 | 下载了 152.0.7977.82.2；精确版本断言拒绝把它当成 154 |
| 带 key 请求 `/api/download/154.0.8037.57.1?channel=preview` | 302 到 152.0.7977.82.2 包 |
| 带 key 请求 `/api/download/latest?channel=preview` | 302 到 152.0.7977.82.2 包 |
| 带 key 请求 `/api/download/latest` | 302 到 152.0.7977.82.1 包 |
| 带 key 请求 `/api/download/152.0.7977.82.2` | 302 到 152.0.7977.82.2 包 |
| 官方 `downloadProBinary('154.0.8037.57.1', key)` | 实际下载包哈希为 152.0.7977.82.1；154 的签名清单验证成功，但包哈希不匹配，下载器拒绝解包 |

154 的[签名清单](https://cloakbrowser.dev/releases/pro/chromium-v154.0.8037.57.1/SHA256SUMS)已存在，列有 Linux x64/ARM64、Windows x64、macOS ARM64/x64 共五种包。清单存在不等于当前 key 的下载入口已经提供这些包。直接访问该 release 路径下的 Linux 二进制返回 403；GitHub 上对应 `chromium-v154.0.8037.57.1-pro` release 查询返回 404。

Linux x64 包校验值：

```text
154.0.8037.57.1 清单预期：0d31b5113ce4a3dab8edd2278e69472cde70ff90d841c73fa065c073c8b46a1b
上述直接下载实际得到：   4fe4ee3c4c014a42c164607ee7730dc68cc84a21c5673f54d3d81a0597b0742a
152.0.7977.82.2 已验证：  4bab1f7f154398a904f135a1783251e150d71d7d06ac50a3f561584de4139aaa
```

第二行与此前 152.0.7977.82.1 的官方校验值一致。这是拿到错误版本包的证据，不能仅凭通用错误文案判断发生恶意篡改。没有跳过 SHA-256，也没有把目录重命名后冒充 154。

**本报告中的运行结果均属于 `152.0.7977.82.2`。目录名 `stable/` 表示公告中的目标分组，不表示当时官方 stable 接口已经指向它。154 尚无可信可运行样本，不能评价其抗检测能力、速度或稳定性。**

## 测试环境与方法

- Linux x86_64 主机；原生 Windows、macOS 和 Linux ARM64 未运行。
- 隔离容器使用 `cloakhub:mac-preview` 基础镜像，ID 为 `sha256:bbe4e5b481ffb2da5baf157700368c8515e52c6f41288e4dbcfbda01b07fb61e`；只读挂载当前项目 `src/`。代码基线为 `a16ded148ce2c7438ed3baa37db82279ca8f2e15`。
- 官方原版浏览器从独立新缓存下载，Ed25519 签名、清单版本与包 SHA-256 校验通过；通过只读路径挂载到测试容器。没有使用仓库里其他实验的修改版浏览器。
- 4 CPU 配额、2 GiB `/dev/shm`，沿用上次 Mac 字体镜像及默认窗口设置，en-US、America/Los_Angeles。同一网络出口，无业务账号，无检测站代理。
- 主测试使用 Mac persona、headed，固定 seed `20260909`、`20260910`、`20260911`。补充 Linux/Windows persona 和 Mac headless。persona 是 Linux 上的指纹配置，不是原生操作系统测试。
- 复用 `examples/antibot-audit.mjs` 与上次 `.cloakhub/mac-channel-comparison/` 的功能及一致性脚本；修改输出路径和预期版本。每次创建独立 profile，按单会话授权串行运行。
- 检测站保存页面文本、HTML、截图、HTTP 状态、请求失败、页面异常及当页指纹。固定等待时间沿用旧流程；页面报错或没有给出结论的项目不能计为通过。
- CDP 基础版本 `152.0.7977.82` 与发行补丁版本 `152.0.7977.82.2`、网页 Client Hints 完整版本是不同字段，不要求字符串相同。

## 公开检测：152.0.7977.82.2

Mac headed、seed `20260909` 的完整九站结果：

| 站点 | 观察结果 | 解释 |
| --- | --- | --- |
| [Sannysoft](https://bot.sannysoft.com/) | 表格中无 failed 行 | 仅代表该站的检查集合 |
| [Rebrowser](https://bot-detector.rebrowser.net/) | 8 项绿，2 项红 | 红项为 `mainWorldExecution`、`exposeFunctionLeak` |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) | 31% like headless，0% headless，0% stealth | 是该站的启发式指标，不是封禁概率 |
| [Device & Browser Info](https://deviceandbrowserinfo.com/are_you_a_bot) | `isBot=false`，details 无 true 项 | 本次未检出 bot |
| [Incolumitas](https://bot.incolumitas.com/) | 新检查 9/9 OK；旧 fpscanner 的 `WEBDRIVER=FAIL` | 不能算全通过；行为分数仍为 `...` |
| [BrowserScan](https://www.browserscan.net/bot-detection) | `Test Results: Normal`；CDP、Dev Tool 等均显示 Normal | 本次页面判定正常 |
| [Fingerprint](https://demo.fingerprint.com/playground) | bot 未检出，tampering=false，anomaly_score=0 | 多 seed 结果见下表 |
| [Iphey](https://iphey.com/) | 100，Trustworthy | 与此次出口及配置有关 |
| [reCAPTCHA v3 demo](https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php) | success=true，score=0.9，error-codes=[] | 单次公开 demo 分数，不代表业务站点验证码通过率 |

九站主文档均返回 HTTP 200，采集脚本没有导航/提取异常。**HTTP 200 不等于检测通过**；页面的子请求失败和检测红项另行保留。

包括补充配置在内，本轮共 26 次站点访问，主文档全部 HTTP 200，0 个采集异常、0 个 `pageerror`。记录到 156 次子请求失败，多数为 Google、广告或统计端点的 `ERR_ABORTED`，也有检测用 `invalid` 地址、CSP 等；这些原始事件没有被抹去。没有逐一诊断全部子请求失败，因此不宣称每个页面的所有资源均完整加载。

Rebrowser 按站方要求在主世界执行检测代码并调用 `page.exposeFunction`，两项红色能真实观察到这些自动化行为。它们与上次结果相同，但不能因此改记为绿色。

Incolumitas 没有执行其表单购物篮行为挑战，因此没有有效行为分类分数。其被动 TCP/IP 探测将最高分系统类别判为 Linux，而网页 persona 是 Mac；页面自己的 `os_mismatch` 字段仍为 false。应同时保留这些原始观察，不能声称浏览器 persona 已经把宿主网络栈也变成 macOS。没有做主动 DNS/WebRTC 泄漏或代理供应商覆盖测试。

### 固定 seed 复测与历史记录

| Mac headed seed | 本次 .82.2 tampering_ml_score | 上次 .82.1 历史记录 | 本次 bot / tampering |
| --- | ---: | ---: | --- |
| 20260909 | 0.0967 | 0.0967 | not_detected / false |
| 20260910 | 0.0300 | 0.0300 | not_detected / false |
| 20260911 | 0.0541 | 0.0541 | not_detected / false |

三组的 `anomaly_score=0`、`anti_detect_browser=false`、`virtual_machine=false`、`os_mismatch=false`，Device & Browser Info 均为 `isBot=false`。本次与[上次报告](browser-channel-comparison.md)数值一致，但上次测试日期不同，本次也没有重新运行 .82.1 对照组，所以这不是同期随机 A/B 实验，更不能把模型分数解释成真实业务封禁率。

### 不同 persona 与 headless

| 配置（seed 20260909） | Sannysoft failed 行 | Device & Browser Info isBot | Fingerprint tampering | tampering_ml_score | anti_detect_browser | anomaly_score |
| --- | ---: | --- | --- | ---: | --- | ---: |
| Mac headed | 0 | false | false | 0.0967 | false | 0 |
| Mac headless | 0 | false | false | 0.2714 | false | 0 |
| Linux headed | 0 | false | false | 0 | false | 0.0033 |
| Windows headed | 0 | false | **true** | **0.9998** | **true** | 0.0502 |

这四组 Fingerprint 的 `bot` 字段均为 `not_detected`。其中 Windows 的另外两个关键字段却为 true，说明只看 bot 字段会漏掉明显问题。Mac headless 未触发布尔告警，但单个 seed 的模型分数高于 headed；样本不足以证明两种模式普遍存在同样差距。

Windows persona 使用本次相同 Linux 镜像的默认字体环境，没有另装真实 Windows 字体集。因此该负面结果针对这套配置，不是原生 Windows 构建结论，也不能归因于某个 Chromium patch。历史 `.cloakhub/cloak152-evaluation/preview/results/summary.json` 中同一 Windows seed 在 .82.1 已有 `tampering=true`、`anti_detect_browser=true`、score=0.9999；历史环境并非完全匹配，至少不能据此称为 .82.2 首次引入的回归。

发现 Windows 告警后追加两个独立 seed，结果如下，均不是单个 seed 的偶发现象：

| Windows headed seed | tampering_ml_score | tampering | anti_detect_browser | Device & Browser Info isBot |
| --- | ---: | --- | --- | --- |
| 20260909 | 0.9998 | true | true | false |
| 20260910 | 0.9999 | true | true | false |
| 20260911 | 0.9998 | true | true | false |

三组 anomaly_score 均为 0.0502。seed 20260910 还被标记 `vpn=true`、`os_mismatch=true`，另外两组为 false；虽然实际没有配置代理，这也说明这些字段是检测器判断，不能直接当作实际网络配置。

### 指纹一致性

三个 Mac seed 各有 12 项检查全部通过：主线程/Worker/跨源 iframe 的 UA、platform、UA-CH，HTTP UA，HTTP UA-CH 四项字段和 fullVersionList，以及主线程/Worker 的语言、CPU、时区。

Linux 的一组和 Windows 的三组也全部通过同样的 12 项检查，即 7 组 headed 共 84 项一致性判断为 true。各组 WebGL/WebGL2 的清屏读回像素均为 `[64,128,191,255]`，GL error=0。Windows 同时仍被 Fingerprint 标红，说明这些基础一致性检查是有限的必要检查，不能替代检测站的更细判定。

这是所列接口之间的一致性；不表示所有 Canvas、Audio、WebGPU、网络栈细节都等同于真实 Mac。本次没有真实 Mac 设备对照。

## 功能、字体与性能观察

152.0.7977.82.2 的下列真实浏览器操作已通过：

- Mac 默认身份、中文/重音字符/emoji 输入；iframe 点击、弹窗、文件上传和下载。
- 两个 CDP 客户端共享同一 profile。
- 正常停止浏览器后自动唤醒，cookies、localStorage、IndexedDB 均保留。
- 正常停止后重启容器，Mac 身份、cookies 和 localStorage 保留。
- 连续五次停止/唤醒并加载本地页面；headless Mac 身份及 Helvetica Neue 加载。
- OfflineAudioContext 的 44,100 个样本为有限数且非静音；OffscreenCanvas WebGL2 可用；WebGPU 可获取 adapter。
- H.264、VP9、AAC、Opus 的 `canPlayType()` 均为 `probably`；存储 quota 为 10 GiB。

codec 检查验证能力声明，没有做实际长视频解码或 GPU 性能压测。

字体检查在 Mac profile 的 `FONTCONFIG_FILE=/app/macos-fonts.conf` 下为 20/20 必需 family 可发现；CSS `local()` 为 18/20。Menlo 和 Comic Sans MS 未加载，Helvetica Neue 正常，与上次问题相同。全局默认 fontconfig 不含这些私有 Mac family，这是 profile 字体隔离的设计，因此必须使用对应的 fontconfig 检查。CreepJS 字体 probe 的 `2/51` 是其特定名单的结果，不能解释为镜像只有两个字体。

| 指标 | 152.0.7977.82.2 本次样本 |
| --- | --- |
| 五次停止后重连并加载本地页 | 4749 / 4817 / 4972 / 6232 / 5264 ms |
| 中位数 | 4972 ms |
| 当次容器内存采样 | 283.9 MiB |
| 浏览器目录逻辑大小 | 787,871,822 bytes（约 751.37 MiB） |

计时包含 Hub、授权、启动和页面加载开销；内存为单点采样。没有同期 154 对照，不能得出 154 更快或 .82.2 显著改善性能的结论。

常规代码检查：227 passed，11 skipped，0 failed；TypeScript typecheck 通过。这是项目基线检查，不替代真实浏览器集成测试。

随后显式设置 `CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true`、`CLOAKHUB_RUN_CDP_TESTS=true`，使用本次 .82.2 原版浏览器运行两个集成测试文件：**10 passed，0 failed，42 个断言，51.87 秒**。覆盖 WebGL 像素、时区/语言/外观、headed/headless、KasmVNC/RFB、CDP 鉴权与发现、两种 CDP 自动恢复入口、空闲停止后的持久化、强制停止、多个客户端并发关闭标签页。这里的强制停止是 Hub 显式 Stop，不是主进程崩溃注入。

## VNC 与代理

noVNC 实际鼠标点击和中文剪贴板粘贴均通过。UI 新 profile 默认为 Mac；显式 Linux profile 保持 `Linux x86_64`，无法加载私有 Helvetica Neue，字体隔离符合预期。

| 代理配置 | 结果 |
| --- | --- |
| 认证 HTTP 代理，经 Hub relay，本地 HTTP/HTTPS 共 12 次导航 | 通过 |
| 同类代理，公网 example.com，HTTPS/HTTP/HTTPS 三次导航 | 均 HTTP 200 |
| 本地代理再加 `--fingerprint-transparent-proxy` | `ERR_NAME_NOT_RESOLVED` |
| 公网可解析域名再加该 flag | `ERR_PROXY_CONNECTION_FAILED` |

透明模式结果与上次 .82.1 的观察相同。本次不能推荐在当前 Hub HTTP relay 配置中启用这个 flag，也不能外推为所有代理协议/供应商都失败。测试脚本捕获了预期错误，因此脚本进程 exit 0 不等于该模式通过，以上结论使用 JSON 内的 `pass` 字段。

本地 HTTPS fixture 使用自签名证书，通过 CDP 临时忽略证书错误；example.com 公网检查没有关闭证书验证。

## 适用范围

本次没有测真实业务账号、住宅/机房代理供应商通过率、原生 Windows/macOS、Linux ARM64、跨机器 cookies 迁移、旧版 profile 升级/降级、长期高负载、DPR 2/4K、真实视频解码、主动网络泄漏或真实 Mac/Windows 硬件对照。没有重复上次主进程硬崩溃后的 15 分钟授权占用实验；正常 stop/wake 与容器重启已单独验证。

对于现有 Linux + Mac persona 工作负载，.82.2 的本次结果支持继续使用并做业务自身回归；没有证据表明它在抗检测上明显优于此前 .82.1。对于 Windows persona，应先解决或定位 Fingerprint 告警；不要用 Sannysoft 全绿代替这一检查。对于 154，必须先取得通过其签名清单校验的正确包，再运行同一套测试。

## 证据与复现

本机原始证据保存在 `.cloakhub/cloak154-evaluation/`（被 Git 忽略）：

- `availability.json`、`availability-fresh.json`：渠道查询；`manifests.json`：发行清单。
- `availability-final.json`、`routes-final.txt`：收尾前再次确认下载入口仍未提供 154。
- `download.mjs`、`download-exact.mjs` 及其日志：官方下载与版本/完整性校验。
- `routes.json`：带 key 下载请求的状态及重定向路径，已去掉签名 URL 查询串。
- `start.py`、`stable-run.py`、`followup.py`：环境、执行次序与测试命令。
- `stable/results/`：按 persona、seed、headed/headless 保存公开站点证据；`surface.json` 保存主线程、Worker、跨源 iframe 与请求头。
- `stable/workflow.json`、`extra.json`：交互、存储、重启、字体、音频、图形能力与启动计时。
- `stable/real-tests.log`、`unit-tests.log`、`typecheck.log`：测试计数及逐项日志。
- `stable/proxy.json`、`proxy-public.json`、`viewer.json`：代理与 VNC 结果；`windows-repeat-steps.json`：追加复测。
- `navigation-summary.json`、`stable/results/summary.json`：站点访问与结构化汇总。
- `cleanup.json`：清理状态及授权会话占用。
- `retry-0511-result.json`、`retry-0511.log`：新 wrapper、全新缓存、无 pin 的 preview 重试。
- `fonts-0511-macos.json`、`fonts-0511-default.json`：官方字体诊断；`wrapper-binary-comparison.json`：两次安装内容对照。
- `language-probe.mjs`、`language-probe.json`：邮件语言与文本声明的补测脚本和结果。

原始检测页面包含出口 IP、访问者标识等数据，仅保留在本机。报告不包含 key、管理 token、签名下载链接或访问者 ID。现有服务和默认浏览器版本不因本次验证而变更。

15:54:40 UTC 完成清理：17 个测试 profile 均已停止，容器内无残留 Chrome/Xvnc，测试容器已停止，授权占用为 **0/1**。保留已验证的浏览器缓存、profile 和证据供复核；没有替换现有服务、修改默认版本、推送镜像或发布 release。

邮件补测于 15:59:55 UTC 再次清理完成：累计 19 个 profile 均停止，测试容器停止，授权占用仍为 **0/1**；记录于 `cleanup-0511.json`。
