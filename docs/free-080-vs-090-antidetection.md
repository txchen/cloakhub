# cloakhub_free 0.8.0 vs 0.9.0：反检测实测比较

测试日期：2026-10-01（UTC）。对象是 GHCR 的正式发布镜像，不是挂载源码的开发实例。

后续已定位 IPHey 的字体性能退化/采集超时/服务端空值异常链路，并补充 OS mismatch 与客户端注入对照，见[后续诊断](identity-diagnosis-20261001.md)。本文保留初次比较时的观测与结论边界。

## 结论

**在本次测试范围内，0.9.0 没有表现出明确强于 0.8.0 的反检测能力；主流浏览器自动化检测结果基本持平。** 0.9.0 的主要变化是内核从 152 升至 154。发现一项可重复的差异：**IPHey 在 0.8.0 能完成，在 0.9.0 停留于占位状态**。这属于待定位的兼容性异常，不是“0 分”，也不能断言是网站主动封禁。

两版共同的限制：

- Playwright `exposeFunction` 注入和刻意的主世界 API 调用都能被识别。
- Fingerprint Pro 虽不判为 bot/tampering，但两版都报告 `VPN / OS mismatch`。
- 同一 seed、同一模式下，升级版本并不保证切断指纹关联；Fingerprint Pro 本次把两版识别成相同 Visitor ID。
- “没被这些检测页识别为机器人”不等于真实业务站点永不拦截，也不等于匿名或不可追踪。

## 1. 对照条件与样本

| 项目 | 0.8.0 | 0.9.0 |
|---|---|---|
| 镜像 | `ghcr.io/txchen/cloakhub_free:0.8.0` | `ghcr.io/txchen/cloakhub_free:0.9.0` |
| 实际 binary `--version` | CloakBrowser 152.0.7977.82.1 | CloakBrowser 154.0.8037.57.1 |
| 镜像 digest | `sha256:3ddc42a0c2c1afee065dabffee3bd92a79f7614e9421ed2b93b60d4d22375c2f` | `sha256:00d17b2979571de694c285db6452a342f317945367247855d92f4a6d6cf78108` |
| 平台 | Linux amd64 Docker | 相同 |
| 浏览器身份 | 镜像默认 macOS | 相同 |
| 语言 / 时区 | 默认 `en-US` / `UTC` | 相同 |
| 屏幕 / CPU | 1366×768 / 4 threads | 相同 |
| `/dev/shm` | 2GiB | 相同 |
| 指纹 seed | `20261001`、`20261002` | 相同 |
| 运行模式 | headed、headless | 相同 |
| 客户端 | Playwright 1.63.0，经 CloakHub CDP | 相同 |

- 同一宿主机、同一直接网络出口，无代理，无附加 stealth 插件、初始化补丁或自定义启动参数。
- 两个专用容器、独立临时 `/data`，不复用现有服务的 cookies、账号或 profiles。
- 每一模式/seed 的公开站点套件使用新 profile；同一套件中的站点共享该 profile。局部探针和商用演示另建新 profile。
- 主套件：2 版本 × 2 模式 × 2 seeds × 5 站点 = **40 次观测**。
- IPHey 首轮 4 次，加新 profile、最长等待 90 秒的复测 4 次。
- Fingerprint Pro：2 版本 × 2 模式 × 1 seed = 4 次。
- 自建 HTTP/Worker/跨源 iframe/WebGL/Canvas 探针：8 个独立 profiles。
- 合计 **52 次公开检测页观测 + 8 组本地探针**。不同站点的检查项不应混合成一个“总通过率”。
- `v0.8.0..v0.9.0` 的 `src/` 差异仅涉及 UI CDP token 控件；运行时源代码无差异。但这是完整镜像比较，不是单独替换 binary 的严格因果实验。

## 2. 检测结果总表

下表主套件每版的结果覆盖两个 seeds × 两种模式，即每版 4 次。

| 检测 | 0.8.0 | 0.9.0 | 解释 |
|---|---|---|---|
| SannySoft | 4/4 无失败标记行 | 4/4 无失败标记行 | webdriver、插件、权限、iframe、WebGL 等传统检查持平 |
| DeviceAndBrowserInfo | 4/4 `isBot=false` | 4/4 `isBot=false` | 展示的 22 个明细检测标志均为 false |
| BrowserScan Bot Detection | 4/4 `Normal` | 4/4 `Normal` | CDP、Headless Chrome 显示 Normal |
| CreepJS | 全部 31% like headless / 0% headless / 0% stealth | 相同 | 是该页分项启发式指标，不是“被封概率” |
| Rebrowser | 每次 8 项绿、2 项红 | 相同 | 两项红为刻意触发的主世界执行及 exposeFunction 泄漏 |
| Fingerprint Pro（每版 2 次） | Bot/Tampering 未检测；Suspect Score 4 | 相同 | 同时报 VPN / OS mismatch |
| IPHey（每版 4 次，含复测） | 4/4 完成：90，Unreliable | 0/4 完成：保持 Temporary value | 新版有可复现的结果未完成问题 |

### SannySoft

两版均显示：

- WebDriver：`missing (passed)`；WebDriver Advanced：`passed`。
- Chrome 对象存在，权限为 `prompt`，插件数量 5，PluginArray 检查通过。
- 语言为 `en-US,en`，无 `HeadlessChrome` UA。
- Apple GPU 身份，WebGL 可用。
- PHANTOM、HEADCHR、SELENIUM 等展示的检测项无失败标记。

页面还有大量纯信息行，不能把全部 58 行都称作“58 项通过”。

### DeviceAndBrowserInfo 与 BrowserScan

DeviceAndBrowserInfo 的 webdriver、iframe webdriver、Playwright、CDP、Worker CDP、Client Hints、GPU、Worker 一致性等检查均未报异常。该页面明确说明不依据 IP 信誉或用户行为作判断；不能据此推广到行为风控。

BrowserScan 总结果均为 `Normal`，CDP 与 Headless Chrome 子项也均为 `Normal`。

### CreepJS

8 次观测都显示：

- `31% like headless`
- `0% headless`
- `0% stealth`

这表示仍有共享的类 headless 弱信号，不是所有表面都与真实用户设备完全一致。`0% stealth` 不表示“没有反检测能力”，而是该检测器没有给相应 stealth 启发式计分。

CreepJS 的 Service Worker 身份与主页面保持对应版本的 macOS / Chrome 身份。页面字体样本显示 `Helvetica Neue`、`Noto Color Emoji`，不是完整字体真实性认证。页面陈旧的版本推断显示 `113–115+`，不把它当作实际 Chromium 版本。

本次未获得独立的 CreepJS 全局 trust/lie 结论，不补造综合评分。

### Rebrowser：两版都存在客户端行为泄漏

每次均为：

| 探针 | 两版结果 |
|---|---|
| runtimeEnableLeak | 未检测到泄漏 |
| sourceUrlLeak | 未检测到可疑 stack |
| navigatorWebdriver | 未发现 webdriver |
| pwInitScripts | 未发现特征全局变量 |
| viewport / bypassCsp / useragent | 绿色 |
| dummyFn | 调用成功，属于测试执行确认 |
| mainWorldExecution | **红色** |
| exposeFunctionLeak | **红色** |

测试依照 Rebrowser 页面说明主动调用 `window.dummyFn()`、`page.exposeFunction()`、主世界 `getElementById` / `getElementsByClassName`，不是只打开网页观察未触发的项目。

因此红项证明：**浏览器内核隐藏部分自动化痕迹，不会自动隐藏客户端主动注入的所有痕迹。** 不应把它们误读为正常每次访问都会立刻暴露，但也不能宣称“Playwright 完全不可检测”。

## 3. Fingerprint Pro：bot 检测持平，但 OS 一致性与可关联性值得注意

| 项目 | 0.8.0 headed | 0.9.0 headed | 0.8.0 headless | 0.9.0 headless |
|---|---:|---:|---:|---:|
| bot | not_detected | not_detected | not_detected | not_detected |
| tampering | false | false | false | false |
| anti_detect_browser | false | false | false | false |
| Suspect Score | 4 | 4 | 4 | 4 |
| VPN / os_mismatch | true / true | true / true | true / true | true / true |
| proxy | false | false | false | false |
| tampering_ml_score | 0.0822 | 0.0861 | 0.2386 | 0.2536 |

ML 分数来自每组单次观测，没有统计显著性；不能据微小差值认定新版更差，也不能据模式差值估算实际封禁率。

**OS mismatch：** 两版默认把 Linux 容器呈现为 macOS，但该演示仍显示 `You are using a VPN (OS mismatch)`。本次没有配置代理/VPN；这是检测器的判定，不是对真实网络拓扑的证明。未进行包级 TCP/TLS 归因，不能断言具体是哪个协议字段暴露。

**可关联性：** 同 seed、同模式下，两版虽然 profile/cookies 独立，仍得到相同 Visitor ID：

- headed：两版 ID 的 SHA-256 截断值均为 `075217ade029a37c`。
- headless：均为 `9db7c8b0c6b67e7a`。
- 0.9.0 显示 `visitor_found=true`，匹配到刚刚观察到的 0.8.0。

真实 Visitor ID 不写入报告，只保留哈希。这里的 confidence 是“身份识别置信度”，不是“真人概率”。同一出口、同 seed、服务端历史也会影响关联，不能把原因完全归于 Canvas。

## 4. IPHey：新版唯一明确的完成性退化

### 0.8.0

有头/无头首测与复测均完成：

- `Your Digital Identity Looks Unreliable`
- `90 MX SCORE`
- Browser：Chrome
- Hardware / Software：Everything is fine

90 分也不是完整通过，因为页面总判定仍为 `Unreliable`。

### 0.9.0

有头/无头都停留于：

- Browser / Location / IP / Hardware / Software：`Temporary value`
- 总判定为空
- 页面默认显示 `0 MX SCORE`

首轮在页面加载后等待 20 秒；随后用新 profile 延长至 90 秒，两种模式仍未完成。复测中已记录的响应均未出现 HTTP 4xx/5xx，没有记录到 requestfailed 或未捕获 pageerror，但这不排除脚本内部异常、被捕获的错误、未结束的异步操作或网站识别逻辑问题。

**正确归类：未完成 / 兼容性异常；不纳入数值优劣评分。** 本次没有足够证据区分上游 Chromium 154 行为变化、patch 副作用与站点实现问题。

## 5. 本地指纹一致性与实际图形能力

8 组独立 profiles 均通过以下 7 项比较：

1. 主页面 UA = Dedicated Worker UA。
2. 主页面 UA = 跨源 iframe UA（127.0.0.1 对 localhost）。
3. 主页面 UA = 本地 HTTP 服务实际收到的 User-Agent。
4. 主页面 platform = Worker platform。
5. 主页面 platform = iframe platform。
6. 主页面高熵 UA-CH = Worker 高熵 UA-CH。
7. 主页面高熵 UA-CH = iframe 高熵 UA-CH。

WebGL 和 WebGL2 均能创建 context、clear、readPixels，所有样本读取 `[64,128,191,255]` 且 `getError()=0`。不仅是返回一个 GPU 名称字符串。

以 seed `20261001` 为例：

| 表面 | 0.8.0 | 0.9.0 |
|---|---|---|
| UA major | Chrome 152 | Chrome 154 |
| UA-CH Chrome full version | 152.0.7977.83 | 154.0.8037.58 |
| navigator.platform | MacIntel | MacIntel |
| UA-CH platform / architecture | macOS / arm / 64 | 相同 |
| UA-CH platformVersion | 15.7.7 | 相同 |
| GPU | Apple M3 | 相同 |
| CPU / memory | 4 / 16 | 相同 |
| language / timezone | en-US,en / UTC | 相同 |

binary 版本、UA reduction 和呈现的完整 Chrome 版本属于不同表面；不能仅凭 UA 中 `10_15_7`、`MacIntel` 与 Apple arm 信息的组合就认定泄漏，因为真实 Chrome 也存在兼容性与 UA reduction 行为。

### Canvas 和运行模式稳定性

固定测试文本的 SHA-256：

| seed / 模式 | 0.8.0 与 0.9.0 是否相同 | 哈希前 16 位 |
|---|---|---|
| 20261001 headed | 相同 | 493f4f97cf16cee16 |
| 20261001 headless | 相同 | 4c2b84da3dccbbeba |
| 20261002 headed | 相同 | 83bd2e121a945b9d5 |
| 20261002 headless | 相同 | 14386d8b2fa293fc0 |

跨版本本样本稳定；跨 seed 不同；**同一 seed 在 headed/headless 间不同**。因此不建议认为“seed 不变就可以随意切换模式而指纹不变”。

同 seed 的模式差异在两版中一致：

- headed：inner 1365×646，outer 1365×738，DPR 1。
- headless：inner 1366×647，outer 1366×738，DPR 2。

这是本次实测配置的值，不是所有分辨率、平台和 seed 的通用规律。未专门进行跨重启长期稳定性测试。

## 6. 选择建议

1. **只考虑本次反检测结果：两版基本持平，不把 0.9.0 宣传为明显增强。**
2. 0.9.0 有更新内核，但应先处理或定位 IPHey 未完成现象，再声称兼容性完全等价。
3. 若业务高度依赖 IPHey 类检测结果的兼容性，0.8.0 在本次测试中完成性更好；这不是建议长期使用旧内核，也不表示其结果为 Reliable。
4. 两版共同需要关注网络层/OS 身份一致性；“Bot not detected”与“没有风控风险”不是一回事。
5. 固定 profile 的模式，不要假设 headed/headless 可无损互换。减少不必要的 `exposeFunction` 或主世界注入；此建议不是对绕过所有检测的保证。

## 7. 限制

- 仅 Linux amd64、默认 macOS persona、同一出口、两个 seeds；未覆盖 Windows/Linux persona、不同代理、IP 信誉分层。
- 默认 UTC 与出口地理时区不一致的可能性属于两版共同的配置条件；本次没有调整地域设置，也未归因 IPHey 的 Unreliable。
- 无真实原生 macOS Chrome 对照，不能证明呈现的身份完全逼真。
- 同一站点的多次结果有相关性，不是独立随机样本；没有“统计显著胜出”结论。
- 没有进行账号登录、批量注册、真实业务反爬突破、CAPTCHA 解题或付费风控绕过。
- 未测试 JA3/JA4、HTTP/2 指纹、长期行为画像、鼠标轨迹、reCAPTCHA 分数或 Cloudflare 挑战通过率。
- CreepJS 与其他页面指标仅代表当时网页版本；外部站点会更新。

## 8. 证据与复现

保留精简证据：[results.json](evidence/free-080-vs-090/results.json)，包含 48 次初始站点观测及 8 组本地探针（其中附 4 次 IPHey 复测）。出口 IP 已从 IPHey 摘录中移除，Fingerprint Pro 只保留选定信号及 Visitor ID 哈希。

主套件使用仓库已有 `examples/antibot-audit.mjs`：

```sh
# 必须只对专用临时实例运行：脚本会创建/停止测试 profiles。
CLOAKHUB_URL=http://127.0.0.1:18080 \
AUDIT_SEED=20261001 \
AUDIT_SITES=sannysoft,rebrowser,creepjs,deviceinfo,browserscan,iphey \
AUDIT_OUTPUT=.cloakhub/free-080-090-comparison/080-seed1 \
node examples/antibot-audit.mjs default_headed
```

0.9.0 使用端口 18090；分别运行 `default_headed` / `default_headless`，第二 seed 使用 `20261002`（主套件不再测 IPHey）。Fingerprint Pro 用 `AUDIT_SITES=fingerprint` 单独跑第一 seed 的两个模式。

本地探针源码：[probe.mjs](evidence/free-080-vs-090/probe.mjs)、[probe-server.js](evidence/free-080-vs-090/probe-server.js)。在临时容器内运行 probe-server，然后从 repo 根目录运行 `node docs/evidence/free-080-vs-090/probe.mjs 080` 或 `090`。该脚本使用上述固定的 localhost 端口，创建独立 profiles 并在 finally 中删除它们。

## 9. 清理

测试结束后删除两个专用容器及其匿名 `/data` volumes，删除本次拉取的 GHCR 0.8.0/0.9.0 镜像及临时 HTML、截图、日志和测试脚本副本。只保留本报告、精简 JSON 和两个小型复现脚本；原有服务、profiles、本地 `0.9.0` 镜像不动。
