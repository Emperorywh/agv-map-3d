# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-01

任务书版本：`TASKS.md` v2.1

规格版本：`SPEC-20260901-agv-3d-monitor` v1.4

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `IN_PROGRESS` |
| 当前 Task | `TASK-008 Mock 拓扑、运动与充电内核` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `7 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 将 TASK-008 改为 `IN_PROGRESS` 后，实现固定种子、可复现的 Mock 仿真内核（四分量分配、有向 Dijkstra、LINE/BEZIER 弧长运动、寻充与死路安全停车），不创建计时器、React 或 Three 对象 |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx`，领先远端 5 个提交（TASK-003～TASK-007 待推送） |
| HEAD | TASK-007 实施提交（TASK-006 提交之后） |
| 未提交差异 | 无（工作区干净；TASK-007 已随提交完成） |
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
  - `components/MapVisualizationFeature.tsx`：公开根组件——清屏底色常驻、方向光（阴影相机按包围盒静态配置）+ 环境工厂注入（失败降级无 IBL 并记诊断）、组合地坪/路径/节点与 TASK-005 语义图层、临时 45° 初始取景（TASK-013 相机 Feature 接入后移除）。
  - 缺陷闭环（在 TASK-005 内完成）：R3F 对已挂载 `<primitive>` 换 `object` 的重建依赖「兄弟序列尾部」探测，与 `{cond ? <primitive/> : null}` 组合时重建被静默丢弃（实测复现）——各图层 primitive 补挂资源代/视图版本 `key` 强制走卸载/挂载路径，修复地图恢复原子替换后场景可能引用已释放几何的隐患。
- TASK-005 已完成地图业务语义图层：
  - `scene/mapNameAtlas.ts`：地图专属 WebGL 名称资源唯一入口——`layoutNameAtlas` 货架式纯函数排布（容量不足逐项丢弃隔离，画布高度取 2 的幂）、`collectMapNameLabels` 收集当前地图 1,193 条名称（1,185 仓库浅黄 + 7 独占区浅蓝 + 1 停车白色 P 字形）、`createMapNameAtlas` Canvas 工厂（无 2D 上下文抛 `MAP_NAME_ATLAS_UNAVAILABLE` 降级）、`buildNameQuadGeometry` 世界坐标静态合批名称四边形（一个 Draw Call）。
  - `scene/buildLandmarkData.ts`：单次遍历节点产出纯实例数据——59 组充电桩/光环/呼吸灯平移矩阵、1,187 块地面方垫矩阵（1,185 仓库浅黄 + 2 停车紫，颜色经 THREE.Color 与节点实例同口径）、1,185 仓库名称锚点与 2 停车锚点。
  - `scene/buildExclusiveGroupsGeometry.ts`：7 个独占区的成员物理路径去重合并为单个低透明蓝色外沿 BufferGeometry（高度 `EXCLUSIVE_OUTLINE_Y` 位于路面之下只露出边缘），名称锚点取成员节点世界包围盒中心（7 个）；幽灵节点/边引用逐项跳过（纵深防御），dispose 幂等。
  - `scene/semanticMaterials.ts`：MeshBasicMaterial + onBeforeCompile 两个补丁材质——名称距离淡出（仓库 30→70m、独占区 40→90m 平滑显隐，GPU 侧零 CPU 写入）与呼吸脉冲（uTime/uPulseEnabled uniforms，`decorationsEnabled=false` 时恒定全亮）；uniforms 创建即存在，useFrame 与测试可直接读写。
  - `components/LandmarksLayer.tsx`：方垫/立柱/光环/呼吸灯/名称各 1 个合批对象（5 个 Draw Call），实例数据静态上载一次；呼吸动画每帧只写 uniforms；图集缺失或名称 key 未入图集时名称 Mesh 整体不创建，地标其余部分不受影响。
  - `components/ExclusiveGroupsLayer.tsx`：外沿 1 Mesh + 分组名称 1 Mesh；外沿几何经 useMemo 构建并在卸载/视图更换时对称释放。
  - `hooks/useMapNameAtlas.ts`：名称图集单一所有者——随视图重建、StrictMode 安全、工厂失败降级为 null 并记录 `MAP_NAME_ATLAS_FAILED` 诊断。
  - `scene/mapAppearance.ts`：新增语义层外观常量（独占区外沿、充电桩/光环/呼吸灯、方垫、名称图集/文字/显隐区间），图层高度阶梯扩展至 `NAME_QUAD_Y`。
  - `decorationsEnabled` 为 MapVisualizationFeature props（默认 true），TASK-014 质量控制接入时由组合层显式传入。
- TASK-006 已完成车辆领域模型、事件合同与车队运行时（`src/features/fleet-monitoring/`，无 React 组件、无 GPU 对象、无网络连接）：
  - `data-source/contract.ts`：`VehicleDataEvent` 四类显式事件（snapshot/update/remove/heartbeat，含 schemaVersion/mapId/sequence/单调 receivedAt）、`VehicleDataSource` 幂等生命周期接口与 `SourceStatus`——Mock（TASK-009）与 WS（TASK-007）的共同合同。
  - `model/types.ts`：不可变 `VehicleSnapshot`（`Object.freeze`）；实体键 `(mapId, agvKey)` 长度前缀无歧义编码 `createVehicleEntityKey`；非法尺寸回退常量 `DEFAULT_VEHICLE_DIMENSION`；原始枚举/故障条目/交通四边形/速度原样保留或置 null。
  - `model/validateVehicle.ts`：单车隔离校验——整车仅因非对象或 agvKey 无法字符串化被拒（`VEHICLE_NOT_AN_OBJECT`/`AGV_KEY_MISSING`/`AGV_KEY_INVALID`，数字 agvKey String 化）；位置 x/y/theta 非有限置 `positionValid=false`；尺寸非正有限回退默认值并置 `dimensionValid=false`（二者经派生传播 INVALID_DATA）；localizationScore/电量/速度缺失置 null 不伪装正常。
  - `model/deriveVehicleState.ts`：connectivity 严格映射（非 ONLINE/OFFLINE 一律 UNKNOWN）；operation 固定优先级链 FAULT→PAUSED→CHARGING→TRAFFIC_WAIT→EXECUTING→IDLE→UNKNOWN；多告警并存（CRITICAL<15≤LOW<30 电量、定位<0.5、INVALID_DATA）；`projectDisplayState` 投影 STALE 冻结 > 断连深灰 > FRESH 业务色，STALE/断连保留最后已知业务状态副徽标。
  - `model/createFleetRuntime.ts`：不依赖 React 的高频运行时——普通 Map 持有实体（最新快照/静态维度/displayState/freshness/单调 lastReceivedAt），snapshot diff 产生 added/removed/updated（同 mapId 基线外删、重复键后到覆盖）、update 不隐式删除、remove 幂等、heartbeat 不刷新单车新鲜度；lastReceivedAt 只增不减；`tick(now)` 1Hz 只做 FRESH/STALE 跃迁；脏集合 pose/display/removed 按签名变化最小标记（`consumeDirty` 消费即清）；事件外壳非法整条拒绝并记 `FLEET_EVENT_REJECTED` 采样诊断；staleAfterMs/时钟/诊断可注入。
  - `model/fleetMonitoringStore.ts`：独立 zustand 低频 store——选中实体键（删除时立即清除）与活跃告警键集合（内容幂等，等价集合不通知）；高频快照/脏集合不进入 store，组件按窄 selector 订阅。
  - `index.ts` 公开合同：事件与数据源接口、快照与派生类型、实体键编码、`ReadonlyFleetRuntime` 只读查询视图；不导出可变实体表、脏集合与 store 实例。
- TASK-007 已完成 WebSocket 数据源与 React 生命周期（`src/features/fleet-monitoring/data-source/websocket/`、`hooks/`、`components/FleetRuntimeProvider.tsx`）：
  - `data-source/websocket/protocolAdapter.ts`：协议适配唯一边界——`WebSocketProtocolAdapter` 把任意 unknown 原始消息映射为恰一条归一化消息（车辆负载复用 validateVehicle，单车隔离）或携带稳定错误码（`PROTOCOL_*` 码表，TASK-021 复用）的 StructuredError，绝不抛异常；`createUnmappedProtocolAdapter` 为真实映射就绪前的默认实现，对一切消息显式拒绝（`PROTOCOL_UNMAPPED`）且无法表达快照请求（null→等待服务端推送），不猜测消息结构。
  - `data-source/websocket/WebSocketVehicleDataSource.ts`：VehicleDataSource 的 WS 实现（可注入 socket 工厂/时钟/随机源/诊断）——connect/disconnect 幂等（重复 connect 复用会话 promise；手动断开清理全部计时器进 CLOSED，绝不自动重连）；异常断开按 1/2/4/8s…30s 封顶 ×80%～120% 抖动退避、连接稳定 60s 重置级别；15s 无有效通道事件立即主动重连（不消耗退避）；连接代次（epoch）隔离旧 socket 全部回调；同连接只接受严格递增 sequence（重复/回退忽略并采样告警）；新连接首个 snapshot 落地前拒绝 update/remove 孤立增量（heartbeat 通行不建立基线），snapshot 落地即 OPEN 并结束重连周期；连续 10 次解码失败进 ERROR 终态停止重连（disconnect+connect 显式恢复）；AbortSignal 覆盖连接前/连接中/重连等待期三阶段取消。
  - `hooks/useVehicleDataSource.ts`：对称接线 Hook——挂载即订阅事件/状态 + 1Hz freshness ticker + 带 AbortSignal 的 connect，清理按相反顺序完整释放；options 经 ref 透传（内联回调不重建连接）；source=null 为合法稳态（状态 IDLE，静态地图照常）。
  - `hooks/FleetRuntimeContext.ts` + `components/FleetRuntimeProvider.tsx`：Feature 内部稳定 Context——Provider 生命周期内只创建一次 createFleetRuntime（useRef 惰性初始化），低频 status 进 React state、高频事件只写运行时；连接失败仅记 `VEHICLE_SOURCE_CONNECT_FAILED` 诊断，无任何连接 DOM。
  - app 接线：`bootstrap/selectVehicleDataSource.ts` 按 config.dataSource 选型（ws→绑定 mapId 的 WS 数据源，adapter/socketFactory 可注入；mock→TASK-009 实现前显式降级 null 并记 `DATA_SOURCE_UNAVAILABLE`）；`App.tsx` 就绪态携带 config/mapId 并 useMemo 构造数据源；`AgvMonitorScene` 以 `FleetRuntimeProvider` 包裹场景子树（TASK-010 起车辆组件经 useFleetRuntime 消费同一运行时）。
  - `index.ts` 公开合同扩展：WS 数据源工厂与可调常量、协议适配边界类型、`createUnmappedProtocolAdapter`、`FleetRuntimeProvider`；Context 对象与消费 Hook 保持 Feature 内部。
- app 接线：`App.tsx` 运行 `bootstrapApplication`（AbortController + 退避重试 1s→30s；`CONFIG_*` 失败为终态保持清屏色，地图阶段失败自动重试），就绪后携带配置与地图上下文构造数据源并装配场景；`AgvMonitorScene` 组合 `MapVisualizationFeature` 并以 Provider 注入车队运行时。
- 工具链齐备：`@/ -> src/` 别名三处一致；脚本含 `lint/typecheck/test:unit/test:architecture`；Vitest（jsdom + Testing Library + `@react-three/test-renderer`）、dependency-cruiser 均已接入。
- 真实浏览器行为不走自动化测试套件：涉及用户行为或浏览器生命周期的验证由执行 Task 的 Coding Agent 调用浏览器自动化技能在真实浏览器中自测，结论记入本文件第 5 节。
- 架构检查（`pnpm test:architecture`）以 `.dependency-cruiser.cjs` 规则校验真实 `src`（102 模块 0 违规），负例证明深层导入、核心 Feature 互导、受限公开入口、反向依赖和循环依赖必被抓到。
- 快速 CI 已建立：`.github/workflows/ci.yml` 执行 lint、typecheck、unit、architecture、build。
- 尚无 Mock 拓扑与仿真（TASK-008/009）、车辆模型渲染与实例批（TASK-010）、标签/选择/交通资源（TASK-011/012）、相机交互、质量控制、后台节流或 WebGL 恢复实现；对应实现分属后续 Task。真实 WS 协议映射与联调属 TASK-021（`WAITING_EXTERNAL`，当前生产配置经默认适配器显式拒绝未映射消息）。

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
| 地图名称条目 | 1,193（1,185 仓库 + 7 独占区 + 1 停车字形，TASK-005 图集输入） |
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
| TASK-005 | 地图业务语义图层 | 004 | `DONE` |
| TASK-006 | 车辆领域模型、事件合同与车队运行时 | 001、002 | `DONE` |
| TASK-007 | WebSocket 数据源与 React 生命周期 | 006 | `DONE` |
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
| Task | `TASK-008 Mock 拓扑、运动与充电内核` |
| 状态 | `TODO` |
| 当前目标 | 形成纯函数、固定种子、可复现的 Mock 仿真内核，能够在真实有向地图上分配车辆、行驶、寻充和安全处理死路；不创建计时器、数据源生命周期、React 或 Three 对象 |
| 当前主要范围 | `features/mock-simulation/model/**`（pathfinding/motion/PRNG/弧长表/仿真领域状态）与共置测试 |
| 当前已有实现 | TASK-003 的 MapModel（有向出边、弱连通分量 2,001/1,187/796/307、逻辑边物理长度）与 TASK-006 的 `VehicleDataSource` 事件合同均就绪；已知死路拓扑：1 个无出边 work 节点（名称「44」） |
| 当前待完成 | 以 `TASKS.md` 的 TASK-008 为准实现：按逻辑边比例覆盖四个分量；Dijkstra 严守方向、代价非法回退物理长度；LINE 线性推进、BEZIER 弧长参数化 + 切线 theta；目标速度 0.5～1.5m/s 受载荷/空载限速；低于 25% 电量寻本分量 charge 充至 90%；大时间差不累积位移；死路/无路径安全停车并产生 Mock 数据告警；随机调用顺序稳定 |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-009（依赖 007、008，007 已 DONE） |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| Lint | `pnpm lint` | 通过（105 文件，0 警告 0 错误） |
| TypeScript | `pnpm typecheck`（`tsc -b`） | 通过 |
| 单元测试 | `pnpm test:unit`（Vitest + jsdom，28 文件 270 例：TASK-002～005 全部保留；TASK-007 新增 41 例——protocolAdapter 默认拒绝合同 3 例、WebSocketVehicleDataSource fake socket/timer 21 例（四类事件与上下文补全、重复/回退序号、孤立增量拒绝、heartbeat 通行不建基线、代次隔离、1/2/4/8s→30s ×0.8/×1.2 抖动退避、60s 稳定重置、15s 静默主动重连、手动断开清理计时器与恢复、连续解码失败 ERROR/清零计数/显式恢复、重连全量对齐、connect 幂等、AbortSignal 三阶段取消、六态状态机）、useVehicleDataSource 9 例（挂载连接/卸载断开、StrictMode 双执行收敛活跃连接峰值≤1、事件只应用一次、1Hz ticker STALE 跃迁、heartbeat 不刷新、快速 source 切换、null 稳态、options 不重建、卸载竞态）、FleetRuntimeProvider 4 例（运行时单实例、状态经 Context 低频可达、事件落运行时、缺 Provider 抛错）、selectVehicleDataSource 4 例（ws 选型与 wsUrl 透传、adapter 注入、mock/wsUrl 缺失降级 null + 诊断）、fakeWebSocket 共置夹具（FakeWebSocket + 测试 JSON 信封适配器，复用生产 validateVehicle） | 通过（270/270） |
| 当前地图集成 | `currentMap.integration.test.ts`：TASK-003/004/005 数据、几何与语义图层事实全部保留 | 通过 |
| 当前车辆夹具 | `vehicleFixture.integration.test.ts`：`json/vehicle.json` 重新校验——TRAFFIC_WAIT（D5）、LOW_BATTERY、LOADED、ONLINE、locked 1 + applying 3、运行时 10s STALE 跃迁 | 通过 |
| 架构检查 | `pnpm test:architecture`（真实 src 114 模块 0 违规；负例全部命中；正例零误报） | 通过 |
| 构建 | `pnpm build`（含 `copyStaticAssets` 与 `verifyDist`） | 通过 |
| dist 校验 | `pnpm verify:dist`（index/config/map 存在、相对路径引用、白名单与凭据检查、map.json 可解析） | 通过 |
| 部署冒烟 | `pnpm smoke:dist`（TASK-002 基线；本轮未改动部署链，未重跑） | 上次通过 |
| 差异检查 | `git diff --check` | 通过（无空白错误；仅 CRLF 提示） |
| 浏览器自测 | TASK-007 浏览器验证项「地图在 WS 无数据或断连时仍保留」：内嵌 Chromium 1280×720，`config.json` 临时切至 `dataSource=ws`、`wsUrl=ws://127.0.0.1:9/`（连接拒绝）后实测——唯一 1280×720 全屏 Canvas、无滚动、无任何 DOM 覆盖层（仅 R3F 空容器 div）；map.json 正常加载且截图取证完整静态地图（地坪/网格/去重路径/节点/仓库/充电语义）持续渲染；页内挂钩 WebSocket 构造器观测到重连循环持续（两次尝试间隔 ≈26s，处于 30s 封顶×抖动区间），无连接 UI | 通过 |

浏览器自测备注：内嵌浏览器面板在宿主窗口后台时节流 `requestAnimationFrame`，标准截图会强制一帧使 R3F 应用全屏尺寸；本轮以「截图强制帧 + 帧内 WebGL readPixels/挂钩 WebSocket 构造器」完成取证，与 TASK-002/003/005 记录的环境节流现象一致，不影响真实部署浏览器。`config.json` 自测后已恢复（dataSource=mock），工作区无残留差异。

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
