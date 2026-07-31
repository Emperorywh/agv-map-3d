# SPEC_factory_3d_map — AGV 工厂地图 3D 可视化（v1）

> 本文档自包含：不依赖任何外部仓库的代码或文档即可实施。
> v1 目标：在 Three.js 中把 AGV 调度地图（节点 + 路径）渲染进一个**完整的工厂建筑**里，明亮工业写实风格，有空间感；无对象级交互，相机可漫游。

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
- 货架/设备道具（资源管线预留，场景不摆放）
- 主题切换（仅明亮工业写实单主题）
- 低空飞入动画、路径流动动画

### 1.3 运行环境

- 展厅 4K 大屏，画质优先，目标 30~60fps
- 现代浏览器（WebGL2）

---

## 2. 技术选型

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 框架 | React 18 + TypeScript + Vite | — |
| 3D | three (r160+) + @react-three/fiber v8 + @react-three/drei v9 | R3F 组件化；drei 提供 OrbitControls / Sky |
| 数据 | `public/map.json` 运行时 fetch | 换图只换文件，不重新打包 |
| 标签 | three/examples `CSS2DRenderer` | 不用 drei Html（1700+ 实例时 React portal 开销大） |
| 资源 | 贴图允许放 `public/textures/`；GLTF 管线预留 `public/models/`（v1 不用） | 地坪贴图缺失时程序化回退 |

---

## 3. 数据契约

### 3.1 数据来源与加载

- 默认 URL：`/map.json`（`public/map.json`），可用环境变量 `VITE_MAP_URL` 覆盖
- 加载器 `loadMap(url)` 需**兼容两种文件形态**：
  1. API 响应信封：`{ code, message, data: { currentMapInfoVersion: { mapJson: {...} } } }` → 解包取 `mapJson`
  2. mapJson 本体：`{ nodes: [...], edges: [...] }` → 直接用
- 判定规则：存在 `data.currentMapInfoVersion.mapJson` 走信封解包，否则按本体解析

### 3.2 类型定义（v1 消费子集）

原始数据字段远多于此（限速/交管/动作/车辆组等），v1 只消费以下字段，其余**原样忽略、不做校验**：

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
  /** "node" | "work" | "park" | "charge" | 其他（未知类型按 "node" 样式兜底） */
  type: string;
  /** 平面坐标，单位：米。数学坐标系：x 向东，y 向北（y 增大 = 北） */
  x: number;
  y: number;
  /** 朝向，弧度。0 = +x（东），逆时针为正。null = 无朝向（不画朝向符号） */
  angle: number | null;
}

interface MapEdge {
  id: string;
  name: string;
  /** "LINE" | "BEZIER"（三次贝塞尔） */
  edgeType: string;
  /** 起点/终点平面坐标，米 */
  sx: number; sy: number; ex: number; ey: number;
  /** 贝塞尔两个控制点；LINE 时为 null。四个值任一为 null 即降级按 LINE 处理 */
  cx: number | null; cy: number | null;
  dx: number | null; dy: number | null;
  /** 反向路径标识：true = 反向（红色语义），false = 正向（灰色语义） */
  isBackEdge: boolean;
  /** 起止节点 id 引用。v1 几何只用 sx/sy/ex/ey，不校验引用有效性 */
  snodeId: string; enodeId: string;
}
```

### 3.3 基准数据规模（性能预算依据）

| 指标 | 量级 |
| --- | --- |
| 节点 | ~1800（node ~1300 / work ~390 / park ~64 / charge ~11） |
| 路径 | ~3000（LINE ~97%，BEZIER ~3%） |
| 反向路径 | ~880（与正向几何大量共线重叠） |
| 地图范围 | ~170m × 75m，坐标为真实世界米制 |
| 单条路径长度 | 中位数 ~1.3m，最短 ~0.04m，最长 ~15m |
| 文件体积 | ~6.5MB |

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
- 全部转换收敛在 `lib/coords.ts` 纯函数中（`mapToWorld` / `yawFromMapAngle`），业务代码不散写取反逻辑

### 4.2 朝向角换算

- 数据朝向单位向量 `(cosθ, sinθ)`（数学系）→ 世界方向 `(cosθ, 0, -sinθ)`
- 结论：**以 +X 为基准前向的几何体，直接 `rotation.y = θ` 即得正确朝向**
- 路径切线同理：直线 yaw = `atan2(ey - sy, ex - sx)`（数据坐标下计算，直接作为 `rotation.y`）；贝塞尔用采样点切线

### 4.3 高度分层表（防 z-fighting）

所有地坪元素在物理上做毫米级微抬高，**并**在材质上叠加 `polygonOffset` 双保险（4K 大屏远观时毫米级偏移低于深度缓冲精度，必须靠 polygonOffset 兜底）：

| 层 | y 偏移 (m) | polygonOffsetUnits | 说明 |
| --- | --- | --- | --- |
| 室外地坪 | -0.02 | 0 | 厂房地坪板（厚 0.3m）压住，不共面 |
| 厂房地坪顶面 | 0 | 0 | — |
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
FactoryCanvas            — Canvas 配置（色调映射/阴影/dpr/雾/灯光/天空）
├── CameraRig            — 初始机位 fit + OrbitControls（§9）
├── FactoryLayer         — 厂房环境：地坪/围墙/窗带/桁架/室外地坪（§6）
├── MapLayer             — 地图：路径带/箭头/节点/朝向符号（§7），raycast 全关
└── LabelLayer           — CSS2D 标签 + 距离剔除（§8）
```

- 数据流：`index.tsx` fetch → `mapJson` state → MapLayer/LabelLayer 用 `useMemo` 一次性构建几何
- 渲染循环常开（`frameloop="always"`），`useFrame` 只用于标签剔除与控制器阻尼——为 v2 机器人动画预留
- MapLayer 所有 mesh 关闭拾取：`raycast={() => null}`，集中在 MapLayer 一处管理

---

## 6. 厂房环境（FactoryLayer）

### 6.1 建筑范围推导

- 厂房内空 = 地图 bbox + 四周各 `FACTORY_MARGIN`（默认 **10m**）：

```
bbox = 节点与路径所有端点/控制点的 min/max（数据坐标）
innerW = (maxX - minX) + 2 × 10      // 基准数据 → ~190m
innerD = (maxY - minY) + 2 × 10      // 基准数据 → ~95m
```

- 地图在厂房内居中偏移量 `originX = minX - 10`、`originZ = -(maxY + 10)`；厂房墙体/桁架/初始机位全部基于此推导，换图自动适配
- 空地图回退：内空 60m × 40m

### 6.2 地坪

- 厂房地坪：Box 顶面 y=0、厚 0.3m，材质 `MeshStandardMaterial` 中灰混凝土色，roughness 0.95
- 贴图：优先 `public/textures/concrete.jpg`（2K，worldUV 每 12m 重复一次）；**缺失时用 Canvas 程序化噪点纹理回退**，不阻塞渲染
- 分缝：6m × 6m 切缝，深色细条（宽 0.02m，y=+0.002），合并为一个 BufferGeometry——兼作尺度参照，不再另加网格层

### 6.3 围墙与窗带

- 四面墙：高 8m、厚 0.2m 的 Box，浅色墙板（近白）
- 窗带：4.0m ~ 6.5m 高度区间为玻璃带（透明材质，opacity 0.35），透出天空与外景
- 墙板分格：竖向每 6m 一条立柱分格条（略深灰），增强尺度感
- 不做门洞（v1 简化）

### 6.4 屋顶桁架（不封顶）

- 简化钢梁网格，不做腹杆细节：
  - 主梁：沿厂房**短跨方向**，间距 8m，截面 0.35m(宽) × 0.7m(高)，梁底标高 8m
  - 檩条：沿长跨方向，间距 4m，截面 0.15m × 0.3m，置于主梁顶
- 材质：深灰钢，castShadow（梁影落在地坪上是空间感的重要来源）
- 无屋面板——任何俯角视线都不被遮挡，无需动态隐藏逻辑
- 荷载由围墙承担，**不设室内立柱**（避免与路径碰撞的避让问题）

### 6.5 外景

- 天空：drei `<Sky>`（程序化，零资源），`sunPosition` 与平行光方向一致
- 室外地坪：2000m × 2000m 大平面（y=-0.02），园区水泥色，roughness 1
- 雾：`THREE.Fog`，颜色与天际线一致（浅蓝灰），near 250 / far 1200——远景柔和融入

### 6.6 灯光与后处理

| 项 | 配置 |
| --- | --- |
| 平行光（太阳） | 色 #FFF6E8，intensity 2.2，方向约 (0.5, 1, 0.35) 归一化 × 300m；castShadow |
| 阴影 | shadow.mapSize 4096；正交 shadow camera 按厂房 bbox 拟合（左右上下 = bbox + 20m，near 10 / far 500）；bias -0.0001，normalBias 0.05 |
| 半球光 | 天 #DCEAF7 / 地 #B8B2A4，intensity 0.55 |
| 环境反射 | `PMREMGenerator` + three 内置 `RoomEnvironment` 作为 `scene.environment`（零下载），各材质 `envMapIntensity` 0.4~0.6 |
| 色调映射 | `ACESFilmicToneMapping`，exposure 1.05 |
| 抗锯齿 | WebGL2 MSAA（`antialias: true`） |
| dpr | `min(devicePixelRatio, 2)` |

> 注意：阴影只由桁架/围墙投射到地坪；地图标线层 receiveShadow=true、castShadow=false。

### 6.7 环境配色表（起始值，集中在 theme.ts，允许微调）

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

- 形态：贴地矩形条带，宽 **0.12m**（2D 语义线宽 0.05m 在 3D 斜视下不可读，加宽至地坪漆带真实尺度；可调）
- 几何构建（CPU 一次性，纯函数 `buildPathGeometry(edges)`）：
  - LINE：起点终点 + 法线（垂直于切线）两侧各扩 `w/2` → 4 顶点 quad
  - BEZIER：采样 24 段折线，逐段生成 quad；段间用「沿切线各外延 w/2」的重叠法处理接缝（同色系重叠不可见，省去斜接计算）
  - 正向全部合并为**一个** BufferGeometry，反向合并为**另一个** → 2 个 mesh、2 次 draw call
- 材质：MeshStandardMaterial，roughness 0.8
- 颜色（沿用调度系统语义，明亮场景适配版）：
  - 正向 `#C9CAC6`（亮灰白漆；地坪为 #A9A6A0，保证对比）
  - 反向 `#E57373`（红）

### 7.2 方向箭头（沿线重复 chevron）

- 规则：
  - 路径弧长 `L < 1.0m`：不放箭头（过短，方向由邻接路径上下文体现）
  - 否则 `n = max(1, floor(L / 6))` 个，沿弧长均匀分布并整体居中（位置 `(i+0.5)·L/n`）
- 朝向：所在点切线方向，`rotation.y = atan2(Δy_data, Δx_data)`
- 几何：人字形 chevron——顶点 `(+0.18, 0)`，两翼端点 `(-0.10, ±0.14)`，条宽 0.06m，两片 quad
- 实现：**一个 InstancedMesh**（正/反向各一个），实例矩阵 = 位置 + 切线 yaw
- 颜色：与所属路径同语义、加深以在漆带上可读——正向 `#83847F`，反向 `#C05454`

### 7.3 节点

| 类型 | 几何 | 颜色 | 尺寸 |
| --- | --- | --- | --- |
| node（普通） | 实心圆盘（CircleGeometry，24 段） | #78909C | r = 0.10m |
| work（工作站） | 圆环（RingGeometry） | #2196F3 蓝 | 外 r 0.15m / 内 r 0.09m |
| charge（充电点） | 圆环 | #8BC34A 绿 | 同上 |
| park（停车点） | 圆环 | #F44336 红 | 同上 |
| 未知类型 | 按 node 样式兜底 | — | — |

- 实现：圆点一个 InstancedMesh、圆环一个 InstancedMesh（按类型用 `instanceColor` 分色，或三种类型各一个 InstancedMesh——二选一，以后者实现更直白）
- work/charge/park 且 `angle !== null` 时叠加**朝向符号**（§7.4）；node 类型即使有 angle 也不画（与既有语义一致：普通节点无朝向）

### 7.4 站点朝向符号

- 形态：圆环内人字形「>」——顶点 `(+0.55r, 0)`，两翼端点 `(0, ±0.5r)`，条宽 0.05m（r = 0.15m）
- 朝向：`rotation.y = node.angle`
- 颜色：与所属圆环同色
- 实现：一个 InstancedMesh 承载全部站点朝向符号

### 7.5 合并策略汇总

| 对象 | 方式 | draw call |
| --- | --- | --- |
| 正向路径带 | mergeGeometries | 1 |
| 反向路径带 | mergeGeometries | 1 |
| 正/反向箭头 | InstancedMesh × 2 | 2 |
| 节点圆点 | InstancedMesh | 1 |
| 站点圆环 | InstancedMesh × 3（按类型） | 3 |
| 站点朝向符号 | InstancedMesh | 1 |
| 合计 | — | **9** |

---

## 8. 标签系统（LabelLayer）

### 8.1 技术方案

- three/examples `CSS2DRenderer`：绝对定位 div 覆盖在 WebGL canvas 上，`pointer-events: none`
- 每个标签 = `CSS2DObject`（包一个 div），挂在世界坐标 `(x, 0.35, z)`
- **不常驻 1800+ DOM**：按距离阈值动态 attach/detach，DOM 元素池复用

### 8.2 内容与位置

- 节点标签：`node.name`，位于节点正上方
- 路径标签：`edge.name`，位于曲线上 **t=0.4** 处，沿法线偏移 0.2m；**默认关闭**（3000 条太密），配置项开启
- 样式：11~12px，深色文字 #2B2F33，白底 rgba(255,255,255,0.78) 圆角 pill，不随距离缩放（屏幕恒定字号）

### 8.3 距离阈值（每帧按相机距离剔除）

| 相机→标签距离 | 显示 |
| --- | --- |
| < 40m | 全部节点 + 站点标签，同屏上限 300 个（就近优先） |
| 40 ~ 90m | 仅站点类（work/charge/park） |
| > 90m | 全部隐藏 |

- 提供全局开关 `labelsVisible`（默认开）

---

## 9. 相机（CameraRig）

### 9.1 初始机位（45° 斜视全景）

- PerspectiveCamera：fov 46，near 0.5，far 2000
- 以**厂房内空 bbox**（含 margin）做 fit：

```
halfW = innerW / 2,  halfD = innerD / 2
vHalf = fov/2,  hHalf = atan(tan(vHalf) × aspect)
dist  = max(halfW / tan(hHalf), halfD / tan(vHalf)) × 1.15
相机位置 = (centerX, dist·sin45°, centerZ + dist·cos45°)   // 位于南侧，向北看
target  = (centerX, 0, centerZ)
```

- 45° 俯角下相机距墙 ~50m 以外，视线轻松越过 8m 墙顶，全景含地坪、围墙、桁架与天际线
- 基准数据下 dist ≈ 140m，相机高约 100m

### 9.2 OrbitControls 参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| enableDamping / dampingFactor | true / 0.08 | — |
| minDistance / maxDistance | 3 / 350 | 防止钻进地坪、飞出雾外 |
| maxPolarAngle | 80° | 防止视线钻到地面以下 |
| minPolarAngle | 5° | 允许接近正俯视（兼容 2D 阅读习惯） |
| screenSpacePanning | false | 平移约束在地面平面 |
| target 夹取 | 厂房 bbox 四周外扩 20m（可选） | 每次 change 后 clamp |

### 9.3 无拾取约定

- 场景内所有地图/厂房 mesh：`raycast = () => null`
- 不注册任何 onClick / onPointerOver / onContextMenu
- 拾取关闭集中在 MapLayer/FactoryLayer 根组件，v2 恢复交互时只改这一处

---

## 10. 性能预算与资源管线

- draw call 总预算 < 50（地图 9 + 厂房 ~15 + 天空/外景 ~3）
- 几何全部 CPU 预构建 + 合并/实例化；渲染期不分配临时对象
- 阴影贴图 4096 一张（4K 画质预算）；桁架/围墙 castShadow，地坪/标线 receiveShadow
- 纹理预算：地坪 2K × 1（可选）+ 程序化回退纹理 512 × 1
- `map.json` 6.5MB：fetch 期间显示全屏 loading（Spin + 文案）；几何构建（3000 边 × 24 段采样）主线程一次 < 100ms，无需 Worker
- GLTF 管线预留：`public/models/` 目录约定 + `useGLTF` 加载封装建议，v1 不摆放任何道具模型

---

## 11. 边界与异常处理

| 情况 | 处理 |
| --- | --- |
| fetch 失败 / HTTP 非 200 | 全屏错误占位 + 重试按钮 |
| JSON 解析失败 / 无 mapJson 字段 | 同上（视为数据格式错误） |
| 信封与本体两种格式 | loadMap 自动判别解包（§3.1） |
| nodes 为空 | 厂房按 60×40m 回退渲染，画布中央提示「暂无地图数据」 |
| edges 为空 | 只渲染节点，不报错 |
| edgeType=BEZIER 但控制点任一为 null | 降级按 LINE 处理 |
| 零长度路径（L < 0.01m） | 跳过不渲染 |
| 未知 node.type | 按 node 样式兜底 |
| angle 为 null | 不画朝向符号 |
| 边引用不存在的节点 id | 不校验、不影响渲染（几何自带端点坐标） |
| zones / nodeEdgeGroups / 业务字段 | 原样忽略 |
| 超大地图（元素 > 2 万） | 实例化策略天然兼容；标签阈值自动收紧（全量阈值 40m → 25m） |
| WebGL 初始化失败 | 全屏提示浏览器/硬件不支持 |
| devicePixelRatio 过高 | clamp 到 2 |

---

## 12. 模块与目录结构（建议）

```
src/pages/FactoryMap3D/
├── index.tsx               # 页面入口：fetch mapJson、loading/error/空态
├── scene/
│   ├── FactoryCanvas.tsx   # Canvas、dpr、色调映射、雾、灯光、Sky、RoomEnvironment
│   ├── CameraRig.tsx       # 初始 fit 机位 + OrbitControls
│   ├── FactoryLayer.tsx    # 地坪/分缝/围墙/窗带/桁架/室外地坪
│   ├── MapLayer.tsx        # 路径带/箭头/节点/朝向符号（实例化 + raycast 关闭）
│   └── LabelLayer.tsx      # CSS2DRenderer + 标签池 + 距离剔除
└── lib/
    ├── mapJson.types.ts    # §3.2 类型
    ├── loadMap.ts          # fetch + 信封解包 + 基础校验
    ├── coords.ts           # mapToWorld / yawFromMapAngle / bbox 计算（纯函数）
    ├── pathGeometry.ts     # 条带/箭头几何构建（纯函数）
    └── theme.ts            # 全部颜色/尺寸/阈值常量（§13）

public/
├── map.json                # 地图数据
└── textures/concrete.jpg   # 可选地坪贴图（缺失自动程序化回退）
```

---

## 13. 可调常量总表（theme.ts 起始值）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| FACTORY_MARGIN | 10 m | 地图 bbox 外扩 |
| WALL_HEIGHT | 8 m | — |
| WINDOW_BAND | 4.0 ~ 6.5 m | 窗带区间 |
| TRUSS_SPACING / PURLIN_SPACING | 8 m / 4 m | 主梁/檩条间距 |
| FLOOR_JOINT | 6 m | 地坪分缝 |
| PATH_WIDTH | 0.12 m | 路径漆带宽 |
| CHEVRON_SPACING | 6 m | 箭头间隔 |
| CHEVRON_MIN_PATH_LEN | 1.0 m | 短于此不放箭头 |
| NODE_DOT_R | 0.10 m | 普通节点半径 |
| STATION_RING_R | 0.15 / 0.09 m | 站点圆环外/内径 |
| LABEL_NEAR / LABEL_FAR | 40 / 90 m | 标签距离阈值 |
| LABEL_MAX_COUNT | 300 | 同屏标签上限 |
| CAMERA_FOV / NEAR / FAR | 46° / 0.5 / 2000 | — |
| ORBIT_MIN / MAX_DIST | 3 / 350 m | — |
| ORBIT_MAX_POLAR | 80° | — |
| FOG_NEAR / FAR | 250 / 1200 m | — |

---

## 14. v2 扩展预留点（v1 只预留、不实现）

| 预留点 | v1 落点 |
| --- | --- |
| 机器人层 | `RobotLayer` 与 MapLayer 平级插入；坐标直接用 `coords.ts` 的 mapToWorld |
| 实时数据 | frameloop 常开 + useFrame 集中入口；新增 WS hook 驱动实例矩阵更新 |
| 对象拾取 | raycast 关闭集中在 MapLayer 根组件一处，恢复即开 |
| 换数据源 | loadMap(url) 是唯一入口，换 API 只改它 |
| 主题 | 颜色/尺寸全在 theme.ts |
| GLTF 道具 | `public/models/` 约定 + drei useGLTF；摆放规则：道具不得压路径（与路径 bbox 求交剔除） |

---

## 15. 实施里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 | 工程骨架 + FactoryCanvas + FactoryLayer + CameraRig | 空厂房可漫游：地坪/围墙/桁架/天空/灯光就位，45° 初始机位正确 |
| M2 | loadMap + MapLayer（路径/箭头/节点/朝向） | 完整地图渲染，任意角度无 z-fighting，颜色语义正确 |
| M3 | LabelLayer | 标签按阈值出现/消失，同屏 ≤ 300，不卡顿 |
| M4 | 打磨：调色/雾/阴影参数、异常态、4K 性能核查 | 验收清单全过 |

---

## 16. 验收清单

- [ ] 加载 map.json 后初始机位为 45° 斜视全景，全厂+天际线入画
- [ ] 节点 4 类型颜色正确（node 灰蓝实心 / work 蓝环 / charge 绿环 / park 红环），未知类型兜底
- [ ] 站点朝向符号与数据 angle 一致（东 0°、北 90°），angle=null 不画
- [ ] 路径正向灰白、反向红；贝塞尔曲线平滑无折角感
- [ ] 对向共线路径无 z-fighting 闪烁（远/近/平视多角度检查）
- [ ] 方向箭头沿线重复、朝向与路径走向一致；<1m 短路径无箭头
- [ ] 标签：近距全显、中距仅站点、远距全隐；同屏 ≤ 300
- [ ] Orbit：可旋转/缩放/平移；不可钻入地面以下；maxDistance 不超出雾界
- [ ] 无对象交互：点击/悬停地图元素无任何响应
- [ ] 桁架阴影落在地坪与标线上，画面明亮写实
- [ ] 透过窗带与屋顶可见天空/外景/雾
- [ ] 空数据/坏数据/断网三种异常均有明确占位提示
- [ ] 4K 分辨率下稳定 30fps 以上
