# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-01

任务书版本：`TASKS.md` v2.1

规格版本：`SPEC-20260901-agv-3d-monitor` v1.4

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `IN_PROGRESS` |
| 当前 Task | `TASK-004 可运行核心地图场景与恢复生命周期` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `3 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 将 TASK-004 改为 `IN_PROGRESS` 后，实现地图几何构建、Ground/PhysicalPaths/Nodes 图层、灯光环境、资源所有权与地图恢复生命周期 |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx`，与远端一致 |
| HEAD | `b90bb8e`（TASK-002 及文档更新已提交） |
| 未提交差异 | TASK-003 实施（当前变更）：新增 `src/shared/spatial/**`（仿射与世界坐标）、`src/features/map-visualization/**`（model 校验/建模、`services/loadMap.ts`、公开入口与共置测试）；修改 `src/app/bootstrap/bootstrapApplication.ts` 与其共置测试（接入地图加载阶段并返回 MapModel/WorldTransform）；修改 `PROGRESS.md` |
| 用户输入 | `docs/SPEC_20260901_agv-3d-monitor.md`、原型图、`json/map.json`、`json/vehicle.json` 无差异 |

所有未提交差异均必须保留。每个 Task 开始和结束时以实际 `git status --short --branch` 为准，并直接更新本节当前值；不得恢复旧状态或把差异写成历史日志。

### 2.2 当前实现

- 应用骨架可启动、可构建：`src/main.tsx` 以 StrictMode 挂载 `src/app/App.tsx`；App 只装配唯一 `100vw × 100dvh` 的 R3F Canvas，场景内为 `src/app/scene/AgvMonitorScene.tsx` 组合锚点（业务 3D 对象属 TASK-004）。
- TASK-002 运行时配置与部署基线：`src/app/bootstrap/loadRuntimeConfig.ts`（`document.baseURI` 解析、严格白名单、稳定错误码、HTTPS-WS 策略）、`src/shared/diagnostics`（结构化诊断通道与 StructuredError）、`src/shared/validation`、部署链（`vite.config.ts` `base: './'`、`copyStaticAssets`、`verifyDist`、`smoke:dist`）。
- TASK-003 已完成统一坐标、地图校验与不可变 MapModel：
  - `src/shared/spatial`：业务无关二维仿射（顺序固定为镜像 Y → 旋转 → 缩放 → 平移，`transformAngle` 给出平面方向角合成）与 `WorldTransform`（`worldX=平面x−originX`、`worldZ=平面y−originY`、`rotation.y=−平面角` 的唯一符号换算点）。
  - `src/features/map-visualization/model/validateMap.ts`：根结构致命错误抛 `MAP_ROOT_INVALID`；其余逐项隔离——ID 为不透明字符串、`edgeType` 区分 LINE/BEZIER 且 LINE 控制点必须为 null、悬空引用剔除、重复 ID 首个生效、mapId 一致性冲突剔除、未知节点类型保留 `category='unknown'` 兜底、edges/groups/zones 缺失按空跳过；输出深度冻结并携带 `MapAnomaly` 列表。
  - `src/features/map-visualization/model/createMapModel.ts`：由校验数据一次性建立冻结只读 `MapModel`——node/edge/group 索引（ReadonlyMap）、有向出边（每节点有条目，无出边为空数组）、弱连通分量（并查集、节点数降序稳定编号、分量内 charge 查询、分量边计数）、`SceneBounds`（世界 AABB + 对角线）；世界原点只取节点平面包围盒中心经仿射后的点，顺序无关、一次定型。
  - `model/edgeGeometry.ts`：`BEZIER_SAMPLE_SEGMENTS = 24` 为全应用唯一离散化口径，物理长度 LINE 直线 / BEZIER 24 段折线。
  - `services/loadMap.ts`：mapUrl 以 baseUrl 解析，稳定错误码 `MAP_URL_INVALID`/`MAP_FETCH_FAILED`/`MAP_HTTP_STATUS`/`MAP_JSON_PARSE`/`MAP_ROOT_INVALID`；取消原样透传；逐项异常随结果返回由调用方上报。
  - `index.ts` 公开最小合同：`loadMap`/`validateMap`/`createMapModel` 与全部只读类型，供 app、后续 Mock 与相机 Feature 消费。
  - `bootstrapApplication` 接入 SPEC §10.3 阶段 3：config 成功后调用 `loadMap`（可注入），返回 `mapModel`/`worldTransform`/`mapUrl`；地图异常逐条写入诊断，阶段耗时写 `BOOTSTRAP_STAGE_DURATION`；地图失败上报一次后原样重抛，页面保持唯一清屏 Canvas（自动重试与旧场景保留归 TASK-004）。
- 工具链齐备：`@/ -> src/` 别名三处一致；脚本含 `lint/typecheck/test:unit/test:architecture`；Vitest（jsdom + Testing Library + `@react-three/test-renderer`）、dependency-cruiser 均已接入。
- 真实浏览器行为不走自动化测试套件：涉及用户行为或浏览器生命周期的验证由执行 Task 的 Coding Agent 调用浏览器自动化技能在真实浏览器中自测，结论记入本文件第 5 节。
- 架构检查（`pnpm test:architecture`）以 `.dependency-cruiser.cjs` 规则校验真实 `src`（54 模块 0 违规），负例证明深层导入、核心 Feature 互导、受限公开入口、反向依赖和循环依赖必被抓到。
- 快速 CI 已建立：`.github/workflows/ci.yml` 执行 lint、typecheck、unit、architecture、build。
- 尚无地图渲染组件、物理路径去重几何、车辆模型、Mock、WebSocket、相机、质量控制或恢复生命周期实现；对应实现分属后续 Task。

### 2.3 当前数据输入

| 项目 | 当前值 |
|---|---:|
| 节点 | 4,291 |
| work / warehouse / charge / park | 3,045 / 1,185 / 59 / 2 |
| 逻辑边 | 9,265 |
| LINE / BEZIER | 5,963 / 3,302 |
| 物理路径 | 5,068（3,351 LINE / 1,717 BEZIER，TASK-004 实现去重） |
| 反向重复几何 | 4,197 |
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
| TASK-004 | 可运行核心地图场景与恢复生命周期 | 003 | `TODO` |
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
| Task | `TASK-004 可运行核心地图场景与恢复生命周期` |
| 状态 | `TODO` |
| 当前目标 | 真实地图在唯一 Canvas 内显示工业地坪、去重物理路径（5,068 条）和全部 4,291 节点；地图首次失败保持清屏色，已有场景刷新失败时保留旧场景并自动恢复 |
| 当前主要范围 | 地图几何构建（`scene/buildMapGeometry.ts`）、Ground/PhysicalPaths/Nodes 图层、MapVisualizationFeature 根组件与 Hook、灯光与环境、资源所有权、app 组合接线及地图浏览器自测 |
| 当前已有实现 | TASK-003 的 `MapModel`/`WorldTransform`/`loadMap` 公开合同（4,291 节点、9,265 逻辑边、分量与出边索引、24 段贝塞尔采样口径均已就绪）；bootstrap 已产出 `mapModel`/`worldTransform`，AgvMonitorScene 仍为空锚点 |
| 当前待完成 | 以 `TASKS.md` 的 TASK-004 为准实现物理路径归一去重、静态合批几何、InstancedMesh 节点层、灯光/环境/色调映射、可取消加载重试与原子恢复，并接入场景渲染 |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-005、TASK-013（部分依赖）、TASK-010（待 006/009） |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| Lint | `pnpm lint` | 通过（58 文件，0 警告 0 错误） |
| TypeScript | `pnpm typecheck`（`tsc -b`） | 通过 |
| 单元测试 | `pnpm test:unit`（Vitest + jsdom，11 文件 94 例：TASK-002 配置/诊断/启动全部保留，新增 spatial 仿射与世界映射、validateMap 逐项隔离、createMapModel 索引/分量/仿射/冻结、loadMap 错误码、bootstrap 地图阶段，以及当前地图集成测试） | 通过（94/94） |
| 当前地图集成 | `currentMap.integration.test.ts`：4,291 节点、9,265 逻辑边（5,963 LINE / 3,302 BEZIER）、7 组成员全部有效、4 个分量 2,001/1,187/796/307 且均含充电站、零校验异常、节点「1644」坐标与类型正确、全部逻辑边物理长度为正有限值 | 通过 |
| 架构检查 | `pnpm test:architecture`（真实 src 54 模块 0 违规；负例全部命中；正例零误报） | 通过 |
| 构建 | `pnpm build`（含 `copyStaticAssets` 与 `verifyDist`） | 通过 |
| dist 校验 | `pnpm verify:dist`（index/config/map 存在、相对路径引用、白名单与凭据检查、map.json 可解析） | 通过 |
| 部署冒烟 | `pnpm smoke:dist`（根路径 `/`、子路径 `/monitor/`、模拟配置失败 `/broken/` 三挂载 HTTP 冒烟） | 通过 |
| 差异检查 | `git diff --check` | 通过（无空白错误） |
| 浏览器自测 | Coding Agent 调用浏览器自动化技能（真实 Chromium 内核，1280×720）访问 `pnpm dev` 开发服务器：唯一全屏 Canvas（CSS 与绘制缓冲均 1280×720）、无滚动、无任何 DOM 覆盖层；`config.json` 与 `/json/map.json`（全量 14.94MB）均经真实 HTTP 200 加载并走完 bootstrap → loadMap → 校验建模链路；页面保持清屏底色（TASK-003 不渲染几何）；截图取证 | 通过 |

浏览器自测备注：内嵌浏览器面板在宿主窗口后台时节流 `requestAnimationFrame`（首测 Canvas 停留在 300×150 初始值）；把面板置前并触发渲染帧后 Canvas 立即应用 1280×720 全屏尺寸，与 TASK-002 记录的环境节流现象一致，不影响真实浏览器部署。诊断通道的控制台输出无法经该自动化接口直接读取，其上报行为由单元测试覆盖。

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
