# AGV 3D 实时监控大屏 — 产品与技术规格说明书

| | |
|---|---|
| 文档编号 | SPEC-20260901-agv-3d-monitor |
| 版本 | v1.3 |
| 日期 | 2026-09-01 |
| 状态 | 可实施；真实 WebSocket 字段映射需联调 |
| 技术基线 | React 19.2 · @react-three/fiber 9.6 · three 0.185 · TypeScript 6 · Vite 8 |

---

## 1. 项目概述

### 1.1 一句话定位

基于 @react-three/fiber 的 AGV（自动导引车）全屏 3D 实时监控场景：以 50～200 台的常规规模、250 台的压力规模实时呈现车队位置、任务状态、交通资源和告警，供监控值班人员 7×24 小时掌握现场态势。

### 1.2 核心目标

1. **实时性**：车辆位置、车体主状态、场景标签和告警环在有效推送到达后的下一渲染帧呈现。
2. **规模性**：在当前完整地图（4,291 节点、9,265 条逻辑边）上支持 200 台车辆，性能指标见 §6 和 §13。
3. **可靠性**：断网重连、数据过期、脏数据、后台节流、WebGL 上下文丢失等场景不崩溃、不把陈旧数据表示为实时数据。
4. **可演进性**：Mock 与 WebSocket 使用同一归一化事件接口；内部实体保留 `mapId` 维度。
5. **可部署性**：应用与地图资源均为静态资源，连接和地图地址通过运行时配置提供，同一构建产物可部署到不同环境。
6. **可维护性**：源码按业务功能垂直切片，组件、Hook、状态、数据访问、WebGL 外观和测试在 Feature 内共置，并以可自动检查的单向依赖保持高内聚、低耦合。

### 1.3 范围界定

**本期包含：**

- 单一全屏 3D 场景：地面、物理路径、节点、充电站、仓库、停车点、独占区、车辆和交通锁。
- 场景内信息：WebGL 车辆标签、车辆选中环、状态色、警示灯和分层告警环。
- 场景交互：轨道相机、车辆选中、镜头跟随和键盘俯瞰。
- 完整 Mock 模拟引擎，与真实数据源使用同一内部事件模型。
- 独立静态页面、运行时配置、地图自动加载和错误恢复。

**本期不包含：**

- 任务路径预测或计划路径展示。
- 运动轨迹尾巴和历史回放。
- 急停、恢复、派单等任何车辆控制指令；大屏保持只读。
- 顶栏、侧栏、底栏、KPI、车辆列表、车辆详情、车队统计、连接状态、当前时间、告警条、搜索、过滤、按钮、抽屉、对话框、加载进度、错误面板及其他 DOM 覆盖层。
- 多地图切换界面；内部数据模型保留 `mapId`。
- 移动端和触屏适配。
- 地图编辑器。
- 告警历史、告警确认和跨终端告警协作。

---

## 2. 数据规格

### 2.1 当前地图数据（`json/map.json`）

顶层结构为 `{ nodes, edges, zones, nodeEdgeGroups }`，文件大小约 14.94MB，包含一个 `mapId`。

| 数据 | 当前数量 | 字段与处理 |
|---|---:|---|
| `nodes[]` | 4,291 | `id/name/mapId/type/x/y/angle` 等；ID 作为不透明字符串处理 |
| `edges[]` | 9,265 | 5,963 LINE、3,302 BEZIER；保留全部有向边用于拓扑计算 |
| `zones[]` | 0 | 缺失或空数组时跳过；非空时由区域图层适配器处理 |
| `nodeEdgeGroups[]` | 7 | 当前为“独占区1～7”，保留成员节点和成员边关系并渲染静态提示层 |

节点类型分布：

| 类型 | 数量 | 默认表现 |
|---|---:|---|
| `work` | 3,045 | 蓝绿色圆形站点 |
| `warehouse` | 1,185 | 浅黄色仓库站点和地面标识 |
| `charge` | 59 | 青色站点和充电桩地标 |
| `park` | 2 | 紫色停车点标识 |
| 未知类型 | 0 | 灰色通用站点，同时产生一次采样数据告警，不阻断地图 |

节点坐标范围：`x∈[2, 241.03425229898]`、`y∈[-79.3874387915441, 46.5]`。当前节点 `angle` 均为 `null`；渲染器不得依赖节点朝向存在。

### 2.2 逻辑边与物理路径

`edges[]` 是有方向的拓扑边：

- LINE 使用 `sx/sy → ex/ey`。
- BEZIER 是三次贝塞尔曲线，使用 `(s) → (c) → (d) → (e)` 四个控制点。
- `snodeId/enodeId` 必须引用有效节点。
- `maxLoadSpeed/maxFreeSpeed` 是速度上限；当前有效值均为 `1m/s`。
- `maxLoadRotationSpeed/maxFreeRotationSpeed/loadSecurity/freeSecurity` 在当前数据中均为 `null`，类型必须允许空值。
- `isBackEdge` 是业务方向属性，不作为渲染去重的唯一依据。

当前数据含 4,197 对几何完全相同、方向相反的逻辑边。数据层保留 9,265 条逻辑边；地图渲染层按“正向几何与反向几何归一后相同”的签名去重，生成 5,068 条物理路径：

- 3,351 条 LINE 物理路径。
- 1,717 条 BEZIER 物理路径。
- BEZIER 每条采样 24 段；当前数据的抽样最大弦误差约 2.9mm。
- 当前去重后约生成 44,559 个中心线段；方向、限速和拓扑信息仍保留在逻辑边上。

若两个相同端点之间存在几何不同的平行路径，不得按节点对合并，必须使用归一化几何签名区分。

### 2.3 独占区

`nodeEdgeGroups[]` 当前包含 7 个有效分组，每组包含 25～32 个节点和 70～199 条边。独占区按以下规则呈现：

- 成员物理路径增加低透明度蓝色外沿，7 个分组合并为一个静态 BufferGeometry。
- 分组名称放在成员节点包围盒中心；远距离隐藏名称，近距离显示。
- 独占区只提供空间语义，不参与前端交通调度或车辆控制。
- 分组引用不存在的节点或边时只跳过该引用，并记录数据异常。

### 2.4 车辆数据（`json/vehicle.json`）

当前文件是一台车的单车快照：

| 字段组 | 字段 | 类型与规则 |
|---|---|---|
| 身份 | `agvKey`、`agvName`、`type` | `agvKey` 是不透明字符串，禁止转为 number；`type` 是未完成业务映射的枚举值 |
| 位置 | `agvPosition` | `{x, y, theta, localizationScore}`；坐标单位米，`theta` 单位弧度 |
| 尺寸 | `agvDimension` | `{length, width, loadLength, loadWidth, centerOffset}`；单位米 |
| 电量 | `batteryState` | `{batteryCharge, batteryHealth, batteryVoltage, charging}` |
| 原始状态 | `connectionState`、`dispatchState`、`orderState`、`vehicleProcStatus`、`paused`、`loaded` | 分维度派生，不直接压缩为一个业务字段 |
| 告警 | `errorEntryList[]` | 非空表示存在车辆故障；结构未知条目保留在归一化快照和诊断记录中 |
| 速度 | `velocity` | `{vx, vy, omega}`；保留在快照中，不用于推算位置 |
| 交通资源 | `trafficShapeResources` | `{lockedRectangles[], applyingRectangles[]}` |
| 元信息 | `createTime` | 服务端时间戳，仅用于数据诊断；新鲜度使用本地单调接收时钟 |

当前车辆关键值为 `type=1`、`length=1.8`、`width=0.7`、`loadLength=1.8`、`loadWidth=0.7`、`centerOffset=0.25`。车型含义未知时使用通用 AGV 模型，不根据数值猜测叉车结构。

内部实体主键是 `(mapId, agvKey)`。车辆消息没有 `mapId` 时，由当前数据源绑定的地图上下文补入；任何数据源不得跨地图复用同一个实体键。

### 2.5 坐标和车体中心

地图与车辆使用同一平面坐标系。当前车辆位置距地图节点“1644”约 0.000042m，且 `theta` 与相邻 LINE 边方向一致。

- 地图 `(mapX, mapY)` 映射为 Three.js `(worldX, worldY, worldZ)`：`worldX=mapX-originX`、`worldY=0`、`worldZ=mapY-originY`。
- `originX/originY` 由地图包围盒中心确定，地图加载期间只计算一次；车辆到达顺序不得改变世界原点。
- 车辆朝向为数学平面角，0 指向 `+x`；通用模型的本地车头轴为 `+x`，因此 `rotation.y=-theta`。
- `centerOffset` 沿车辆本地车头轴为正方向。车体几何中心为：`centerX=x+centerOffset×cos(theta)`、`centerY=y+centerOffset×sin(theta)`。
- 地图、车辆、交通矩形和独占区必须复用同一个坐标转换函数。
- 若后端坐标系发生变化，通过运行时二维仿射变换配置统一处理缩放、旋转、镜像和平移，不在各渲染组件内分别修正。

### 2.6 派生状态模型

状态分为互不丢失信息的五个维度：

| 维度 | 值 | 派生规则 |
|---|---|---|
| `connectivity` | ONLINE / OFFLINE / UNKNOWN | 根据 `connectionState` 严格映射；未知枚举不得归为 IDLE |
| `freshness` | FRESH / STALE | 本地连续 10s 未收到该车有效更新时为 STALE |
| `operation` | FAULT / PAUSED / CHARGING / TRAFFIC_WAIT / EXECUTING / IDLE / UNKNOWN | 根据错误、暂停、充电、过程状态和订单状态派生 |
| `loadState` | LOADED / EMPTY / UNKNOWN | 根据 `loaded` 派生 |
| `alerts[]` | LOW_BATTERY / CRITICAL_BATTERY / LOW_LOCALIZATION / INVALID_DATA 等 | 允许多个告警同时存在 |

`operation` 的判定顺序是：

1. `errorEntryList` 非空 → FAULT。
2. `paused===true` → PAUSED。
3. `batteryState.charging===true` → CHARGING。
4. `vehicleProcStatus==='TRAFFIC'` → TRAFFIC_WAIT。
5. `orderState==='PROCESSING'` → EXECUTING。
6. 已知空闲组合 → IDLE。
7. 无法识别的组合 → UNKNOWN。

用于车体基础颜色和场景标签状态的 `primaryDisplayState` 按以下顺序投影：

1. STALE：数据已不可信，基础色为冻结灰；最后已知业务状态保留为副徽标。
2. OFFLINE 或 UNKNOWN 连接状态：深灰；最后已知业务状态保留为副徽标。
3. FRESH 时使用 `operation` 对应颜色。

上述正交维度直接驱动车体颜色、场景标签、警示灯和告警环。页面不计算或渲染在线数、执行任务数、空闲数、故障数、平均电量等聚合指标；状态投影不得丢失原始维度，供场景表达和诊断使用。

---

## 3. 数据接入层

### 3.1 归一化事件合同

Mock 和 WebSocket 必须输出同一内部事件模型：

```ts
/*
 * 数据源只向应用层暴露完成校验和地图上下文补全后的事件。
 * 事件类型、序号和删除语义不得由数组长度或空值隐式推断。
 */
type VehicleDataEvent =
  | {
      type: 'snapshot'
      schemaVersion: string
      mapId: string
      sequence: number
      receivedAt: number
      vehicles: VehicleSnapshot[]
    }
  | {
      type: 'update'
      schemaVersion: string
      mapId: string
      sequence: number
      receivedAt: number
      vehicle: VehicleSnapshot
    }
  | {
      type: 'remove'
      schemaVersion: string
      mapId: string
      sequence: number
      receivedAt: number
      agvKey: string
    }
  | {
      type: 'heartbeat'
      schemaVersion: string
      mapId: string
      sequence: number
      receivedAt: number
    }

/*
 * connect 和 disconnect 必须幂等，能够承受 React 开发模式下的重复挂载。
 * 手动断开不会自动重连，网络异常断开才进入重连状态。
 */
interface VehicleDataSource {
  connect(signal?: AbortSignal): Promise<void>
  disconnect(): void
  requestSnapshot(): void
  readonly status: SourceStatus
  onEvent(cb: (event: VehicleDataEvent) => void): Unsubscribe
  onStatusChange(cb: (status: SourceStatus) => void): Unsubscribe
}
```

`SourceStatus` 为 `IDLE | CONNECTING | OPEN | RECONNECTING | CLOSED | ERROR`。

### 3.2 WebSocket 适配规则

- 原始消息先完成 JSON 解析、消息类型识别、版本检查和字段校验，再映射为 `VehicleDataEvent`。
- 全量、增量、删除和心跳必须通过显式消息类型区分。
- 同一连接内只应用比当前序号新的事件；重复或回退序号忽略并记录采样告警。
- WebSocket 本身保证单连接消息有序；连接更换后必须以新的全量快照建立基线，旧连接事件全部失效。
- 全量快照按 `(mapId, agvKey)` 做 diff，缺失实体视为删除；增量更新不得隐式删除其他车辆。
- 单条车辆字段异常只隔离该车；消息外壳无法解析时拒绝整条消息并累计解码错误。
- 真实协议的消息字段、鉴权和快照请求方式集中在 `features/fleet-monitoring/data-source/websocket/protocolAdapter.ts`，不得侵入车辆运行时模型、Hook 或渲染组件。

### 3.3 连接管理

- 异常断开后使用带抖动的指数退避：基础间隔 1s、2s、4s、8s，最大 30s；实际等待在基础值的 80%～120% 内随机。
- 连接连续稳定 60s 后重置退避级别。
- 重连成功后立即请求或等待全量快照；在快照到达前保持 RECONNECTING，不应用新连接上的孤立增量。
- 连接 OPEN 但连续 15s 没有 heartbeat、snapshot 或 update 时视为数据通道异常，主动重连。
- 页面销毁或数据源被程序化断开时停止所有重连计时器。
- 认证信息不得写入 `VITE_*` 或公开配置；使用同源 Cookie、反向代理或运行时获取的短期令牌。

---

## 4. 状态管理与数据流

- 状态按业务功能归属拆分：`fleet-monitoring` 管理车辆选中和活跃告警，`camera-navigation` 管理镜头跟随，`render-quality` 管理质量等级；各功能使用独立的 zustand store，不建立包含所有业务状态的全局万能 Store。
- 车辆矩阵、高频快照、脏槽位和标签图集元数据保存在 `fleet-monitoring` 自有的普通 `Map` 和运行时对象中，不进入 React state 或 zustand。
- 各 Feature 的运行时对象只创建一次；React Context 只注入稳定引用，组件通过窄粒度 selector、命令接口或 `useSyncExternalStore` 订阅所需的低频状态，禁止订阅整份车队快照。
- 数据源连接、事件订阅、1Hz ticker 和浏览器生命周期监听由所属 Feature Hook 建立，并在清理函数中完整释放；连接与清理必须满足 React StrictMode 重复挂载下的幂等要求。
- 跨 Feature 协作由 `app` 组合层通过 props、回调和只读适配器显式连接；禁止 Feature 直接读取其他 Feature 的 Store，也不使用全局事件总线传递业务状态。
- 数据接收只标记发生变化的实例槽位；`useFrame` 每帧批量刷新脏矩阵和颜色，不遍历更新未变化车辆。
- 车辆位置、朝向、车体主状态、场景标签和告警环在下一渲染帧统一更新。
- `lastReceivedAt` 使用 `performance.now()` 等单调时钟记录；1Hz ticker 只处理 FRESH/STALE 跃迁。
- 初始实例容量为 256，满足 250 台压力模式；超过容量时按 256 为步长增加批次，运行时硬上限默认 512。
- 全量快照产生 `added/removed/updated` 集合；删除事件只删除目标车。
- 实例槽位使用空闲链表复用；车辆移除时释放标签图集槽位和自有 GPU 资源。
- 选中或跟随中的车辆被移除时立即清除选择和跟随状态，不保留详情快照。

---

## 5. 3D 场景设计

### 5.1 场景对象与渲染策略

| 对象 | 表现 | 渲染策略 |
|---|---|---|
| 地面 | 程序生成工业地坪和网格刻线 | 按地图包围盒加 10m 边距一次生成 |
| 物理路径 | 深灰路面条带和中线 | 5,068 条去重物理路径合并为静态 BufferGeometry |
| 节点 | work/warehouse/charge/park 四类颜色 | 一个 InstancedMesh，实例颜色区分 |
| 充电站 | charge 节点处充电桩和呼吸灯 | 少量独立 Mesh 或合并同类实例 |
| 仓库 | warehouse 节点地面标识和名称 | 静态合批 |
| 停车点 | park 节点紫色停车标识 | 节点实例与少量符号几何 |
| 独占区 | 成员路径淡蓝外沿和分组名称 | 静态合批，名称按距离显隐 |
| 交通锁 | locked 红色、applying 黄色 | 低频批量重建动态 BufferGeometry |
| 车辆 | 通用程序化 AGV | 多个 InstancedMesh 批次 |
| 车辆标签 | 名称、状态色和电量条 | 图集 + 实例化 billboard，最多两个 Draw Call |
| 选中/告警环 | 选中、L1、L2 的分层光环 | 少量实例化几何，不使用全场景 outline pass |

### 5.2 车辆模型

通用车辆模型按每车 `agvDimension` 构建：

```text
├─ 底盘       长度 × 固定高度 × 宽度，深灰金属
├─ 外壳       车体主体，颜色来自 primaryDisplayState
├─ 方向楔     位于本地 +x 方向，明确表示车头
├─ 载荷平台   loaded=true 时显示，尺寸使用 loadLength/loadWidth
├─ 载荷       loaded=true 时显示通用托盘
├─ 警示灯     FAULT 时红色旋转闪烁，OFFLINE/STALE 时熄灭
└─ 车底阴影   半透明椭圆贴片，不使用真实车辆投影
```

- 车体中心应用 §2.5 的 `centerOffset` 位移后再旋转和平移。
- `length/width/loadLength/loadWidth` 分别进入实例矩阵，不能只使用统一样例尺寸。
- 尺寸必须是有限正数，并限制在配置的安全范围；非法尺寸使用通用默认值并产生 INVALID_DATA。
- `type` 未完成映射时不显示货叉等具有业务含义的结构；车型到模型变体的关系统一由配置提供。
- `loaded`、故障灯等低频可见性使用零缩放矩阵或独立活跃实例表，不使用不存在的 `instanceColor.a`。
- 车辆拾取只对外壳 InstancedMesh 生效，通过 `(batchId, instanceId)` 映射内部实体键。

### 5.3 交通矩形

每个矩形输入包含 8 个有限数值。渲染前执行以下归一化：

1. 转为四个二维点并去除重复点。
2. 按质心极角排序，得到无自交环。
3. 验证凸四边形面积大于最小阈值。
4. 使用统一坐标转换和索引三角化。
5. 无法形成有效凸四边形时跳过该矩形，并为所属车辆增加 INVALID_DATA。

交通资源更新按 100ms 窗口合并；只有归一化几何哈希发生变化时才重建全局交通锁 BufferGeometry，避免每条 2Hz 增量消息触发重建。

### 5.4 光照与工业风格

- 使用方向光和 RoomEnvironment/PMREM 环境光，色调映射为 ACESFilmic。
- 地面和静态地标接收阴影；车辆不投射实时阴影，只显示车底假阴影。
- 默认阴影贴图 2048；方向光 shadow camera 按地图静态包围盒配置。
- 车体使用 MeshStandardMaterial，推荐 `metalness≈0.2`、`roughness≈0.6`。
- 状态不得只靠颜色表达；方向、文字徽标、告警环和图标同时提供语义。

### 5.5 相机

- OrbitControls 支持旋转、平移和缩放，启用阻尼。
- 最小距离 2m，最大距离为地图对角线的 3 倍。
- 初始机位按地图包围盒自动取景，俯视角约 45°。
- 跟随模式保持进入时的相对偏移；手动拖拽立即退出跟随。
- 按空格键回到地图包围盒中心并退出跟随。
- 不提供来自列表、按钮或详情卡的定位飞行；相机运动仅包括初始自动取景、轨道控制、车辆跟随和键盘俯瞰。

---

## 6. 性能预算与策略

### 6.1 验收基准环境

- Windows 11 64 位。
- Intel Core i5-1135G7、Intel Iris Xe、16GB 内存或性能不低于该组合的设备。
- 验收当日 Microsoft Edge 稳定版，开启硬件加速；报告记录浏览器、GPU 驱动和系统版本。
- 1080p 场景使用 1920×1080 Canvas、DPR=1；4K 场景使用 3840×2160 Canvas、DPR=1。
- 性能测试使用当前完整地图、固定 Mock 种子和规定机位，不以远距离隐藏全部标签的方式规避负载。

### 6.2 性能指标

| 场景 | 指标 |
|---|---|
| 100 台、1080p、默认画质 | 帧时间 P50≤16.7ms，P95≤20ms |
| 200 台、1080p、默认画质 | 帧时间 P50≤33.3ms，P95≤40ms |
| 200 台、4K、允许降级至第 2 级 | 帧时间 P50≤33.3ms，P95≤45ms |
| Draw Call | 默认画质、近景标签开启时总数≤150；车辆相关≤12 |
| 冷缓存启动 | 本机静态服务器、压缩开启，导航开始到首帧可交互≤3s |
| 运行稳定性 | 24h 压力运行无崩溃；第 1 小时后到第 24 小时 JS Heap 增长<200MB |

性能测试先关闭自动降级以验证默认画质，再单独验证自动降级行为。记录 `renderer.info.render.calls/triangles/textures`、帧时间分位数、长任务和内存快照；Draw Call 使用 renderer 统计和 Spector.js 捕获交叉验证。

### 6.3 车辆批渲染

- 每个容量批次包含底盘、外壳、方向楔、载荷平台、载荷、警示灯和车底阴影等 InstancedMesh。
- 初始批次容量 256；200 台验收时车辆主体相关 Draw Call 不超过 8，连同标签和光环不超过 12。
- 位置、朝向、尺寸和可见性统一写入实例矩阵；状态颜色写入 RGB `instanceColor`。
- 每帧只提交有脏实例的批次；同一批次的多次更新合并为一次 `needsUpdate`。
- 不参与拾取的实例化子部件关闭 raycast。

### 6.4 标签合批

- 不使用 drei Html，也不为每台车创建独立 SpriteMaterial。
- 使用 2048×2048 名称图集保存最多 256 个 256×64 名称单元；名称增加或变化时只重绘对应单元。
- 标签背景状态色、电量条、选中态和告警态由实例属性和 shader 绘制，不因电量变化重绘名称纹理。
- 标签使用实例化 billboard 平面；一个批次最多两个 Draw Call。
- 标签显隐依据投影尺寸：重点车始终显示；车体投影长度≥8px 时显示全部名称；≥20px 时增加电量条和完整状态。
- 重点车顺序为：选中、FAULT、STALE、OFFLINE、严重低电量、低定位置信度；远景最多显示 20 个重点标签。

### 6.5 自动质量控制

目标帧率根据车辆数确定：不超过 100 台时为 60fps，101～200 台时为 30fps。平均帧时间超过目标预算的 105% 持续 3s 时，每 5s 最多降低一级：

1. 仅保留重点标签和近景标签。
2. 阴影 2048 降为 1024。
3. 关闭动态阴影和交通锁脉冲。
4. DPR 上限降为 1，并停用非关键装饰动画。

平均帧时间低于目标预算的 75% 持续 30s 时，每 30s 最多恢复一级。质量等级变化写入调试指标；不得隐藏车辆、物理路径、主状态或 L1/L2 告警环。

---

## 7. 页面与场景呈现

### 7.1 全屏布局

```text
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                      3D 场景 Canvas                         │
│                     100vw × 100dvh                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- `html`、`body` 和 `#root` 占满视口、无外边距且禁止页面滚动；Canvas 使用 `100vw × 100dvh` 覆盖全部可用区域。
- 页面只挂载一个全屏 3D Canvas，不为隐藏内容预留任何宽度或高度。
- Canvas 外不渲染标题、顶栏、侧栏、底栏、KPI、车辆列表、详情卡、车队统计、连接状态、当前时间、告警条、确认入口、搜索、过滤、按钮、抽屉、对话框、加载进度、错误面板或其他 DOM 覆盖层。
- 设计基准为 1920×1080，并适配 1280px 以上桌面视口和 4K；本期不适配移动端和触屏。

### 7.2 场景内信息表达

- 页面信息只能通过 WebGL 场景对象表达，包括地图对象、车辆、交通锁、车辆标签、状态色、警示灯、选中环和告警环。
- 车辆标签使用实例化 billboard，显示车辆名称、主状态和电量；STALE、OFFLINE 或连接状态 UNKNOWN 时同时保留最后已知业务状态。标签属于 3D 场景，不得使用 DOM、drei Html 或 CSS 覆盖层实现。
- 车辆原始快照、内部 `mapId`、速度、尺寸、订单明细、错误 JSON、数据源状态和聚合统计不在页面展示，仅保留在运行时数据和诊断记录中。
- 页面不提供聚合指标、列表、详情、告警历史、告警确认、搜索或过滤能力。

### 7.3 场景告警

| 层级 | 触发 | 3D 表现 |
|---|---|---|
| L1 提示 | `15%≤batteryCharge<30%`、`localizationScore<0.5` | 黄色外环，不覆盖车体主状态色 |
| L2 告警 | FAULT、OFFLINE、STALE、`batteryCharge<15%`、INVALID_DATA | 红色外环，不统一把车体改成红色 |

- 活跃告警键为 `(mapId, agvKey, alertType)`；条件持续存在时保持同一场景状态，条件恢复后移除对应告警环。
- 选中环、L1 黄环和 L2 红环允许同时存在，按从内到外“选中、L1、L2”排列。
- 坐标无效的车辆无法放置车体和告警环，只写入结构化诊断记录。
- 不创建告警历史，不写入 localStorage，不提供确认操作或声音提醒。
- WS 断连、地图不可用和 WebGL 恢复失败不渲染横幅、文字提示或阻断层；处理规则见 §7.4 和 §11。

### 7.4 加载与失败状态

- 应用从启动到运行始终保持单一全屏 Canvas。配置或地图尚未就绪时只渲染场景清屏色，不显示加载文案、进度或骨架屏。
- 地图加载失败时保留上一份有效 3D 场景；首次加载尚无有效场景时保持清屏色。加载器在后台自动重试并写入结构化诊断记录，不显示错误面板或重试按钮。
- WebSocket 断连时不显示全局状态；已有车辆按 10s 阈值进入 STALE，并通过车体冻结灰、场景标签和 L2 红环表达。
- WebGL 上下文丢失时暂停场景提交并尝试重建 GPU 资源；恢复期间和最终失败后都不挂载 DOM 兜底界面，错误写入结构化诊断记录。

---

## 8. 交互规格

| 操作 | 行为 |
|---|---|
| 拖拽场景 | 通过 OrbitControls 旋转或平移相机 |
| 滚轮 | 缩放相机，距离限制遵循 §5.5 |
| 单击 3D 车辆 | 选中车辆并显示选中环，不展开任何面板且不自动移动相机 |
| 双击 3D 车辆 | 进入跟随模式 |
| 拖拽相机 | 退出跟随 |
| Esc 或点击场景空白 | 取消选中；被选中车辆的告警环保持不变 |
| 空格 | 退出跟随并俯瞰全厂 |

所有交互都直接作用于 Canvas 和 3D 对象，不创建工具栏、按钮、提示气泡、上下文菜单或其他页面元素。车辆拾取只接受主鼠标指针；本期不定义触屏手势。

---

## 9. Mock 模拟引擎

### 9.1 拓扑基线

当前地图有 4 个弱连通分量，节点数分别为 2,001、1,187、796、307，每个分量都含充电站。存在一个无出边工作节点；Mock 必须把死路视为合法拓扑，而不是异常崩溃。

### 9.2 运动模型

- 初始车辆按各连通分量的逻辑边数量比例分配，再从有效有向边上生成。
- 普通行驶只选择当前节点的出边；无出边时车辆停在节点并进入 IDLE，不瞬移、不逆向穿越。
- 车辆目标速度从 0.5～1.5m/s 采样，再限制为当前边对应的 `maxFreeSpeed/maxLoadSpeed`。
- LINE 按弧长线性推进；BEZIER 使用弧长参数化推进，`theta` 使用曲线切线方向。
- 电量低于 25% 时，使用有向图 Dijkstra 寻找同一连通分量内代价最低的 charge 节点；`cost` 非有限或非正时使用物理长度。
- 找不到充电路径时停在当前位置，增加 Mock 专用数据告警，不传送到其他分量。
- 到达 charge 后设置 `charging=true`，充至 90% 再恢复任务。

### 9.3 事件模拟

- 默认随机种子为 `20260901`；相同地图、车辆数和配置必须产生可复现事件序列。
- 默认 60 台，运行时可调至 250 台；超过 256 台需显式启用第二实例批次。
- 基础位置推送频率 2Hz，每次间隔加入 ±50% 抖动。
- 支持接单/完成、故障/恢复、掉线/恢复、暂停、交通等待、充电、低定位置信度、车辆新增和车辆删除。
- 压力验收使用确定性场景脚本，保证所有事件在规定窗口内至少发生一次，不依赖随机概率碰巧命中。
- 交通矩形根据占用路径生成，输出前使用 §5.3 的规范化点序。
- `window.__AGV_MOCK__` 只在开发和 Mock 模式暴露，可修改车辆数、种子、事件开关和模拟暂停状态；生产 WS 模式不得暴露。

---

## 10. 地图加载、配置与部署

### 10.1 运行时配置

应用启动时先读取与 `index.html` 同部署根目录的 `config.json`。配置 URL 使用 `document.baseURI` 解析，支持部署到子目录；`VITE_*` 只允许提供开发默认值，不承担生产运行时配置。

```jsonc
{
  /*
   * 配置文件会公开给浏览器读取，只能包含非敏感运行参数。
   * 密钥、长期令牌和内部凭据不得写入此文件或前端构建产物。
   */
  "dataSource": "mock",
  "mapUrl": "./json/map.json",
  "wsUrl": null,
  "maxVehicles": 256,
  "staleAfterMs": 10000,
  "renderer": {
    "maxDpr": 1.5,
    "shadowMapSize": 2048
  },
  "coordinateTransform": {
    "scale": 1,
    "rotation": 0,
    "mirrorY": false,
    "translateX": 0,
    "translateY": 0
  }
}
```

`wsUrl` 未配置且 `dataSource='ws'` 时停止数据源初始化并写入结构化配置错误，Canvas 保持清屏色，不渲染配置错误页面或覆盖层。HTTPS 页面只允许 `wss:` 或同源安全代理地址。

### 10.2 地图资源发布

- 源数据保存在仓库 `json/map.json`。
- 本地开发服务器必须把它映射为 `./json/map.json`；生产构建流程必须把它复制到 `dist/json/map.json`，不依赖 Vite 默认 public 目录偶然可见。
- 构建后执行资源存在性检查：`dist/index.html`、`dist/config.json` 和 `dist/json/map.json` 缺一即失败。
- 静态服务器必须为 JSON 启用 gzip 或 Brotli；`map.json` 使用带版本的缓存策略，`config.json` 使用 no-cache。
- 地图接口来自其他域时，由部署方配置 CORS；前端不得静默绕过跨域失败。

### 10.3 启动阶段

启动过程按以下阶段上报耗时：

1. 读取并校验 `config.json`。
2. 并行加载地图和初始化数据源。
3. 解析、校验并建立地图逻辑索引。
4. 去重物理路径并创建静态几何。
5. 创建首批车辆实例并完成首次渲染。
6. OrbitControls 和 3D 车辆拾取可交互后记录 `appInteractive`。

各阶段耗时只写入性能指标，不在页面显示。地图失败后的画面、自动重试和恢复行为遵循 §7.4；地图恢复后使用最新车辆快照一次性创建场景，不回放失败期间的中间位置。

---

## 11. 边界情况行为矩阵

| # | 场景 | 行为 |
|---|---|---|
| 11.1 | 单车数据过期 | 以单调接收时钟计算，10s 无有效更新后 `freshness=STALE`；最后业务状态只作为副信息 |
| 11.2 | WS 断连 | 不显示全局 UI；连接层指数退避，已有车辆在 10s 后逐车 STALE 并通过 3D 状态表达；新连接全量快照到达前不应用增量 |
| 11.3 | 定位异常 | `localizationScore<0.5` 显示 L1 黄环；缺失值按 UNKNOWN 处理，不默认伪装成正常 |
| 11.4 | 位置跳变 | 下一帧直接使用新位置，不插值、不推算；内部保留最后接收时间供诊断 |
| 11.5 | 后台节流 | 页面隐藏时暂停渲染，数据源继续保留每车最新快照；回前台强制 diff、恢复 ticker 并瞬时对齐 |
| 11.6 | 车辆增减 | snapshot diff 和 remove 事件均可删除；新增复用空闲实例槽位；选中或跟随中的车辆被删除后立即清除对应状态 |
| 11.7 | 原始 JSON 失败 | 拒绝整条消息、累计解码错误，不修改现有有效数据；连续失败触发数据源 ERROR |
| 11.8 | 单车字段异常 | 隔离该车；非法坐标不渲染车体，只记录 INVALID_DATA；未知枚举保持 UNKNOWN；不创建列表或错误提示 |
| 11.9 | WebGL 上下文丢失 | 暂停提交并尝试重建 GPU 资源；连续 3 次恢复失败后停止渲染并记录错误，页面仍只保留原 Canvas |
| 11.10 | 地图加载失败 | 保留上一份有效场景或清屏色，在后台自动重试；恢复后用最新车辆快照创建场景，不显示错误面板或按钮 |
| 11.11 | 空数据 | 保留完整静态地图且不渲染车辆，不显示空态文案或聚合数字 |
| 11.12 | zones/groups 异常 | 缺失数组直接跳过；无效成员引用逐项隔离，不阻断其他地图元素 |
| 11.13 | 超过容量 | 自动增加 256 容量批次；超过运行时硬上限时保留有效快照，只渲染容量内车辆并记录未渲染数量，不显示页面提示 |

---

## 12. 工程结构与模块边界

### 12.1 组织原则

- `src` 以业务功能为第一分组维度，不建立顶层 `data/`、`scene/`、`hooks/`、`components/` 或 `store/` 技术分层目录。
- 每个 Feature 自己拥有完成该业务能力所需的 React/R3F 组件、Hook、状态模型、数据访问、Three.js 资源、样式和测试；修改一项业务能力时，主要改动必须收敛在一个 Feature 内。
- 每个 Feature 只通过根目录 `index.ts` 暴露最小公开 API。外部模块不得导入其内部文件，Feature 内部也不创建汇总所有文件的多级 barrel。
- `app` 是唯一组合根，只负责启动、依赖选择、Feature 编排和全屏 Canvas 装配，不承载地图去重、状态派生、协议映射、寻路或实例槽位管理等业务算法。
- `shared` 只保存稳定、无业务含义且被多个 Feature 复用的能力。包含 `Vehicle`、`Map`、`Alert`、`Traffic` 等业务词汇的实现不得放入 `shared`；代码只有在至少两个独立 Feature 中出现真实复用且语义一致时才可提升到 `shared`。
- Feature 单元测试、集成测试和夹具与被测实现共置；只有跨 Feature 的端到端测试和性能验收保留在根目录 `tests`。
- 页面没有 Feature 级 DOM 样式。若后续业务范围允许新增 DOM 组件，其 `Component.module.css` 必须与组件共置；WebGL 材质、shader、颜色和几何外观保存在所属 Feature 的 `scene` 目录。

### 12.2 最终目录

```text
json/
├── map.json                                      # 当前完整地图源数据
└── vehicle.json                                  # 单车夹具
public/
└── config.json                                   # 运行时公开配置模板
scripts/
├── copyStaticAssets.mjs                          # 复制地图与运行时配置
└── verifyDist.mjs                                # 校验发布产物完整性
src/
├── main.tsx                                      # React 唯一浏览器入口
├── app/
│   ├── App.tsx                                   # 应用根组件
│   ├── bootstrap/
│   │   ├── bootstrapApplication.ts               # 启动阶段编排
│   │   ├── loadRuntimeConfig.ts                  # 读取并校验运行时配置
│   │   └── selectVehicleDataSource.ts            # 按配置注入 WS 或 Mock 数据源
│   ├── scene/
│   │   └── AgvMonitorScene.tsx                   # Canvas 内的 Feature 组合根
│   └── styles/
│       └── global.css                            # 仅含视口与全局重置
├── features/
│   ├── map-visualization/
│   │   ├── components/
│   │   │   ├── MapVisualizationFeature.tsx       # 地图功能公开根组件
│   │   │   ├── GroundLayer.tsx                   # 工业地坪
│   │   │   ├── PhysicalPathsLayer.tsx            # 去重物理路径
│   │   │   ├── NodesLayer.tsx                    # 节点实例
│   │   │   ├── LandmarksLayer.tsx                # 仓库、充电站与停车点
│   │   │   └── ExclusiveGroupsLayer.tsx          # 独占区提示层
│   │   ├── hooks/
│   │   │   └── useMapVisualization.ts            # 加载、重试和资源生命周期
│   │   ├── model/
│   │   │   ├── types.ts                          # 地图原始类型与只读 MapModel
│   │   │   ├── validateMap.ts                    # 地图字段与引用校验
│   │   │   └── createMapModel.ts                 # 逻辑索引和静态派生模型
│   │   ├── services/
│   │   │   └── loadMap.ts                        # 地图资源读取
│   │   ├── scene/
│   │   │   ├── buildMapGeometry.ts               # 物理边去重与静态几何
│   │   │   └── mapAppearance.ts                  # 地图材质和视觉常量
│   │   ├── __tests__/                            # 地图单元、集成测试与夹具
│   │   └── index.ts                              # MapModel、边界和根组件公开入口
│   ├── fleet-monitoring/
│   │   ├── components/
│   │   │   ├── FleetMonitoringFeature.tsx        # 车队监控功能公开根组件
│   │   │   ├── VehicleInstances.tsx              # 车辆实例批次
│   │   │   ├── VehicleLabels.tsx                 # 图集与 billboard 标签
│   │   │   ├── VehicleRings.tsx                  # 选中及 L1/L2 光环
│   │   │   └── TrafficLocksLayer.tsx             # 交通资源规范化与合批
│   │   ├── hooks/
│   │   │   ├── useVehicleDataSource.ts           # 连接、订阅和 StrictMode 清理
│   │   │   ├── useFleetFrameSync.ts              # 脏槽位的逐帧批量提交
│   │   │   └── useVehicleSelection.ts            # 拾取与选中状态
│   │   ├── model/
│   │   │   ├── types.ts                          # 车辆快照、事件和派生状态
│   │   │   ├── validateVehicle.ts                # 单车隔离校验
│   │   │   ├── deriveVehicleState.ts             # 正交状态与告警派生
│   │   │   ├── fleetMonitoringStore.ts           # 选中和活跃告警低频状态
│   │   │   ├── createFleetRuntime.ts             # 高频 Map、脏集合和查询接口
│   │   │   ├── applyVehicleEvent.ts              # snapshot/update/remove 归并
│   │   │   └── instanceSlots.ts                  # 容量批次和空闲槽位复用
│   │   ├── data-source/
│   │   │   ├── contract.ts                       # VehicleDataSource 公开合同
│   │   │   └── websocket/
│   │   │       ├── WebSocketVehicleDataSource.ts # 重连、心跳和序号管理
│   │   │       └── protocolAdapter.ts            # 真实协议校验与事件映射
│   │   ├── scene/
│   │   │   ├── createVehicleGeometry.ts          # 通用 AGV 几何
│   │   │   ├── labelAtlas.ts                     # 名称图集资源
│   │   │   ├── fleetAppearance.ts                # 车辆、标签与光环视觉常量
│   │   │   └── shaders/                          # 标签和实例属性 shader
│   │   ├── __tests__/                            # 协议、状态、diff、渲染集成夹具
│   │   └── index.ts                              # 数据源合同、只读查询和根组件
│   ├── camera-navigation/
│   │   ├── components/CameraNavigationFeature.tsx # OrbitControls 与相机 Rig
│   │   ├── hooks/useCameraNavigation.ts           # 自动取景、跟随和键盘生命周期
│   │   ├── model/cameraNavigationStore.ts         # 仅保存低频镜头状态
│   │   ├── __tests__/                            # 相机命令和交互测试
│   │   └── index.ts                              # 相机命令与根组件公开入口
│   ├── mock-simulation/
│   │   ├── data-source/MockVehicleDataSource.ts   # VehicleDataSource 的 Mock 实现
│   │   ├── model/
│   │   │   ├── createSimulation.ts               # 仿真时钟与车辆生命周期
│   │   │   ├── motion.ts                         # LINE/BEZIER 弧长运动
│   │   │   └── pathfinding.ts                    # 有向图 Dijkstra
│   │   ├── scenarios/acceptanceScenario.ts        # 确定性压力事件脚本
│   │   ├── __tests__/                            # 固定种子、拓扑和事件测试
│   │   └── index.ts                              # Mock 数据源工厂公开入口
│   └── render-quality/
│       ├── components/RenderQualityFeature.tsx    # Canvas 内质量控制器
│       ├── hooks/useAdaptiveQuality.ts            # 帧时间采样与迟滞控制
│       ├── model/
│       │   ├── qualityPolicy.ts                   # 等级阈值和降级能力
│       │   └── renderQualityStore.ts              # 当前质量等级低频状态
│       ├── __tests__/                            # 降级、恢复和边界测试
│       └── index.ts                              # 质量状态与根组件公开入口
├── shared/
│   ├── diagnostics/                              # 结构化日志、采样和性能指标
│   ├── spatial/                                  # 业务无关二维仿射与世界坐标类型
│   ├── three/                                    # GPU 资源释放和 WebGL 恢复工具
│   └── validation/                               # 有限数值等无业务校验原语
└── vite-env.d.ts
tests/
├── e2e/                                          # 跨 Feature 交互与失败恢复
└── performance/                                  # 启动、帧时间、Draw Call 和 24h 脚本
```

### 12.3 Feature 职责

| 模块 | 单一职责 | 公开能力 |
|---|---|---|
| `app` | 读取配置、选择实现、持有启动状态并组合 Canvas 内各 Feature | 不对外公开业务 API |
| `map-visualization` | 从地图资源生成不可变 `MapModel`，管理世界边界并渲染所有静态地图对象 | `MapModel`、`SceneBounds`、地图查询接口、根组件 |
| `fleet-monitoring` | 接收归一化车辆事件，维护车队运行时，并渲染车辆、标签、告警和交通资源 | `VehicleDataSource` 合同、WS 数据源工厂、只读车队查询、交互回调类型、根组件 |
| `camera-navigation` | 管理轨道相机、自动取景、车辆跟随和俯瞰命令 | `CameraNavigationCommands`、根组件 |
| `mock-simulation` | 基于地图拓扑实现可复现的 `VehicleDataSource` | Mock 数据源工厂和开发控制类型 |
| `render-quality` | 独立采样帧时间并输出质量等级，不直接修改其他 Feature 的状态 | 只读质量状态、能力开关和根组件 |
| `shared` | 提供不含 AGV 业务语义的基础能力 | 按子目录导入，不提供聚合全库的根 barrel |

`AgvMonitorScene` 把 `MapModel`、稳定的世界坐标转换、数据源、只读车队查询和质量能力作为显式 props 或适配器传给对应 Feature。车辆双击产生的跟随请求由该组合层转交给 `camera-navigation`；质量等级也由组合层映射为标签、阴影和装饰能力开关。Feature 之间不得通过隐藏单例或互读 Store 完成协作。

### 12.4 依赖方向

| 导入方 | 允许依赖 |
|---|---|
| `app` | 所有 Feature 的 `index.ts` 与 `shared/*` |
| `map-visualization` | `shared/*` |
| `fleet-monitoring` | `shared/*`；地图模型和坐标转换由 `app` 注入，不导入地图内部实现 |
| `render-quality` | `shared/*` |
| `mock-simulation` | `shared/*`、`map-visualization` 公开的只读拓扑类型、`fleet-monitoring` 公开的 `VehicleDataSource` 合同 |
| `camera-navigation` | `shared/*`、`map-visualization` 公开的场景边界类型、`fleet-monitoring` 公开的只读跟随目标接口 |
| `shared` | 浏览器、React、Three.js 等第三方基础库；不得依赖 `app` 或任何 Feature |

- 依赖图必须保持单向且无环；`map-visualization`、`fleet-monitoring` 和 `render-quality` 之间不得互相导入。
- 跨 Feature 类型使用 `import type`，运行时协作优先通过 `app` 注入的接口、props 和回调完成。
- 禁止 `@/features/<name>/...` 深层导入；Feature 外部只能从 `@/features/<name>` 公开入口导入。
- `@/` 必须在 `tsconfig.app.json` 和 `vite.config.ts` 中一致映射到 `src/`，测试工具复用同一别名配置，禁止依赖仅被某一个工具识别的路径规则。
- `shared` 不得成为未归类代码的落脚点，也不得保存业务 Store、业务组件或协议类型。
- CI 必须执行静态依赖边界和循环依赖检查，发现越层导入、反向依赖或环依赖即失败。

### 12.5 React 与 R3F 组件约束

- `App` 和 `AgvMonitorScene` 只做组合；包含 React/R3F 呈现的 Feature 由一个公开根组件协调内部子组件和 Hook，内部组件保持单一渲染职责。
- 数据连接、计时器、浏览器事件和 GPU 资源生命周期封装在所属 Hook 中；每个 Effect 都必须具备对称清理，并能承受开发模式的 setup→cleanup→setup。
- 纯校验、状态派生、diff、寻路、坐标和几何算法写成与 React 无关的纯函数；不得用 Effect 计算可在渲染前确定的派生值。
- 高频车辆更新不得触发 React 组件树逐车重渲染。`useFrame` 只读取稳定运行时引用并批量写入实例属性，低频 UI 状态使用精确 selector。
- R3F 组件只消费已经校验的模型，不解析协议、不发起网络连接、不读运行时配置文件；数据源组件也不得创建 Three.js 对象。
- Three.js geometry、material、texture 和 render target 由创建它的 Feature 明确拥有并释放；共享静态资源使用 Feature 内引用计数或单一所有者，不依赖隐式垃圾回收。
- 业务组件需要 CSS 时使用同名 CSS Module 共置，不写入 `global.css`；WebGL 外观常量不得散落在组件 JSX 中。
- `index.ts` 只导出跨 Feature 需要的稳定合同，不导出内部 Store、可变 `Map`、实例槽位或 GPU 资源。

### 12.6 工程验证

- Feature 内的 `__tests__` 覆盖其纯模型、Hook 生命周期和 R3F 组件集成；夹具只服务该 Feature 时必须共置。
- 根目录 `tests/e2e` 只覆盖真实用户交互、启动恢复和跨 Feature 协作，`tests/performance` 承担 §6 的统一基准。
- React StrictMode 测试必须证明数据源不会重复连接、计时器不会泄漏、事件监听不会重复注册。
- 依赖边界测试必须证明公开入口可用、内部路径不可跨 Feature 导入、`shared` 无业务依赖且整个 `src` 无循环依赖。
- 高频更新集成测试必须证明车辆消息不会导致 `App`、地图静态层或全部车辆 React 组件逐条重渲染。

运行依赖包括 `@react-three/drei` 和 `zustand`；zustand 仅用于 Feature 自有的低频状态。开发验证依赖包括 Vitest、Playwright 和静态依赖边界检查工具。地图复制、压缩检查、依赖边界检查和产物完整性检查纳入 `dev/build` 或 CI 脚本，不依赖人工执行。

---

## 13. 验收标准

### A. 数据与几何

- [ ] A1 加载当前地图后得到 4,291 节点、9,265 逻辑边、5,068 物理路径、7 个独占区，无丢失引用。
- [ ] A2 work/warehouse/charge/park 四类节点显示正确；未知节点类型使用通用兜底。
- [ ] A3 4,197 对反向重合边只生成一份物理路面，但 Mock 仍保留双向拓扑。
- [ ] A4 当前车辆与节点“1644”、相邻 LINE 边和交通矩形在同一位置；`centerOffset=0.25` 后车体中心正确。
- [ ] A5 当前四个交通矩形均形成无自交凸四边形。

### B. 性能与稳定性

- [ ] B1 按 §6 基准环境，100 台默认画质达到帧时间 P50≤16.7ms、P95≤20ms。
- [ ] B2 200 台默认画质达到帧时间 P50≤33.3ms、P95≤40ms；近景总 Draw Call≤150、车辆相关≤12。
- [ ] B3 冷缓存、压缩开启的本机静态部署中，导航开始到 `appInteractive`≤3s；报告列出各启动阶段耗时。
- [ ] B4 200 台确定性事件流连续运行 24h，无崩溃；第 1 小时后到第 24 小时 JS Heap 增长<200MB，无超过 500ms 的周期性主线程停顿。
- [ ] B5 自动降级和恢复符合 §6.5，任何质量级别都不隐藏车辆、路径、主状态和 L1/L2 告警环。

### C. 数据源与边界

- [ ] C1 snapshot、update、remove、heartbeat、重复序号、回退序号和重连全量对齐均有自动化测试。
- [ ] C2 断网保持 60s 后恢复，30s 内完成重连和全量对齐；期间已有车辆按 10s 阈值进入 STALE。
- [ ] C3 JSON 语法错误、消息外壳错误、字段缺失、非有限数值、未知枚举和非法坐标均符合 §11。
- [ ] C4 标签页后台 10min 后回前台，场景与最新快照一致，无累计位移。
- [ ] C5 WebGL 上下文丢失和恢复流程可演示；无法恢复时停止渲染、记录结构化错误且不创建额外 DOM 界面。
- [ ] C6 地图下载失败时保留上一份有效场景或清屏色并自动重试；成功后 3D 场景直接使用最新车辆状态。

### D. 状态、场景呈现与交互

- [ ] D1 使用多个条件同时成立的组合覆盖状态投影：FAULT+OFFLINE、FAULT+STALE、TRAFFIC+PROCESSING、PAUSED+CHARGING 等。
- [ ] D2 在启动、运行、WS 断连、地图失败和恢复期间，页面始终只有一个全屏 3D Canvas，不出现顶栏、侧栏、底栏、KPI、列表、详情、告警条、按钮或 DOM 覆盖层。
- [ ] D3 车辆名称、主状态、电量、选中态和 L1/L2 告警只通过 WebGL 标签、车体和分层光环表达；条件恢复后对应光环立即移除。
- [ ] D4 3D 单击选中、双击跟随、拖拽退出跟随、Esc/空白取消选中、滚轮缩放和空格俯瞰符合 §8。
- [ ] D5 当前 `vehicleProcStatus=TRAFFIC` 的车辆在车体和场景标签中显示 TRAFFIC_WAIT。

### E. Mock 与交付

- [ ] E1 固定种子重复运行得到相同初始车辆、路径选择和事件时间线。
- [ ] E2 四个连通分量均有车辆；死路车辆安全停止；低电量车辆使用有向路径到达本分量充电站。
- [ ] E3 压力脚本在规定窗口内覆盖故障、掉线、暂停、交通等待、充电、增删车和定位异常。
- [ ] E4 交付本规格、README、运行时配置说明、静态服务器压缩配置和真实协议映射说明。
- [ ] E5 `dist` 包含应用、配置模板和地图资源；部署到根路径与子路径均可启动。

### F. 工程架构与 React 实践

- [ ] F1 `src` 按 §12 的 Feature-Based 结构组织；不存在承载业务实现的顶层 `data/`、`scene/`、`components/`、`hooks/` 或全局业务 Store。
- [ ] F2 Feature 外部只从该 Feature 的 `index.ts` 导入；静态检查确认无深层导入、反向依赖或循环依赖，`shared` 不含 AGV 业务实现。
- [ ] F3 `App` 和 `AgvMonitorScene` 只负责组合；协议映射、地图建模、车辆状态派生、寻路和质量策略均由对应 Feature 独立拥有并测试。
- [ ] F4 React StrictMode 下重复挂载不会造成重复数据源连接、重复计时器、重复事件监听或 GPU 资源泄漏。
- [ ] F5 2Hz 车辆事件持续输入时，高频快照和实例矩阵更新不进入 React state；`App`、地图静态层和未变化车辆不会随每条消息重渲染。
- [ ] F6 Feature 专属组件、Hook、WebGL 外观、测试和夹具均在该 Feature 内共置；跨 Feature 的测试仅保留端到端与性能验收。

---

## 14. 风险与外部依赖

| # | 当前风险 | 影响 | 处理方式 |
|---|---|---|---|
| R1 | 真实 WS 消息外壳、鉴权和快照请求尚未提供 | 真实联调无法完成 | 内部事件合同固定；真实差异限制在 `fleet-monitoring/data-source/websocket` 和连接握手层 |
| R2 | `type` 车型枚举含义未知 | 无法准确显示叉车等变体 | 默认通用 AGV，不根据数值猜测；收到正式映射后只增加配置 |
| R3 | `errorEntryList` 条目结构未知 | 故障原因无法标准化 | 保留原始 JSON 到归一化快照和诊断记录；协议明确后增加结构化映射 |
| R4 | 4K 低配设备可能触发质量降级 | 阴影和装饰效果下降 | 使用 §6.5 的可恢复质量阶梯，核心监控信息不降级 |
| R5 | 地图文件较大且依赖静态服务器压缩 | 弱网络下首屏可能超过 3s | 强制 gzip/Brotli、版本缓存、分阶段耗时和可重试加载 |
| R6 | 后端未来可能提供不同坐标约定 | 位置、方向或比例错误 | 所有对象复用统一二维仿射变换；通过真实车辆与路径夹具验收 |

---

## 附录 A：当前有效决策

- 页面只渲染一个占满视口的 3D Canvas，不提供任何非 3D UI 或 DOM 覆盖层。
- 页面只读，不发送车辆控制命令。
- 车辆实时位置不插值、不推算。
- 地图保留有向逻辑边，渲染去重物理路径。
- 当前完整地图全量加载并静态合批，不做地图分块或编辑。
- 独占区作为静态空间提示显示，不参与前端调度。
- 车辆默认使用通用程序化模型，车型映射不得猜测。
- 状态采用正交维度，并直接驱动车体、场景标签、警示灯和告警环。
- 交通矩形先规范化点序，再参与三角化和合批。
- 标签使用图集和实例化 billboard，不使用 DOM 标签或每车独立材质。
- Mock 使用真实有向拓扑、固定随机种子和确定性验收场景。
- 生产配置通过运行时 `config.json` 提供，敏感凭据不进入前端配置。
- 单地图展示，内部实体使用 `(mapId, agvKey)`。
- 源码按业务 Feature 组织；Feature 只暴露最小公开入口，跨 Feature 依赖保持单向且无环。
