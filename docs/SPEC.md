# SPEC_factory_3d_map — AGV 工厂地图 3D 可视化（v1）

> 本文档是 v1 的唯一工程规格。技术版本、输入契约、模块边界、性能环境和验收口径均在本文中固定，不从旧系统继承兼容、灰度、fallback 或 deprecated 行为。
> v1 目标：在 Three.js 中把 AGV 调度地图（节点 + 路径）渲染进一个**完整的工厂建筑**里，形成明亮工业写实风格和明确空间层次；无对象级交互，相机可漫游。

---

## 1. 背景与目标

### 1.1 v1 范围

- 加载一份 AGV 调度地图数据（mapJson 格式，见 §3），在 3D 工厂场景中渲染：
  - **路径**：地坪漆面标线带（贴地），含方向箭头
  - **节点**：地贴圆点 / 圆环（按类型分色），站点含朝向符号
  - **标签**：节点/路径名称（CSS2D 悬浮，带距离阈值）
- 工厂环境：地坪、围墙（带窗带）、屋顶钢桁架（不封顶）、天空与室外外景
- 相机：45° 斜视全景初始机位，OrbitControls 漫游（旋转/缩放/平移）

### 1.2 非目标（v1 明确不做）

- 机器人/车辆、实时位置、WebSocket、交管可视化
- 任何对象级交互：点击、悬停、选中、拖拽、右键菜单、Tooltip
- 地图编辑、区域（zones）、nodeEdgeGroups、多楼层
- 货架/设备道具及其资源加载管线
- 主题切换（仅明亮工业写实单主题）
- 低空飞入动画、路径流动动画

### 1.3 运行环境

- 展厅画布 CSS 尺寸为 **3840 × 2160**，操作系统显示缩放与浏览器缩放均固定为 **100%**
- WebGL2；验收浏览器使用目标展厅机器上交付时冻结的 Chromium 稳定版，并在验收报告中记录完整版本与 WebGL renderer 字符串
- 参考硬件下限：Intel Core i5-12400 / AMD Ryzen 5 5600 同级 CPU、16GB 内存、NVIDIA RTX 3060 / AMD RX 6600 同级独立显卡
- 4K 画质优先，持续漫游场景的性能门槛见 §10.2；低于参考硬件不属于 v1 性能承诺范围

### 1.4 页面容器

- `html`、`body`、`#root` 与 FactoryMapPage 均固定占满 viewport，`margin=0`、`overflow=hidden`；必须移除脚手架的 1126px 最大宽度、边框和深色媒体查询
- Canvas 与 CSS2D overlay 使用同一个 `position: relative` 宿主，宽高100%；viewport 任一维为0时暂停 setSize/render，恢复为正数后重新计算 projection 与标签候选
- 页面固定 `color-scheme: light`，不响应系统深色主题
- loading/preparing/empty/error 使用 Canvas 上方的普通 DOM overlay；重试/刷新按钮必须可键盘聚焦并带明确中文文本

---

## 2. 技术选型

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 框架 | React 19.2.8 + TypeScript 6.0.3 + Vite 8.1.5 | react 与 vite 同仓库 `pnpm-lock.yaml` 基线一致，TypeScript 锁定 6.0.3；实施前把 `package.json` 改为精确版本并由 lockfile 固定 |
| 3D | three 0.185.1 + @react-three/fiber 9.6.1 + @react-three/drei 10.7.7 | drei 提供 OrbitControls / Sky；three 与 fiber 同 lockfile 基线一致，drei 不在当前基线中，实施时新增并锁定精确版本；禁止使用未锁定的版本范围 |
| 数据 | `public/map.json` 运行时 fetch + 专用 Web Worker 解码/校验/构建场景数据 | 换图只换文件，不重新打包；主线程不解析 6.5MB JSON、不构建路径顶点 |
| 标签 | 与 three 同版本的 `CSS2DRenderer`，封装在 `Css2dLabelRendererAdapter` | 不使用 drei Html；DOM 数量由全局硬上限控制 |
| 地坪纹理 | 确定性 Canvas 程序纹理，512 × 512 | v1 的唯一实现，不探测、不加载外部混凝土贴图 |
| 测试 | Vitest 4.1.10 + @playwright/test 1.62.1 | 两者均不在当前仓库基线中，实施时新增并锁定精确版本；`pnpm test` 只运行无浏览器测试；浏览器/性能脚本由验收人员显式启动 |

- 所有依赖（含 devDependencies）必须使用精确版本并提交 `pnpm-lock.yaml`；不得使用 `^`、`~` 或 `r160+` 一类开放范围
- `three/addons`、R3F 与 drei 必须使用上表同一版本基线，不允许分别升级
- `test` / `test:browser` / `test:perf` 脚本当前尚不存在于 `package.json`，由 M0 随测试依赖一并建立

---

## 3. 数据契约

### 3.1 唯一输入形态

- 默认 URL：`/map.json`（`public/map.json`），允许用环境变量 `VITE_MAP_URL` 指定同契约的另一个 URL
- 单次请求超时固定为 `MAP_REQUEST_TIMEOUT_MS=15,000`，由 PageController 的 AbortController 实施
- 唯一合法顶层结构：`{ code, message, data: { currentMapInfoVersion: { mapJson } } }`
- 顶层未列出的字段（如 `timestamp`）一律忽略，不视为非法信封
- `code` 必须严格等于 `200`；`mapJson` 必须是对象；原始 mapJson 本体不作为合法顶层输入
- 换数据源时由新的 `MapRepository` 适配器转换为上述信封，领域层和场景构建层不识别传输协议差异
- MapRepository 读取 response body stream；`Content-Length` 或实际累计字节超过 `MAX_MAP_BYTES=20MiB` 时立即中止并返回 `MapCapacityError`
- Worker 接收 transferable ArrayBuffer，用 `new TextDecoder('utf-8', { fatal: true })` 解码后依次执行 JSON 解析、信封解码、字段校验、领域规范化和场景数据构建；成功后通过 transferable TypedArray 返回主线程

### 3.2 原始消费字段

原始数据字段远多于此（限速/交管/动作/车辆组等）。解码器只读取以下字段；未列出的业务字段不进入领域模型：

```ts
interface MapJson {
  nodes: MapNode[];
  edges: MapEdge[];
  zones?: unknown[];          // v1 忽略
  nodeEdgeGroups?: unknown[]; // v1 忽略
}

interface MapNode {
  id: string;
  name: string;
  type: "node" | "work" | "park" | "charge";
  /** 平面坐标，单位：米。数学坐标系：x 向东，y 向北（y 增大 = 北） */
  x: number;
  y: number;
  /** 朝向，弧度。0 = +x（东），逆时针为正。null = 无朝向（不画朝向符号） */
  angle: number | null;
}

interface MapEdge {
  id: string;
  name: string;
  /** LINE 或三次贝塞尔；不存在其他合法值 */
  edgeType: "LINE" | "BEZIER";
  /** 起点/终点平面坐标，米 */
  sx: number; sy: number; ex: number; ey: number;
  /** 贝塞尔两个控制点；LINE 时四项必须全为 null，BEZIER 时四项必须全为有限数值 */
  cx: number | null; cy: number | null;
  dx: number | null; dy: number | null;
  /** 反向路径标识：true = 反向（红色语义），false = 正向（灰色语义） */
  isBackEdge: boolean;
  /** 起止节点 id 引用；必须引用当前 mapJson 中存在的节点 */
  snodeId: string; enodeId: string;
}
```

### 3.3 解码、不变量与错误策略

解码器输入类型固定为 `unknown`，不得把 `response.json()` 结果直接断言为 `MapJson`。校验完成后才创建只读领域模型 `FactoryMap`。

| 规则 | 处理 |
| --- | --- |
| 集合字段 | nodes / edges 必须是数组；数组项必须是非 null object |
| 输入字节 | UTF-8 payload 不得超过 `MAX_MAP_BYTES = 20MiB` |
| `id` / `name` | 必须是非空字符串；节点 id、边 id 各自唯一 |
| 数值字段 | 必须是 JSON number 且 `Number.isFinite`；坐标绝对值不得超过 1,000m（避免 float32 顶点在远离原点处出现毫米级量化） |
| 地图范围 | bbox 宽度和深度均不得超过 `MAX_MAP_EXTENT = 220m`；加 margin 后在 4:3 画幅的 fit 距离仍不超过 ORBIT_MAX_DIST=350m |
| `node.type` | 只接受 node/work/park/charge；其他值返回 `MapValidationError` |
| `angle` | node 类型必须为 null；站点只接受 null 或有限弧度值；有限值进入领域模型时规范化到 `[-π, π)` |
| `edgeType` | 只接受 LINE/BEZIER；其他值返回 `MapValidationError` |
| `isBackEdge` | 必须是 boolean，不接受 0/1 或字符串转换 |
| 控制点 | LINE 必须全部为 null；BEZIER 必须全部为有限数值；不做类型降级 |
| 节点引用 | `snodeId` / `enodeId` 必须存在；端点坐标与节点坐标允许存在业务偏差，不要求相等 |
| 路径长度 | 按几何弧长计算；`L < 0.01m` 返回 `MapValidationError`，不静默跳过 |
| 容量 | `nodes.length + edges.length <= 20,000`；超出返回 `MapCapacityError` |
| 空数据 | nodes 与 edges 同时为空时产生 `empty` 页面状态；nodes 为空但 edges 非空因引用不成立而校验失败 |

错误对象必须包含稳定错误码、字段路径和可展示的简体中文摘要，例如 `MAP_NODE_TYPE_INVALID`、`nodes[17].type`。不得忽略坏记录后继续渲染，也不得把未知值转换成其他合法类型。

### 3.4 基准数据规模（性能预算依据）

| 指标 | 量级 |
| --- | --- |
| 节点 | 1767（node 1303 / work 389 / park 64 / charge 11） |
| 路径 | 3043（LINE 2934 / BEZIER 109） |
| 反向路径 | 878（与正向几何大量共线重叠） |
| 地图范围 | 167.84m × 75.32m，坐标为真实世界米制 |
| 单条路径长度 | 中位数约 1.44m，最短约 0.04m，最长约 15.46m |
| 文件体积 | 6.53MB |

---

## 4. 坐标系与单位约定

### 4.1 映射公式（全项目唯一约定）

- **1 世界单位 = 1 米**，地面为 XZ 平面，+Y 向上
- 数据坐标 `(x, y)` → 世界坐标：

```
world.x = map.x
world.y = 0（地面高度，各层偏移见 §4.3）
world.z = -map.y        ← 关键：取反，保证俯视时北在上，与既有 2D 视图方向一致
```

- 贝塞尔控制点同样映射：`(cx, cy) → (cx, 0, -cy)`、`(dx, dy) → (dx, 0, -dy)`
- 全部转换收敛在领域层 `coordinates.ts` 纯函数中（`mapToWorld` / `yawFromMapAngle`），其他模块不得散写取反逻辑

### 4.2 朝向角换算

- 数据朝向单位向量 `(cosθ, sinθ)`（数学系）→ 世界方向 `(cosθ, 0, -sinθ)`
- 结论：**以 +X 为基准前向的几何体，直接 `rotation.y = θ` 即得正确朝向**
- 路径切线同理：直线 yaw = `atan2(ey - sy, ex - sx)`（数据坐标下计算，直接作为 `rotation.y`）；贝塞尔用采样点切线
- 圆盘、圆环和全部贴地符号直接在本地 XZ 平面构建，顶点法线为 +Y；箭头本地 +X 为前向。不得依赖 `CircleGeometry` 默认 XY 平面后再叠加隐式 Euler 旋转

### 4.3 高度分层表（防 z-fighting）

所有地坪元素在物理上做毫米级微抬高，**并**在材质上叠加 `polygonOffset` 双保险（4K 大屏远观时毫米级偏移低于深度缓冲精度，必须由 polygonOffset 提供第二层保障）：

| 层 | y 偏移 (m) | polygonOffsetUnits | 说明 |
| --- | --- | --- | --- |
| 室外地坪 | -0.02 | 0 | 厂房地坪板（厚 0.3m）压住，不共面 |
| 厂房地坪顶面 | 0 | 0 | — |
| 地坪分缝 | +0.002 | -1 | 位于路径下方，仍使用 polygonOffset 防远景闪烁 |
| 正向路径带 | +0.004 | -2 | — |
| 正向路径箭头 | +0.006 | -3 | — |
| 反向路径带 | +0.008 | -4 | 反向整体抬高 → 对向共线路径不闪屏 |
| 反向路径箭头 | +0.010 | -5 | — |
| 普通节点圆点 | +0.012 | -6 | — |
| 站点圆环 | +0.014 | -7 | — |
| 站点朝向符号 | +0.016 | -8 | — |

材质统一写法：`polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: <上表值>`。

---

## 5. 场景架构与分层

```
FactoryMapPage
├── loading / preparing / error → PageStateView
└── ready / empty → FactoryScene
    ├── EmptyMapOverlay       — 仅 empty 状态显示
    ├── FactoryCanvas         — WebGL renderer、质量策略、灯光、天空、雾
    ├── CameraRig             — 初始 fit + OrbitControls（§9）
    ├── FactoryLayer          — 只负责编排以下环境子层
    │   ├── FloorLayer
    │   ├── BuildingEnvelopeLayer
    │   ├── RoofFrameLayer
    │   └── ExteriorLayer
    ├── MapLayer
    │   ├── PathLayer
    │   └── NodeLayer
    └── LabelLayer            — 标签选择策略与 CSS2D 适配器
```

### 5.1 单向数据流

```text
MapRepository.fetchPayload(url, signal)
→ MapBuildWorker.decodeAndBuild(arrayBuffer)
→ FactorySceneModel（只读、可序列化、TypedArray 可转移）
→ FactoryScene（只消费 SceneModel，不接触 HTTP/原始 JSON）
```

`FactorySceneModel` 是 Worker 与主线程之间唯一场景契约：

```ts
/**
 * Worker 完成构建后把 TypedArray 所有权转移给主线程。
 * 渲染层只能绑定和读取这些数组，不得就地修改场景模型。
 */
interface FactorySceneModel {
  readonly bounds: FactoryBoundsDto;
  readonly paths: {
    readonly forward: GeometryBatchDto;
    readonly backward: GeometryBatchDto;
  };
  readonly arrows: {
    readonly forward: InstanceBatchDto;
    readonly backward: InstanceBatchDto;
  };
  readonly nodes: {
    readonly dots: InstanceBatchDto;
    readonly rings: ColoredInstanceBatchDto;
    readonly directions: ColoredInstanceBatchDto;
  };
  readonly labels: readonly LabelMetadataDto[];
  readonly stats: SceneStatsDto;
}

interface GeometryBatchDto {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

interface FactoryBoundsDto {
  readonly innerMinX: number;
  readonly innerMaxX: number;
  readonly innerMinZ: number;
  readonly innerMaxZ: number;
  readonly centerX: number;
  readonly centerZ: number;
}

interface InstanceBatchDto {
  readonly matrices: Float32Array; // 每个实例连续 16 个数
}

interface ColoredInstanceBatchDto extends InstanceBatchDto {
  readonly colors: Float32Array; // 每个实例连续 RGB 三个数，线性颜色空间
}

interface LabelMetadataDto {
  readonly id: string; // 固定使用 node:<nodeId> 或 edge:<edgeId>，避免跨集合冲突
  readonly category: "station" | "node" | "path";
  readonly text: string;
  readonly worldPosition: readonly [number, number, number];
}

interface SceneStatsDto {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly arrowCount: number;
  readonly labelMetadataCount: number;
}
```

- Worker transfer 前必须断言：positions/normals 长度相等且为3的倍数、indices 全部小于顶点数、matrices 长度为16的倍数、colors 数量与实例数一致、所有浮点数有限、label id 全局唯一
- 主线程 binder 再校验数组长度和 index 上界；失败时返回 `SceneBuildError`，不得把不可信 buffer 直接交给 WebGL

- 页面状态使用显式判别联合：`idle | loading | preparing | ready | empty | error`，不得用多个布尔值组合隐式状态
- `loading` 表示网络请求中；`preparing` 表示 Worker 校验和构建中；`ready` 和 `empty` 都携带完整 `FactorySceneModel`，empty 的地图批次数组为空且 bounds 为60×40m
- 地图切换或重试必须先 Abort 前一请求；若 Worker 正在 preparing，直接 terminate 并创建新 Worker，因为同步 JSON.parse 不能由取消消息中断；同时使用单调递增 requestId 丢弃竞态中的过期结果
- React 组件不在 `useMemo` 中解析 JSON 或构建大批量顶点；`useMemo` 只允许组装轻量只读视图数据

### 5.2 渲染与交互边界

- v1 使用 `frameloop="demand"`；OrbitControls 的 `change` 事件调用 `invalidate()`，阻尼尚未停止时持续触发下一帧，静止后停止 WebGL 重绘
- 标签候选集仅在相机位姿变化超过 §8.3 阈值时重算；CSS2D 投影在实际重绘帧执行
- Canvas 不注册 R3F 对象事件。MapLayer/FactoryLayer 根 group 的 `raycast` 返回 `false`，阻止递归拾取；标签遮挡检测直接持有不透明厂房遮挡 mesh 引用，不经过该根 group
- 未来功能不得通过跨层读取 React ref 获取原始数据；只能增加新的应用用例、SceneModel 字段或与 MapLayer 平级的场景层

---

## 6. 厂房环境（FactoryLayer）

### 6.1 建筑范围推导

- 厂房内空 = 地图 bbox + 四周各 `FACTORY_MARGIN`（固定 **10m**）：

```
bbox = 节点与路径所有端点/控制点的 min/max（数据坐标）
innerMinX = minX - FACTORY_MARGIN
innerMaxX = maxX + FACTORY_MARGIN
innerMinZ = -maxY - FACTORY_MARGIN
innerMaxZ = -minY + FACTORY_MARGIN
innerW = innerMaxX - innerMinX        // 基准数据 → 187.84m
innerD = innerMaxZ - innerMinZ        // 基准数据 → 95.32m
center = ((innerMinX + innerMaxX) / 2, 0, (innerMinZ + innerMaxZ) / 2)
```

- 上述值组成不可变值对象 `FactoryBounds`。`innerMinX/innerMinZ` 是厂房内边界，不是地图平移量；地图世界坐标不再二次平移
- nodes 与 edges 同时为空时进入 `empty` 状态，并使用明确的空场景尺寸 60m × 40m；该尺寸只服务空态展示，不参与正常地图计算

### 6.2 地坪

- 厂房地坪：Box 顶面 y=0、厚 0.3m，材质 `MeshStandardMaterial` 中灰混凝土色，roughness 0.95
- 贴图：以 `FLOOR_TEXTURE_SEED=0x4D415033` 驱动 xorshift32，为 #A9A6A0 的每个 RGB 通道加入 `[-6,+6]` 整数噪声，生成 512 × 512 不透明 CanvasTexture；`colorSpace=SRGBColorSpace`、wrapS/wrapT=RepeatWrapping、anisotropy=`min(8, renderer.capabilities.getMaxAnisotropy())`
- 仅地坪顶面使用世界坐标 UV，每 12m 重复一次；Box 侧面使用无纹理同色材质。不得探测或加载其他地坪贴图
- 分缝：6m × 6m 切缝，深色细条（宽 0.02m，y=+0.002），直接写入一个 BufferGeometry，使用 §4.3 的 polygonOffset；不再增加网格层
- 地坪本体 1 个 mesh，分缝 1 个 mesh

### 6.3 围墙与窗带

- 每面墙沿高度明确拆为三段：0～4.0m 实墙、4.0～6.5m 玻璃、6.5～8.0m 实墙；玻璃位置后方不得存在完整不透明墙体
- 四面实墙写入一个合并 BufferGeometry；四面玻璃写入另一个合并 BufferGeometry
- 玻璃材质固定为 `transparent=true`、`opacity=0.35`、`depthWrite=false`、`side=DoubleSide`、`renderOrder=10`，不投射阴影
- 墙板分格：沿墙每 6m 一条立柱分格条，0~8.0m 全高贯通（穿过玻璃带，形成窗带分格棂条）；以一个 InstancedMesh 承载全部实例
- 不做门洞（v1 简化）

### 6.4 屋顶桁架（不封顶）

- 简化钢梁网格，不表达真实结构受力计算，不做腹杆细节：
  - 主梁：沿厂房**短跨方向**，间距 8m，截面 0.35m(宽) × 0.7m(高)，梁底标高 8m
  - 檩条：沿长跨方向，间距 4m，截面 0.15m × 0.3m，置于主梁顶
- 主梁与檩条分别使用一个 InstancedMesh；材质为深灰钢，castShadow
- 无屋面板——任何俯角视线都不被遮挡，无需动态隐藏逻辑
- 不设室内立柱，避免与路径产生未经定义的空间关系

### 6.5 外景

- 天空：drei `<Sky>`（程序化，零资源），`sunPosition=normalize(0.5, 1, 0.35)`，与 §6.6 的 target→sun 向量一致
- 室外地坪：以厂房中心为中心的 2000m × 2000m 大平面（y=-0.02），园区水泥色，roughness 1
- 雾：`THREE.Fog`，颜色取与 Sky 地平线接近的浅蓝灰 #D8E0E8（Sky 为程序散射着色，无法严格同色，观感以 §15.3 视觉基线为准），near 250 / far 1200——远景柔和融入

### 6.6 灯光与后处理

| 项 | 配置 |
| --- | --- |
| 平行光（太阳） | 色 #FFF6E8，intensity 2.2；方向向量固定为 normalize(0.5, 1, 0.35)，light target 固定为厂房中心，light position = target + direction × 300m；castShadow |
| 阴影 | shadow.mapSize 4096；把厂房三维结构 bounds 的 8 个角转换到 light-view 空间，按投影 min/max 加 20m padding 设置正交 shadow camera；near/far 同样由 light-view 深度范围推导，bias -0.0001，normalBias 0.05 |
| 半球光 | 天 #DCEAF7 / 地 #B8B2A4，intensity 0.55 |
| 环境反射 | `PMREMGenerator` + `three/addons/environments/RoomEnvironment.js` 生成一次 environment texture；`envMapIntensity` 固定值：窗玻璃 0.6，其余材质 0.5（§13.3） |
| 色调映射 | `ACESFilmicToneMapping`，exposure 1.05 |
| 抗锯齿 | WebGL2 MSAA（`antialias: true`） |
| dpr | `min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)), 2)`，`MAX_RENDER_PIXELS = 8,294,400`；4K CSS 画布的有效 dpr 固定为 1 |

> 阴影只由桁架、墙柱和实墙投射；地坪与地图标线 receiveShadow=true，地图元素、玻璃和室外地坪 castShadow=false。

### 6.7 环境批次预算

| 批次 | draw call |
| --- | --- |
| 地坪 / 分缝 | 2 |
| 实墙 / 玻璃 / 墙柱 | 3 |
| 主梁 / 檩条 | 2 |
| 室外地坪 / Sky | 2 |
| 合计 | **9** |

### 6.8 环境配色表（v1 固定值，定义在 `visualTheme.ts`）

| 元素 | 颜色 |
| --- | --- |
| 厂房地坪 | #A9A6A0（中灰，须与正向路径拉开对比） |
| 地坪分缝 | #7F7C76 |
| 墙板 | #E9E7E2 |
| 墙柱分格 | #8A94A0 |
| 窗玻璃 | #A8CCE8，opacity 0.35 |
| 桁架钢 | #5D6873 |
| 室外地坪 | #ACA79B |
| 雾/天际 | #D8E0E8 |

---

## 7. 地图渲染（MapLayer）

### 7.1 路径条带

- 形态：贴地矩形条带，宽 **0.12m**；该值是 v1 固定的地坪标线宽度
- Worker 内纯函数 `buildPathBatches(edges)` 一次遍历直接写入正向/反向两组 TypedArray，不为每条边创建临时 BufferGeometry，也不在主线程调用 `mergeGeometries`
- LINE：起点终点 + 法线两侧各扩 `PATH_WIDTH/2`，端点使用 butt cap
- BEZIER 使用 De Casteljau 自适应细分，同时满足：
  - 控制多边形到弦的最大距离 `<= CURVE_MAX_ERROR = 0.01m`
  - 单段控制多边形长度 `<= CURVE_MAX_SEGMENT = 0.25m`
  - 最大递归深度 16；达到深度仍不满足时返回 `MapGeometryError`，不得改用粗糙采样
- 相邻采样点距离 `< 1e-6m` 时去重；去重后少于 2 个点返回 `MapGeometryError`
- 折线连接使用 miter join，`MITER_LIMIT = 2`；超过限制时生成 bevel join，保证无裂缝、无无限尖角
- 正向和反向各生成一个 BufferGeometry → 2 个 mesh、2 次 draw call
- 材质：MeshStandardMaterial，roughness 0.8
- 颜色（沿用调度系统语义，明亮场景适配版）：
  - 正向 `#C9CAC6`（亮灰白漆；地坪为 #A9A6A0，保证对比）
  - 反向 `#E57373`（红）

### 7.2 方向箭头（沿线重复 chevron）

- 规则：
  - 路径弧长 `L < 1.0m`：不放箭头（过短，方向由邻接路径上下文体现）；基准数据有 869 条边（约 28.6%）因此无箭头，验收时据此预期箭头密度
  - 否则 `n = max(1, floor(L / 6))`，相邻箭头严格间隔 6m，首个位置为 `(L - (n-1)×6) / 2`，使整组箭头沿弧长居中
- 朝向：所在点切线方向，`rotation.y = atan2(Δy_data, Δx_data)`
- `isBackEdge` 只决定颜色和高度层；箭头方向始终由 `(sx, sy)` 指向 `(ex, ey)`
- 几何：人字形 chevron——顶点 `(+0.18, 0)`，两翼端点 `(-0.10, ±0.14)`，条宽 0.06m，两片 quad
- 实现：正向/反向各一个 InstancedMesh，实例矩阵 = 弧长位置 + 切线 yaw
- 颜色：与所属路径同语义、加深以在漆带上可读——正向 `#83847F`，反向 `#C05454`

### 7.3 节点

| 类型 | 几何 | 颜色 | 尺寸 |
| --- | --- | --- | --- |
| node（普通） | `createDiskGeometryXZ(24)` 实心圆盘 | #78909C | r = 0.10m |
| work（工作站） | `createRingGeometryXZ(24)` 圆环 | #2196F3 蓝 | 外 r 0.15m / 内 r 0.09m |
| charge（充电点） | 圆环 | #8BC34A 绿 | 同上 |
| park（停车点） | 圆环 | #F44336 红 | 同上 |

- 实现：普通节点使用一个 InstancedMesh；全部站点圆环使用一个 InstancedMesh，并用 `instanceColor` 表达三种合法类型；`instanceColor` 独立生效，对应 MeshStandardMaterial 不得启用 `vertexColors`（几何体无 color attribute 时启用会使 vColor 乘上未绑定 attribute 的默认值，渲染为黑色）
- work/charge/park 且 `angle !== null` 时叠加**朝向符号**（§7.4）；普通 node 的 angle 已由领域不变量保证为 null

### 7.4 站点朝向符号

- 形态：圆环内人字形「>」——顶点 `(+0.55r, 0)`，两翼端点 `(0, ±0.5r)`，条宽 0.05m（r = 0.15m）
- 朝向：`rotation.y = node.angle`
- 颜色：与所属圆环同色
- 实现：一个 InstancedMesh 承载全部站点朝向符号，通过 `instanceColor` 与所属圆环保持一致；材质同样不得启用 `vertexColors`（原因同 §7.3）

### 7.5 合并策略汇总

| 对象 | 方式 | draw call |
| --- | --- | --- |
| 正向路径带 | Worker 直写单一 BufferGeometry | 1 |
| 反向路径带 | Worker 直写单一 BufferGeometry | 1 |
| 正/反向箭头 | InstancedMesh × 2 | 2 |
| 节点圆点 | InstancedMesh | 1 |
| 站点圆环 | InstancedMesh + instanceColor | 1 |
| 站点朝向符号 | InstancedMesh | 1 |
| 合计 | — | **7** |

---

## 8. 标签系统（LabelLayer）

### 8.1 技术方案

- `Css2dLabelRendererAdapter` 独占一个 CSS2DRenderer，将绝对定位容器覆盖在 WebGL canvas 上，容器与标签统一 `pointer-events: none`
- Adapter 通过同一个 ResizeObserver 同步 WebGL/CSS2D 尺寸；每个实际重绘帧在 WebGL 完成后调用一次 CSS2D render
- DOM 池最多创建 `LABEL_MAX_COUNT = 300` 个元素；池按 label id 绑定/解绑并复用，不为全量节点创建隐藏 DOM
- Adapter unmount 时必须从宿主移除 CSS2D 容器、移除 ResizeObserver、清空 CSS2DObject 与 DOM 池
- CSS2D 标签以 CSS 像素绝对定位并与 WebGL 画布逐帧对齐，其字号与对齐行为只在 100% 浏览器/显示缩放下定义；§1.3 的缩放约束（3840×2160 画布、dpr=1 验收口径）因此是部署前置条件，v1 不提供其他缩放模式

### 8.2 内容与位置

- 节点标签：`node.name`，锚点位于节点正上方 `LABEL_ANCHOR_Y = 0.5m` 处；该高度同时是 §8.3 遮挡射线的终点高度
- 路径标签：`edge.name`，锚点位于弧长 `s=0.4L` 处，沿路径左法线偏移 0.2m，高度同为 `LABEL_ANCHOR_Y`；距离满足 §8.3 时固定启用
- 标签内部 id 固定为 `node:<nodeId>` / `edge:<edgeId>`；显示文字仍只使用 name
- 样式：固定 12px，深色文字 #2B2F33，白底 rgba(255,255,255,0.78) 圆角 pill，不随距离缩放（屏幕恒定字号）
- 标签内容只通过 `textContent` 写入，禁止使用 `innerHTML`

### 8.3 候选选择、迟滞与全局上限

| 标签类别 | 进入距离 | 退出距离 | 保留名额 |
| --- | --- | --- | --- |
| 站点（work/charge/park） | ≤ 90m | > 95m | 120 |
| 普通节点 | ≤ 40m | > 44m | 120 |
| 路径 | ≤ 25m | > 28m | 60 |

- 相机位置变化 ≥ 0.25m、朝向变化 ≥ 0.25°、viewport 尺寸变化或地图变化时重算候选；阻尼移动期间最多 10Hz，停止时立即执行最终重算
- 重算使用复用数组，先执行距离迟滞和相机视锥过滤，再在各类别内按 `(distanceSquared, id)` 稳定排序
- 依次为三类标签填充各自保留名额；遇到实墙、墙柱、主梁或檩条遮挡时跳过并继续该类后续候选。玻璃不遮挡
- 三类保留完成后，把剩余可见候选按 `(distanceSquared, category, id)` 稳定排序并补足空余容量
- 所有距离档位和标签类别共同受 300 个全局硬上限约束；保留名额用于防止高密度站点让普通节点和路径标签完全饥饿，不是额外容量
- 选中集合变化后做集合差分，只 attach/detach 变化项；不得每次清空并重建全部 DOM
- 基准地图初始全景机位下所有标签距离均大于 90m，因此首屏无标签是明确设计；用户拉近后标签按上述规则出现

---

## 9. 相机（CameraRig）

### 9.1 初始机位（45° 斜视全景）

- PerspectiveCamera：fov 46，near 0.1，far 2000
- fit 对象是完整厂房三维包围盒，而不是二维宽深：`min=(innerMinX, 0, innerMinZ)`，`max=(innerMaxX, 9.0, innerMaxZ)`；9.0m 包含主梁和檩条顶部
- `target=(centerX, 0, centerZ)`；相机位于南侧，目标观察方向固定为 45° 俯角：

```
forward = normalize(0, -sin45°, -cos45°) // 相机指向 target
right   = (1, 0, 0)
up      = cross(right, forward)
vHalf   = radians(fov / 2)
hHalf   = atan(tan(vHalf) × aspect)

required = 0
for corner in structureBounds 的 8 个角:
  q = corner - target
  requiredH = abs(dot(q, right)) / tan(hHalf) - dot(q, forward)
  requiredV = abs(dot(q, up))    / tan(vHalf) - dot(q, forward)
  required = max(required, requiredH, requiredV)

dist = required × 1.15
camera.position = target - forward × dist
camera.lookAt(target)
```

- 该算法把近侧深度对水平视锥的影响计入距离；不得恢复为 `max(halfW/tan(hHalf), halfD/tan(vHalf))` 的二维公式
- 基准数据、16:9 画幅下，旧二维公式约 143.13m 且会产生约 20% 横向越界；新算法应约为 189.2m（含 15% 距离余量），最终数值以纯函数测试为准
- 220m×220m 上限地图在 4:3 画幅下 fit 距离约 348.7m，距 ORBIT_MAX_DIST=350m 仅约 1.3m 余量；该余量是刻意的边界设计，不得再上调 MAX_MAP_EXTENT
- 单元测试必须把 8 个角投影到 NDC，断言 `abs(x) <= 1`、`abs(y) <= 1`；覆盖 16:9、4:3、32:9 三种画幅
- 首次 ready、地图变更时重新 fit；用户尚未操作时 viewport resize 重新 fit，用户已操作后 resize 只更新 aspect/projection，不重置其机位

### 9.2 OrbitControls 参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| enableDamping / dampingFactor | true / 0.08 | — |
| minDistance / maxDistance | 3 / 350 | 限制围绕 target 的漫游距离 |
| maxPolarAngle | 80° | 防止视线钻到地面以下 |
| minPolarAngle | 5° | 允许接近正俯视，保持常用平面阅读方向 |
| screenSpacePanning | false | 平移约束在地面平面 |
| target 夹取 | XZ 固定夹取到厂房内边界外扩 20m，Y 固定为 0 | 每次 change 后强制执行 |

### 9.3 无拾取约定

- MapLayer/FactoryLayer 根 group：`raycast = () => false`，利用当前 three 版本的递归终止语义
- 不注册任何 onClick / onPointerOver / onContextMenu
- CSS2D 容器和标签统一 `pointer-events: none`
- 标签遮挡使用专用 labelOccluders 引用列表执行内部 Raycaster，不开启 R3F 对象事件

---

## 10. 性能预算与资源管线

### 10.1 静态预算

| 指标 | 硬上限 |
| --- | --- |
| 每个完整 WebGL 帧的 draw call | `renderer.info.render.calls <= 25`，包含主渲染与阴影 pass |
| 地图主 pass | 7（§7.5） |
| 厂房/天空/外景主 pass | 9（§6.7） |
| 阴影 caster 批次 | 实墙、墙柱、主梁、檩条共 4 |
| shadow map | 4096 × 4096 × 1 |
| 运行时纹理 | 程序地坪 512 × 512 × 1 + PMREM environment × 1 + shadow map × 1 |
| CSS2D DOM | 300 个标签 + 1 个 renderer 容器 |
| WebGL 实际渲染像素 | `<= 8,294,400`，由 §6.6 dpr 公式保证 |

- Worker 负责 JSON 解析、校验、bounds、路径细分、顶点/索引、箭头矩阵和标签元数据；主线程只把 transferable TypedArray 绑定为 BufferAttribute
- 稳态渲染不得创建逐边、逐节点临时 Vector/Matrix/数组；相机、标签和遮挡计算使用预分配对象
- 生产包不包含 GLTF 资源、模型加载器封装或空的未来功能目录

### 10.2 可重复性能基准

性能测试使用 §1.3 参考硬件、3840×2160 CSS 画布、100% 缩放、有效 dpr=1、基准 `public/map.json` 和全部标签类别。验收报告必须记录硬件、浏览器、WebGL renderer、commit、数据文件 SHA-256 和每项原始结果。

测试专用 `PerformanceHarness` 连续驱动相机，不进入生产包：

1. 预热 10 秒
2. 全景阶段 30 秒：以初始 fit 距离、45° 俯角绕厂房中心匀速旋转 180°
3. 近景阶段 30 秒：相机距 target 35m、45° 俯角匀速旋转 180°，触发标签 300 上限

| 指标 | 通过条件 |
| --- | --- |
| 帧时间 | 两阶段分别满足 p95 ≤ 33.3ms、p99 ≤ 50ms，不以平均 FPS 替代 |
| 主线程长任务 | ready 后测试阶段不得出现 >100ms long task |
| Worker prepare | 连续 10 次本地文件测试 p95 ≤ 500ms |
| 主线程 SceneModel 绑定 | p95 ≤ 16.7ms |
| draw call / DOM | 全程满足 §10.1 硬上限 |
| 资源稳定性 | 连续加载/卸载地图 10 次后，`renderer.info.memory.geometries/textures` 回到首次卸载后的基线，CSS2D 容器数为 0 |

任一指标失败即性能验收失败；不得通过降低阴影分辨率、隐藏标签或改变基准数据临时规避。

### 10.3 资源所有权与释放

| 所有者 | 资源 | 释放时机 |
| --- | --- | --- |
| PageController | AbortController、Worker | 新加载/重试时 abort 请求并按 §5.1 终止正在计算的 Worker；页面卸载时 terminate Worker |
| MapSceneResources | 路径 BufferGeometry、实例 geometry、实例颜色/矩阵 buffer | SceneModel 替换或 MapLayer 卸载时逐一 dispose |
| FactorySceneResources | 地坪纹理、厂房 geometry/material | bounds 变化时释放旧 geometry；FactoryCanvas 卸载时再释放共享纹理/material |
| EnvironmentResource | PMREMGenerator、RoomEnvironment 临时 scene、environment texture | 生成后立即释放 generator/临时 scene；Canvas 卸载时释放 environment texture |
| Css2dLabelRendererAdapter | renderer DOM、CSS2DObject、ResizeObserver、DOM 池 | LabelLayer 卸载时完整清理 |

- 共享资源只能由唯一 owner 释放；消费组件不得释放借用的 material/geometry
- 所有 setup/cleanup 必须幂等，在 React StrictMode 的重复挂载检查下不得产生重复 DOM、事件监听器、Worker 或 WebGL 资源

---

## 11. 边界与异常处理

进入新一轮加载时立即卸载旧 SceneModel，不保留旧画面作为失败时的隐式 fallback。所有错误进入统一 `error` 状态，不渲染部分地图。

| 错误类型 | 条件 | 页面行为 |
| --- | --- | --- |
| `MapNetworkError` | 网络失败、15秒超时、请求被非当前流程意外中断 | 全屏错误码/摘要 +“重新加载”按钮 |
| `MapHttpError` | HTTP 非 2xx | 显示 HTTP 状态和移除 query/hash 后的请求 URL +“重新加载”按钮 |
| `MapParseError` | 非法 UTF-8 或 JSON 语法错误 | 显示解析错误码，不展示原始响应内容 +“重新加载”按钮 |
| `MapEnvelopeError` | code 非 200、信封或 mapJson 缺失 | 显示稳定错误码和字段路径 +“重新加载”按钮 |
| `MapValidationError` | §3.3 任一数据不变量失败 | 显示首个错误路径、摘要和错误总数 +“重新加载”按钮 |
| `MapCapacityError` | payload 超过20MiB、元素总数超过20,000或地图范围超过220m | 显示实际值与上限，不创建 SceneModel +“重新加载”按钮 |
| `MapGeometryError` | 自适应细分、条带或实例数据无法产生有限结果 | 显示边 id 和错误原因，不渲染部分几何 +“重新加载”按钮 |
| `SceneBuildError` | Worker 崩溃或主线程绑定资源失败 | 终止当前 Worker；用户点击重试时创建新 Worker，不自动重试 |
| `WebGLUnavailableError` | WebGL2/context 初始化失败或 context lost | 全屏提示硬件/浏览器不支持 +“刷新页面”按钮；context lost 后不自动恢复旧场景 |

- nodes 与 edges 同时为空：进入 `empty`，渲染 60×40m 空厂房并显示“暂无地图数据”
- nodes 非空、edges 为空：合法 ready 状态，只渲染节点
- `angle=null`：合法值，不绘制朝向符号
- zones、nodeEdgeGroups 和未消费业务字段：解码阶段不复制到领域模型
- 重试按钮每次只启动一个新请求；按钮在 `loading/preparing` 状态禁用，避免并发隐式状态

---

## 12. 模块与目录结构（强制）

```
src/features/factory-map/
├── domain/                         # 无 React、Three、DOM、fetch 依赖
│   ├── factoryMap.ts               # 只读领域实体与合法枚举
│   ├── decodeMapEnvelope.ts        # unknown → FactoryMap，字段路径错误
│   ├── coordinates.ts              # mapToWorld / yawFromMapAngle
│   ├── bounds.ts                   # MapBounds / FactoryBounds
│   ├── limits.ts                   # MAX_MAP_BYTES / MAX_MAP_EXTENT / MAX_MAP_ELEMENTS
│   ├── invariants.ts               # 容量、引用、几何输入不变量
│   └── errors.ts                   # 稳定领域错误码
├── application/                    # 用例与端口，不依赖 React/Three
│   ├── ports/
│   │   ├── MapRepository.ts
│   │   └── FactoryScenePreparer.ts
│   ├── loadFactoryMap.ts           # fetch → prepare 的单一用例
│   ├── factorySceneModel.ts        # 用例输出契约：只读元数据 + transferable TypedArray
│   └── factoryMapPageState.ts      # 显式判别联合与状态转换
├── infrastructure/                 # 外部系统适配器
│   ├── HttpMapRepository.ts        # 流式读取、字节上限、AbortSignal
│   └── worker/
│       ├── mapBuild.worker.ts      # Worker composition root
│       ├── WorkerScenePreparer.ts  # requestId、transfer、取消、错误映射
│       ├── workerProtocol.ts       # 可序列化 request/result 协议
│       └── builders/
│           ├── buildFactorySceneModel.ts
│           ├── buildPathBatches.ts
│           └── buildNodeInstances.ts
├── rendering/
│   ├── core/                       # 无 React；把用例输出绑定为 Three 资源
│   │   ├── bindFactorySceneModel.ts
│   │   └── fitPerspectiveCamera.ts
│   ├── resources/                  # 明确 owner 的资源创建/释放
│   │   ├── MapSceneResources.ts
│   │   ├── FactorySceneResources.ts
│   │   └── EnvironmentResource.ts
│   └── scene/
│       ├── FactoryCanvas.tsx
│       ├── CameraRig.tsx
│       ├── FactoryLayer.tsx        # 只编排，不包含几何算法
│       ├── floor/FloorLayer.tsx
│       ├── building/BuildingEnvelopeLayer.tsx
│       ├── building/RoofFrameLayer.tsx
│       ├── exterior/ExteriorLayer.tsx
│       ├── map/MapLayer.tsx        # 只编排 PathLayer/NodeLayer
│       ├── map/PathLayer.tsx
│       ├── map/NodeLayer.tsx
│       └── labels/
│           ├── LabelLayer.tsx
│           ├── selectVisibleLabels.ts
│           └── Css2dLabelRendererAdapter.ts
├── presentation/
│   ├── FactoryMapPage.tsx          # 仅渲染页面状态与 FactoryScene
│   ├── FactoryMapPageController.ts # 调用用例、管理生命周期
│   └── PageStateView.tsx
├── config/
│   ├── visualTheme.ts
│   ├── sceneMetrics.ts
│   ├── labelPolicy.ts
│   ├── cameraConfig.ts
│   ├── qualityProfile.ts
│   └── mapLoadConfig.ts
└── index.ts                        # 功能模块唯一公开出口

public/
└── map.json                        # 唯一运行时静态资源
```

依赖方向固定为：domain 不依赖其他层；application 只依赖 domain；infrastructure 实现 application ports；rendering 只消费 application 的 `FactorySceneModel` 和 domain 坐标语义；presentation 组合 application 与 rendering。禁止 presentation 直接 fetch、infrastructure 导入 React、scene 组件解析原始 JSON，或跨目录深层导入未公开实现。

---

## 13. 配置常量（v1 固定值）

### 13.1 `sceneMetrics.ts`

| 常量 | 值 | 说明 |
| --- | --- | --- |
| FACTORY_MARGIN | 10 m | 地图 bbox 外扩 |
| WALL_HEIGHT | 8 m | — |
| STRUCTURE_MAX_Y | 9 m | 包含檩条顶部，用于相机/阴影 fit |
| WINDOW_BAND | 4.0 ~ 6.5 m | 窗带区间 |
| TRUSS_SPACING / PURLIN_SPACING | 8 m / 4 m | 主梁/檩条间距 |
| FLOOR_JOINT | 6 m | 地坪分缝 |
| FLOOR_TEXTURE_SEED | 0x4D415033 | 程序地坪纹理固定随机种子 |
| PATH_WIDTH | 0.12 m | 路径漆带宽 |
| CURVE_MAX_ERROR / MAX_SEGMENT | 0.01 / 0.25 m | 贝塞尔自适应细分条件 |
| MITER_LIMIT | 2 | 路径连接限制 |
| CHEVRON_SPACING | 6 m | 箭头间隔 |
| CHEVRON_MIN_PATH_LEN | 1.0 m | 短于此不放箭头 |
| NODE_DOT_R | 0.10 m | 普通节点半径 |
| STATION_RING_R | 0.15 / 0.09 m | 站点圆环外/内径 |

### 13.2 `labelPolicy.ts`

| 常量 | 值 | 说明 |
| --- | --- | --- |
| NODE_ENTER / EXIT | 40 / 44 m | 普通节点距离迟滞 |
| STATION_ENTER / EXIT | 90 / 95 m | 站点距离迟滞 |
| PATH_LABEL_ENTER / EXIT | 25 / 28 m | 路径标签距离迟滞 |
| LABEL_MAX_COUNT | 300 | 同屏标签上限 |
| LABEL_CAMERA_DELTA | 0.25 m / 0.25° | 候选重算阈值 |
| LABEL_RECALC_MAX_HZ | 10 | 相机运动时最大重算频率 |
| LABEL_RESERVED_STATION / NODE / PATH | 120 / 120 / 60 | 各类别保留名额，总和等于全局上限 |
| LABEL_ANCHOR_Y | 0.5 m | 标签锚点高度（§8.2），同时用作遮挡射线终点高度 |

### 13.3 `cameraConfig.ts` 与 `qualityProfile.ts`

| 常量 | 值 | 说明 |
| --- | --- | --- |
| CAMERA_FOV / NEAR / FAR | 46° / 0.1 / 2000 | — |
| CAMERA_FIT_MARGIN | 1.15 | 三维视锥 fit 距离余量 |
| ORBIT_MIN / MAX_DIST | 3 / 350 m | — |
| ORBIT_MIN / MAX_POLAR | 5° / 80° | — |
| ORBIT_DAMPING_FACTOR | 0.08 | enableDamping=true |
| ORBIT_TARGET_CLAMP_MARGIN | 20 m | target XZ 夹取到厂房内边界的外扩量 |
| ENV_MAP_INTENSITY | 0.5（窗玻璃 0.6） | 材质环境反射强度固定值，定义在 qualityProfile.ts |
| FOG_NEAR / FAR | 250 / 1200 m | — |
| MAX_RENDER_PIXELS | 8,294,400 | 实际渲染像素硬上限 |
| SHADOW_MAP_SIZE | 4096 | 单张方向光阴影贴图 |

### 13.4 `mapLoadConfig.ts`

| 常量 | 值 | 说明 |
| --- | --- | --- |
| MAP_REQUEST_TIMEOUT_MS | 15,000 | 单次地图请求硬超时 |

颜色只存在于 `visualTheme.ts`，数值与 §6.8、§7 一致。业务阈值、几何尺寸、相机参数和性能参数不得移入 `visualTheme.ts`。

---

## 14. 架构演进约束

v1 只保证模块边界能够扩展，不创建空模块、未使用依赖、占位状态或提前运行的逻辑。

| 后续能力 | 扩展方式 |
| --- | --- |
| 机器人/实时位置 | 新增应用用例、实时数据 port 和与 MapLayer 平级的 RobotLayer；RobotLayer 激活时再引入连续帧策略 |
| 对象交互 | 新增独立 InteractionLayer 与选择用例；不得把业务状态写入 Three Object3D |
| 新数据源 | 新建 MapRepository adapter，仍输出 §3.1 唯一信封语义 |
| 新主题 | 增加完整 VisualTheme 值对象并通过依赖注入切换；v1 不实现切换状态 |
| GLTF 道具 | 需求进入版本范围后再增加资源仓库和碰撞/摆放规则；v1 不创建 `public/models/` 或 useGLTF 封装 |

---

## 15. 测试规范

### 15.1 无浏览器自动测试（`pnpm test`）

| 模块 | 必测用例 |
| --- | --- |
| HttpMapRepository | Content-Length超限、流式累计超限、15秒超时、AbortSignal、HTTP错误、合法ArrayBuffer transfer |
| decodeMapEnvelope | 正常信封、顶层未知字段忽略、code非200、缺字段、非法数值、node带angle、未知类型、控制点组合错误、重复id、失效引用、容量超限、空图 |
| coordinates | 原点、东/北方向、角度规范化、map/world 往返不变量 |
| bounds | 节点/端点/控制点联合 bbox、负坐标、仅节点、空态尺寸、边界坐标命名不产生二次平移 |
| fitPerspectiveCamera | 16:9、4:3、32:9下8角NDC全部入画；基准地图不得退回约143m的错误结果；220m×220m上限地图在4:3下fit距离≤350m |
| buildPathBatches | LINE、直/弯 BEZIER、误差/段长约束、miter/bevel、重复采样点、有限顶点、正反向批次 |
| bindFactorySceneModel | 长度不匹配、越界index、NaN/Infinity、颜色/实例数不一致、合法buffer绑定与dispose |
| arrows/nodes | 弧长位置、切线朝向、短路径、instanceColor、null angle |
| selectVisibleLabels | 三类迟滞/保留名额、稳定排序、视锥、不透明厂房遮挡、全局300上限、attach/detach差分 |
| page state | idle→loading→preparing→ready/empty/error、abort、preparing时terminate Worker、过期requestId、单次重试 |

- domain、application、infrastructure、rendering/core 的分支覆盖率不得低于90%；错误路径与几何边界分支必须100%覆盖
- 测试不得依赖真实网络、系统时间或随机数；程序纹理使用固定 seed

### 15.2 显式浏览器测试

- `pnpm test:browser`：由验收人员显式启动，验证 WebGL2 初始化、CSS2D 生命周期、resize、context lost 错误态和连续 10 次装卸资源
- `pnpm test:perf`：由验收人员在参考展厅机器显式启动 §10.2 PerformanceHarness
- `pnpm build`、`pnpm lint`、`pnpm test` 不得隐式启动浏览器

### 15.3 视觉基线

使用基准地图固定保存三张 3840×2160 截图：初始全景、35m近景、`polarAngle=80°`低视线（距地平线10°）。产品验收人一次性确认配色、曝光、雾、阴影和建筑观感；之后视觉回归以这三张已确认基线为准，不以“感觉接近”替代。

---

## 16. 实施里程碑

| 里程碑 | 内容 | 准入条件 |
| --- | --- | --- |
| M0 | 精确依赖、目录边界、domain/application ports、测试骨架 | 依赖锁定；架构依赖检查通过；`pnpm build/lint/test` 通过 |
| M1 | MapRepository + Worker + 解码/校验 + 页面状态机 | §3 和状态机测试全过；错误不产生部分 SceneModel |
| M2 | FactorySceneModel + FactoryLayer + CameraRig | 厂房 9 批次；相机 NDC 测试全过；空态可漫游 |
| M3 | PathLayer + NodeLayer | 地图 7 draw call；自适应曲线与实例测试全过 |
| M4 | LabelLayer + CSS2D adapter | 遮挡、迟滞、稳定排序、DOM 300 上限和完整清理通过 |
| M5 | 灯光、视觉基线、异常态、4K 性能与资源验收 | §10、§15.2、§15.3、§17 全部通过 |

里程碑必须按序通过；不得在 M0/M1 架构与契约未稳定时向场景组件堆叠业务逻辑。

---

## 17. 验收清单

- [ ] `package.json` 与 lockfile 使用 §2 精确版本，无开放版本范围，生产包无未使用的未来功能依赖
- [ ] 唯一 API 信封可加载；所有非法契约按 §11 显示稳定错误码/字段路径，不降级、不部分渲染
- [ ] 初始相机为 45° 斜视，厂房三维 bounds 的 8 个角全部位于 NDC 内；基准 16:9 距离约 189.2m
- [ ] 节点四种合法类型颜色和几何正确；非法类型被解码器拒绝
- [ ] 站点朝向与 angle 一致（东 0°、北 90°），angle=null 不画；普通 node 不画朝向
- [ ] 路径正向灰白、反向红；BEZIER 满足 0.01m 误差和 0.25m 最大段长测试，无可见裂缝/尖刺
- [ ] 对向共线路径在初始全景、35m近景、`polarAngle=80°`低视线各持续观察30秒，无 z-fighting 闪烁
- [ ] 方向箭头沿弧长每 6m 居中重复，朝向始终由起点指向终点；<1m 路径无箭头
- [ ] 标签满足迟滞、视锥、类别保留名额和不透明厂房遮挡；任意距离下 DOM 标签总数 ≤ 300；初始全景无标签
- [ ] Orbit 可旋转/缩放/平移，target Y 恒为0且 XZ 不越过厂房边界外扩20m，视线不能进入地面以下
- [ ] 页面与 CSS2D 无对象点击、悬停、右键响应；内部标签遮挡 Raycaster 不暴露交互
- [ ] 实墙没有覆盖玻璃带，透过玻璃和开放屋顶可见天空/外景/雾；玻璃无阴影和错误深度遮挡
- [ ] 地图主 pass 7、厂房主 pass 9、阴影 caster 4；完整帧 `renderer.info.render.calls <= 25`
- [ ] 空图、仅节点、断网、HTTP、坏 JSON、坏信封、坏字段、容量超限、Worker/WebGL 失败均进入规定状态
- [ ] 连续装卸 10 次后 WebGL/CSS2D/Worker/监听器资源回到基线，无重复容器和增长资源
- [ ] §10.2 两阶段 4K 测试分别满足 p95 ≤ 33.3ms、p99 ≤ 50ms，报告包含完整环境与数据哈希
- [ ] 三张视觉基线经产品验收人确认，后续截图与基线不存在未批准的结构、材质或配色变化
