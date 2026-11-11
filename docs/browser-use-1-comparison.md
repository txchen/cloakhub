# Browser Use 1.0 与 CloakHub + skill：差距在哪里

背景见[发布解读与最初设计分析](browser-use-1-analysis.md)。后续已完成 [同 Pi / gpt-6-luna 的 CLI 小样本实测](pi-browser-comparison.md)，与完整 Browser Use Agent 对比仍需区分。

核查日期：2026-11-10。这是当时的实现分析快照，不是自动跟随上游更新的功能清单；整理入库未重新核验外部发布页。Browser Use 固定为 `1.0.0`，CloakHub 一侧包括当时新增的任务会话。本文是官方源码与本地实现比较，不是同模型 A/B 实测。之前真实 profile 的十项检查是执行器功能与生命周期验收，不能称为十个 agent 任务全部成功。

## 判断

目前没有证据支持“我们落后多少百分比”，也没有证据支持“加了 session 就与它持平”。两者共有的基础能力已经接近：agent 编写通用代码、远程 CDP、可复用运行状态。明显差距集中在浏览器专用 agent 运行闭环、截图回传、结构化成果、失败恢复和评测，而不是 Python 与 JavaScript 的区别。

比较对象必须说全：Browser Use 提供模型调用到最终结果的完整 `Agent`；CloakHub 提供远程持久浏览器，skill 提供客户端工具，真正做决策和上下文管理的是宿主 agent。因此“Browser Use vs CloakHub”本身不是同层比较，应该是“相同模型的 Browser Use Agent vs 宿主 agent + CloakHub skill”。后者的上下文压缩、模型重试、视觉能力可能已由宿主提供，不能因为 skill 没实现就说整个方案没有。[Agent 源码](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/agent/service.py)、[本地 skill](../skills/cloakhub-browser/SKILL.md)

## 具体差异

| 方面 | Browser Use 1.0 | 当前 CloakHub + skill | 差距判断 |
| --- | --- | --- | --- |
| 自由编程 | Python cell 与 CDP/helpers | JavaScript 与完整 Playwright，可自行用 CDP | 同一方向，无法从抽象层直接推断性能 |
| 持久执行状态 | cell 在同一个 Python namespace 编译执行，普通变量和定义自然延续 | 每轮新建 AsyncFunction；仅 `state` 对象及其引用显式延续，普通局部变量不延续 | 我们是持久会话，不是完整语言 REPL；易用性有差别 |
| 观察与动作 | 可选 ultrafast accessibility-tree id helpers；按需截图自动作为图片回给模型 | aria/局部 observe、网络提取、Playwright locator；截图文件需要宿主另行查看 | 我们可完成相似操作，但视觉路径步骤更多，尚无同条件评分 |
| 结果与记录 | Agent 管理 steps、usage、messages、结构化结果与 workspace | session 返回 ok/output/error；任务完成与费用由宿主管理 | 缺统一可比较的浏览器任务记录 |
| 执行超时 | 父进程关闭失效 worker，反馈结构化错误；下次调用可启动新 worker，文件与浏览器状态保留 | deadline 后整个 session 退出，客户端收到连接中断；需新 session 和重新发现 tabs | 我们恢复体验明显更原始 |
| 输出与检查点 | cell 输出文件、截图、显式 checkpoint，截断可引用完整文件 | 输出截断到 65,536 字符；未自动保存被截断部分，检查点需脚本自行写文件 | 长采集与失败诊断有实际差距 |
| 文件传输 | 官方整合本地和其云浏览器的工作区与下载结果 | 可按字节上传；远程 CDP 下载回客户端未保证 | 我们缺经过验证的端到端下载体验；其云能力也不能推定在任意外部 CDP 等价可用 |
| 持久身份与运维 | 支持本地 profile、其云 profile，也可用外部 CDP | 自托管 profile、稳定 CDP URL、viewer、休眠与唤醒 | CloakHub 的明确价值；Browser Use 可以作为其上层客户端，并非只能二选一 |

依据：[worker.py](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/repl/worker.py)、[session.py](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/repl/session.py)、[service.py](https://github.com/browser-use/browser-use/blob/1.0.0/browser_use/agent/service.py)、[迁移指南](https://github.com/browser-use/browser-use/blob/1.0.0/MIGRATING.md)、本地 [session.mjs](../skills/cloakhub-browser/scripts/session.mjs)、[文件传输说明](../skills/cloakhub-browser/references/operations.md#files-across-two-machines)、[README](../README.md)。表中“差距判断”是基于实现的分析，不是实测排名。

我们的真实测试发现同步死循环可拖住同 profile 其他客户端直到 watchdog 结束。独立进程能回收执行器，并不等于共享浏览器上的行为隔离。Browser Use 有独立父子进程和 daemon，但本次未运行同样压力场景，不能宣称它一定没有此问题。[本地实测记录](evidence/skill-sessions/README.md)

## 宣传数字不能回答我们的差距

原帖的大幅改善比较旧 0.x 与 1.0，并没有 CloakHub 这一组。更接近现代代码执行路线的是官方 release 对 Browser Use Pi 的比较：同模型、60 个任务各 3 次；排除模型服务故障后，评分差为 +1.1，95% 区间 [-3.2, +5.7]，不支持显著评分提升。费用差 -$0.013/任务、时间差 -114 秒/任务。这说明对照对象会大幅改变结论；仍然不能把 Pi 当作 CloakHub 的替身。[官方发布说明](https://github.com/browser-use/browser-use/releases/tag/1.0.0)

该 release 的当前表格是 `ultrafast` 原始 62.5 vs Pi 56.3，且明确解释原始差距受 provider outage 影响。之前笔记记载的另一组数字不可与此表混用。评分也不是二元任务成功率；自报 `is_successful()` 不是外部验证。费用应同时注明模型、浏览器、代理是否计入。[发布说明](https://github.com/browser-use/browser-use/releases/tag/1.0.0)、[结果字段定义](https://github.com/browser-use/browser-use/blob/1.0.0/MIGRATING.md#the-result-agenthistorylist)

## 怎样真正测出差距

分两层，避免混淆“工具能力”和“agent 决策”：

1. **执行层对比**：同一个 CloakHub 浏览器构建、等价初始状态，分别使用 skill 和 Browser Use 的 browser-harness/helpers，预先给定等价脚本；比较连接、定位、截图、上传下载、超时恢复。没有模型参与，只能说明执行器能力与开销。
2. **任务层对比**：同模型版本、reasoning、预算、初始任务说明，让两边自主完成任务。Browser Use 使用外部 CDP；skill 由选定宿主 agent 调用。固定版本、记录模式，默认/ultrafast 分开报告。不要把预写正确脚本称作 agent benchmark。

起步可选 6 类真实任务，各重复 3 次，共每组 18 次：筛选分页提取、跨页合并去重、iframe 表单草稿、SPA 动态状态、上传后验证、下载后解析。再加入需要视觉判断和人工介入的任务作单独分组。每次使用等价测试账号/数据与新任务 tab，清除前次任务经验或同时提供相同 recipe；同 profile 顺序执行，避免互相暂停标签页。不可把熟悉网站的一方与首次探索的一方混为同条件。

使用独立可验证的标准：精确字段和行数、最终页面状态、生成文件内容；完成率按任务二元计，部分完成评分另列。记录总 wall time、模型请求数、输入/输出/cache token、费用、人工介入、误操作、恢复次数、最终清理。包括失败运行的耗时和成本，不只计算成功样本。输出每个任务原始结果，再汇总中位数和分布；18 次只能初筛，不能证明普遍 SOTA。

若同一模型无法同时接入两边，应标注“用户可用方案的端到端比较”，不能归因于框架。本文初写时尚未开展模型任务实测；后续已使用 Pi 的既有认证完成[相同宿主／模型的 CLI 对比](pi-browser-comparison.md)，所以“不具备模型调用凭据”不再是该层试验的阻碍。但完整 Browser Use Agent 引擎与宿主 agent + skill 的任务层对照仍未完成，CLI 试验不能代替它。

## 最值得优先补的能力

1. **统一任务证据**：任务 id、调用耗时、结果摘要、完整输出文件和截图索引。先能解释失败，才知道应优化哪里。
2. **结构化超时与显式恢复**：将连接断开区分为超时/退出/浏览器丢失；反馈旧状态失效及已发生操作未知。恢复不得自动重放写操作。
3. **视觉与成果回传**：让 session 返回 screenshot/artifact 路径清单，宿主按需查看；保留长输出并支持读取局部。验证远程下载后再承诺支持。
4. **之后再优化 AX 与提示词**：用真实任务衡量 locator、AX id 与截图路线；不要为了贴近宣传先移除 Playwright。

这些是可验证的工程差距。是否最终任务做得更好、快多少、便宜多少，必须留给公平实测。
