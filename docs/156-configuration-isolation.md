# 156 配置逐项对照

日期：2026-11-03 UTC。目标是区分原部署配置与新版 binary 的问题，而非宣称所有场景都修复。

## 方法

同一 `cloakhub:0.9.0` 镜像、官方 156.0.8078.47.1 Linux x64 binary、Bun 1.3.14，直接使用官方 `cloakbrowser@0.7.0` 与 `playwright-core@1.64.1`。不启动 CloakHub，不通过 Hub CDP 连接。容器限 4 CPU、2 GiB shm；有头用 KasmVNC，所有测试串行、独立 browser/profile，无代理。

逐项设置：默认 launch；加入固定 seed 20260909；再加 macOS persona；再设置 FONTCONFIG_FILE=/app/macos-fonts.conf；最后加入旧的四个图形参数：`--disable-gpu --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader`。

默认组使用 wrapper 随机 seed 和默认 Windows persona，其结果不能与固定 seed 组作严格单变量数值比较。字体组只切换 fontconfig，镜像中的字体文件未增删。未额外设置 locale、timezone、屏幕等 Hub 参数，不能称为完整复原 Hub 启动配置。

## 已完成结果

每行一组，不是统计样本；页面可能随时间变化。

| 模式与配置 | WebGL/2 | tampering / anti-detect | VM | IPHey |
|---|---|---|---|---|
| 有头默认 | 正常 | true / true | true | 完成，70 / Unreliable |
| 有头固定 seed，默认 Windows | 正常 | true / true | true | 完成，70 / Unreliable |
| 有头 macOS，系统 fontconfig | 正常 | true / true | true | 完成，90 / Unreliable |
| 有头 macOS，Mac fontconfig | 正常 | **false / false** | true | 完成，90 / Unreliable |
| 上一组加旧四个图形参数 | **null / null** | false / false | true | 未完成 |
| 无头默认 | null / null | true / true | true | 未完成 |
| 无头固定 seed，默认 Windows | null / null | true / true | true | 未完成 |

所有完成的 Fingerprint 观测均为 bot=not_detected。该镜像不是完整 Windows 字体环境，wrapper 给出缺字体警告，所以默认 Windows 的 tampering 不能作为推荐环境也失败的证据。

### 可以修正的判断

1. **有头图形失败与旧参数组合有关。** 固定 seed、macOS persona 和字体配置不变，默认图形路径可用，加旧四个参数后失败。尚未拆分四个参数，不能断定是其中哪一个。
2. **macOS 有头 tampering 受字体配置影响。** 系统 fontconfig 为 true，Mac fontconfig 为 false；两组 WebGL 都正常。这是配置相关证据，而不是 156 必然被识破。
3. **IPHey 完成性与本次图形配置变化同向。** WebGL 正常的四组都完成，旧图形参数和两组无头均未完成。尚未隔离具体内部错误，不能断言 GPU 是唯一因果链。完成也只是 Unreliable，并非全部通过。
4. **VM 标记仍存在。** 七组都为 true，包括 WebGL 正常、tampering=false 的 macOS 有头组。因此“恢复 WebGL 就会去掉 VM”不成立。也未证明这是浏览器 bug；宿主环境、虚拟显示、渲染性能和服务端判据仍未排除。
5. **156 macOS 无头新增 tampering 尚未完成配置隔离。** 不能拿默认 Windows 无头结果替代 macOS 对照。

## 阻塞与运行限制

原先单进程连续跑矩阵在完成前三组后停滞，工具超时后确认没有浏览器进程残留，停止专用容器。后续改为每组独立进程及超时限制。

后三组无头 macOS、Mac fontconfig、额外图形参数均被 `CloakBrowserLicenseError` 阻止。等待后重试仍失败；官方 `/api/license/validate` 返回 HTTP 200、valid=false、plan=free。未确定是过期、撤销还是其他账户状态，不把它归为浏览器或反检测失败。无头 seed 组紧邻授权失败，站点未完成还应保留可能受会话状态影响的限制。

未绕过授权，未更换他人 key。测试容器均已退出删除，生产服务未改动。

## 证据及后续

[精简矩阵结果](evidence/config-matrix-156/results.json)保留观测值，无 key、token、IP 或原始访客标识。执行脚本和日志位于 `.cloakhub/issue636-repro/config-matrix.mjs` 及同目录 `config-matrix/`。

授权恢复后优先完成后三组；再对四个图形参数逐一隔离，并在图形正常的配置下对比 152/156。当前可操作方向是试用官方默认有头图形路径和正确的 Mac fontconfig，但不在本次实验中直接修改生产默认值。
