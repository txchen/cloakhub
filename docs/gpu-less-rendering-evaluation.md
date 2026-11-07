# 无 GPU 部署的渲染配置评估

日期：2026-11-03 UTC。

## 决策建议

**无 GPU 支持必须保留，但不需要等同于固定使用 `--disable-gpu` 和 SwiftShader。** 当前验证更支持：有头模式优先让浏览器选择渲染后端，镜像保留软件渲染所需的 Mesa/EGL/GBM 依赖和 KasmVNC。

本次只评估，没有修改 `src/`、Dockerfile 或生产服务，也没有发布新镜像。正式切换默认值前，还需要在可用授权下补齐 156 的 Hub 级验收，以及验证发布镜像中的其他 binary 版本。

## 实际测试环境

使用生产同款 `ghcr.io/txchen/cloakhub_free:0.8.3`，binary 为 `152.0.7977.82.1`。这是现有修改版 free artifact，不作为官方 152 binary 的结论。精确 image ID 保存在结果 JSON。

为每个变体创建独立容器，从镜像提取 launcher，只替换有头模式那组图形参数，通过只读文件挂载注入临时测试容器；镜像的其他代码、字体、默认 macOS persona 均不变。不调用官方 wrapper，不借用生产 profiles。

每个容器均验证：

- 没有 `/dev/dri` 或 `/dev/nvidia0`。
- Docker `Devices`、`DeviceRequests` 为空，`Privileged=false`。
- 不挂载宿主显示 socket 或 GPU。
- 4 CPU 配额、2 GiB `/dev/shm`。

因此通过结果不是宿主物理 GPU 加速带来的。

## 变体及结果

所有变体的无头启动逻辑保持不变。下表列的是有头参数变化。

| 变体 | 参数 | 152 端到端验收 |
|---|---|---|
| legacy | 原四个参数 | 通过，反向复测也通过 |
| auto | 不添加四个参数 | **通过，反向复测也通过** |
| angle | `--use-gl=angle --use-angle=swiftshader` | 通过 |
| no_disable_gpu | 上述两个，加 `--disable-dev-shm-usage` | 通过 |
| only_disable_gpu | 仅 `--disable-gpu` | **失败：有头 WebGL context 不可用** |

原四个参数是 `--disable-gpu --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader`。

每个通过的变体都完成：

1. 默认 macOS 有头和无头 profile 的 WebGL1/2 shader 编译、link、真实三角形绘制、readPixels。中心像素为 `[0,255,0,255]`，GL error=0。不是只检查 renderer 字符串或 clear。
2. 每种模式停止后再启动，重复绘图，验证 localStorage 持久化。
3. 通过真实 Hub noVNC 页面连接，读取远端画布像素：CSS 绿块与 WebGL 红块颜色正确。
4. 通过 VNC 鼠标点击远端按钮，读取页面产生的结果。
5. 通过 viewer 粘贴中文，读取远端 input 实际值。

失败的 only_disable_gpu 变体在有头绘图断言处停止，没有继续执行其 VNC/无头步骤；不能把未执行项记为失败或通过。

## 浏览器实际上选择了什么

反向复测采集 browser-level CDP `SystemInfo.getInfo`，而不是只看网页中被 persona 改写的 GPU 名称：

| 模式 | auto | legacy |
|---|---|---|
| 有头 | ANGLE OpenGL，Mesa **llvmpipe**，LLVM 15.0.6 | ANGLE Vulkan，**SwiftShader** |
| 无头 | ANGLE Vulkan，SwiftShader | 相同 |

llvmpipe 和 SwiftShader 都是 CPU 软件渲染，不需要物理 GPU。`hardwareSupportsVulkan=false`，也与无 GPU 设备的容器条件一致。

这里最重要的区分是：

- **没有物理 GPU** 不等于要禁用浏览器的 GPU 服务。
- 浏览器的 GPU 进程也可以执行 CPU 软件渲染。
- 强制禁用 GPU、强制后端和共享内存设置是三种不同决策，不应作为一个不可分割的“Docker 必需组合”。

SystemInfo 的部分无头 featureStatus 显示 unavailable_software，但 shader 实测成功。因此验收以真实绘图和像素结果为准，不把状态标签直接当成功能失败。也不根据同一份状态信息声称硬件视频解码或 WebGPU 已验证。

## 与 156 结果如何结合

此前在相同系列镜像中直接跑官方 wrapper，156 默认有头可以绘图；加入旧参数组合则失败。配置逐项实验中，默认有头图形路径也能完成 IPHey；使用正确 Mac fontconfig 后 tampering=false。见 [156 配置隔离](156-configuration-isolation.md)。

但以下事实不能忽略：

- 156 默认无头仍在本环境出现 Vulkan/SwANGLE 初始化失败。删除有头参数不修复这个独立问题。
- 本次官方 license 校验仍返回 valid=false，不能重跑 156 的真实 Hub/noVNC 验收；未绕过校验。
- 不能根据 152 通过就宣称 156 所有功能通过，也不能将 wrapper 默认有头成功等同于完整 Hub 集成成功。

## 推荐的后续变更范围

1. 将有头默认候选设为 **auto**，不强制添加旧四参数组合。此次 152 结果证明该候选不会天然失去无 GPU 能力。
2. 保留镜像中 Mesa 软件栈、EGL/GBM 依赖、字体和虚拟显示。不要一边改参数一边删除依赖。
3. 保留 Compose 的 shm 配额。`--disable-dev-shm-usage` 是资源/兼容策略，不是图形后端修复；本次 2 GiB shm 下无需它，并不代表 64 MiB 或高并发也安全。
4. 不自动改已有 profile 的 headed/headless 模式，不在故障时偷偷换后端。切换后端可能改变渲染指纹和资源消耗，本次未测反检测、长期稳定性或性能优劣。
5. 将“无 GPU + shader 绘图 + noVNC 像素/输入 + 重启”作为每个要发布的 binary 的验收要求。不能只看端口可连接、进程没退出或页面宣称的 GPU 名称。
6. 授权恢复后补测 156 的 auto Hub 路径，并继续定位无头问题，再决定是否发布默认参数变更。当前生产 152 保持原样。

本次没有加入配置开关或自动版本分支，避免在证据不足时固化新的兼容规则。

## 证据与复现

- [精简结果](evidence/gpu-less-rendering/results.json)
- [编排脚本](evidence/gpu-less-rendering/run.py)
- [验收脚本](evidence/gpu-less-rendering/check.mjs)
- [本地页面](evidence/gpu-less-rendering/fixture.mjs)

从仓库根目录，先把这三个脚本复制到 `.cloakhub/gpu-less-evaluation/`。该目录需有从被测镜像提取的 `launcher-original.ts`：

```sh
docker create --name cloak-gpu-inspect ghcr.io/txchen/cloakhub_free:0.8.3
docker cp cloak-gpu-inspect:/app/src/browser-process-launcher.ts .cloakhub/gpu-less-evaluation/launcher-original.ts
docker rm cloak-gpu-inspect
python3 .cloakhub/gpu-less-evaluation/run.py
python3 .cloakhub/gpu-less-evaluation/run.py --repeat
```

脚本需要本地 `@playwright/test` 和 `/opt/google/chrome/chrome`，后者仅作为 noVNC 控制客户端，不是被测浏览器。只对专用临时容器执行，不要改成生产地址。脚本会删除自己创建的容器及匿名卷。原始日志与截图保留在忽略目录；本次所有测试容器已删除，生产服务未修改。
