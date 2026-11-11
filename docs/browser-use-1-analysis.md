# Browser Use 1.0：从固定动作到可编程浏览器

> **历史研究快照：引入任务会话之前。** 文中的“当前没有 REPL／任务级执行状态”描述当时状态，不是当前功能清单。后续已实现可选任务会话；参见[实现比较](browser-use-1-comparison.md)、[session 使用说明](../skills/cloakhub-browser/references/sessions.md)和[后续 CLI 小样本实测](pi-browser-comparison.md)。本文保留当时的推理与来源，不把发布方数字改写成我们的实测。

研究日期：2026-11-10。已通过 CloakHub 浏览器直接核对[原帖](https://x.com/browser_use/status/2119983662162952278)，检查原帖配图、官方发布说明、1.0.0 tag 的迁移文档与 REPL 源码。本文没有运行性能对比，也没有安装或接入 Browser Use。

## 核心判断

最值得学的是让 agent 自己组合代码、决定读取什么信息，并把已学到的操作沉淀下来。CloakHub 已经通过 skill 执行任意 Playwright JavaScript，再连接远程 CDP；它并没有把 agent 限制在固定点击动作中。因此，这个方向支持现有设计，不能直接推出需要删除 Playwright、重写服务端或更换浏览器。

需要区分三种持久状态：磁盘 profile 保存登录态；浏览器进程保存 tabs 和页面状态；REPL 保存变量、函数与中间结果。CloakHub 已有第一种，运行期间有第二种；当前客户端每轮执行后退出，没有第三种。这才是值得评估的具体差异。依据：[本地 README](../README.md)、[客户端 skill](../skills/cloakhub-browser/SKILL.md)、[Browser Use 迁移指南](https://github.com/browser-use/browser-use/blob/1.0.0/MIGRATING.md)。

## 帖子到底发布了什么

Browser Use 1.0 将 agent 引擎改为：模型写 Python cell → 持久 REPL 执行 → 通过 browser-harness helpers 或 raw CDP 操作 Chrome → 结果返回模型 → 下一轮。官方称移除了旧 DOM serializer 和 action schema；模型可以按任务写循环、条件、数据转换及临时 helper，无需先增加一种框架动作。[官方 1.0.0 发布说明](https://github.com/browser-use/browser-use/releases/tag/1.0.0)

“raw CDP”不等于没有辅助层。实际仍有 browser-harness、截图、网络等待、secret 输入等 helpers，`ultrafast` 模式还使用 accessibility-tree ids。源码中 worker 将 browser-harness helpers 导入共享 `ns`，多个 cell 在这个 namespace 中执行；父进程管理 worker，超时可杀死并重启。重启后不能假定 Python 变量仍在。依据：[worker.py](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/repl/worker.py)、[session.py](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/repl/session.py)。

因此可借鉴的原则是：helper 作为便利入口，保留通用代码与协议出口。不是为了“少代码”而放弃进程管理、可靠连接与恢复能力。

## 性能数字应怎么读

原帖正文宣称同模型最高改善 50%、便宜 2–5 倍、快 2–3 倍。配图给出的 0.x → 1.0 数据如下；这些是发布方报告，不是本仓库复测结果。

| 配图模型标签 | 评分（满分 100） | 模型费用/任务 | 分钟/任务 |
| --- | --- | --- | --- |
| Luna high | 41.1 → 73.9 | $0.26 → $0.10 | 30.2 → 13.5 |
| Terra medium | 56.9 → 76.0 | $1.45 → $0.40 | 14.3 → 5.0 |
| Sol medium | 64.2 → 78.3 | $3.56 → $0.68 | 20.5 → 6.4 |

来源：[原帖配图](https://pbs.twimg.com/media/HWuv_yRbQAAmZPd.jpg?name=orig)。评分不是完整任务成功率；正文的“50%”没有在配图中给出统一计算定义。第一行是增加 32.8 个评分点，不能混写成增加 32.8% 成功率。费用栏明确指模型成本。

另有两个重要细节：

- 原帖说删除 90% 旧库，但同一帖配图及 release 写的是删除 80%、减少 136,866 行。应保留口径差异，不把某个比例当作独立验证事实。
- release 另列 60 个任务、每任务 3 次的 BU Bench v2，对照对象是 Browser Use Pi，不是旧 0.x：1.0 默认模式评分 62.6，Pi 为 61.3，配对差值置信区间跨零；费用约低 18%、耗时约低 15%。这组结果不能用来证明前面的 2–5 倍提升，也不能把它当成对前面图表的反证。它们比较的是不同对象。[官方发布说明](https://github.com/browser-use/browser-use/releases/tag/1.0.0)

上述 release 数字是研究时记录的特定比较口径；[后续实现比较](browser-use-1-comparison.md)还记录了另一组 ultrafast／provider-outage 口径。整理入库时没有重新联网核验发布页，也不把两组数字拼成同一对照表。

“SOTA”应理解为作者的发布宣称。目前取得的证据不足以推出它在所有网站、所有模型或 CloakHub 的真实登录任务上都更好。

## 对 CloakHub 最有价值的借鉴

### 1. 保持可编程入口，按需读取页面

现有 skill 已允许任意 async JavaScript，并要求优先网络数据、其次 DOM、最后像素；还鼓励将可预测的步骤放在一个脚本中。这已经覆盖该方向的重要部分。继续完善 `observe`、`captureResponses` 等便利工具即可，不必变成数十个固定 MCP 动作。[客户端 skill](../skills/cloakhub-browser/SKILL.md)

对于跨域 iframe、shadow DOM、网络事件等具体问题，可按需要开放或展示 raw CDP 用法。是否替换某个 Playwright 路径，应由失败案例和实测决定。官方早期文章强调让模型直接处理 CDP 错误并写缺失 helper，这是设计主张，不是“raw CDP 自动消除反爬”的证明。[The Bitter Lesson of Agent Harnesses](https://browser-use.com/posts/bitter-lesson-agent-harnesses)

### 2. 评估任务级状态，而不是永久保持 CDP 连接

持久 REPL 可以复用变量、导入、函数和采集结果，减少多轮重复准备。可能收益来自减少模型往返和重复输出，尚不能归因于 Python 比 JavaScript 更快。

CloakHub 当前每轮断连有明确目的：开放 CDP 连接会阻止 idle sleep。若加入任务级 REPL，需要分别定义执行器寿命和 CDP 连接寿命；任务结束、超时或取消后释放连接。若浏览器睡眠、重启或崩溃，旧 page/session 对象失效，即使 REPL 还活着也不能继续使用。可先保存 JSON/checkpoint 与 helper 文件，再决定是否值得引入常驻执行器。[本地 README](../README.md)、[客户端 skill](../skills/cloakhub-browser/SKILL.md)

### 3. 沉淀站点操作经验

把成功任务中的稳定选择器、分页方式、等待条件和已验证的数据接口记录成可复用 recipe，可减少下一次探索。Browser Use 官方文章介绍了任务后提炼 URL pattern 与 recipe、依据失败反馈更新和淘汰的机制。这属于它的技能学习路线，不能据此声称开源 1.0 自动具备整套云端技能系统。[Web Agents That Actually Learn](https://browser-use.com/posts/web-agents-that-actually-learn)

对 CloakHub，可从用户自己的少量重复站点开始：记录适用 URL、验证日期、前置条件、失败后重新探索的方式。不要把账号数据、token 或偶然抓到的响应写进通用 recipe。helper 应放在任务或用户工作目录，验证后再纳入共享工具；无需让 agent 在任务中修改服务端核心。

## 接入层面要知道的差异

1.0 仍支持 `Browser(cdp_url=...)`，所以远程 CDP 是值得试验的连接路径；但没有做过 CloakHub 端到端验证。迁移文档明确写 `headers` 尚不支持 WebSocket handshake，不能照搬旧版通过自定义 header 认证的样例。还需要验证 tab 清理、断连与 stop 行为、下载路径、已有 profile 和多客户端相互影响。

`Browser()` 默认改成 Browser Use Cloud，模型默认走其 gateway；要测试 CloakHub 必须明确提供外部 CDP 与选定模型。官方要求用 `==` 固定版本。REPL 执行模型代码使用当前用户权限，secret 脱敏和域名规则不是完整沙箱；若未来提供多人执行服务，执行器隔离应另行设计。这不是单纯把一个 Python REPL 放进浏览器容器就能完成的接入。来源：[1.0.0 迁移指南](https://github.com/browser-use/browser-use/blob/1.0.0/MIGRATING.md)。

## 建议验证顺序

先保持现有架构，以相同模型、相同任务、等价初始 profile 对比现有短脚本和任务级 REPL。挑选真实重复任务：登录后的列表采集、筛选与分页、上传下载、复杂 iframe、需要人工接管的流程。重复运行并记录实际完成情况、模型调用数、token/费用、总耗时、恢复次数和清理后能否正常 idle sleep。

只有确认持久执行状态带来收益，再实现可选任务会话。Playwright 与 raw CDP 的比较应作为另一个变量单独测试，避免同时更换模型、执行方式和浏览器后把收益全部归因于 CDP。此次仅完成研究记录，未改动运行代码。
