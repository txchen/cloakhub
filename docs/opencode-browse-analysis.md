# OpenCode Browse 与 CloakHub：借鉴判断

研究日期：2026-11-07。检查官方产品页、README 和源码，Browse 快照为 `d1c8374aa65de8e3d7232558fb398338f03ee5be`。没有安装扩展或进行端到端对比，因此不推断成功率、性能或反检测优劣。

## 结论

值得借鉴交接和任务管理，不值得照搬浏览器架构。Browse 把用户电脑上的现成浏览器交给 agent；CloakHub 把持久身份浏览器放在服务器上，供远程客户端访问。两者共享登录态、Playwright 和人工介入需求，但解决的是不同部署问题。对 CloakHub，最有价值的增量是“人接手后如何可靠恢复任务”，其次才是 MCP 接入。

## 已核实的差异

| 维度 | Browse | CloakHub | 判断 |
| --- | --- | --- | --- |
| 浏览器位置 | 用户本机，复用现有浏览器及扩展 | Linux 服务器，持久 profile、代理和指纹配置 | 保留 CloakHub 核心 |
| 控制链路 | MCP/CLI → 本地 relay → 扩展 chrome.debugger；execute 使用 Patchright | skill/Playwright → 远程 CDP gateway → CloakBrowser | 无需加入扩展和 relay |
| 人工接管 | 指定 session/tab 的 handoff，Continue 后恢复 | 已有实时 viewer，可手工登录 | 借鉴显式交接协议 |
| 多任务 | session、agent tab 管理、借出和收回 tab | 同 profile 客户端共享 tabs 和登录态 | 先做任务归属，不能声称安全隔离 |
| 生命周期 | 管理 agent tabs 与 session | idle 停浏览器，保留磁盘状态但关闭 tabs | handoff 必须与 idle 联动 |
| 诊断 | status、doctor、日志、HAR、录屏 | 已有 check、observe、detectChallenge、captureResponses 等 | 改善统一结果，不重复开发 |

来源：[Browse README](https://github.com/anomalyco/browse/blob/d1c8374aa65de8e3d7232558fb398338f03ee5be/README.md)，本地 [README](../README.md)、[CDP gateway](../src/cdp-gateway.ts)、[浏览器生命周期](../src/browser-runtime.ts)、[客户端脚本](../skills/cloakhub-browser/scripts/browser.mjs)。

## 最值得借鉴：交接是协议，不只是打开 viewer

Browse 的 [HandoffRegistry](https://github.com/anomalyco/browse/blob/d1c8374aa65de8e3d7232558fb398338f03ee5be/cli/src/session-manager/handoff.ts) 将交接绑定 session、tab、target 和唯一 id，区分 resolved、timeout、target detached/crashed、session stopped。它还处理“用户完成点击与启动动作同时发生”的竞态。这些设计比一个“等待用户”的提示更值得参考。

建议 CloakHub 首期做 profile 级任务租约，记录交接原因、目标 tab、过期时间、浏览器实例代次；viewer 显示待处理动作及 Continue/Cancel。等待人工时阻止 idle shutdown，完成、取消、超时释放租约；显式 Stop/Restart 仍可操作，但令交接失效，不能自动恢复旧 target。使用管理端认证完成交接，CDP token 不应同时获得人工确认权限。

这属于建议，当前未实现。仅在 skill 中暂停是协作约定，不能阻止别的原始 CDP 客户端继续操作；若承诺独占，必须在 gateway 层覆盖连接和命令。首期可明确只支持一个合作任务，避免马上实现复杂的多 session CDP 虚拟化。

验收应覆盖：交接期间超出 idle 时间仍存活；Continue 恢复正确 tab；Cancel 不继续；重启后旧 Continue 无效；第二个任务看见占用状态。

## 第二优先：任务归属与可诊断性

现在的 [tab close guard](../src/cdp-tab-guard.ts) 保护最后一个 tab，避免浏览器退出；它不定义 tab 属于哪个任务。可先在客户端记录任务创建的 target ids，清理只关闭这些 tabs，人工已有 tabs 必须显式选择。不要将此描述为隔离：共享 profile 仍共享 cookies/storage。

Browse 的 [CDP guardrails](https://github.com/anomalyco/browse/blob/d1c8374aa65de8e3d7232558fb398338f03ee5be/cli/src/cdp/guardrails.ts) 对危险命令、cookies 和所谓只读 session 有专门逻辑。但源码允许 Runtime.evaluate/callFunctionOn，明确说明 CDP 没有只读 evaluation。因此不能照搬一个“read-only”标签就承诺无副作用。

CloakHub 已有多项诊断工具。优先统一结果：当前 profile/tab、挑战类型、是否需要人工、viewer 链接、下一步操作；之后再按真实排障需求添加可选 HAR/录屏和保留期限。无需一次性复制 Browse 的 secrets、录制、journal 子系统。

## 权限策略可以学，但不能夸大边界

Browse 的 [navigation guard](https://github.com/anomalyco/browse/blob/d1c8374aa65de8e3d7232558fb398338f03ee5be/cli/src/session-manager/navigation-guard.ts) 在 agent 导航前检查域名；对链接、重定向、脚本导航采用观察后停止或置空，源码明确承认请求可能已发出。图片、fetch、iframe、worker 等子资源不受此 allowlist 限制。因此它是导航约束，不是完整的网络隔离或数据防泄漏。

CloakHub 若增加允许站点，先明确约束语义和 CDP 绕过路径。当前 profile CDP token 可选的行为应在 UI 明确展示；任务级权限不是在 Playwright helper 加判断即可成立。对个人可信 agent，这不是首期必须重构的理由；对多人或不可信 agent，服务端授权和独立 profile 应优先于新工具数量。

## 暂不借鉴

- 本机扩展、配对、本地 relay：解决本机浏览器接入，不能改善 CloakHub 的远程持久浏览器主场景。
- 默认后台 tabs：CloakHub 客户端已有指针渲染与前台 tab 的限制，应先验证后台输入、截图与挑战页，不能照抄“后台不打扰”。
- 替换 CloakBrowser 为 Patchright：两者覆盖的行为及指纹层不同，未做同条件测试，没有替换依据。
- 全套 MCP：现有 skill/CDP 能完成任务。只有用户确实需要仅支持 MCP 的客户端，再加薄适配层，复用连接和任务逻辑。
- 自动更新浏览器：保持现有固定构建和镜像版本策略；浏览器升级涉及身份与 profile 兼容性。

## 建议顺序与必要性

1. **优先做小规模交接闭环**：如果登录、2FA、验证码需要人工是常见阻塞，收益直接，必要性最高。
2. **按并发需求加任务归属**：单人单任务可以延后；多个 agent 共用 profile 时价值明显。
3. **统一诊断及安装检查**：扩展已有 check/observe，减少连接失败和挑战页面上的来回沟通。
4. **有明确用户需求再做 MCP、站点策略、录屏**：不要因竞品具备就一次性加入。

无需给“借鉴百分比”：功能清单与代码量不能衡量适配度。实际值得搬的是少数交互和生命周期设计，主体架构继续保留。源码 [LICENSE](https://github.com/anomalyco/browse/blob/d1c8374aa65de8e3d7232558fb398338f03ee5be/LICENSE) 为 MIT；若实际复制代码，应保留对应声明，并单独核对引入依赖的许可证。
