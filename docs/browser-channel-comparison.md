# Mac persona：152 preview 与 151 stable 对比

测试日期：2026-09-11（America/Los_Angeles；原始日志为 UTC 2026-09-12）。

标准构建已改为 preview `152.0.7977.82.1`。这次对照中，152 的三组
Fingerprint 篡改模型分数均低于 151，常规功能测试未发现版本回归。
这不是所有网站通过率的估计；两版在主要检测器上的布尔判定本来就相同。

## 环境与安装

| 项目 | stable | preview |
| --- | --- | --- |
| 官方完整版本 | 151.0.7922.108.6 | 152.0.7977.82.1 |
| CDP 返回版本 | 151.0.7922.108 | 152.0.7977.82 |
| 网页 Client Hints 的 Chrome 完整版本 | 151.0.7922.109 | 152.0.7977.83 |
| 浏览器目录逻辑大小 | 782,547,835 bytes | 787,839,336 bytes |

官方版本接口分别查询了 Linux x64 和 ARM64；两者都返回上述版本，preview
没有回退到 stable。实际运行测试只覆盖 Linux amd64。
来源：[stable](https://cloakbrowser.dev/api/download/version)、
[preview](https://cloakbrowser.dev/api/download/version?channel=preview)，请求使用
`X-Platform` 头。

两组使用相同应用镜像
`sha256:ce9ef8ad88295249f120d82e7c3a7a479612222b90839a98335dc88e8acccd79`，
仅改变浏览器版本及渠道。两组均从空缓存通过官方 `cloakbrowser@0.5.10`
下载器安装，保留 Ed25519、manifest 版本和 SHA-256 校验；没有用显式 binary
路径绕过托管安装。实际下载路径和 CDP 版本均核对过。

共同条件：Mac persona、46 个真实字体文件（55.06 MiB）、headed、1366×768、
DPR 1、4 CPU 配额、2 GiB shared memory、SwiftShader 软件渲染、en-US、
America/Los_Angeles、相同出口。
公共检测不使用代理、账号或自定义 UA。三个新 profile 的 seed 为 20260909、
20260910、20260911；每个 seed 在两版相同。第二组交换运行顺序，所有浏览器
串行运行，以适应单会话许可证。

## 公共检测

| Seed | 151 tampering_ml_score | 152 tampering_ml_score |
| --- | ---: | ---: |
| 20260909 | 0.2322 | 0.0967 |
| 20260910 | 0.0748 | 0.0300 |
| 20260911 | 0.1258 | 0.0541 |

六次 Fingerprint 观察均为：`bot=not_detected`、`tampering=false`、
`anomaly_score=0`、`anti_detect_browser=false`、`virtual_machine=false`。
六次 Device & Browser Info 观察均为 `isBot=false`，其明细没有 true 项。
模型分数不是业务通过率，也不应解释为“有多少概率被网站封禁”。分数受
引擎版本、特征组合和服务端模型影响，本次不能定位到某一个具体补丁。

以下站点只对第一组 seed 做完整对照：

| 检测项目 | 151 | 152 |
| --- | --- | --- |
| Sannysoft | 表格中无 failed 项 | 相同 |
| Rebrowser | mainWorldExecution、exposeFunctionLeak 两项红色 | 相同 |
| CreepJS | 31% like headless、0% headless、0% stealth | 相同 |
| CreepJS 字体加载探测 | 2/51 | 相同 |
| Iphey | 100，Trustworthy | 相同 |

Rebrowser 脚本按站点要求主动执行主世界代码并调用 `exposeFunction`，这两项
能观察到自动化操作；不能把上述结果描述成“所有反侦测项目全绿”。CreepJS
的 2/51 是其特定字体列表探测结果，不等于本机只安装了两个字体。
所有 20 次公共站点访问均返回 HTTP 200，未记录页面导航错误。

## 功能与指纹一致性

普通测试：211 通过；类型检查通过。默认跳过的 10 项真实浏览器集成测试，
这次显式启用并在两版分别执行，均为 10 通过、0 失败。这十项覆盖 WebGL
像素、区域/暗色设置、headless/headed、KasmVNC/RFB、CDP 鉴权、自动唤醒、
空闲休眠后的持久化、强制停止、多客户端关闭标签页。其 fixture 使用应用
基础 Linux 默认值；下面另外通过实际 Docker 服务测试 Mac 默认值。

两版均通过：

- UI/API 默认创建 Mac profile；显式 Linux profile 保留 Linux 身份且无法加载私有 Helvetica Neue。
- Mac 多语言输入、iframe、弹窗、上传、下载、多 CDP 客户端。
- 浏览器停止后唤醒保留 cookie、localStorage、IndexedDB。
- 容器重启后保留 Mac 身份、cookie 和 localStorage。
- 连续五次停止/唤醒；headless Mac 身份和字体加载。
- WebGL/WebGL2 像素输出、OffscreenCanvas WebGL2、OfflineAudioContext 非静音有限采样。
- WebGPU adapter 可获取；H.264、VP9、AAC、Opus 的 `canPlayType` 均为 probably。

编解码检查测的是能力声明，不是完整视频解码压力测试；WebGPU 检查不是
GPU 性能测试。两版报告的存储配额均为 10 GiB。

三个 seed 的主线程、Worker、跨域 iframe、HTTP UA/Client Hints、语言、CPU、
时区共 12 项一致性检查，两版均通过。同 seed 的 12 组文字测量、WebGL
renderer/版本/像素、screen 和 window 数据在两版相同；UA/Client Hints 的
Chromium 主版本随引擎升级，GREASE brand 也改变。发行版本、CDP 版本与网页
完整版本是不同表面，不把它们数值不完全相同单独当作检测失败。

字体安装检查为 20/20 家族；CSS `local()` 直接使用家族名只加载 18/20。
Menlo 的实际完整名称是 `Menlo Regular`，Comic Sans MS 当前只有 Bold。
继续测试其完整名和 PostScript 名，两版仍无法通过 CSS `local()` 加载这两种
字体；原因尚未定位，不能只归因于调用时用了家族名。其他 18 个家族名可加载。
初始扩展探测把“家族名可发现”和“同名 CSS local 可加载”等同，触发断言；
后续改为分别记录这两个问题，字体文件和浏览器配置没有为消除断言而修改。

## VNC、代理与 profile 升级

两版均通过实际 noVNC UI 的鼠标点击和中文剪贴板粘贴。
把正常关闭后的 151 Mac profile 复制到 152 后，cookie、localStorage 和
IndexedDB 均保留；原 151 profile 未改动。这是同主机、同镜像环境的升级测试，
不是跨机器 portable-cookies 测试，也不是降级测试。

| 代理场景 | 151 | 152 |
| --- | --- | --- |
| 普通认证 HTTP 代理，经 Hub relay，12 次本地 HTTP/HTTPS 导航 | 通过 | 通过 |
| 普通认证 HTTP 代理，example.com 的 HTTPS/HTTP/HTTPS 三次导航 | 全部 200 | 全部 200 |
| 额外开启 `--fingerprint-transparent-proxy` | 启动失败，日志报告配置无效 | 能启动，导航未通过 |

透明模式最初在虚构域名上测试，152 报 `ERR_NAME_NOT_RESOLVED`；因此补测
可解析的 example.com 和可转发公网 CONNECT 的认证代理。151 仍未能启动，
152 报 `ERR_PROXY_CONNECTION_FAILED`。这证明本次 HTTP relay 配置下未实现
透明模式的可用对照，不能据此宣称它在所有代理上失效，也没有观察到其连接
可靠性提升。该标志没有加入默认配置。

本地 HTTPS fixture 使用自签名证书，测试通过 CDP 临时忽略该证书错误；
example.com 对照没有关闭证书校验。

## 耗时与体积

| 项目 | 151 | 152 |
| --- | --- | --- |
| 五次停止后重新连接并加载本地页面，毫秒 | 4749 / 4855 / 5048 / 5133 / 5339 | 4751 / 4950 / 5026 / 5189 / 5346 |
| 中位时间 | 5.048 s | 5.026 s |
| 当次容器内存样本 | 307 MiB | 287.3 MiB |

这只是同主机顺序运行的小样本，包含 Hub、许可证和页面加载开销，不能据此
宣称 152 显著更快或更省内存。浏览器目录增加 5,291,501 bytes，约 5.05 MiB。

## 异常退出与许可证

主动对 151 主进程发送 `Browser.crash` 后，Hub 清理了本地浏览器和显示进程，
但服务端仍计数 1/1，阻止后续启动。直接启动官方二进制作为控制，也在短暂
开放 CDP 后退出，退出码为 76；CDP 端口出现不等于许可证检查最终通过。

官方在 [issue #477 的维护者回复](https://github.com/CloakHQ/CloakBrowser/issues/477#issuecomment-5132347894)
确认：免费版硬崩溃遗留会话最多等待 15 分钟自动过期，正常关闭立即释放。
这是上游会话策略，不能把等待期间 152 收到的 503 算作 152 引擎回归。
本次首次观察占用归零为 UTC 00:37:53，距离约 00:22:45 的故障约 15 分钟
（每 10 秒轮询）。之后同一 CDP URL 能重新启动原 profile；但紧接着写入后
立即硬崩溃的 localStorage 值读回为 null，该持久化断言失败。测试没有在
故障前确认该次写入已落盘，不能用它代表正常关闭后的持久化。

主进程硬崩溃注入发生在 151；没有在 152 再重复一次相同的 15 分钟服务器
占位实验。两版正常停止、自动唤醒和容器重启恢复已分别测试。

## 范围限制与构建变更

本次没有测试真实业务账号、多主机 cookie 迁移、152 数据目录降级回 151、
长时间压力负载、ARM64 运行时或真实 MacBook 对照。代理测试只覆盖本地测试
代理；不代表住宅/数据中心代理供应商的成功率。当前显示仍为 DPR 1，未验证
4K/DPR 2。字体家族齐全不等于所有字重、字形或字体接口与真实 Mac 完全一致。

标准及自定义字体 Dockerfile 现在固定 `152.0.7977.82.1` / `preview`。
安装器接受精确 Chromium 版本，并显式传递 `CLOAKHUB_BROWSER_CHANNEL`；保留
精确版本不匹配拒绝、原子缓存发布及官方签名校验。可显式选择
`151.0.7922.108.6` / `stable`。新 profile 默认 Mac，已有 profile 的 persona
和 seed 不会被重写。

本地标签 `cloakhub:mac-preview`、`cloakhub:mac-private`、`cloakhub:mac-standard`
指向这次 preview 镜像。没有推送镜像、发布版本或替换既有服务。
两组测试容器均已停止；关闭前没有残留浏览器、显示进程或僵尸进程，
最终许可证占用为 0/1。
操作说明见 [Mac fonts and image builds](private-macos.md)。

原始日志、测试脚本、页面及截图保存在本机忽略目录
`.cloakhub/mac-channel-comparison/`。含 IP、访客标识或令牌的原始材料不写入本报告。
