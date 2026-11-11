# Pi + gpt-6-luna：CloakHub skill 与 Browser Use CLI 实测

2026-11-10。已实际调用本机 Pi 的现有认证，无需额外 API key。此前仅检查环境变量后认为无法跑模型实测，是检查不完整。

## 范围与结论

这次比较 **Pi + CloakHub skill** 与 **Pi + Browser Use 1.0.0 官方 CLI/skill**，共同连接同一个已有的真实 CloakHub profile（本地标识不公开）。不是 Browser Use `Agent` 引擎、ultrafast 模式或其云端产品的评测。CLI 不能代表完整 Agent 的持久 Python REPL、模型循环与截图回传实现。

下表对应历史安装版 skill，部分文件哈希与当前仓库不同，不是当前 HEAD 的性能承诺，具体边界见文末。

在一种“三页库存汇总并提交表单”任务的三个数据变体上，我们没有显示劣势。默认 Browser Use 遇到前台标签页适配问题，补充环境提示后可执行，但有一次汇总错误。结果不能推广到网站总体成功率，更不能说我们已击败 Browser Use。

| 方案 | 正确提交 | 平均总耗时 | 中位耗时 | 平均模型请求 | 平均估算模型费用 |
| --- | --- | --- | --- | --- | --- |
| Pi + CloakHub skill | 3/3 | 42.56 s | 42.15 s | 8.0 | $0.002353 |
| Pi + Browser Use CLI，默认 skill | 0/3 | 69.16 s | 72.55 s | 14.33 | $0.003721 |
| Pi + Browser Use CLI，补充前台提示 | 2/3 | 58.60 s | 54.30 s | 11.33 | $0.002457 |

以上均包括失败运行与 skill 阅读。`model_calls` 按 Pi 的已完成 assistant 消息计数，不是独立抓取的 provider HTTP 请求／重试次数。费用取 Pi usage 的模型目录估算（非 provider invoice），包含缓存 token 的估算；不包括浏览器/代理/机器成本。样本小、缓存预热与提供商延迟未严格控制，费用差约 4% 没有可宣称的意义。补充提示轮是发现失败后的诊断，不能冒充预注册独立对照。

## 任务和评分

每个变体有 12 行库存、每页 4 行。模型必须浏览三页，把“库存 > 0 且价格 <= 50”的库存求和，填写 reference 和 total，勾选确认，点击保存并验证完成。三组数据随机种子固定为 810、811、812，期望总数分别 43、19、25。每组两方案使用相同数据、不同任务 URL，各自新进程无聊天历史；先后顺序交替。

任务没有给正确数值或解题脚本。禁止直接 HTTP、读测试服务器文件、读取页面脚本变量、跳过分页，以及用 JS 修改 DOM/应用状态。允许读取渲染 DOM 和正常输入/点击。服务端独立校验 **恰好一次** 提交且 reference、total、confirmed 全部正确。模型说“Review saved”不等于业务结果正确。

Pi 1.5.0，`openai/gpt-6-luna`，`--thinking medium`，工具仅 read/bash，关闭自动扩展、MCP、skill/context 文件发现，显式让每组阅读对应 skill。每次运行预算 180 秒。Browser Use 1.0.0，browser-harness 0.1.13，独立 Python venv；域名技能、录制和 tab marker 关闭。两边都使用已有 profile，未替换浏览器或启动付费云实例。

## 失败分析

1. **默认 BU 的三次失败**：反复点击 Next 后仍停在第一页，最终明确报告未完成。我们的 skill 明确要求指针操作前 bringToFront；官方 BU skill 默认鼓励后台操作，仅在明确请求或发现页面停止渲染时激活。
2. **单独诊断**：只增加“该 CloakHub 仅前台渲染，明确要求先 activate_tab(current_tab())”的说明，未提供答案。三次均能翻页与提交，支持前台适配是主要操作障碍的解释，不能证明它是唯一因素。
3. **诊断第 2 次业务错误**：期望 19，实际提交 17。模型填写并确认保存成功，却没有检出汇总错误。其日志显示逐页读取后直接输入 17；这不是浏览器提交失败。
4. **我们也不是零错误执行**：第三轮曾用不合适的文本拆分读取表格，随后改用逐 cell 提取重新计算，最终提交正确。比较的是最终可核验结果，不是工具调用无报错。

补充后的逐轮耗时：BU 52.75 / 54.30 / 68.74 秒；CloakHub 41.87 / 42.15 / 43.66 秒。

## 基础设施与限制

初始远程浏览器无法访问测试机 LAN 地址，产生 ERR_ADDRESS_UNREACHABLE；该轮隔离保存，未计入表格。之后用同一条 Playwright request route 将测试 origin 转发到本机 fixture 服务。页面仍由真实远程浏览器渲染，模型执行实际点击和输入，服务端收取真实提交；两边使用相同转发，但它改变了网络条件，不能代表真实网站延迟和反爬表现。

模型可能阅读了不同长度的技能文档，这是原样产品工具组合比较的一部分。没有测视觉推理、跨域 iframe、下载、账号登录、验证码、反检测或故障恢复。没有比较去掉 session 的旧 skill，因此不能把结果归因于刚新增的持久会话。没有统计显著性结论。

## 复现与证据

- [证据说明、安全运行步骤及限制](evidence/pi-browser-comparison/README.md)。
- [参数化执行脚本](evidence/pi-browser-comparison/run.py)及[合成 fixture](evidence/pi-browser-comparison/fixture.html)：默认只校验配置；必须 `--execute` 才调用模型和浏览器。
- [请求转发](evidence/pi-browser-comparison/bridge.js)：仅转发保留测试域／回环 origin 到本机回环 fixture，完成后断连释放 route。
- [版本与 skill 哈希](evidence/pi-browser-comparison/metadata.json)：本机路径已换成逻辑名称，另记录历史 harness 的原始哈希。
- [默认结果](evidence/pi-browser-comparison/results.json)、[前台诊断结果](evidence/pi-browser-comparison/foreground/results.json)、[不计分的基础设施失败](evidence/pi-browser-comparison/infra-failure/results.json)。只对基础设施失败的文本做了测试 origin 脱敏，数值与评分未改。
- [精简事件证据](evidence/pi-browser-comparison/compact-events.json)：只保留调用计数、工具名称、用量和原日志哈希，不含提示词、模型思考、命令参数或工具输出。

**重放边界：** 这是历史安装版 skill 的实验，记录的 `SKILL.md`、`session.mjs`、`references/sessions.md` 哈希与整理时仓库版本不同；不能把这些数字当作当前 HEAD 的性能承诺。公开脚本是实验之后的参数化、安全整理版本，未重新运行真实 agent 对照。其业务 fixture 与评分目标延续原实验，但不声称字节级或成本／时延重现。

原始 `.jsonl`、本机原始 harness 和第三方 skill 文本快照留在本地并被 Git 忽略。第三方快照的许可／再分发条件没有在本次整理中核实，所以不随仓库发布，仅保留哈希；复测需自行取得有权使用的固定版本 skill。精简日志能核对计数，不能独立证明每次 UI 行为或提示词约束遵从，故详细失败归因仍依赖未公开的原始记录。

新脚本要求显式配置两个客户端指向同一个**专用测试 profile**并确认，不再默认连接个人 profile；检查不等于自动验证映射或权限隔离。模型代码仍以当前用户权限执行，提示词约束不是安全沙箱。超时会停止后续矩阵，需检查残留页面、会话和可能尚未完成的提交，不得自动重放写操作。历史试验结束时已断开转发、停止 BU daemon，并确认没有遗留测试页面或 session worker；这不等于新脚本已通过相同端到端验收。

## 决策

当前无需为了宣传倍率替换 skill。更有价值的是把明确的前台要求、结构化数据计算和业务结果验证做好。下一轮若要讨论整体差距，应扩展到不同任务类型，并单独运行 Browser Use `Agent` 引擎；当前 CLI 小样本不能代替那一层结论。
