# 最终验收核对记录（SPEC §16 / §17）

> 核对对象：`docs/SPEC.md`（启动哈希 SHA-256
> `288b285fe3bc106761798d3283b0e7e7ec2218603796dac0c41e11546099360b`，全程未改动）。
> 核对日期：2026-08-04。代码基线：分支
> `apex-coding-agent/RUN-d8399e33-5b67-4847-97ec-ceda15f4def3`（TASK-001～014 全部提交）。
> 结论分三类：**机器已核**（本次或既有自动验证留有可复现证据）、
> **验收人员显式执行**（§15.2 定义的显式启动设施，步骤见
> [验收运行手册](./ACCEPTANCE-RUNBOOK.md)）、**产品验收人确认**（§15.3 视觉基线）。

---

## 1. 全量回归（机器已核）

干净环境依次执行，全部退出码 0：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过（lockfile 与 package.json 一致，无需变更） |
| `pnpm build` | 通过（tsc -b + vite build；产物见 §3 审计） |
| `pnpm lint` | 通过（oxlint + 架构依赖方向检查） |
| `pnpm test` | 通过（38 个测试文件 / 618 个测试全部通过） |
| `pnpm check:arch` | 通过（60 个源文件无违规，SPEC §12 依赖方向） |

复跑方式：`pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm test && pnpm check:arch`（单条命令链，任一失败即中断非 0）。

## 2. 单元测试覆盖率证据（SPEC §15.1，机器已核）

`pnpm test --coverage`（v8 provider）实测，§15.1 要求的四个层级分支覆盖率均 ≥90%：

| 层级 | 分支覆盖率 | 语句 | 函数 |
| --- | --- | --- | --- |
| domain | **100%**（117/117） | 100% | 100% |
| application | **100%**（36/36） | 100% | 100% |
| infrastructure（含 worker/builders） | **100%**（172/172） | 100% | 100% |
| rendering/core | **100%**（70/70） | 100% | 100% |

补充：rendering/scene 纯函数几何模块（floor/building/exterior/map instanceGeometry）分支 100%，
labels 目录分支 93.61%，rendering/resources 分支 96.88%；React 组件壳（Canvas/Layer tsx）
按 §15.2 划分由显式浏览器用例覆盖，不属于 §15.1 覆盖率口径。
覆盖率产物为临时文件，核对后已删除；复跑 `pnpm test --coverage` 即可重现。

## 3. 生产包审计（SPEC §2 / §10.1 / §14，机器已核）

`pnpm build` 产物清单（哈希随构建变化）：

```
dist/index.html
dist/assets/index-*.js            主包（含 three/R3F/drei，gzip ≈318 kB）
dist/assets/index-*.css
dist/assets/mapBuild.worker-*.js  Worker chunk（type:module，主包懒加载引用）
dist/map.json                     运行时数据（public/ 拷贝）
dist/favicon.svg                  页面图标（index.html 引用）
```

逐项结论：

| 审计项 | 结论 | 证据 |
| --- | --- | --- |
| GLTF 资源 | **无** | `dist/` 无 `.gltf`/`.glb` 文件；`public/` 仅 `map.json` 与被 index.html 引用的 `favicon.svg`，无 `public/models/` |
| 模型加载器封装 | **无** | dist 产物 `GLTFLoader`/`useGLTF`/`DRACOLoader`/`KTX2Loader` 计数均为 0；dist 中唯一含 "gltf" 的字符串是 three 核心动画插值 API 名 `isInterpolantFactoryMethodGLTFCubicSpline`（three 核心库内部标识，非加载器） |
| 空未来功能目录 | **无** | `src/`、`tests/`、`scripts/`、`docs/` 无空目录；§14 各扩展方向（RobotLayer/InteractionLayer/主题切换等）均未提前建目录或占位模块 |
| 未使用依赖 | **无** | 16 项依赖逐一核对：6 项 dependencies（react/react-dom/three/@react-three/fiber/@react-three/drei/@types/three）与 10 项 devDependencies 均被源码、配置或脚本引用（@types/node 由 tsconfig.node/tests 的 `types:["node"]` 消费，@vitest/coverage-v8 由 `--coverage` 消费，oxlint 由 lint 脚本与 `.oxlintrc.json` 消费） |
| 开放版本范围 | **无** | `package.json` 全部 16 项为精确版本（无 `^`/`~`/范围符）；`pnpm-lock.yaml` importers 段 specifier 与 version 完全一致；`pnpm install --frozen-lockfile` 通过即 lockfile 未漂移 |
| 测试设施隔离 | **通过** | dist 产物 `PerformanceHarness` 与 `__FACTORY_MAP_TEST_BRIDGE__` 计数均为 0；harness 独立构建到 `dist-harness/`（已 gitignore），`pnpm build/lint/test` 不经过 playwright.config.ts |

## 4. §17 验收清单逐条核对

| # | 清单项 | 结论 | 证据 / 指向 |
| --- | --- | --- | --- |
| 1 | package.json 与 lockfile 使用 §2 精确版本，无开放版本范围，生产包无未使用的未来功能依赖 | **机器已核** | 本文件 §3 审计表；§2 版本表逐项一致（react 19.2.8 / three 0.185.1 / fiber 9.6.1 / drei 10.7.7 / vite 8.1.5 / typescript 6.0.3 / vitest 4.1.10 / @playwright/test 1.62.1 等） |
| 2 | 唯一 API 信封可加载；所有非法契约按 §11 显示稳定错误码/字段路径，不降级、不部分渲染 | **机器已核** | `domain/decodeMapEnvelope.test.ts` 覆盖 §3.3 规则表每行（code 非 200/信封缺失/非法类型/控制点组合/重复 id/失效引用/容量/空图等）；基准 `public/map.json`（1767 节点/3043 边/878 反向边）全量解码构建通过（Worker 集成测试）；`presentation/errorViewModel.test.ts` 覆盖 §11 九类错误展示；状态机测试断言错误不产生部分 SceneModel、进入新一轮加载即卸载旧模型。**人工指向**：错误态页面观感按手册「人工核对动线 · 错误态」核对 |
| 3 | 初始相机 45° 斜视，厂房三维 bounds 的 8 个角全部位于 NDC 内；基准 16:9 距离约 189.2m | **机器已核** | `rendering/core/fitPerspectiveCamera.test.ts`：16:9/4:3/32:9 三画幅 8 角经 three PerspectiveCamera 投影 \|x\|≤1、\|y\|≤1；基准地图 16:9 距离 `toBeCloseTo(189.2, 1)` 并锚定旧二维公式 143.13m、断言新距离 > 旧值+40m 拒绝回退；220m×220m 上限地图 4:3 距离 ≈348.73m ≤ ORBIT_MAX_DIST=350 |
| 4 | 节点四种合法类型颜色和几何正确；非法类型被解码器拒绝 | **机器已核** | `builders/buildNodeInstances.test.ts`（disk r0.10/ring 外 0.15 内 0.09、24 段、instanceColor 三站点色）；`config/config.test.ts` 钉死 §7.3 四色（#78909C/#2196F3/#8BC34A/#F44336）；`decodeMapEnvelope.test.ts` 非法 type → `MapValidationError`（`MAP_NODE_TYPE_INVALID` + `nodes[i].type`）。观感以 §15.3 视觉基线为准（产品验收人确认） |
| 5 | 站点朝向与 angle 一致（东 0°、北 90°），angle=null 不画；普通 node 不画朝向 | **机器已核** | `domain/coordinates.test.ts`：`yawFromMapAngle` 东 0°/北 90°/规范化 [-π,π)；`buildNodeInstances.test.ts`：directions 批次 `rotation.y=angle`、angle=null 不生成实例、仅 work/charge/park 进入；domain 不变量强制普通 node 的 angle 必须为 null（否则校验失败）。目测复核并入人工漫游 |
| 6 | 路径正向灰白、反向红；BEZIER 满足 0.01m 误差和 0.25m 最大段长测试，无可见裂缝/尖刺 | **机器已核 + 人工观感** | `builders/buildPathBatches.test.ts`：De Casteljau 自适应细分同时满足弦误差 ≤0.01m 与段长 ≤0.25m、深度 16 超限抛 `MapGeometryError`；miter join（MITER_LIMIT=2）超限退化 bevel，断言无裂缝/无无限尖角；颜色钉死 #C9CAC6/#E57373（config 测试）。**人工指向**：「无可见裂缝/尖刺」的观感经视觉基线与漫游核对 |
| 7 | 对向共线路径在初始全景、35m 近景、polarAngle=80° 低视线各持续观察 30 秒，无 z-fighting 闪烁 | **验收人员显式执行（人工观察）** | 防闪机制已机器核对：§4.3 高度分层（正/反向带 0.004/0.008m）与 polygonOffset 双保险（units -2/-4、factor -1）由 MapSceneResources 测试钉死。三机位 30 秒观察步骤见手册「人工核对动线 · z-fighting」 |
| 8 | 方向箭头沿弧长每 6m 居中重复，朝向始终由起点指向终点；<1m 路径无箭头 | **机器已核** | `buildPathBatches.test.ts`：L<1.0m 不放箭头；n=max(1,floor(L/6))、首个位置 (L-(n-1)×6)/2 严格 6m 居中；yaw=atan2(Δy,Δx) 起点→终点；isBackEdge 仅决定批次/高度层不改方向 |
| 9 | 标签满足迟滞、视锥、类别保留名额和不透明厂房遮挡；任意距离下 DOM 标签总数 ≤300；初始全景无标签 | **机器已核** | `labels/selectVisibleLabels.test.ts`：三类迟滞（90/95、40/44、25/28 含边界等号）、视锥过滤、(distanceSquared,id) 稳定排序、保留名额 120/120/60 与补足、全局 ≤300、内部 Raycaster 只对 labelOccluders（实墙/墙柱/主梁/檩条，玻璃不遮挡）、attach/detach 差分；`tests/browser/css2d-lifecycle.spec.ts`：初始全景无标签（最近距离 >90m）、35m 近景出现且 ≤300、容器恰 1 个。**人工指向**：遮挡观感漫游复核 |
| 10 | Orbit 可旋转/缩放/平移，target Y 恒为 0 且 XZ 不越过厂房边界外扩 20m，视线不能进入地面以下 | **机器已核（参数与夹取）+ 人工操作** | `rendering/core/orbitTargetClamp.test.ts`（XZ 夹取内边界外扩 20m、Y 恒 0）；`config/config.test.ts` 钉死 §9.2 六参数（damping 0.08、dist 3/350、polar 5°/80°、screenSpacePanning=false）。**人工指向**：实际拖拽/滚轮/平移操作按手册漫游步骤核对 |
| 11 | 页面与 CSS2D 无对象点击、悬停、右键响应；内部标签遮挡 Raycaster 不暴露交互 | **机器已核 + 人工确认** | 静态扫描 src 无 R3F 对象事件注册（PageStateView 的 onClick 属 §1.4 要求的 DOM 重试/刷新按钮）；MapLayer/FactoryLayer 根 group `raycast=()=>false`（两测试钉死）；CSS2D 容器与标签 `pointer-events:none`（适配器测试）；遮挡 Raycaster 仅持有 labelOccluders 引用、不挂事件。**人工指向**：页面上实际点击/悬停/右键确认无响应 |
| 12 | 实墙没有覆盖玻璃带，透过玻璃和开放屋顶可见天空/外景/雾；玻璃无阴影和错误深度遮挡 | **机器已核 + 人工观感** | `building/buildingGeometry.test.ts`：三段墙 0~4/4~6.5/6.5~8，玻璃带后方无不透明几何；玻璃五参数（transparent/opacity 0.35/depthWrite=false/DoubleSide/renderOrder=10）且不投影；`roofFrameGeometry.test.ts`：仅主梁+檩条，无屋面板。**人工指向**：视觉基线机位 3（polarAngle=80° 低视线）专核玻璃透视与雾 |
| 13 | 地图主 pass 7、厂房主 pass 9、阴影 caster 4；完整帧 renderer.info.render.calls ≤25 | **机器已核（结构）+ 验收人员显式执行（运行期）** | 结构：`MapSceneResources.test.ts` 断言 7 批次（路径 Mesh×2 + InstancedMesh×5）；`FactorySceneResources.test.ts` 断言 8 mesh + drei Sky = §6.7 主 pass 9 批次；castShadow 恰为实墙/墙柱/主梁/檩条 4 个。运行期：`pnpm test:perf` 逐帧断言 `maxDrawCalls ≤25`（含阴影 pass），由验收人员在参考机器显式执行 |
| 14 | 空图、仅节点、断网、HTTP、坏 JSON、坏信封、坏字段、容量超限、Worker/WebGL 失败均进入规定状态 | **机器已核 + 人工抽查** | 状态机判别联合 idle/loading/preparing/ready/empty/error 全转换测试（`factoryMapPageState.test.ts`）；空图 → empty（60×40m bounds、「暂无地图数据」）与仅节点 ready 有测试；断网/HTTP/坏 JSON/坏信封/坏字段/容量超限由 HttpMapRepository、mapBuildRunner、decodeMapEnvelope 测试覆盖并经 errorViewModel 展示；Worker 崩溃/终止由 WorkerScenePreparer 测试覆盖；WebGL context lost 由 `tests/browser/context-lost.spec.ts` 自动化核对（WEBGL_CONTEXT_LOST、不自动恢复）。**人工指向**：手册「错误态」给出断网/404/坏 JSON/空图的 dev 复现步骤供抽查 |
| 15 | 连续装卸 10 次后 WebGL/CSS2D/Worker/监听器资源回到基线，无重复容器和增长资源 | **验收人员显式执行** | `tests/browser/resource-baseline.spec.ts`：连续 10 次装卸后 `renderer.info.memory` 回首次卸载基线；`pnpm test:perf` 指标⑥同口径断言且 CSS2D 容器数为 0。各 owner dispose 幂等性另有单测（MapSceneResources 20 项/FactorySceneResources 两级生命周期/EnvironmentResource/Css2dLabelRendererAdapter） |
| 16 | §10.2 两阶段 4K 测试分别满足 p95 ≤33.3ms、p99 ≤50ms，报告包含完整环境与数据哈希 | **验收人员显式执行** | `pnpm test:perf`（tests/perf/performance.spec.ts）：PerformanceHarness 预热 10s → 全景 30s → 近景 30s，六项指标全部断言；报告自动写入 `tests/perf/reports/perf-report-*.json`，含硬件/浏览器完整版本/WebGL renderer 字符串/commit/数据 SHA-256/每项原始结果/质量口径快照。性能结论仅在 §1.3 参考硬件上有效 |
| 17 | 三张视觉基线经产品验收人确认，后续截图与基线不存在未批准的结构、材质或配色变化 | **产品验收人确认** | `pnpm test:visual` 固定捕获 3840×2160 三机位（初始全景/35m 近景/polarAngle=80°）到 `tests/visual/baseline/` 并附 manifest.json（环境/WebGL renderer/数据 SHA-256/实际位姿）；PNG 尺寸经 IHDR 断言。确认流程见手册「视觉基线确认」 |

## 5. §16 M0–M5 里程碑证据映射

| 里程碑 | 准入条件 | 已通过的验证（证据） | 对应提交 |
| --- | --- | --- | --- |
| M0 工程基线 | 依赖锁定；架构依赖检查通过；`pnpm build/lint/test` 通过 | package.json 16 项精确版本 + pnpm-lock.yaml（frozen install 通过）；`scripts/check-architecture.mjs`（含 `--self-test` 负例自测，12 项违规全检出）；全链退出 0 | `1d99c09` |
| M1 数据与状态机 | §3 和状态机测试全过；错误不产生部分 SceneModel | domain 解码/不变量/坐标/bounds 测试；application 状态机与用例测试；HttpMapRepository 流式/上限/超时/中止测试；Worker 协议/runner/构建器测试（runner 断言错误路径不产生部分模型）；四层分支覆盖率 100% | `6d757fb` `ccd024d` `ee53ce5` `24cb15d` `5fd279c` |
| M2 厂房与相机 | 厂房 9 批次；相机 NDC 测试全过；空态可漫游 | FactorySceneResources 8 mesh + Sky = 9 批次测试；fitPerspectiveCamera 三画幅 8 角 NDC + 189.2m 测试；empty 态 60×40m bounds 随模型渲染空厂房（页面/控制器测试），CameraRig 对 empty 同样 fit 可漫游 | `5b84bc7` `eb72f37` `e1cf285` `3108d79` |
| M3 地图图层 | 地图 7 draw call；自适应曲线与实例测试全过 | MapSceneResources 7 批次结构测试；buildPathBatches（LINE/BEZIER 细分约束/miter/bevel/箭头规则）与 buildNodeInstances/instanceGeometry 顶点断言测试全过 | `24cb15d` `b2546f1` |
| M4 标签层 | 遮挡、迟滞、稳定排序、DOM 300 上限和完整清理通过 | selectVisibleLabels 迟滞/视锥/排序/保留名额/遮挡/300/差分测试；Css2dLabelRendererAdapter DOM 池 ≤300、unmount 完整清理（StrictMode 幂等）测试 | `bed0c0d` |
| M5 质量与验收 | §10、§15.2、§15.3、§17 全部通过 | §10.1 预算结构测试 + PerformanceHarness 六项指标设施就绪；§15.2 五个浏览器用例（tests/browser）；§15.3 三机位截图设施（tests/visual）；§17 逐条核对见本文件 §4。其中浏览器/性能/视觉基线与展厅实测由验收人员按手册显式执行并确认 | `e1cf285` `3108d79` `125ea31` + 本终验提交 |

> 里程碑按序通过：M0→M5 的提交链即实施顺序；§15.2 定义的显式验收项不构成
> 代码门禁（`pnpm build/lint/test` 不启动浏览器），其执行责任在验收人员，
> 本仓库交付的是流程就绪与全部机器可核证据。
