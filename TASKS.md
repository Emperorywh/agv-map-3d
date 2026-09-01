# AGV 3D 实时监控大屏实施任务书

任务书版本：v2.0

适用规格：`docs/SPEC_20260901_agv-3d-monitor.md` v1.3

## 1. 项目终态

本项目交付一个基于 React、`@react-three/fiber` 和 Three.js 的只读 AGV 3D 实时监控页面。页面从启动、运行到异常恢复始终只有一个占满视口的 WebGL Canvas；地图、车辆、标签、状态、告警、交通资源和交互全部在 3D 场景内表达，不存在顶栏、侧栏、列表、详情、按钮、进度、错误面板、图例或其他 DOM 覆盖层。

最终实现必须同时满足：

- 完整加载当前 4,291 节点、9,265 逻辑边的地图，并保留 5,068 条去重物理路径和 7 个独占区。
- 支持 50～200 台常规车队和 250 台压力车队，Mock 与 WebSocket 使用同一归一化事件合同。
- 车辆位置、朝向、主状态、标签和告警在有效事件到达后的下一渲染帧同步更新。
- 正确处理断网、数据过期、脏数据、后台节流、地图失败和 WebGL 上下文丢失。
- 源码按业务 Feature 组织，依赖方向可自动检查，运行时配置和地图支持静态根路径及子路径部署。
- SPEC 第 13 节 A1～F6 均有当前、可复现、可追溯的验收证据。

## 2. 事实来源与不可违反项

### 2.1 事实优先级

1. `docs/SPEC_20260901_agv-3d-monitor.md` 是最高优先级事实来源。
2. SPEC 第 13 节验收标准和附录 A 当前有效决策决定最终完成状态。
3. `json/map.json`、`json/vehicle.json` 是当前数据输入。
4. `docs/prototypes/agv-3d-scene-prototype.png` 只提供工业风格和空间语义参考。
5. `PROGRESS.md` 只描述当前执行状态；若它与 Git 或当前代码不一致，必须先直接修正为当前事实。

原型右下角图例属于禁止的覆盖式信息，不实现。原型道路布局只是示意，实际场景必须由 `json/map.json` 驱动。原型中的货架、设备和车型细节不是产品要求；未知车型统一显示通用 AGV。可以沿用深色工业地坪、深灰路径、青色节点和充电地标、浅黄色仓库标识、紫色停车点、蓝色独占区、红黄交通资源及紧凑 WebGL 标签的视觉语言。

### 2.2 全局边界

- 不修改 SPEC、原型图、`json/map.json` 或 `json/vehicle.json`，除非用户明确要求更新输入或规格。
- 不手工编辑 `dist`；发布产物只能由构建流程生成。
- 不实现 SPEC 之外的 UI、控制命令、轨迹、路径预测、历史、多地图切换、搜索、筛选、移动端或触屏功能。
- 不使用 DOM、`drei Html`、每车独立 Sprite 或每车独立 Material 实现车辆标签。
- 不把高频车辆快照、实例矩阵、脏槽位或图集元数据放入 React state 或 zustand。
- 不允许 Feature 深层跨模块导入、反向依赖、全局事件总线或全局万能 Store。
- 新增或修改的可注释代码文件必须包含说明职责、边界和关键不变量的多行简体中文注释。
- 不主动运行格式化器，不修改无关排版，不清理用户差异，不执行破坏性 Git 命令。

### 2.3 当前数据不变量

- 地图包含 4,291 个节点、9,265 条逻辑边、7 个独占区和 4 个弱连通分量，无悬空引用。
- 节点类型为 3,045 个 work、1,185 个 warehouse、59 个 charge、2 个 park。
- 逻辑边为 5,963 条 LINE、3,302 条 BEZIER；按正反向几何归一后得到 5,068 条物理路径，其中 4,197 条是反向重复几何。
- 当前单车夹具的 `agvKey` 是字符串，位置与节点名称“1644”对齐，`centerOffset=0.25`，`vehicleProcStatus=TRAFFIC`，包含 1 个 locked 和 3 个 applying 交通四边形。
- 上述数值必须由自动化测试从当前输入重新计算；输入发生合法变化时，直接更新本节和相关验收值，不保留旧值说明。

## 3. Task 设计与执行规则

### 3.1 Task 完整性

一个 Task 必须同时满足：

- 能由一个 Coding Agent 在单个上下文中可靠完成。
- 形成业务或技术上内聚的完整增量，不只创建长期未接线的零件。
- 新能力在该 Task 内接入实际调用路径、Feature 根组件或应用组合层。
- 具备自动化验证；涉及用户行为或浏览器生命周期时，在该 Task 内同步增加对应 E2E。
- 对后续 Task 暴露稳定、最小、已测试的公共合同。

Task 的“主要范围”是所有权边界，不是阻止正常实现的逐文件白名单。为完成目标，可以同步调整直接相关的公开类型、Feature 根组件、app 接线、共置测试、构建脚本和 `PROGRESS.md`；不得借机实现后续 Task 或修改无关模块。若发现目标本身必须发生实质变化，应停止并请求用户或 Planner 调整当前任务书。

### 3.2 执行顺序与状态

- 编号表示推荐交付顺序，`依赖`只表示真实技术前置，不把相邻编号自动视为依赖。
- 一个上下文只执行 `PROGRESS.md` 指向的一个 Task。Task 未完成时可以在后续上下文继续同一 Task，但不得把部分结果标为 `DONE`。
- `TODO` 表示尚未开始，`IN_PROGRESS` 表示当前仍需完成，`DONE` 表示代码、接线、测试和当前文档状态全部完成，`BLOCKED` 表示缺少完成目标所需的用户选择或权限，`WAITING_EXTERNAL` 只用于已知外部输入尚未到达的条件任务。
- 条件任务处于 `WAITING_EXTERNAL` 时，不阻塞与它没有依赖关系的内部任务。
- 开始前读取适用规格、当前 Task、`PROGRESS.md`、适用的 `AGENTS.md`、当前代码和 `git status --short --branch`。
- 结束前直接替换 `PROGRESS.md` 中的当前状态、当前验证、当前差异和下一步；不得追加交接日志、验证历史、决策历史或修改过程。
- 不自动提交 Git；只有用户明确要求时才提交。

### 3.3 公共完成标准

从对应脚本建立后，每个 Task 至少执行：

- `pnpm lint`
- `pnpm typecheck`
- 本 Task 对应的 `pnpm test:unit -- <测试路径>`
- `pnpm test:architecture`
- `git diff --check`

涉及应用组合、R3F 渲染、构建或部署的 Task 还必须执行 `pnpm build`。涉及真实用户行为、网络失败或浏览器生命周期的 Task 必须执行对应 Playwright 用例。验证失败时修复当前 Task 范围内的问题并重新验证；只有剩余问题实质超出当前目标时才标记 `BLOCKED`。

## 4. 工程 Task

### TASK-001 工程、单 Canvas 与自动验证基线

- 依赖：无。
- 对应规格：§7.1、§7.4、§12.1～§12.6；D2、F1～F6。
- 完整增量：得到可启动、可构建、可测试的单 Canvas 应用骨架，并用自动检查锁定 Feature-Based 架构和禁止 DOM 覆盖层的约束。
- 主要范围：依赖与锁文件、TypeScript/Vite/Vitest/Playwright 配置、架构检查脚本、快速 CI、`src/main.tsx`、`src/app/**`、模板样式和资源。
- 必做：加入 `@react-three/drei`、zustand、Vitest、Testing Library、jsdom、R3F test renderer、Playwright 和依赖边界工具；统一 `@/ -> src/` 别名；建立 `typecheck/test:unit/test:e2e/test:architecture`；负例证明深层导入、反向依赖和循环依赖会失败；移除 Vite 演示页；从第一帧只挂载一个 `100vw × 100dvh` Canvas；StrictMode 下无重复副作用。
- 验证：依赖锁定安装、lint、typecheck、单元工具链、架构正负例、Playwright 用例列表、单 Canvas DOM 断言和 build 全部通过；页面无滚动、模板文案、按钮或覆盖层。
- 不做：不加载配置、地图或车辆，不创建业务 3D 对象。

### TASK-002 运行时配置、诊断、静态资源与部署基线

- 依赖：TASK-001。
- 对应规格：§3.3、§10、§11、§12.3；B3、E4、E5。
- 完整增量：同一构建产物可从根路径或子路径读取公开配置和当前地图资源；配置失败时仍保持唯一清屏 Canvas，并产生可测试的结构化诊断。
- 主要范围：`src/app/bootstrap/**`、`src/shared/validation/**`、`src/shared/diagnostics/**`、`public/config.json`、静态资源复制/校验脚本、Vite 构建接线和部署冒烟测试。
- 必做：通过 `document.baseURI` 读取并严格校验 dataSource、mapUrl、wsUrl、maxVehicles、staleAfterMs、renderer、coordinateTransform；支持 AbortSignal 和重复启动取消；结构化错误具有稳定代码、级别、上下文、单调时间、采样去重和可注入 sink；显式复制地图到 `dist/json/map.json`；校验 dist 应用、配置和地图；支持根路径与子路径；配置不得包含密钥或长期令牌。
- 验证：合法/非法/取消/网络/JSON/HTTPS-WS 配置测试，诊断采样与隔离测试，`pnpm build`、`pnpm verify:dist` 及根路径和子路径静态冒烟全部通过。
- 不做：不解析地图业务内容，不建立数据源连接，不显示错误 DOM。

### TASK-003 统一坐标、地图校验与不可变 MapModel

- 依赖：TASK-002。
- 对应规格：§2.1～§2.5、§5.5、§9.1、§10.3、§11.10～§11.12；A1～A4、C3、E2。
- 完整增量：应用可以从运行时 mapUrl 加载当前地图，完成逐项隔离校验，建立稳定世界坐标、不可变索引和只读拓扑，并向后续场景与 Mock 暴露最小公共 API。
- 主要范围：`src/shared/spatial/**`、`src/features/map-visualization/model/**`、`services/loadMap.ts`、Feature 公开入口、app 的地图启动接线和共置测试。
- 必做：ID 作为不透明字符串；实际边字段使用 `edgeType`；LINE/BEZIER 分别校验必需坐标及允许的 null；无效引用逐项隔离；未知节点类型保留 fallback；支持 scale、rotation、mirrorY、translateX/Y，并固定变换顺序、方向符号和地图 bounds 中心 origin；建立 node/edge/group 索引、有向出边、弱连通分量、charge 查询、组成员、SceneBounds 和逻辑边物理长度；隐藏可变 Map。
- 验证：当前地图得到 4,291 节点、9,265 逻辑边、7 组、4 个分量和零丢失引用；分量节点数为 2,001/1,187/796/307；节点“1644”、组合仿射、方向、非有限值、未知类型、缺失数组和悬空引用测试通过。
- 不做：不创建 Three geometry 或地图渲染组件，不实现寻路。

### TASK-004 可运行核心地图场景与恢复生命周期

- 依赖：TASK-003。
- 对应规格：§2.2、§5.1、§5.4、§6.3、§7.4、§10.3、§11.10；A1～A3、B2、C6、D2、F3、F4。
- 完整增量：真实地图在唯一 Canvas 内显示工业地坪、去重物理路径和全部节点；地图首次失败保持清屏色，已有场景刷新失败时保留旧场景并自动恢复。
- 主要范围：地图几何构建、Ground/PhysicalPaths/Nodes 图层、MapVisualizationFeature 根组件和 Hook、灯光与环境、资源所有权、app 组合接线及地图 E2E。
- 必做：按正反向归一几何签名得到 5,068 条物理路径；BEZIER 固定采样 24 段；保留逻辑边到物理路径映射；地面按 bounds 加 10m；路径和节点静态合批；一个 InstancedMesh 渲染 4,291 节点；方向光、RoomEnvironment/PMREM、ACESFilmic 和静态 shadow camera 正确接入；加载重试可取消，恢复时原子替换模型和 GPU 资源；创建者明确释放 geometry、material、texture 和 render target。
- 验证：5,068 条物理路径、4,197 条重复几何、约 44,559 个中心线段、节点类型/矩阵/颜色、Draw Call、静态重渲染计数、失败重试、旧场景保留、StrictMode 和资源释放测试通过；应用可见核心地图且 build 通过。
- 不做：不渲染仓库名称、充电地标、停车符号、独占区或车辆。

### TASK-005 地图业务语义图层

- 依赖：TASK-004。
- 对应规格：§2.1、§2.3、§5.1、§5.4、§7.2；A1、A2、B2、F4。
- 完整增量：核心地图增加全部充电、仓库、停车和独占区语义，形成完整可读的静态地图 Feature。
- 主要范围：LandmarksLayer、ExclusiveGroupsLayer、地图专属 WebGL 名称资源、外观常量、MapVisualizationFeature 接线和共置测试。
- 必做：59 个充电节点显示青色充电桩和可关闭的低频呼吸灯；1,185 个仓库节点显示浅黄色地面标识和合批名称；2 个停车点显示紫色符号；7 个独占区把成员物理路径合并为低透明蓝色外沿并在成员节点 bounds 中心显示近景名称；无效成员逐项隔离；所有名称均为 WebGL 内容；资源对称释放。
- 验证：数量、位置、组成员映射、批次和 Draw Call、远近显隐、动画能力开关、未知引用隔离、近远景截图和资源释放测试通过；完整静态地图在应用中可见。
- 不做：不增加货架库存、设备模型、独占调度或 DOM 图例。

### TASK-006 车辆领域模型、事件合同与车队运行时

- 依赖：TASK-001、TASK-002。
- 对应规格：§2.4～§2.6、§3.1、§4、§7.3、§11.1、§11.3、§11.6、§11.8、§11.13；C1、C3、D1、D5、F5。
- 完整增量：形成经校验的 VehicleSnapshot、统一 VehicleDataEvent 合同和不依赖 React 的高频车队运行时，可正确处理快照、增量、删除、新鲜度和多告警。
- 主要范围：`fleet-monitoring/model/**`、`data-source/contract.ts`、Feature 公开合同、低频 Fleet store 和共置测试。
- 必做：实体键为 `(mapId,agvKey)`；`agvKey` 始终为字符串；保留原始状态、速度和未知 error JSON；非法位置/尺寸逐车隔离并传播 INVALID_DATA；严格派生 connectivity、freshness、operation、loadState、alerts 和 primaryDisplayState；snapshot 产生 added/removed/updated，update 不隐式删除；单调接收时间和 1Hz freshness 跃迁；高频快照、脏集合不进入 React state/zustand；低频选择与告警使用窄订阅。
- 验证：四类事件、空快照、重复/删除、地图隔离、10s STALE 恢复、未知枚举、非法数据、多告警和组合状态表驱动测试通过；当前夹具为 TRAFFIC_WAIT、LOW_BATTERY 且 loaded。
- 不做：不建立网络连接、不创建 React/R3F 组件或 GPU 对象。

### TASK-007 WebSocket 数据源与 React 生命周期

- 依赖：TASK-006。
- 对应规格：§3.2、§3.3、§4、§11.2、§11.7、§12.5；C1～C3、F4、F5。
- 完整增量：得到可注入协议适配器和 WebSocket 工厂的可靠 VehicleDataSource，并在 React StrictMode 下安全连接到车队运行时；真实后端字段仍被限制在单一适配边界。
- 主要范围：`fleet-monitoring/data-source/websocket/**`、`useVehicleDataSource`、稳定 Context/Provider、app 的 WS 选择接线和共置测试。
- 必做：connect/disconnect 幂等；完整 SourceStatus；异常断开按 1/2/4/8 秒到 30 秒并加 80%～120% 抖动；稳定 60s 重置；15s 无有效通道事件主动重连；连接代次隔离旧事件；新连接快照前拒绝孤立增量；同连接只接受递增 sequence；手动断开清理全部计时器；协议接口从 unknown 映射为事件或结构化错误；未提供真实映射时明确拒绝而不猜测；Hook 对称管理连接、订阅、ticker 和 AbortSignal。
- 验证：fake socket/timer 覆盖快照、增量、删除、心跳、序号、旧连接、退避、静默超时、手动断开、连续解码失败、重连全量对齐、快速 source 切换、StrictMode 和卸载竞态；地图在 WS 无数据或断连时仍保留。
- 不做：不猜真实鉴权、消息外壳或 snapshot payload，不显示连接 UI。

### TASK-008 Mock 拓扑、运动与充电内核

- 依赖：TASK-003、TASK-006。
- 对应规格：§9.1、§9.2；A3、E1、E2。
- 完整增量：形成纯函数、固定种子、可复现的 Mock 仿真内核，能够在真实有向地图上分配车辆、行驶、寻充和安全处理死路。
- 主要范围：`mock-simulation/model/pathfinding.ts`、`motion.ts`、PRNG、弧长表、仿真领域状态和共置测试。
- 必做：按逻辑边比例覆盖四个弱连通分量；Dijkstra 严格遵守方向；代价非法时使用物理长度；LINE 线性推进；BEZIER 按弧长参数化并使用切线 theta；目标速度 0.5～1.5m/s 后受边上载荷/空载速度限制；低于 25% 寻找本分量 charge，充至 90%；大时间差不累积位移；死路或无路径时安全停止并产生 Mock 数据告警；随机调用顺序稳定。
- 验证：固定种子复现、四分量分配、单向不可达、最近充电点、弧长步长不变性、曲线端点/朝向、速度限制、后台大时间差、死路和完整充电循环测试通过。
- 不做：不创建计时器、数据源生命周期、React 或 Three 对象。

### TASK-009 Mock 数据源、确定性场景与启动接线

- 依赖：TASK-007、TASK-008。
- 对应规格：§3.1、§9.3、§10.3；E1～E3、F4。
- 完整增量：运行时选择 `dataSource=mock` 后，应用通过统一 VehicleDataSource 持续产生可复现车队事件，并保证验收事件在固定窗口内发生。
- 主要范围：Mock simulation 生命周期、MockVehicleDataSource、acceptanceScenario、开发控制桥、selectVehicleDataSource/bootstrapApplication 的 Mock 分支和集成测试。
- 必做：默认 seed 20260901、60 台，可调至 250；2Hz 且间隔 ±50% 抖动；显式产生 snapshot/update/remove/heartbeat；connect/disconnect/requestSnapshot 幂等；暂停不积累位移；确定时间线覆盖接单/完成、故障/恢复、掉线/恢复、暂停、交通等待、充电、低定位、增车和删车；交通矩形按占用路径生成有效点序；`window.__AGV_MOCK__` 仅开发且 Mock 模式存在；Mock 必须在 MapModel 拓扑就绪后创建，WS 初始化不受该屏障限制。
- 验证：完整时间线重复一致、不同 seed 不同、60/250 台、暂停恢复、快照请求、增删生命周期、生产 WS 构建无 Mock 全局、StrictMode 和应用启动集成测试通过。
- 不做：不创建页面控制面板，不依赖概率碰巧命中验收事件。

### TASK-010 AGV 程序化模型、槽位与实例批渲染

- 依赖：TASK-004、TASK-006、TASK-009。
- 对应规格：§4、§5.2、§6.3、§7.2、§11.13；A4、B2、D1、D3、D5、F5。
- 完整增量：Mock 车辆在实际地图上以程序化 AGV 批量渲染，所有车体属性在下一帧同步，并形成 FleetMonitoringFeature 的可运行核心。
- 主要范围：实例槽位管理、createVehicleGeometry、fleetAppearance、VehicleInstances、useFleetFrameSync、FleetMonitoringFeature 根组件、app 接线和 R3F 集成测试。
- 必做：初始容量 256、按 256 扩容、默认硬上限 512；删除复用槽位，超过上限保留快照并记录未渲染数；底盘、外壳、+x 方向楔、载荷平台、托盘、警示灯和车底假阴影按每车尺寸及 centerOffset 进入矩阵；车型未知不显示业务变体；车辆不投实时阴影；多子部件 InstancedMesh 每帧只提交脏批次；外壳拾取映射 `(batchId,instanceId)`；FAULT 警示灯旋转闪烁，OFFLINE/STALE 熄灭；删除清理矩阵和槽位。
- 验证：当前车辆与节点“1644”及方向对齐；下一帧位置/朝向/颜色/载荷/灯同步；0/1/200/250/256/257/512/513 容量、随机增删、拾取、未变化槽位不写、React 渲染计数和 200 台车辆主体 Draw Call≤8 测试通过。
- 不做：不实现车辆标签、选择/告警环或交通锁。

### TASK-011 图集化 WebGL 车辆标签

- 依赖：TASK-010。
- 对应规格：§5.1、§6.4、§7.2；B2、D3、D5。
- 完整增量：每辆可渲染车辆拥有场景内名称、主状态和电量表达，标签在远近景、状态组合和批次扩容下保持可读且不使用 DOM。
- 主要范围：VehicleLabels、labelAtlas、标签 shader、标签实例属性、FleetMonitoringFeature 接线和共置测试。
- 必做：每个 256 容量批次使用 2048×2048 图集及 256 个 256×64 名称槽；名称变化只重绘目标单元；状态、电量、选中和告警走实例属性/shader；billboard 始终朝相机；投影长度 8px/20px 分级；远景最多 20 个重点标签，优先级为选中、FAULT、STALE、OFFLINE、严重低电量、低定位；STALE/OFFLINE/UNKNOWN 保留最后业务状态副徽标；中文名称可用。
- 验证：图集分配回收、局部重绘、中文、LOD 边界、重点排序、状态组合、资源释放通过；单个 256 批次最多两个标签 Draw Call，200 台总计最多两个，257 台最多四个。
- 不做：不使用 DOM/Html、每车 CanvasTexture、每车 SpriteMaterial，不因电量变化重绘名称纹理。

### TASK-012 选择、告警环与交通资源表达

- 依赖：TASK-010、TASK-011。
- 对应规格：§5.3、§7.3、§8、§11.6、§11.8；A4、A5、D3、F4、F5。
- 完整增量：单击车辆即可选中，车辆的 L1/L2 告警和红黄交通资源在场景中正确合批表达；无效交通四边形完整传播为该车 INVALID_DATA。
- 主要范围：VehicleRings、TrafficLocksLayer、useVehicleSelection、交通规范化/哈希工具、车辆校验与告警派生的直接调整、FleetMonitoringFeature 接线和集成测试。
- 必做：选中、L1、L2 环从内到外可同时存在并在条件恢复的下一帧移除；非法坐标车辆不放置车体或环；8 个有限数值转四点、去重、质心极角排序、凸性和面积校验、统一坐标转换、索引三角化；无效矩形跳过并给所属车 INVALID_DATA；交通几何按 100ms 合并窗口且只在规范化哈希变化时重建；locked 红、applying 黄；单击外壳选择，Esc 或空白取消选择，车辆删除立即清理选择；双击只向 app 暴露 follow 请求。
- 验证：当前四个矩形均为无自交凸四边形并与车辆/节点“1644”对齐；多告警叠加/恢复、FAULT+STALE、OFFLINE、低电量、低定位、重复点、凹形、零面积、NaN、乱序、哈希不变、2Hz 合并、选择/取消/删除和高频渲染计数测试通过。
- 不做：不创建告警历史、确认、声音、DOM 文字或相机跟随。

### TASK-013 相机、车辆跟随与完整交互

- 依赖：TASK-004、TASK-010、TASK-012。
- 对应规格：§5.5、§8、§12.3；D4、F3、F4。
- 完整增量：用户可以在唯一 Canvas 中完成轨道浏览、车辆选择、双击跟随、拖拽退出和空格俯瞰，跨 Feature 协作只发生在 app 组合层。
- 主要范围：`camera-navigation/**`、Fleet 与 camera 的公开回调/只读适配器、AgvMonitorScene 桥接和交互 E2E。
- 必做：OrbitControls 旋转/平移/滚轮缩放并启用阻尼；最小 2m、最大地图对角线 3 倍；初始约 45° 自动取景；双击进入跟随并保留相对偏移；相机每帧读取只读目标；手动拖拽或目标删除立即退出；单击只选择不移动；Esc/空白只取消选择；空格退出跟随并回地图中心；只接受主鼠标指针；监听器对称清理。
- 验证：bounds 变化、距离限制、自动取景数学、完整交互序列、单击/双击去抖、拖拽竞争、车辆删除、键盘默认行为、重复挂载监听、公开入口和跨 Feature 依赖检查全部通过。
- 不做：Feature 互读 Store、全局事件总线、列表/按钮定位、位置插值或触摸手势。

### TASK-014 自适应质量与质量能力接线

- 依赖：TASK-005、TASK-011、TASK-012、TASK-013。
- 对应规格：§6.1、§6.5、§12.3；B5、F3、F5。
- 完整增量：Canvas 内持续采样真实帧时间并按稳定迟滞策略调整质量；地图、车辆标签、交通效果、阴影、DPR 和装饰动画通过 app 显式接收能力开关。
- 主要范围：`render-quality/**`、app 质量能力映射、地图/Fleet/灯光公开 props 和共置测试。
- 必做：不超过 100 台目标 60fps，101～200 台目标 30fps；预算 105% 持续 3s 时每 5s 最多降一级；75% 持续 30s 时每 30s 最多升一级；四个降级动作严格按 SPEC 顺序；测试/基准可关闭自动降级；帧样本不进入 React 高频 state；任何级别都保留车辆、路径、主状态和 L1/L2；质量变化记录诊断指标。
- 验证：阈值边界、抖动、车辆数切换、逐级降/恢复、合成帧序列、真实 useFrame、能力 props、基准锁定 DPR=1、核心语义不变和 build 通过。
- 不做：不增加画质按钮、状态 UI 或隐藏核心对象。

### TASK-015 后台节流与前台瞬时对齐

- 依赖：TASK-009、TASK-010、TASK-013、TASK-014。
- 对应规格：§11.4、§11.5；C4、F4、F5。
- 完整增量：页面隐藏时停止渲染但继续接收每车最新快照，回前台后一帧内与最新状态对齐，不回放或累积中间运动。
- 主要范围：Fleet 数据生命周期、帧同步、Canvas frameloop、可见性控制、相机/选择恢复和浏览器生命周期测试。
- 必做：`visibilitychange` 监听对称清理；隐藏期间只保留最新状态；WebSocket 和 Mock 均不断开；ticker 暂停或恢复时立即重算 freshness；回前台强制全量 diff 和脏槽位提交；被删除的选择/跟随目标按既有语义清理；不累积仿真位移。
- 验证：模拟后台 10min、多次 update/remove、回前台一帧矩阵与最新快照一致、无累计位移、选择/相机状态正确、监听不重复且隐藏期间确实无渲染；对应 E2E 通过。
- 不做：不回放中间事件，不显示后台状态 UI。

### TASK-016 WebGL 上下文丢失与恢复

- 依赖：TASK-005、TASK-010、TASK-011、TASK-012、TASK-014。
- 对应规格：§7.4、§11.9、§12.5；C5、F4。
- 完整增量：唯一 Canvas 遭遇 WebGL 上下文丢失后暂停提交，并利用各 Feature 已有资源所有权和最新模型/快照恢复完整场景；连续三次失败后安全停止渲染。
- 主要范围：Canvas 上下文控制、app 恢复编排、各资源所有者的最小 recreate/dispose 适配、恢复集成测试和 E2E。
- 必做：context lost 时 `preventDefault`；暂停帧提交；按地图、环境、车辆、标签、环、交通资源的确定顺序恢复；恢复期间继续保留最新数据；重复释放幂等；部分重建失败回滚；失败计数作用域明确；连续三次失败后记录结构化错误并停止渲染；页面仍只有原 Canvas；StrictMode 无监听和 GPU 资源泄漏。
- 验证：浏览器事件及真实 `WEBGL_lose_context` 路径覆盖一次成功恢复、恢复中车辆更新、部分失败、连续三次失败、重复挂载和 dispose/recreate 计数；恢复 E2E 和 build 通过。
- 不做：不预建脱离真实资源所有者的万能注册表，不创建第二 Canvas、DOM 兜底、自动刷新或新业务外观。

### TASK-017 启动编排、失败恢复与跨 Feature 回归

- 依赖：TASK-007、TASK-009、TASK-013、TASK-015、TASK-016。
- 对应规格：§7.4、§8、§10.3、§11、§12.2、§12.3；B3、C1～C6、D2～D5、F3～F6。
- 完整增量：完成最终启动状态机和跨 Feature 故障恢复回归，确保每个此前已接入的垂直增量在真实浏览器组合中共同工作。
- 主要范围：bootstrapApplication、selectVehicleDataSource、AgvMonitorScene、开发/测试隔离接口、`tests/e2e/**` 和发现的当前组合缺陷所属文件。
- 必做：配置完成后，WS 可与地图加载并行初始化，Mock 在 MapModel 就绪后初始化；记录 config、map、index、geometry、instances、appInteractive 阶段；配置失败、首次地图失败、旧地图刷新失败、地图恢复、WS 缺 URL、断网 60s、空数据、后台 10min、WebGL 恢复都保持唯一 Canvas；地图恢复直接使用最新车辆快照；覆盖单击、双击、空白、Esc、拖拽、滚轮、空格、snapshot/update/remove、TRAFFIC_WAIT 和多告警语义。
- 验证：`pnpm test:e2e` 在 Chromium 通过；可用时同步运行本机 Edge channel；1280、1080p 和 4K 布局断言通过；网络和时间使用确定 fake/route；全量快速流水线和 build 通过。
- 不做：不创建产品测试面板，不用 DOM 文字代替 WebGL 状态断言，不新增规格外功能。

### TASK-018 性能基准、指标采集与针对性调优

- 依赖：TASK-017。
- 对应规格：§6.1～§6.5、§10.3；B1～B3、B5。
- 完整增量：得到可复现、机器可读的 100/200 台、1080p/4K 和冷缓存性能基准工具，并在当前执行环境完成冒烟及当前结果报告；正式目标硬件结论由 GATE-001 给出。
- 主要范围：`tests/performance/**`、性能 Playwright 配置、只读诊断指标导出、Mock/相机测试配置、性能脚本，以及为达到结构预算所需的直接渲染优化。
- 必做：固定 seed、当前完整地图、规定近景机位和 DPR=1；禁用自动降级验证默认，再启用验证质量；交互就绪后预热 30s，再采样 120s；排除页面隐藏、上下文丢失和测试布置帧；报告 P50/P95、renderer calls/triangles/textures、长任务、启动阶段和原始样本；冷缓存至少运行 5 次并保留每次结果；压缩静态服务器参与冷启动；Spector.js 交叉验证步骤固定；不通过隐藏标签规避负载。
- 验证：短时性能冒烟可重复；200 台车辆相关 Draw Call≤12、默认近景总数≤150；报告能够自动判定 SPEC B1～B3/B5，但只有符合 §6.1 的机器结果才能把 GATE-001 标为通过。
- 不做：不篡改阈值、不降低核心语义、不把当前机器结果冒充目标硬件结论。

### TASK-019 稳定性压力工具与短时故障注入

- 依赖：TASK-018。
- 对应规格：§6.2、§13 B4；B4、E3、F4。
- 完整增量：得到可中断、可恢复、可机器判定的 200 台稳定性 runner 和分析器，并用短时运行证明事件覆盖、采集和故障检测有效；正式 24h 结论由 GATE-002 给出。
- 主要范围：`tests/performance/**` 中 soak runner/分析器、Mock 验收场景测试接线、报告模板和 package 脚本。
- 必做：固定 seed、机位、DPR 和事件时间线；同一浏览器会话使用同一 JS Heap 采集接口；记录崩溃、上下文丢失、主线程 >500ms 停顿、renderer 资源、计时器/监听和事件覆盖；不自动刷新；中断时写入可继续的当前检查点；短时模式必须覆盖故障注入、资源增长判定和报告失败路径。
- 验证：分析器单测和至少 10min 的 200 台短时运行通过，能正确识别故意注入的 heap 增长、长任务、上下文丢失及事件缺失；短跑不得把 GATE-002 标为通过。
- 不做：不以刷新掩盖泄漏，不把短时结果换算成 24h 成功结论。

### TASK-020 当前交付文档、部署样例与完整 CI

- 依赖：TASK-017、TASK-018、TASK-019。
- 对应规格：§10、§12.6；E4、E5、F2。
- 完整增量：部署方和联调方能够仅依据当前文档安装、构建、测试、部署和识别尚未通过的外部 Gate；CI 自动保护全部快速验证。
- 主要范围：`README.md`、`docs/` 下当前部署/协议/验收文档、静态服务器配置、CI workflow、package 验证脚本和交付收敛脚本。
- 必做：记录当前有效的开发/构建/测试命令、config 全字段、安全边界、根/子路径、JSON gzip/Brotli、map 版本缓存、config no-cache、CORS、WS 映射边界、性能/soak 运行方法和 Gate 状态；CI 执行 lint、typecheck、unit、architecture、build、dist、E2E 冒烟、性能短跑和 soak 分析器测试；发布包缺少应用、配置或地图时失败。
- 验证：全新目录按 README 可安装、构建和预览；根路径与子路径启动；CI 配置语法和全部快速流水线通过；文档只保留当前状态，不含追加式日志或已失效方案。
- 不做：不宣称未完成的真实 WS、目标硬件性能或 24h 结果，不嵌入凭据。

### TASK-021 真实 WebSocket 协议联调

- 状态前提：外部必须提供真实消息样例或 Schema、协议版本、鉴权方式、快照请求方式以及可用联调端点或录制夹具；资料未齐时为 `WAITING_EXTERNAL`。
- 依赖：TASK-007、TASK-017；不依赖 TASK-018～020。
- 对应规格：§3.2、§3.3、R1、R3；C1、C2、E4。
- 完整增量：真实全量、增量、删除、心跳、鉴权和快照请求只在协议边界完成映射，并通过实际或录制重连验证与内部运行时全量对齐。
- 主要范围：protocolAdapter、WebSocketVehicleDataSource 的握手/请求接线、脱敏协议夹具、非敏感运行时连接项、协议测试和当前协议文档。
- 必做：保存脱敏真实夹具；严格校验版本、类型和字段；补全 mapId；单车异常隔离；保持连接代次和 sequence 语义；HTTPS 安全；敏感信息只通过 Cookie、代理或短期令牌；断网保持 60s 后恢复并在 30s 内完成重连和全量一致。
- 验证：真实或正式录制的四类消息、错误夹具、鉴权/快照路径、旧连接隔离、断网重连、snapshot 对齐和协议字段表全部通过；应用仍满足单 Canvas 和无连接 UI。
- 不做：不修改 Fleet runtime、Mock、渲染或状态规则迎合协议，不把长期 token 写入 config/VITE，不容忍未知外壳。

## 5. 验收 Gate

Gate 是交付判定，不是要求一个 Coding Agent 在单上下文持续等待的工程 Task。Gate 只直接替换当前验收报告和 `PROGRESS.md` 中的当前结果，不追加运行历史。

### GATE-001 目标硬件性能验收

- 前置：TASK-018 `DONE`；具备 SPEC §6.1 指定或有充分证据证明性能不低于该组合的 Windows/Edge/GPU 环境。
- 执行：使用 TASK-018 固定协议完整运行 100 台 1080p、200 台 1080p、200 台 4K、Draw Call、冷缓存启动和自动质量控制验收。
- 通过条件：B1、B2、B3、B5 全部达到 SPEC 阈值，原始 JSON、环境、Edge、GPU 驱动和 Spector.js 证据完整。

### GATE-002 24h 稳定性验收

- 前置：TASK-019 `DONE`；具备连续 24h 运行窗口和报告存储空间。
- 执行：200 台确定性事件流连续运行 24h，不刷新页面；第 1 小时形成基线，第 24 小时使用相同接口比较。
- 通过条件：无崩溃，第 1h 到第 24h JS Heap 增长 <200MB，无超过 500ms 的周期性主线程停顿，事件覆盖和资源指标完整。

### GATE-003 全量交付验收

- 前置：TASK-001～TASK-021 全部 `DONE`，GATE-001 和 GATE-002 均通过。
- 执行：逐项复核 SPEC 第 13 节 A1～F6、根/子路径 dist、压缩、真实 WS、单 Canvas、无禁用 UI、依赖图、工作区差异及当前交付文档。
- 通过条件：所有验收项均有当前成功证据；任何未达项保持失败或阻塞，项目只有在全部通过时为 `COMPLETE`。

## 6. 验收追踪矩阵

| 验收组 | 主要工程 Task | 最终 Gate |
|---|---|---|
| A1～A3 地图、拓扑与去重 | TASK-003～TASK-005、TASK-008 | GATE-003 |
| A4～A5 坐标、车体和交通四边形 | TASK-003、TASK-010、TASK-012 | GATE-003 |
| B1～B3 性能、Draw Call 与启动 | TASK-004、TASK-010、TASK-011、TASK-017、TASK-018 | GATE-001、GATE-003 |
| B4 24h 稳定性 | TASK-019 | GATE-002、GATE-003 |
| B5 自动质量控制 | TASK-014、TASK-018 | GATE-001、GATE-003 |
| C1～C3 数据源与脏数据 | TASK-003、TASK-006、TASK-007、TASK-012、TASK-021 | GATE-003 |
| C4 后台恢复 | TASK-015、TASK-017 | GATE-003 |
| C5 WebGL 恢复 | TASK-016、TASK-017 | GATE-003 |
| C6 地图恢复 | TASK-004、TASK-017 | GATE-003 |
| D1 状态组合 | TASK-006、TASK-010～TASK-012 | GATE-003 |
| D2 单 Canvas、无 DOM UI | TASK-001、TASK-002、TASK-017 | GATE-003 |
| D3 WebGL 状态表达 | TASK-010～TASK-012 | GATE-003 |
| D4 交互 | TASK-013、TASK-017 | GATE-003 |
| D5 TRAFFIC_WAIT | TASK-006、TASK-010、TASK-011、TASK-017 | GATE-003 |
| E1～E3 Mock | TASK-008、TASK-009、TASK-019 | GATE-002、GATE-003 |
| E4～E5 交付 | TASK-002、TASK-020、TASK-021 | GATE-003 |
| F1～F3 架构与组合 | TASK-001、TASK-003～TASK-017、TASK-020 | GATE-003 |
| F4 生命周期 | TASK-004、TASK-005、TASK-007、TASK-009～TASK-016、TASK-019 | GATE-002、GATE-003 |
| F5 高频更新 | TASK-006、TASK-010～TASK-015、TASK-018 | GATE-001、GATE-003 |
| F6 共置与公开边界 | TASK-001、所有 Feature Task、TASK-020 | GATE-003 |

## 7. 当前规划维护规则

- 本文件始终描述当前有效任务结构。规格、输入或实现事实发生变化时，直接修改相关 Task、依赖、验收值和矩阵，删除失效内容。
- `PROGRESS.md` 始终只保留当前指针、当前状态、当前差异、当前验证和当前阻塞，不保存历史账本。
- 不为了记录“曾经有多少 Task”“某次如何调整”或“过去为何失败”追加章节；需要版本历史时使用 Git，而不是在当前实施文档中累积修改过程。
- 执行中发现缺陷时，优先在拥有该能力的当前 Task 内完成闭环；只有缺陷构成新的内聚工程能力或实质改变范围时，才调整本任务书。
