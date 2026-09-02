# AGV 3D 实时监控大屏实施进度

状态日期：2026-09-02

任务书版本：`TASKS.md` v2.1

规格版本：`SPEC-20260901-agv-3d-monitor` v1.4

## 1. 当前执行状态

| 字段 | 当前值 |
|---|---|
| 项目状态 | `IN_PROGRESS` |
| 当前 Task | `TASK-015 后台节流与前台瞬时对齐` |
| 当前 Task 状态 | `TODO` |
| 已完成工程 Task | `14 / 21` |
| 条件任务 | `TASK-021 WAITING_EXTERNAL` |
| 验收 Gate | GATE-001、GATE-002、GATE-003 均为 `NOT_READY` |
| 当前下一步 | 将 TASK-015 改为 `IN_PROGRESS` 后，实现：`visibilitychange` 监听对称清理；隐藏期间停止渲染但数据源继续保留每车最新快照（WS 与 Mock 均不断开）；ticker 暂停/恢复时立即重算 freshness；回前台强制全量 diff 与脏槽位提交、一帧内与最新快照对齐；被删除的选择/跟随目标按既有语义清理；不累积仿真位移；浏览器生命周期自测（模拟后台 10min、多次 update/remove、回前台一帧对齐、监听不重复、隐藏期间无渲染） |
| 项目完成条件 | TASK-001～TASK-021 全部 `DONE`，GATE-001～GATE-003 全部通过，SPEC A1～F6 均有当前证据 |

编号是推荐交付顺序，执行前必须核对真实依赖。`WAITING_EXTERNAL` 的 TASK-021 不阻塞 TASK-018～020；其他 Task 只有在自身依赖全部 `DONE` 后才能开始。

## 2. 当前仓库状态

### 2.1 Git 与工作区

| 项目 | 当前值 |
|---|---|
| 工作区 | `C:\code\agv-map-3d` |
| 分支 | `rxx`，跟踪 `origin/rxx`，领先远端 1 个提交（TASK-014 待推送；TASK-003～TASK-013 已在远端，此前记载的「领先 13」已过期并据 `git ls-remote` 校准） |
| HEAD | TASK-014 实施提交（TASK-013 提交之后） |
| 未提交差异 | `gui-test-screenshots/pngcrop.mjs` 保持已暂存（用户既有差异，未纳入本轮提交）；未跟踪目录 `gui-test-screenshots/task-014/` 为本轮浏览器自测截图存档 |
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
- TASK-008 已完成 Mock 拓扑、运动与充电内核（`src/features/mock-simulation/`，纯函数领域内核——无计时器、无数据源生命周期、无 React/Three 对象）：
  - `model/prng.ts`：mulberry32 确定性 PRNG——`DEFAULT_MOCK_SEED=20260901`，`randomInRange`/`randomInt` 防御式回退不抛异常；内核全部随机决策（建车「边→进度→电量→速度→载荷」、到站「电量裁决→出边随机」）消费同一条固定种子流，调用顺序稳定。
  - `model/pathfinding.ts`：有向 Dijkstra（二叉最小堆 + 距离/插入序决胜）——只沿 `outEdgeIds` 扩展绝不逆行；代价正有限用 `edge.cost`，否则回退物理长度，二者皆不可用按不可通行隔离；`findNearestChargePath` 本分量 charge 多目标早停，可达性天然不跨分量；起点即目标返回空路径。
  - `model/arcLengthTable.ts`：边弧长遍历表——LINE 线性插值恒定朝向；BEZIER 复用 map-visualization 公开入口的 `sampleCubicBezier`（新增导出，与物理长度/渲染几何三方同一 24 段口径）建立累计弧长表，弧长绝对落点与推进分区无关，theta 取解析切线方向（退化按段弦向→整曲线弦向→0 回退）；端点守恒、越界钳制、零长边退化表。
  - `model/motion.ts`：两级速度裁决——目标速度 [0.5,1.5]m/s 采样，载荷/空载分别受正有限的 `maxLoadSpeed/maxFreeSpeed` 钳制，缺失或非法视为不限速，结果永不为负。
  - `model/simulationKernel.ts`：`createMockSimulationKernel(mapModel, options)`——按分量逻辑边数量最大余额法（`allocateByEdgeProportion`）分配车辆并从本分量有向边池随机生成初始位姿；「剩余时间驱动」推进循环按各边限速换算里程、跨边重估限速、单步换边上限 64 次防极短边链；电量按里程消耗，到站低于 25% 触发本分量最近充电寻路、到站充至 90% 恢复任务；死路停在节点、寻充失败停在当前位置，均进入 `IDLE_BLOCKED` 并写入 Mock 数据告警（`MOCK_DEAD_END`/`MOCK_NO_CHARGE_PATH`），不瞬移不跨分量；`step(dt)` 把单步时长钳制到 `maxStepSeconds`（缺省 1s），大时间差丢弃超额部分不累积位移；`getVehicleStates()` 零拷贝只读视图，TASK-009 发布事件前必须复制为不可变快照。
  - `index.ts` 公开合同：内核工厂与只读状态类型、比例分配、有向寻路、弧长表、速度裁决与 PRNG 原语；TASK-009 的事件生产、场景时间线与交通矩形生成都以此为引擎。
  - 架构规则校准（在同轮闭环）：`adapter-*-public-entry-only` 拆分为按 Feature 的两条规则并豁免自身目录——此前规则会把 adapter 类 Feature 的正常内部相对导入误判为跨 Feature 违规；负例仍各自命中，正例新增 mock-simulation 内部导入夹具证明零误报。
- TASK-009 已完成 Mock 数据源、确定性场景与启动接线（`src/features/mock-simulation/data-source/`、`scenarios/` 与内核生命周期扩展）：
  - `data-source/MockVehicleDataSource.ts`：VehicleDataSource 的 Mock 实现——connect 即发布经 `validateVehicle` 统一校验路径的全量 snapshot（60 台默认）并转 OPEN；自调度计时链按 2Hz 基频逐 tick 加 ±50% 抖动（`[250,750)ms`）推进内核，按内容签名变化发布 update（静止车自然静默）、按仿真时钟 5s 心跳；所有事件共用严格递增 sequence 并由注入单调时钟打点 receivedAt；connect/disconnect/requestSnapshot 幂等，手动断开清空计时链进 CLOSED 绝不自动重连（RECONNECTING/ERROR 对本地仿真不可达）；暂停期间不推进、不发布且持续刷新计时基准——恢复后首步位移不超过一个普通周期；受阻车（死路/无充电路径）按合法拓扑静默停车并记一次性采样诊断，不伪装 FAULT。
  - `scenarios/acceptanceScenario.ts`：确定性验收时间线（120s 窗口循环、模块级常量调度表、单调游标、无随机源）——2s 接单、8s 故障、14s 掉线、20s 暂停、26s 交通等待、32s 低定位、38～68s 逐项恢复、74s 删车、80s 增车；场景覆盖只作用于上报字段（订单/故障/连接/暂停/交通/定位），不改写内核运动与电量语义；目标序号（11 起）与内核低电量前 2 台错开。
  - `model/trafficRectangle.ts`：交通矩形纯几何——按占用路径切线角生成 8 数值凸四边形（四角固定绕向，永不自交），locked 最紧、applying 逐级外扩，字段名与真实夹具 `lockedRectangles/applyingRectangles` 同构。
  - 内核生命周期扩展：`addVehicle()`（「车辆数/逻辑边数」最低分量、并列取最小序号）与 `removeVehicle(agvKey)`（幂等），agvKey 序号全局递增永不复用（`formatMockAgvKey`/`parseMockAgvSerial` 公开）；新增 `lowBatteryVehicleCount` 选项——前 N 台初始电量采样在寻充阈值之下，保证充电事件在时间线内确定出现（默认数据源取 2，当前真实地图上首次充电出现在约 172s 仿真时间）。
  - `data-source/mockDevBridge.ts` + app 接线：`window.__AGV_MOCK__`（setVehicleCount/setPaused/setScenarioEnabled/resetSimulation/getSeed/getStats）由 App 提交阶段 effect 在「开发模式 + Mock 数据源」时注册、卸载对称摘除——StrictMode 双渲染下 render 阶段注册会指向被丢弃实例（本轮实测复现并修复），effect 始终持有被提交且被连接的同一实例；生产构建 `import.meta.env.DEV` 静态替换为 false 后整块死代码消除（dist grep 0 命中，浏览器实测无该全局）。
  - `selectVehicleDataSource` Mock 分支：以 `mapModel` 为硬前置（Mock 必须在 MapModel 拓扑就绪后创建），缺失时降级 null 并记 `DATA_SOURCE_UNAVAILABLE`；WS 分支不依赖该屏障；本模块保持纯工厂，桥注册归 App effect。`App.tsx` 就绪态携带 mapModel 传入。
  - 确定性验证：同 seed + 注入时钟/随机源下 130s 完整事件序列（含 receivedAt）逐位一致，不同 seed 不同；真实地图集成测试锁定 200s 窗口覆盖全部验收事件（含充电）、删一增一后规模守恒、250 台压力规模可用。
- TASK-010 已完成 AGV 程序化模型、槽位与实例批渲染（`src/features/fleet-monitoring/` 的 `model/instanceSlots.ts`、`scene/`、`components/`、`hooks/useFleetFrameSync.ts`）：
  - `model/instanceSlots.ts`：实例槽位表——批次容量 256（250 台压力模式单批）、超容量按 256 步长扩批、硬上限默认 512；空闲栈 LIFO 复用（弹栈序即槽位升序），硬上限满时实体进 FIFO 等待队列并在槽位释放时原子转派（release 返回 `{freed, admitted}` 供渲染层对补录车立即全量写入）；`resolve(batch, slot)` 反向映射 O(1) 支持外壳拾取 `(batchId, instanceId)`→实体键；末批按硬上限截断，截断槽位永不分配。
  - `scene/fleetAppearance.ts`：车辆视觉常量唯一事实源——主状态→车体色映射（STALE 冻结灰 / DISCONNECTED 深灰 / FRESH 业务色，与投影规则同序）、部件固定高度阶梯、方向楔占比与亮度系数、FAULT 信标自旋 4.5rad/s 与闪烁 1.6Hz、假阴影参数；充电色与 charge 节点、执行色与 work 节点同色系。
  - `scene/createVehicleGeometry.ts`：纯函数布局 + 几何工厂——`computeVehiclePartLayout(snapshot, displayState)` 产出七部件（底盘/外壳/+x 方向楔/载荷平台/托盘/警示灯/车底假阴影）本地中心与全尺寸（每车 `length/width/loadLength/loadWidth` 分别进入矩阵，固定高度只进 y 分量）；`computeVehicleWorldPose` 按 §2.5 唯一口径合成 centerOffset 位移与 `rotation.y=-theta`；`visible = positionValid && dimensionValid`（非法车不放置）、`beaconActive` 当且仅当投影主状态为 FAULT；几何工厂产出共享单位盒、三角棱柱方向楔（非索引顶点 + computeVertexNormals，鼻尖 +x）、穹顶+扫掠叶片信标（mergeGeometries 手工合并）、水平阴影面片与七份材质，由 Feature 根组件单一持有、dispose 幂等。
  - `hooks/useFleetFrameSync.ts`：运行时脏集合的唯一帧消费者——每帧 `consumeDirty` 一次，位姿差写六部件矩阵（信标由显示/动画路径负责）、显示差写外壳/楔实例颜色与平台托盘可见性、删除释放槽位并零缩放清场（转派时对补录车立即全量写入）；FAULT 信标逐帧写自旋矩阵与正弦亮度脉动实例颜色，熄灭为零缩放；(批次,部件) 脏标记合并为每帧至多一次 `needsUpdate`（未变化槽位不写）；扩批经 `onBatchCountChanged` 上抛 setState 挂载新批次，挂载后按批次数组身份触发一次全量重写——全量重写以运行时实体表为唯一事实源（重挂载/地图就绪后脏集合即使已被消费也完整收敛）；非法位置车不占槽位且整车零缩放；硬上限溢出记 `FLEET_RENDER_CAPACITY_EXCEEDED` 采样诊断（回落后可再告警）。
  - `components/VehicleInstances.tsx`：批次挂载组件——每批次恒 7 个 InstancedMesh（200 台 = 7 Draw Call ≤ 8），实例矩阵零缩放初始化 + DynamicDrawUsage，`frustumCulled=false`，castShadow=false（车辆不投实时阴影，假阴影独立半透明贴片）；仅外壳保留 raycast 并携带 `userData.batchId`，其余部件 raycast 置空；批次数是唯一进入 React state 的结构值（key 携带批次数强制走干净卸载/挂载路径，规避 R3F primitive 换 object 的重建丢弃）。
  - `components/FleetMonitoringFeature.tsx`：Feature 公开根组件——消费 `useFleetRuntime`，单一持有 `VehicleResources`（useMemo 创建、卸载幂等释放）、实例槽位表（useRef 惰性创建，车体与标签共享）与批次数（唯一进入 React state 的结构值，两图层保持一致），组合 `VehicleInstances` 与 `VehicleLabels`；`worldTransform=null`（地图未就绪）渲染 null 且不创建实例缓冲，运行时继续积累事件、就绪后首帧全量收敛。
  - app 接线：`App.tsx` 就绪态把 bootstrap 产物的 `worldTransform` 传入 `AgvMonitorScene`，场景组合根在 `FleetRuntimeProvider` 内挂载 `FleetMonitoringFeature`（fleet-monitoring 不导入地图实现，坐标转换由 app 注入，SPEC §12.4）；`index.ts` 公开 `FleetMonitoringFeature` 与 props 类型。
- TASK-011 已完成图集化 WebGL 车辆标签（`src/features/fleet-monitoring/` 的 `scene/labelAtlas.ts`、`scene/labelMaterials.ts`、`scene/labelLod.ts`、`hooks/useFleetLabelFrameSync.ts`、`components/VehicleLabels.tsx`）：
  - `scene/labelAtlas.ts`：名称图集唯一栅格化入口——`createLabelCellBook` 纯单元账本（「槽位→已绘文字」缓存，同名重绘/对空清除均 no-op，只重绘目标单元）+ `createVehicleLabelAtlas` 真实 2048×2048 Canvas 工厂（256 个 256×64 名称槽即实例槽位、绘制按单元裁剪防溢出、`flush` 每帧至多一次纹理上载、中文名称与地图名称同一字体栈）；`createVehicleBadgeAtlas` 状态芯片副徽标图集（7 个业务状态「彩底+白字」一次性栅格化、全批次共享、永不重绘），`badgeChipUv` 纯查表（null → 零矩形隐藏）；无 2D 上下文抛 `VEHICLE_LABEL_ATLAS_UNAVAILABLE` 由调用方降级。
  - `scene/labelMaterials.ts`：标签两层 ShaderMaterial——视空间 billboard 顶点（实例中心 + 实例矩阵 x/y 轴长度展开，恒朝相机、文字不镜像，零缩放矩阵即整体隐藏）；背景层片元以实例属性绘制圆角状态底板（主状态色加深）、L1 黄/L2 红告警边框（外圈）、白色选中边框（内圈，可与告警并存）、电量条（仅完整档且电量已知，<15% 红/[15,30)% 黄/其余绿，阈值经 defines 与 `deriveVehicleState` 同源）与状态芯片（采样共享徽标图集）；名称层片元采样批次图集；颜色常量经 defines 注入线性空间并共用 tone mapping/colorspace 管线。每批次背景+名称恒 2 个 Draw Call。
  - `scene/labelLod.ts`：显示决策纯函数——`labelLevelForPixels`（≥8px 名称、≥20px 完整，边界含、非有限隐藏）、`labelImportanceRank`（选中>FAULT>STALE>断连>严重低电量>低定位）、`labelAlertLevel`（与 §7.3 同表，L2 优先）、`labelChipOf`（FRESH 显示业务主状态，STALE/断连保留最后已知业务状态副徽标，UNKNOWN 不作徽标）、`capImportantLabels`（按「秩×4096+扁平槽位」打包排序稳定截断）。
  - `hooks/useFleetLabelFrameSync.ts`：标签帧同步唯一消费者——每帧全量扫描 ≤512 实体，以「快照/显示状态对象引用」为差量只写变化实例属性（内容差→底色/电量/告警级/芯片 UV/名称单元；相机投影逐帧重算 LOD 档位；远景只保留按秩截断的前 20 个重点标签并以名称档显示）；删除清理先于内容扫描（先构建 seen 集合，图集单元必清除，矩阵清零以 `table.resolve` 防护避免覆盖同帧转派车）；批次数组身份变化即清缓存全量重写；(批次, 属性) 脏标记合并提交、图集一帧至多一次上载。绝不消费运行时 pose/display/removed 脏集合（那是车体帧同步的独占输入）；名称绘制只在名称变化时触达图集，电量/选中/告警变化绝不重绘名称纹理。
  - `components/VehicleLabels.tsx`：标签批次挂载组件——每批次独享名称图集/几何/材质（背景 renderOrder=10、名称 11，均透明不写深度、关闭拾取），共享芯片图集组件级单一持有；图集工厂可注入，不可用时整层降级不渲染并记 `VEHICLE_LABEL_ATLAS_FAILED` 诊断，车体语义不受影响；key 携带批次数强制干净重建（R3F primitive 重建丢弃规避）。
  - 接线调整：槽位表与批次数从 `VehicleInstances` 上提到 `FleetMonitoringFeature`（车体与标签共享同一槽位表——标签槽位恒等于车体槽位、图集单元即槽位），`useFleetFrameSync` 仍是脏集合唯一消费者并经 `onBatchCountChanged` 上抛批次数。
  - 布局与外观常量扩展至 `scene/fleetAppearance.ts`（标签尺寸 0.6m 高 × 4:1、锚点 0.8m、8px/20px 阈值、重点上限 20、边框/电量条配色、标签字体栈——不跨 Feature 引用 mapAppearance）。
- TASK-012 已完成选择、告警环与交通资源表达（`src/features/fleet-monitoring/` 的 `model/trafficRectangle.ts`、`scene/trafficGeometry.ts`、`scene/vehicleRings.ts`、`components/VehicleRings.tsx`、`components/TrafficLocksLayer.tsx`、`hooks/useFleetRingFrameSync.ts`、`hooks/useVehicleSelection.ts` 与接线调整）：
  - `model/trafficRectangle.ts`：交通矩形规范化唯一入口——8 有限数值 → 四点、ε 去重、质心极角排序（同角按距离决胜）、严格凸校验与最小面积阈值（0.01m²）；任意输入点序/绕向规范化后点序与哈希完全一致（哈希按 0.1mm 精度取整编码）；无效一律返回 null（只拒绝不改写），`trafficHasInvalidRectangle` 是 INVALID_DATA 传播的唯一判定依据。
  - `model/deriveVehicleState.ts`（扩展）：任一 locked/applying 矩形无法形成有效凸四边形时给所属车传播 INVALID_DATA（SPEC §5.3 第 5 步）；有效矩形与缺失资源不产生告警。
  - `scene/vehicleRings.ts` + `hooks/useFleetRingFrameSync.ts` + `components/VehicleRings.tsx`：选中/L1 黄/L2 红分层光环——层序 0/1/2 从内到外（半径系数 1.25/1.65/2.05 × 每车 max(长,宽) 缩放），L1/L2 判定与 §7.3 告警表同口径且互不排斥（标签边框取最高级、光环每层独立）；每批次恒 1 个 InstancedMesh（容量 = 车辆槽位 × 3 层，1 个光环 Draw Call，200 台车辆相关合计 7+2+1=12 满足 §6.3 预算）；实例颜色只在激活沿写入层色；条件恢复同帧零缩放移除；非法坐标车辆不放置任何环；删除清理先于内容扫描且经 `table.resolve` 防护同帧转派；count 按「缓存真实激活态」重算收缩（活跃但本帧未写矩阵的实例持续绘制）。
  - `scene/trafficGeometry.ts` + `components/TrafficLocksLayer.tsx`：全车队交通矩形聚合为单个合批动态 BufferGeometry——每车归一化按快照引用缓存（无效矩形逐项跳过）、100ms 合并窗口内多条 2Hz 更新一次结算、只在「kind + 规范化哈希组合签名」变化时重建（车辆顺序无关）；世界变换换代立即原子重建；凸四边形固定索引 (0,1,2)(0,2,3) 三角化 + 顶点色（locked 红 = L2 红、applying 黄 = L1 黄，与标签边框同源）；无矩形时几何为 null 且网格不可见；mesh 对象身份恒定（几何换代不触碰 React），raycast 关闭、renderOrder=2 低于光环与标签。
  - `hooks/useVehicleSelection.ts`：选择交互——事件处理器展开在 Feature 根 group（R3F 事件沿场景图冒泡，仅外壳 raycast 开启）；(batchId, instanceId) 经槽位表 resolve 为实体键；只接受主鼠标指针（pointerType/isPrimary 双检）；pointerdown→click 位移超阈值（6px）视为轨道拖拽抑制；Esc 经 window keydown（对称清理）取消；点击非本组对象（onPointerMissed）取消；双击仅上抛 `onFollowRequest`（不移动相机，跟随归 TASK-013）。
  - 接线调整：`FleetMonitoringFeature` 组合四图层并持有 `RingResources`（车体/标签/光环共享同一槽位表），新增 `onFollowRequest` props（TASK-013 起由 app 组合层转交相机命令）；`useVehicleDataSource` 新增 `onDiffApplied` 差异回调，`FleetRuntimeProvider` 把 removed 差异转发为 store 的 `notifyEntitiesRemoved`——车辆删除立即清除选中（SPEC §11.6）；`fleetAppearance` 扩展光环/交通锁外观常量（复用标签边框配色，贴地层次 0.012 < 0.02 < 0.03）。
  - 缺陷闭环（在本 Task 内完成）：真实浏览器实测发现外壳拾取永远落空——InstancedMesh 在挂载期实例全零时其 boundingSphere 被外部路径提前计算并缓存为「原点半径 0」，而 three 的 raycast 只在 boundingSphere===null 时惰性重算，包围球预检永远失败；修复为 `useFleetFrameSync` 在 shell 矩阵脏提交时重算该批次 shell 包围球（拾取球恒与最新实例数据一致，含车辆移出旧球的情形），真实浏览器点击拾取回归通过。
- TASK-013 已完成相机、车辆跟随与完整交互（新增 `src/features/camera-navigation/`、fleet-monitoring 只读跟随目标适配器与 app 桥接调整）：
  - `camera-navigation/model/overviewFraming.ts`：俯瞰取景纯函数——45° 俯角 + 45° 方位角唯一确定机位，距离按垂直视场包络包围球（半对角线/tan(fov/2)×1.1 余量）并钳制进 [2m, 对角线×3]；极小地图下保证 max > min 的保底间隔；near/far 与最大距离同源重设。初始取景与空格俯瞰共用同一数学。
  - `camera-navigation/model/cameraNavigationStore.ts`：Feature 内部低频 zustand store（followedEntityKey，幂等写入）；逐帧相机数据绝不进入 store（SPEC §4）。
  - `camera-navigation/hooks/useCameraNavigation.ts`：自持 three `OrbitControls` 实例（enableDamping、minDistance 2 / maxDistance 随 bounds 重设，卸载 dispose 并清空注入引用）；bounds 对象身份变化即重新取景（先退出跟随）；跟随状态机全部在 ref——进入捕获「相机−注视点」相对偏移、跟随中切换目标保留原偏移，每帧读取注入的只读目标并写相机与 target，目标删除（读取器返回 null）当帧退出；拖拽（按下后位移 >6px，与车辆选择拖拽抑制同口径，主鼠标指针过滤）立即退出跟随且 controls 当前姿态无缝接管；跟随期间 controls 缩放关闭、滚轮改缩放相对偏移（钳制进距离限制）；空格经 window keydown（preventDefault）退出跟随并回俯瞰；命令出口经 `commandsRef`（follow/exitFollow/overview/isFollowing/getFollowedKey，卸载置 null）；监听器全部 effect 对称清理，StrictMode setup→cleanup→setup 无残留。
  - `camera-navigation/components/CameraNavigationFeature.tsx` + `index.ts`：公开根组件（渲染 null，相机只体现在默认相机位姿）与最小合同（根组件、CameraNavigationCommands、computeOverviewPose、CAMERA_MIN_DISTANCE_M）；内部 store 不外露（跨 Feature 协作只走命令引用与回调）。
  - fleet-monitoring 适配器：`scene/followTarget.ts` 的 `createFollowTargetReader({runtime, worldTransform})` 产出「实体键 → 车体中心世界坐标」只读读取器——坐标完全复用渲染路径 `computeVehicleWorldPose`（§2.5 centerOffset 口径），未知键/非法位置/非有限结果一律返回 null（相机据此退出），绝不抛出；`index.ts` 公开该工厂与类型；`FleetRuntimeProvider` 新增 `onRuntimeAvailable`（以生命周期内恒定的运行时引用在 effect 中幂等通知，StrictMode 重复通知同引用）。
  - app 桥接（跨 Feature 协作只在组合层，SPEC §12.3）：`AgvMonitorScene` 组合 `CameraNavigationFeature`，取景包围盒取 bootstrap 种子 `sceneBounds`；经 `onRuntimeAvailable` 拿到只读运行时后与 `worldTransform` 派生跟随目标读取器注入相机 Feature；车辆双击请求由 `FleetMonitoringFeature.onFollowRequest` 转交 `commandsRef.follow`——两 Feature 互不导入、互不感知；scene 仅持有一个命令引用 + 一个运行时引用低频状态，无逐帧数据。移除 `MapVisualizationFeature` 中临时的 45° 初始取景（InitialFraming），相机位姿唯一写入方为 camera-navigation；`MapVisualizationFeature` 语义图层不受影响。
  - 测试：camera-navigation 3 个测试文件 18 例（取景数学 6：45° 俯角/包络距离/最大距离与远平面/bounds 变化/退化小地图/非有限对角线；store 2：幂等写入；Feature 集成 10：自动取景与距离限制、逐帧对齐只读目标、目标删除当帧退出、拖拽退出与单击不退出、空格俯瞰、跟随期间滚轮缩放偏移、切换目标保留偏移、卸载对称清理、StrictMode 无重复监听、bounds 变化重设）；fleet `followTarget` 5 例（坐标与渲染车体一致、更新即时可读、删除/非法位置/未知键返回 null）；`FleetRuntimeProvider` +1（onRuntimeAvailable 恒定引用幂等通知）；`App` 外壳测试增加相机 Feature 替身并锁定 bounds 接线；`AgvMonitorScene` 测试新增「相机接管自动取景」与「双击请求→组合层命令→逐帧对齐车体世界位姿」桥接用例（含移动更新后相机平移同位移）；`vitest.setup.ts` 补齐 jsdom 缺失的指针捕获 API（three OrbitControls pointerdown 依赖，仅测试环境最小实现）。
- TASK-014 已完成自适应质量与质量能力接线（新增 `src/features/render-quality/`，fleet-monitoring 与 map-visualization 能力开关 props、app 组合层质量映射）：
  - `render-quality/model/qualityPolicy.ts`：质量控制纯函数与迟滞状态机唯一入口——`targetFpsForVehicleCount`（≤100 台 60fps、>100 台 30fps，非有限/非正回退 60）；`createQualityPolicy` 纯裁决状态机（不读真实时钟，由调用方喂入「帧耗时 + 单调累计帧时间」）：1000ms 滑窗平均为「平均帧时间」，超预算 105% 持续 3s 降一级（距上次变化 ≥5s），低于 75% 持续 30s 升一级（≥30s），等级钳制 [0,4]；两侧条件互斥、条件破坏即清零持续计时；单样本钳制 1000ms、非有限/负样本整体忽略；>2s 采样断流（页面隐藏/挂起恢复）清空窗口与持续计时、不跨断流累积迟滞；`setTargetFps` 切换预算并重置持续计时（保留冷却与等级）；`capabilitiesForLevel` 按 SPEC §6.5 四个动作逐级叠加产出能力开关（1 仅重点+近景标签 → 2 阴影 2048→1024 取 min → 3 关动态阴影+交通脉冲 → 4 关装饰动画），任何等级不含隐藏核心语义的开关；`effectiveDprFor`（4 级上限 min(1,maxDpr) 只降不抬，再与设备像素比取 min）。
  - `render-quality/model/renderQualityStore.ts` + `hooks/useQualityLevel.ts`：低频 zustand store 只持当前质量等级（写入幂等、越界钳制，是唯一写边界）；对外仅暴露只读消费面——`useQualityLevel` 精确 selector 订阅与 `subscribeQualityLevel`（登记即回调、退订对称）；store 本体与写入口不出 Feature。
  - `render-quality/hooks/useAdaptiveQuality.ts`：useFrame 采样唯一路径——每帧把 R3F delta 换算为毫秒样本喂入策略；裁决时钟是「累计帧时间」而非墙钟（真实循环与测试渲染器 advanceFrames 共用同一确定性语义）；车队规模读取器每帧取值、跨越 100 台阈值自动切换目标预算；帧样本/窗口/计时器全部在 ref 普通对象，绝不进 React state/zustand；等级跃迁写 store 并记 `QUALITY_LEVEL_CHANGED` 结构化诊断（方向/等级/平均帧时间/目标帧率/车队数）；`auto=false` 完全旁路（测试/基准锁定默认画质）。
  - `render-quality/components/RenderQualityFeature.tsx` + `index.ts`：Canvas 内质量控制器（渲染 null）——组合采样 Hook 与 DPR 应用（经 `useThree.setDpr`，唯一 DPR 写入方：基准 = min(maxDpr, 设备像素比)，4 级降为 1）；公开合同仅根组件、等级/能力映射纯函数与只读订阅。
  - 能力开关接线（跨 Feature 协作只在 app 组合层，SPEC §12.3）：`AgvMonitorScene` 订阅 `useQualityLevel`（低频），`capabilitiesForLevel` 映射后显式传入——`MapVisualizationFeature` 新增 `dynamicShadowsEnabled`（false 时方向光 castShadow=false，shadow camera 配置保留）；`FleetMonitoringFeature` 新增 `importantLabelsOnly`（经 VehicleLabels → useFleetLabelFrameSync：中距离纯名称档 8～20px 隐藏，重点车与近景完整档不受影响）与 `trafficPulseEnabled`（交通锁材质新增 onBeforeCompile 脉冲 uniforms——uTime/uLockPulseEnabled，0 时恒定不透明度，即 SPEC §6.5「交通锁脉冲」的可关效果本体）；`App.tsx` 把 `config.renderer.maxDpr/shadowMapSize` 经 props 传入场景（此前 maxDpr 仅校验未接线）；`map-visualization` 公开入口补导出 `DEFAULT_SHADOW_MAP_SIZE`。
  - 缺陷闭环（在本 Task 内完成）：`MapVisualizationFeature` 灯光/目标点 primitive 无 key——阴影分辨率或动态阴影开关变化时旧灯对象身份变化触发 R3F「primitive 换 object」静默丢弃（TASK-005 实测结论的又一处未设防路径），灯光换代被丢弃后场景持有旧配置；修复为灯光与目标点 primitive 携带模块级资源代 `key` 强制卸载/挂载，能力开关变化必然生效（测试锁定换代后场景唯一）。
  - 测试：render-quality 3 文件 29 例（policy 21：目标帧率阈值/逐级能力映射与阴影 min 钳制/DPR 上限与非法回退/3s 持续+5s 冷却的降级时间线/抖动重置/30s 持续+30s 冷却恢复/0 与 4 级钳制/setTargetFps 重置/非有限样本忽略/样本钳制/断流重置/reset 清冷却；store+只读视图 3：幂等 no-op/越界钳制/登记即回调与退订对称；Feature 5：合成帧序列逐级降级+诊断采样合并语义/车队数切档/auto=false 旁路/4 级 setDpr(1) 落地/渲染 null 与 StrictMode）；fleet +4（重要标签降级的中距离抑制与重点保留含对照、交通脉冲 uniforms 存在性与开关不影响重建判据、trafficPulseEnabled 帧同步写入）；map +1（dynamicShadowsEnabled/shadowMapSize 变化灯光换代生效且唯一）；`AgvMonitorScene` +1（2/3 级映射为阴影分辨率/动态阴影/交通脉冲的组合层接线）；`App` 外壳补 render-quality 替身并锁定 maxDpr/shadowMapSize 传递；`currentMap.integration` 重负载用例显式放宽超时（全量并行下实测超 5s 默认值，单独运行 0.8s）。
- app 接线：`App.tsx` 运行 `bootstrapApplication`（AbortController + 退避重试 1s→30s；`CONFIG_*` 失败为终态保持清屏色，地图阶段失败自动重试），就绪后携带配置、地图上下文与世界变换构造数据源并装配场景；`AgvMonitorScene` 组合 `MapVisualizationFeature` 与 `FleetMonitoringFeature` 并以 Provider 注入车队运行时。
- 工具链齐备：`@/ -> src/` 别名三处一致；脚本含 `lint/typecheck/test:unit/test:architecture`；Vitest（jsdom + Testing Library + `@react-three/test-renderer`）、dependency-cruiser 均已接入。
- 真实浏览器行为不走自动化测试套件：涉及用户行为或浏览器生命周期的验证由执行 Task 的 Coding Agent 调用浏览器自动化技能在真实浏览器中自测，结论记入本文件第 5 节。
- 架构检查（`pnpm test:architecture`）以 `.dependency-cruiser.cjs` 规则校验真实 `src`（188 模块 0 违规），负例证明深层导入、核心 Feature 互导、受限公开入口、反向依赖和循环依赖必被抓到。
- 快速 CI 已建立：`.github/workflows/ci.yml` 执行 lint、typecheck、unit、architecture、build。
- 尚无后台节流与 WebGL 恢复实现；对应实现分属 TASK-015/TASK-016。自适应质量已由 TASK-014 接入（Canvas 内采样 + 迟滞策略 + 组合层能力映射，测试/基准可经 `auto=false` 锁定默认画质与基准 DPR）。相机轨道、自动取景、双击跟随与空格俯瞰已由 TASK-013 接入（双击 follow 请求经 app 组合层转交相机命令，跟随目标经只读读取器逐帧取数）。真实 WS 协议映射与联调属 TASK-021（`WAITING_EXTERNAL`，当前生产配置经默认适配器显式拒绝未映射消息）。

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
| 当前交通四边形 | locked 1 个、applying 3 个，均规范化为无自交凸四边形（A5，最小面积阈值 0.01m²，集成测试锁定） |
| Mock 默认车队 | 60 台（seed 20260901，可经开发桥调至 250），低电量前 2 台保证充电 |
| Mock 验收窗口 | 120s 循环时间线；当前真实地图上首次充电约出现在 172s 仿真时间 |

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
| TASK-008 | Mock 拓扑、运动与充电内核 | 003、006 | `DONE` |
| TASK-009 | Mock 数据源、确定性场景与启动接线 | 007、008 | `DONE` |
| TASK-010 | AGV 程序化模型、槽位与实例批渲染 | 004、006、009 | `DONE` |
| TASK-011 | 图集化 WebGL 车辆标签 | 010 | `DONE` |
| TASK-012 | 选择、告警环与交通资源表达 | 010、011 | `DONE` |
| TASK-013 | 相机、车辆跟随与完整交互 | 004、010、012 | `DONE` |
| TASK-014 | 自适应质量与质量能力接线 | 005、011、012、013 | `DONE` |
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
| Task | `TASK-015 后台节流与前台瞬时对齐` |
| 状态 | `TODO` |
| 当前目标 | 页面隐藏时停止渲染但继续接收每车最新快照，回前台后一帧内与最新状态对齐，不回放或累积中间运动 |
| 当前主要范围 | Fleet 数据生命周期、帧同步、Canvas frameloop、可见性控制、相机/选择恢复和浏览器生命周期测试 |
| 当前已有实现 | `useVehicleDataSource` 持有连接/订阅/ticker 生命周期；`createFleetRuntime` 的 `tick(now)` 只做 1Hz FRESH/STALE 跃迁；帧同步 Hook 以脏集合为唯一输入（回前台强制 diff 的挂点已在 `consumeDirty` 语义内）；相机跟随目标读取器对未知键/非法位置返回 null（目标删除当帧退出）；选择删除清理由 `notifyEntitiesRemoved` 完成；Mock 暂停语义（不积累位移）已在数据源内核实现 |
| 当前待完成 | 以 `TASKS.md` 的 TASK-015 为准实现：`visibilitychange` 对称监听；隐藏期间停止渲染（Canvas frameloop 控制）且 WS/Mock 不断开、只保留每车最新快照；ticker 暂停/恢复时立即重算 freshness；回前台强制全量 diff 与脏槽位提交（一帧对齐、无累计位移）；被删除的选择/跟随目标按既有语义清理；浏览器生命周期自测（模拟后台 10min、多次 update/remove、回前台一帧矩阵一致、监听不重复、隐藏期间确实无渲染） |
| 当前阻塞 | 无 |
| 完成后可开始 | TASK-016（依赖 005、010、011、012、014，均已 `DONE`） |

Task 开始后，把本卡直接替换为实际进行中的工作：当前修改文件、当前成功验证、当前失败原因、当前剩余步骤和下一条可执行命令。Task 完成后删除已解决问题，只保留完成结果和新的当前指针。

## 5. 当前验证状态

| 范围 | 当前命令或检查 | 当前结果 |
|---|---|---|
| Lint | `pnpm lint` | 通过（170 文件，0 警告 0 错误） |
| TypeScript | `pnpm typecheck`（`tsc -b`） | 通过 |
| 单元测试 | `pnpm test:unit`（Vitest + jsdom，58 文件 546 例：TASK-002～013 全部保留；TASK-014 新增/扩展 34 例——render-quality 29 例（policy 21：目标帧率阈值、逐级能力映射与阴影 min 钳制、DPR 上限与非法回退、3s 持续+5s 冷却降级时间线、抖动重置、30s 持续+30s 冷却恢复、0/4 级钳制、setTargetFps 重置、非有限样本忽略、样本钳制、断流重置、reset 清冷却；store 与只读视图 3：幂等 no-op、越界钳制、登记即回调与退订对称；Feature 5：合成帧序列逐级降级+诊断采样合并、车队数切档、auto=false 旁路、4 级 setDpr(1) 落地、渲染 null 与 StrictMode）；fleet +4（重要标签降级中距离抑制与重点保留对照、交通脉冲 uniforms 与开关不影响重建判据、trafficPulseEnabled 帧同步写入）；map +1（dynamicShadowsEnabled/shadowMapSize 灯光换代生效且唯一）；`AgvMonitorScene` +1（质量等级→阴影/脉冲组合层接线）；`App` 外壳扩展锁定 maxDpr/shadowMapSize 传递；`currentMap.integration` 重负载用例显式放宽超时至 30s（全量并行下实测超默认 5s，单独运行 0.8s）） | 通过（546/546） |
| 当前地图集成 | `currentMap.integration.test.ts`：TASK-003/004/005 数据、几何与语义图层事实全部保留；`mockDataSource.integration.test.ts`：默认 60 台位置落在当前地图坐标范围、200s 窗口覆盖全部验收事件（含充电约 172s）、固定 seed 事件序列逐位一致、250 台可用 | 通过 |
| 当前车辆夹具 | `vehicleFixture.integration.test.ts`：`json/vehicle.json` 重新校验——TRAFFIC_WAIT（D5）、LOW_BATTERY、LOADED、ONLINE、locked 1 + applying 3 且经 §5.3 规范化均为无自交凸四边形（A5）、无 INVALID_DATA、运行时 10s STALE 跃迁；`vehicleSceneAlignment.integration.test.ts`（app 组合层）：当前车辆与节点「1644」及方向、centerOffset、部件尺寸矩阵对齐（A4） | 通过 |
| 架构检查 | `pnpm test:architecture`（真实 src 199 模块 0 违规；负例全部命中；正例零误报） | 通过 |
| 构建 | `pnpm build`（含 `copyStaticAssets` 与 `verifyDist`） | 通过 |
| dist 校验 | `pnpm verify:dist`（index/config/map 存在、相对路径引用、白名单与凭据检查、map.json 可解析） | 通过 |
| 部署冒烟 | `pnpm smoke:dist`（根路径与子路径静态冒烟） | 通过 |
| 生产无 Mock 全局 | `grep -c "__AGV_MOCK__" dist/assets/*.js` | 0 命中（死代码消除生效） |
| 差异检查 | `git diff --check` | 通过（无空白错误；仅 CRLF 提示） |
| 浏览器自测 | TASK-014 质量能力自测（Chromium 内嵌面板，dev 模式，1280×720，dataSource=mock）：唯一全屏 Canvas、零 DOM 覆盖层（body 仅 #root + canvas）、设备 DPR=1 下 config maxDpr=1.5 生效值 1、全程无页面错误。逐项结论：① 0 级完整画质——地坪网格、路径、仓库黄垫、充电青桩、独占区、车辆、名称标签与 L1/L2 环全部在场（近景与中景截图存档）；② 经 Vite dev 模块图注入同一 store 实例（测试探针，非产品入口）强制 1 级：中距离普通车名称芯片隐藏、重点车（旁有 L2 红环）与近景车标签保留——同机位 0↔1 对照截图确认与 SPEC §6.5 行动 1 一致；③ 逐级推进 2→3→4：场景持续存活，4 级下车辆、路径、主状态与告警环全部保留（B5 核心语义不隐藏）；④ 恢复 0 级后场景完整如初；⑤ 滚轮缩放贯穿全程正常（交互未受质量接线影响）。自动迟滞 ladder 本身由确定性合成帧序列经真实 useFrame 路径的单测覆盖；本机渲染 60 台远未过载，浏览器内无法自然触发降级（预期）。证据存档 `gui-test-screenshots/task-014/`。环境观察（非缺陷）：内嵌面板被宿主窗口遮挡时页面被节流（TASK-015 产品语义）；IAB 截图/滚轮回执偶发 30s 超时但操作实际生效，重开标签页恢复 | 通过（TASK-014） |

浏览器自测备注：内嵌浏览器面板被宿主窗口遮挡时页面被整体节流（`requestAnimationFrame` 与仿真计时停滞，实测 reload 后 simTime 恒 0），经可见性控制置前面板后数据流恢复；每张强制截图触发一次 BeginFrame 渲染帧，两张截图之间仿真时间跳变数秒，故故障窗口（8～38s）的连续抓帧受限。该现象属已知环境特性，不影响真实前台部署浏览器，后台节流的产品语义归 TASK-015。`config.json` 当前为 `dataSource=mock`。当前车辆夹具与节点「1644」的 §2.5 对齐在数据层由 TASK-006 锁定、渲染路径口径（centerOffset 合成、rotation.y 符号）由几何单测以合成变换锁定，车辆沿真实路网行驶为浏览器目视证据。

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
