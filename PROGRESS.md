# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-01

任务书版本：`TASKS.md` v2.1

规格版本：`SPEC-20260901-agv-3d-monitor` v1.4

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `IN_PROGRESS` |
| 当前 Task | `TASK-005 地图业务语义图层` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `4 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 将 TASK-005 改为 `IN_PROGRESS` 后，实现 59 充电桩（可关闭呼吸灯）、1,185 仓库地面标识与合批名称、2 停车符号、7 独占区蓝色外沿与近景名称，以及无效成员隔离与资源对称释放 |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx`，领先远端 2 个提交（TASK-003、TASK-004 待推送） |
| HEAD | TASK-004 实施提交（TASK-003 提交之后） |
| 未提交差异 | 无（工作区干净；TASK-004 已随提交完成） |
| 用户输入 | `docs/SPEC_20260901_agv-3d-monitor.md`、原型图、`json/map.json`、`json/vehicle.json` 无差异 |

每个 Task 开始和结束时以实际 `git status --short --branch` 为准，并直接更新本节当前值；不得恢复旧状态或把差异写成历史日志。

### 2.2 当前实现

- 应用骨架可启动、可构建：`src/main.tsx` 以 StrictMode 挂载 `src/app/App.tsx`；App 只装配唯一 `100vw × 100dvh` 的 R3F Canvas（显式 `ACESFilmic` 色调映射），持有启动状态并组合 `src/app/scene/AgvMonitorScene.tsx`。
- TASK-002 运行时配置与部署基线：`src/app/bootstrap/loadRuntimeConfig.ts`、`src/shared/diagnostics`、`src/shared/validation`、部署链（`vite.config.ts` `base: './'`、`copyStaticAssets`、`verifyDist`、`smoke:dist`）。
- TASK-003 统一坐标、地图校验与不可变 MapModel：`src/shared/spatial`（仿射与世界坐标）、`validateMap`（逐项隔离）、`createMapModel`(索引/分量/包围盒)、`services/loadMap.ts` 稳定错误码；`bootstrapApplication` 产出 `mapModel`/`worldTransform`。
- TASK-004 已完成可运行核心地图场景与恢复生命周期：
  - `scene/buildMapGeometry.ts`：按「正/反向点对逆序坐标序列取字典序」的归一化几何签名去重，当前地图 9,265 条逻辑边 → 5,068 条物理路径（3,351 LINE / 1,717 BEZIER，4,197 条重复几何），保留逻辑边→物理路径完整映射；BEZIER 复用 24 段采样，中心线段 44,559；输出世界坐标静态合批几何（路面条带 BufferGeometry + 中线 LineSegments）与 4,291 节点的实例矩阵/颜色数据；`dispose()` 幂等释放自建 GPU 几何。
  - `scene/mapAppearance.ts`：清屏色、地坪/网格/路径/节点颜色与图层高度阶梯等视觉常量的唯一事实源。
  - `scene/createSceneEnvironment.ts`：RoomEnvironment+PMREM 环境工厂，采样后释放房间场景，句柄幂等释放 render target 与生成器。
  - `components/GroundLayer.tsx`：按地图包围盒加 10m 边距一次生成工业地坪（MeshStandardMaterial，receiveShadow）与 5m 网格刻线；bounds 更换时整体重建并释放旧对象。
  - `components/PhysicalPathsLayer.tsx`：路面 Mesh + 中线 LineSegments 两个 Draw Call；只拥有材质，几何归 MapGeometry 所有。
  - `components/NodesLayer.tsx`：唯一 InstancedMesh 渲染全部节点，实例颜色按类别（work/warehouse/charge/park/unknown 兜底），矩阵与颜色静态上载一次。
  - `hooks/useMapVisualization.ts`：场景侧地图生命周期——优先消费 bootstrap 种子直接建模（不重复拉取 14.94MB）；mapUrl 变化触发刷新；失败按指数退避（1s→30s 封顶）后台重试且可取消；已有场景时刷新失败保留旧场景，恢复后单次 setState 原子替换，旧几何在新视图提交后由所有权 effect 释放；StrictMode 重复执行以 sourceUrl 幂等。
  - `components/MapVisualizationFeature.tsx`：公开根组件——清屏底色常驻、方向光（阴影相机按包围盒静态配置）+ 环境工厂注入（失败降级无 IBL 并记诊断）、组合三个图层与临时 45° 初始取景（TASK-013 相机 Feature 接入后移除）。
  - app 接线：`App.tsx` 运行 `bootstrapApplication`（AbortController + 退避重试 1s→30s；`CONFIG_*` 失败为终态保持清屏色，地图阶段失败自动重试），就绪后以稳定描述符（含 bootstrap 种子）传入场景；`AgvMonitorScene` 组合 `MapVisualizationFeature` 并透传描述符。
- 工具链齐备：`@/ -> src/` 别名三处一致；脚本含 `lint/typecheck/test:unit/test:architecture`；Vitest（jsdom + Testing Library + `@react-three/test-renderer`）、dependency-cruiser 均已接入。
- 真实浏览器行为不走自动化测试套件：涉及用户行为或浏览器生命周期的验证由执行 Task 的 Coding Agent 调用浏览器自动化技能在真实浏览器中自测，结论记入本文件第 5 节。
- 架构检查（`pnpm test:architecture`）以 `.dependency-cruiser.cjs` 规则校验真实 `src`（70 模块 0 违规），负例证明深层导入、核心 Feature 互导、受限公开入口、反向依赖和循环依赖必被抓到。
- 快速 CI 已建立：`.github/workflows/ci.yml` 执行 lint、typecheck、unit、architecture、build。
- 尚无仓库/充电/停车地标与独占区语义层（TASK-005）、车辆模型与车队运行时（TASK-006/010）、Mock、WebSocket、相机交互、质量控制或后台/WebGL 恢复实现；对应实现分属后续 Task。

### 2.3 当前数据输入

| 项目 | 当前值 |
|---|---:|
| 节点 | 4,291 |
| work / warehouse / charge / park | 3,045 / 1,185 / 59 / 2 |
| 逻辑边 | 9,265 |
| LINE / BEZIER | 5,963 / 3,302 |
| 物理路径 | 5,068（3,351 LINE / 1,717 BEZIER，TASK-004 已实现去重并锁定集成测试） |
| 反向重复几何 | 4,197 |
| 中心线段 | 44,559（LINE×1 + BEZIER×24） |
| 独占区 | 7（成员 25～32 节点 / 70～199 边，当前全部引用有效） |
| 弱连通分量节点数 | 2,001 / 1,187 / 796 / 307，每个分量均含充电站 |
| 死路拓扑 | 存在 1 个无出边 work 节点（名称「44」），Mock 须安全停车 |
| 当前车辆位置 | 与节点名称“1644”相距约 0.000042m |
| 当前车辆状态 | `TRAFFIC_WAIT`、`LOW_BATTERY`、loaded |
| 当前交通四边形 | locked 1 个、applying 3 个，均为有效凸四边形 |

## 3. 工程 Task 状态

| Task | 当前任务名称 | 真实依赖 | 状态 |
|---|---|---|---|
| TASK-001 | 工程、单 Canvas 与自动验证基线 | 无 | `DONE` |
| TASK-002 | 运行时配置、诊断、静态资源与部署基线 | 001 | `DONE` |
| TASK-003 | 统一坐标、地图校验与不可变 MapModel | 002 | `DONE` |
| TASK-004 | 可运行核心地图场景与恢复生命周期 | 003 | `DONE` |
| TASK-005 | 地图业务语义图层 | 004 | `TODO` |
| TASK-006 | 车辆领域模型、事件合同与车队运行时 | 001、002 | `TODO` |
| TASK-007 | WebSocket 数据源与 React 生命周期 | 006 | `TODO` |
| TASK-008 | Mock 拓扑、运动与充电内核 | 003、006 | `TODO` |
| TASK-009 | Mock 数据源、确定性场景与启动接线 | 007、008 | `TODO` |
| TASK-010 | AGV 程序化模型、槽位与实例批渲染 | 004、006、009 | `TODO` |
| TASK-011 | 图集化 WebGL 车辆标签 | 010 | `TODO` |
| TASK-012 | 选择、告警环与交通资源表达 | 010、011 | `TODO` |
| TASK-013 | 相机、车辆跟随与完整交互 | 004、010、012 | `TODO` |
| TASK-014 | 自适应质量与质量能力接线 | 005、011、012、013 | `TODO` |
| TASK-015 | 后台节流与前台瞬时对齐 | 009、010、013、014 | `TODO` |
| TASK-016 | WebGL 上下文丢失与恢复 | 005、010、011、012、014 | `TODO` |
| TASK-017 | 启动编排、失败恢复与跨 Feature 回归 | 007、009、013、015、016 | `TODO` |
| TASK-018 | 性能基准、指标采集与针对性调优 | 017 | `TODO` |
| TASK-019 | 稳定性压力工具与短时故障注入 | 018 | `TODO` |
| TASK-020 | 当前交付文档、部署样例与完整 CI | 017、018、019 | `TODO` |
| TASK-021 | 真实 WebSocket 协议联调 | 007、017、外部协议资料 | `WAITING_EXTERNAL` |

## 4. 当前 Task 工作卡

| 字段 | 当前内容 |
|---|---|
| Task | `TASK-005 地图业务语义图层` |
| 状态 | `TODO` |
| 当前目标 | 核心地图增加全部充电、仓库、停车和独占区语义，形成完整可读的静态地图 Feature |
| 当前主要范围 | LandmarksLayer、ExclusiveGroupsLayer、地图专属 WebGL 名称资源、外观常量、MapVisualizationFeature 接线和共置测试 |
| 当前已有实现 | TASK-004 的 MapModel/WorldTransform/buildMapGeometry/三图层/灯光环境/生命周期 Hook 均就绪；`MapModel.components`、`groupList`、`nodes` 索引可直接支撑地标与独占区查询 |
| 当前待完成 | 以 `TASKS.md` 的 TASK-005 为准实现 59 充电桩与可关闭呼吸灯、1,185 仓库地面标识与合批名称、2 停车紫色符号、7 独占区低透明蓝色外沿与成员 bounds 中心近景名称；无效成员逐项隔离；全部名称为 WebGL 内容；资源对称释放 |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-014（部分依赖）、后续车辆与交互 Task（按各自依赖） |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| Lint | `pnpm lint` | 通过（69 文件，0 警告 0 错误） |
| TypeScript | `pnpm typecheck`（`tsc -b`） | 通过 |
| 单元测试 | `pnpm test:unit`（Vitest + jsdom，14 文件 126 例：TASK-002/003 全部保留，新增 buildMapGeometry 去重与几何、useMapVisualization 生命周期（种子/加载/退避重试/旧场景保留/原子替换/取消/StrictMode）、MapVisualizationFeature 场景组合与资源释放、当前地图物理路径集成断言） | 通过（126/126） |
| 当前地图集成 | `currentMap.integration.test.ts`：数据事实全部保留；新增 5,068 物理路径（3,351 LINE / 1,717 BEZIER）、4,197 重复几何、44,559 中心线段、映射覆盖 9,265 逻辑边无遗漏、静态几何规模（路面 4 顶点/段、中线 2 顶点/段）、节点「1644」实例矩阵与世界坐标一致、几何可幂等释放 | 通过 |
| 架构检查 | `pnpm test:architecture`（真实 src 70 模块 0 违规；负例全部命中；正例零误报） | 通过 |
| 构建 | `pnpm build`（含 `copyStaticAssets` 与 `verifyDist`） | 通过 |
| dist 校验 | `pnpm verify:dist`（index/config/map 存在、相对路径引用、白名单与凭据检查、map.json 可解析） | 通过 |
| 部署冒烟 | `pnpm smoke:dist`（根路径 `/`、子路径 `/monitor/`、模拟配置失败 `/broken/` 三挂载 HTTP 冒烟） | 通过 |
| 差异检查 | `git diff --check` | 通过（无空白错误；仅 CRLF 提示） |
| 浏览器自测 | Coding Agent 调用浏览器自动化技能（内嵌 Chromium，1280×720）访问 `pnpm dev`：唯一全屏 Canvas（CSS 与绘制缓冲均 1280×720）、无滚动、无任何 DOM 覆盖层；`config.json` 与 `/json/map.json`（全量 14.94MB）均经真实 HTTP 200 加载并走完 bootstrap → loadMap → 建模 → 几何构建链路；强制渲染帧内像素采样 57,438/57,600（99.7%）为场景内容（非清屏色）；rAF 帧内 `toDataURL` 取证截图确认 45° 俯视下工业地坪、网格刻线、深灰物理路径网络与蓝绿/浅黄节点群完整可见 | 通过 |

浏览器自测备注：内嵌浏览器面板在宿主窗口后台时节流 `requestAnimationFrame`，页面只呈现清屏色且 Canvas 停留在初始尺寸；标准截图命令会强制一帧使 R3F 应用 1280×720 全屏尺寸，但截图管道在节流页面上可能卡死。本轮改用「rAF 回调内同步 `readPixels`/`toDataURL`」完成取证，与 TASK-002/003 记录的环境节流现象一致，不影响真实部署浏览器。

本节只保留当前 Task 的最终有效验证状态。重跑后直接替换结果；失败被修复后删除已失效的失败描述，不追加验证流水账。

## 6. 当前外部条件与 Gate

| 项目 | 当前状态 | 当前所需条件 |
|---|---|---|
| TASK-021 真实 WS | `WAITING_EXTERNAL` | 真实消息样例或 Schema、协议版本、鉴权、snapshot 方式、端点或正式录制夹具 |
| GATE-001 性能 | `NOT_READY` | TASK-018 完成，并提供符合 SPEC §6.1 或已证明不低于该组合的验收环境 |
| GATE-002 24h | `NOT_READY` | TASK-019 完成，并提供连续 24h 窗口及报告空间 |
| GATE-003 全量交付 | `NOT_READY` | 21 个工程 Task 全部完成，GATE-001 和 GATE-002 均通过 |

当前主机是 Windows 11、Intel Core i5-14500、Intel UHD Graphics 770、约 15.7GB 内存，同时存在虚拟显示驱动。当前没有足够证据把该环境直接认定为 SPEC §6.1 的正式验收环境，因此它可以用于开发和性能冒烟，不能单独把 GATE-001 标为通过。

## 7. 当前文档维护要求

- 本文件只保存当前状态，不保存交接历史、验证历史、决策历史或已失效基线。
- 状态、代码、Git 差异、外部条件或 Gate 结果变化时，直接替换对应内容并删除旧结论。
- 需要追溯修改过程时使用 Git；不得在本文件中通过不断追加行或章节记录过程。
