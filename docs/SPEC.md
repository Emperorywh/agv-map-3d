# AGV 调度地图 3D 可视化 —— 工厂建筑场景规格说明

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 已完成访谈，待评审 |
| 创建日期 | 2026-08-21 |
| 目标版本 | v1.0 |
| 关联代码 | `public/map.json`（真实 2D 调度地图导出，6.5 MB） |

---

## 1. 背景与目标

在 Three.js 中把 AGV 调度地图（节点 + 路径）渲染进一个**完整的工厂建筑**里，形成一个可供演示与监控查看的 3D 可视化应用：

- 建筑提供空间上下文（墙体、立柱、货架、充电区、天窗），但**视觉焦点永远是调度地图本身**；
- AGV 在建筑内沿路径网络巡航作业（前端模拟任务流），运动遵守地图数据中的朝向约束与倒车规则；
- 用户可旋转/缩放/俯视/跟随 AGV，点击任意节点、边、AGV 查看属性详情。

## 2. 范围与非目标

### 2.1 本期范围（In Scope）

- 读取 `public/map.json` 静态数据，渲染单层工厂建筑 + 调度地图 + 模拟巡航 AGV；
- 纯查看器：相机三模式（自由 / 俯视 / AGV 跟随）、拾取选中 + 右侧详情面板；
- UI 面板：AGV 列表与定位、图层开关、统计信息；
- 核心逻辑单元测试 + 手动验收。

### 2.2 非目标（Out of Scope，本期明确不做）

- 地图编辑（拖拽节点、连边、保存导出）；
- 实时数据接入（WebSocket / 轮询），数据层不为"快照+增量"预留抽象；
- 多地图切换、多层建筑渲染（数据结构仅预留 `floor` 字段与电梯点类型）；
- 搜索定位、截图/视频导出、移动端适配、i18n、主题切换；
- 后端服务（纯前端静态应用）。

## 3. 技术栈

| 类别 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 19 + TypeScript + Vite 8 | 已有脚手架 |
| 3D | three 0.185 + @react-three/fiber 9 | 已有依赖 |
| 3D 辅助 | **新增** @react-three/drei | OrbitControls、Stats 等 |
| 状态管理 | **新增** zustand | R3F 生态标准，UI 状态与模拟状态共享 |
| 测试 | **新增** vitest | 纯函数模块单测 |
| Lint | oxlint | 已有 |

渲染入口结构：`App.tsx`（DOM UI 壳）→ `<Canvas>`（R3F）→ 场景组件树。UI 面板在 Canvas 外，通过 zustand 与场景通信，**禁止**在 React 渲染路径上放每帧更新的状态（每帧数据走 ref / store 瞬时值读取）。

## 4. 数据源与数据模型

### 4.1 map.json 实测结构

`public/map.json` 为真实调度系统的地图导出（地图名"中环大地图"，`floor: 1`），结构：

```
code / message / timestamp
└─ data
   └─ currentMapInfoVersion.mapJson
      ├─ nodes[1767]   { id, name, type, x, y, angle, enterChargeStationId, actions, ... }
      ├─ edges[3043]   { id, name, edgeType, sx, sy, ex, ey, cx, cy, dx, dy,
      │                  snodeId, enodeId, sfacing, efacing, isBackEdge, cost,
      │                  maxLoadSpeed, maxFreeSpeed, maxLoadAcceleration, ... }
      ├─ zones[0]          （本期为空，忽略）
      └─ nodeEdgeGroups[0] （本期为空，忽略）
```

实测关键事实（已用脚本验证）：

| 事实 | 数值 |
| --- | --- |
| 节点类型分布 | `node` 1303 / `work` 389 / `charge` 11 / `park` 64 |
| 边类型 | `LINE` 2934（控制点为 null）/ `BEZIER` 109（**三次**贝塞尔，c/d 两个控制点） |
| 坐标范围 | x ∈ [-165.74, 2.10]，y ∈ [-25.12, 50.20]，单位**米**，场地约 168m × 75m |
| 有反向配对的有向边 | 1994 条（即约 997 条双向走廊） |
| 无配对的单向边 | 1049 条 |
| 配对组中恰一条 `isBackEdge=true` | 871 组（语义：该方向 AGV **倒车**通过） |
| 配对组中两条均非 back | 126 组（双向均可正向行驶） |
| `sfacing ≠ efacing` 的边 | 51 条（沿边行驶需渐变朝向） |
| 悬空引用边（指向不存在节点） | 0 条 |
| 节点 `angle` 非空 | 464 个（停放/作业朝向） |

### 4.2 规范化内部模型（NormalizedMap）

加载层把 map.json 规范化为与后端格式解耦的内部模型（domain 层纯类型）：

```ts
interface NormalizedMap {
  calibration: Calibration;      // 见 4.3
  floor: number;                 // 预留多层，本期恒为 1
  nodes: NormalizedNode[];       // { id, name, kind, x, y, angle? }
  edges: NormalizedEdge[];       // { id, name, from, to, geometry: Polyline,
                                 //   sFacing, eFacing, isBackEdge, cost,
                                 //   maxSpeedLoad, maxSpeedFree, ... }
  corridors: Corridor[];         // 按无序节点对配对出的走廊（见 6.1）
}

type NodeKind = 'node' | 'work' | 'charge' | 'park' | 'elevator'; // elevator 仅预留
```

- `kind` 由 `type` 字段映射；未知类型降级为 `node` 并 console 警告；
- BEZIER 边在规范化阶段细分为折线（`geometry: Polyline`，含累积弧长表），LINE 边为两点折线，下游统一处理；
- `corridors` 由 `edges` 按无序节点对聚合，是渲染层唯一消费的路径形态；有向 `edges` 保留给模拟器。

### 4.3 坐标系与校准

- 约定：地图坐标单位视为**米**，世界坐标系为 three.js 默认右手系（Y 向上）；
- 规范化模型携带 `calibration: { scale, rotationRad, offsetX, offsetY }`，当前由 normalize 层输出默认值：`scale=1, rotation=0`，offset 取节点包围盒中心（使建筑与地图居中于世界原点）；
- **地图 (x, y) → 世界 (x·s - ox, 0, -(y·s - oy))**：2D 的 y 向上对应世界 -z。**z 轴翻转与校准计算只许出现在 `domain/coordinates.ts` 一个模块**，其余代码一律使用其导出的转换函数，不得自行取反；
- 建筑外壳与地图共用同一转换，天然对齐，不需要二次配准。

### 4.4 加载管线

1. `fetch('/map.json')` + 加载进度 UI（6.5 MB，本地秒级，部署后取决于网络）；
2. JSON.parse 与规范化放入 **Web Worker**，避免主线程卡顿；失败时见 §10；
3. 规范化完成后一次性构建静态场景几何（分帧构建，避免长任务）。

## 5. 场景设计

### 5.1 视觉风格：Schematic 示意风

- **建筑**：低饱和、浅灰/米白、哑光，半透或纯色平涂；不抢戏；
- **地图元素**（路径 / 节点 / AGV）：高饱和 + 轻微 emissive，深色通道色带压在地面上，视觉层级最高；
- 地面（地坪）用中性深灰，与通道色带拉开对比；
- 色彩规范集中在 `config/theme.ts`，禁止散落硬编码。

### 5.2 建筑外壳（程序化生成）

由参数化函数生成，尺寸 = 地图包围盒 + `FACTORY_MARGIN`（常量，默认四周各 8m）：

| 元素 | 规格 |
| --- | --- |
| 地坪 | 单块平面，深灰哑光，带浅网格刻线（每 10m） |
| 外墙 | 高 6m，沿包围盒矩形，schematic 浅色，近相机侧自动淡出（见 5.5） |
| 立柱 | 规则阵列（默认柱距 12m，可调），避开走廊 ribbon 区域采样放置 |
| 屋顶 | 平屋顶 + 规则天窗带；默认隐藏，随相机模式/高度自动淡入淡出（见 5.5） |
| 卷帘门 | 外墙长边各 2 扇（装饰性，固定关闭） |

### 5.3 内部元素

| 元素 | 规则 |
| --- | --- |
| 货架与工作台 | 摆放在走廊网络覆盖不到的"空地"区域（按网格采样，与最近走廊距离 > 阈值才放置），成排布置，风格化低多边形 |
| 充电区 | 与 `charge` 节点对齐：在 charge 节点旁生成充电桩占位体 + 地面充电位色块；**这是数据关联元素，不是纯装饰** |
| 地面标线 | 通道两侧边缘线（随 ribbon 生成）、斑马线（卷帘门内侧）、区域色块（充电区/装卸区） |
| 天窗与照明 | 屋顶天窗带（发光材质模拟透光）+ 室内吊灯阵列（仅发光体，不逐个投影）；光照用 1 盏平行光 + 半球光，阴影只对建筑与 AGV 开低分辨率 shadow map，货架/立柱不投影 |

### 5.4 glTF 点缀资产

- 仅少量：充电桩造型、卷帘门门框。放在 `public/assets/`；
- 加载失败 → 用程序化占位体替换并 console 警告（分级降级，见 §10），**不阻塞场景**；
- 资产统一约定：+Z 为正面、米制、原点在底部中心；加载后按校准规则摆放。

### 5.5 遮挡处理：屋顶自动隐藏 + 相机穿透淡出

- 默认（俯视/中远距离）：屋顶与天窗**隐藏**，直接看到内部地图；
- 相机高度低于屋檐（进入建筑内部）：屋顶自动淡入呈现室内感；
- 相机靠近/穿入外墙：被穿透或遮挡视线的墙段自动淡出（按相机与墙段距离驱动透明度，带滞后阈值避免闪烁）；
- 图层开关中提供"屋顶"手动覆盖项（自动 / 强制显示 / 强制隐藏）。

## 6. 地图渲染

### 6.1 走廊配对与去重（关键规则）

数据中的一条"路"通常是**两条几何重叠的有向边**（每个方向一条）。直接全量渲染会 z-fighting 且箭头互相矛盾。规则：

1. 按无序节点对聚合有向边为 `Corridor`；
2. 一条走廊只渲染**一条 ribbon**（几何取任一方向，配对边几何不一致时取长度较短者并警告）；
3. 走廊通行属性：
   - **双向**（存在反向配对）：不画方向箭头；
   - **单向**（无配对，1049 条）：画方向箭头（snode→enode 方向）；
4. 倒车标识：某方向 `isBackEdge=true` 时，该方向按"倒车通行"渲染——双向走廊在 ribbon 对应侧画虚线边缘；单向倒车边整条用虚线样式 + 异色；
5. 两条均非 back 的双向走廊（126 组）：正常纯色 ribbon。

### 6.2 路径 ribbon 几何

- 宽度常量 `RIBBON_WIDTH`（默认 1.5m，可调），贴地坪上方 2cm（防 z-fighting 用 polygonOffset）；
- 折线生成三角带，拐角处 miter join（限制 miter 长度防脱节）；全部走廊合并为**一个** BufferGeometry（顶点色编码样式：普通/倒车/单向底色），箭头用单独 instanced 几何或纹理动画；
- BEZIER 自适应细分（弦高差容差可配，默认 0.05m），细分结果缓存弧长表供模拟器复用。

### 6.3 节点渲染

全部节点用 InstancedMesh（按类型分组，4~5 个 draw call）：

| 类型 | 造型 | 尺寸/强调 |
| --- | --- | --- |
| `work` 装卸站点 | 方形台 + 图标色块 | 最大，最醒目 |
| `charge` 充电位 | 六边形/圆台 + 充电区色块联动 | 大 |
| `park` 停车位 | 中小圆点 | 中 |
| `node` 普通导航点 | 小圆点 | 最小，相机拉远时整类隐藏 |
| `elevator`（预留） | 仅类型定义，本期不渲染 | — |

### 6.4 标签策略

- Canvas 绘制文字图集（支持中文，如"门口充电桩1"）→ sprite；同名字符合并图集，禁止每标签一张纹理；
- 距离分级：> 80m 全部隐藏；20~80m 仅 `work`/`charge`；< 20m 全部显示；
- hover / 选中的对象**强制显示**其标签；
- 阈值常量可调；标签始终面向相机。

## 7. AGV 模拟器与运动学

### 7.1 任务流状态机

模拟器（domain 层，纯 TS，可单测）驱动默认 **20 台** AGV（可调，上限按 100 设计）：

```
IDLE(停在 park/work)
  → TO_PICK(规划到某个 work 节点) → LOADING(停留 N 秒)
  → TO_DROP(规划到另一 work 节点) → UNLOADING(停留 N 秒)
  → 电量 < 阈值 → TO_CHARGE(最近空闲 charge 节点) → CHARGING → IDLE
```

- 路径规划：Dijkstra，权重 = 边长 / 限速（或直接用 `cost`，二选一，常量切换）；
- 充电位占用互斥；任务选择带随机性，保证演示画面有差异；
- 状态集合：`空闲 / 去取货 / 载货中 / 去充电 / 充电中 / 装卸中`，各配状态色（`config/theme.ts`）。

### 7.2 运动学（遵守数据约束）

- 沿边折线弧长参数化行驶，速度/加减速取边的 `maxFreeSpeed / maxLoadSpeed / max*Acceleration` 字段（缺省值兜底）；
- **朝向约束**：进入边时朝向对齐 `sfacing`，离开时对齐 `efacing`；两者不等的边（51 条）沿弧长插值旋转；节点处若相邻边朝向突变，AGV 原地旋转后再出发；
- **倒车边**：`isBackEdge=true` 的边上 AGV 车头朝运动反方向（车尾先行的叉车倒车姿态），倒车速度低于正向（常量系数）；
- 节点 `angle` 非空时，AGV 在该节点停靠期间对齐 `angle`。

### 7.3 AGV 外观

- 风格化几何体小车（底盘 + 顶盖 + 方向楔形/前灯），示意叉车比例（默认 1.6 × 1.0 m，常量）；
- 顶部状态色环 + 编号 sprite（复用标签图集机制）；
- InstancedMesh 渲染，每帧只更新实例矩阵与颜色，不重建几何。

## 8. 相机、交互与 UI

### 8.1 相机三模式

| 模式 | 行为 |
| --- | --- |
| 自由 Orbit（默认） | 极角限制 5°~85°（防穿地/防翻转），距离 5~400m，阻尼开启 |
| 正交俯视 | 一键切换，等效 2D 地图视角，支持平移缩放 |
| AGV 跟随 | 从 AGV 列表或选中 AGV 触发；相机跟随目标，仍可环绕/缩放；Esc 或手动切模式退出 |

模式切换带平滑过渡（位置/目标点插值，约 0.5s）。

### 8.2 拾取与详情

- Raycast 拾取节点 / 走廊 / AGV（InstancedMesh 按 instanceId 反查对象）；建筑元素不可拾取；
- 选中后：场景中高亮（emissive 提升 + 描边色环），右侧详情面板显示完整属性：
  - 节点：名称、类型、坐标、angle、关联边列表；
  - 边/走廊：名称、方向（单/双向）、是否倒车、长度、cost、限速等原始属性；
  - AGV：编号、状态、当前任务、所在边、电量（模拟值）；
- 点击空白处取消选中；hover 有弱高亮 + 强制标签。

### 8.3 UI 面板（DOM，Canvas 外）

1. **AGV 列表**：编号 + 状态色点，点击定位（切跟随模式），显示计数；
2. **图层开关**：节点 / 路径 / 标签 / 货架与工作台 / 地面标线 / 屋顶（自动-显示-隐藏三态）；
3. **统计信息**：AGV 各状态数量、节点/走廊/边总数、FPS；
4. 顶部栏：相机模式切换按钮。

## 9. 性能预算与策略

| 指标 | 预算 | 手段 |
| --- | --- | --- |
| 目标 | 桌面 Chrome/Edge，1080p 稳定 60fps | — |
| Draw call | < 200 | 静态几何合并、InstancedMesh、材质数量控制 |
| 主线程帧耗时 | < 8ms | 每帧只写实例矩阵/颜色；几何零重建；UI 不订阅每帧状态 |
| 启动 | 地图解析 + 场景构建 < 3s | Worker 解析、分帧构建、加载进度反馈 |
| 阴影 | 1 盏主光，≤1024 shadow map | 仅建筑 + AGV 投影 |

规模按中型上限设计：~1800 节点 / ~3000 有向边（~1500 走廊）/ 100 AGV 内不触发降级。超出时降级策略（按序启用）：关阴影 → 标签阈值收紧 → 隐藏普通导航点。

## 10. 异常与分级降级

| 异常 | 处理 |
| --- | --- |
| map.json 请求失败 / JSON 损坏 / 顶层结构缺失 | 全屏错误页（原因 + 重试按钮），不进场景 |
| 个别节点缺坐标 / 类型未知 | 跳过该节点（关联边一并跳过），console 警告 + 计数面板可见 |
| 个别边引用不存在节点 / 几何退化（s=e） | 跳过该边，console 警告 + 计数 |
| glTF 点缀资产加载失败 | 程序化占位体替换，console 警告，场景照常 |
| WebGL 不可用 | 提示页（浏览器不支持说明） |
| 模拟器进入异常状态（如找不到可达充电位） | 该 AGV 回到 IDLE 并告警计数，不拖垮全局 |

原则：**主场景永远尽量可打开**；所有跳过都有日志与计数，便于发现数据问题。

## 11. 测试策略

vitest 单测覆盖纯函数模块（domain / rendering 的几何纯函数部分），3D 渲染手动验收：

- `coordinates`：校准、y→-z 翻转、往返转换一致性；
- `normalize`：map.json → NormalizedMap（类型映射、BEZIER 细分、未知类型降级、坏数据跳过）；
- `corridors`：配对/去重规则、单双向判定、back 方向归属（用 §4.1 实测分布做断言样本）；
- `graph`：邻接表构建、Dijkstra 正确性、不可达处理；
- `simulator`：状态机迁移、充电互斥、任务完成回流 IDLE；
- `bezier/ribbon`：细分精度、弧长表单调性、ribbon 顶点数与拐角退化。

手动验收清单：视觉走查（风格/遮挡/标签分级）、交互走查（三相机模式/选中/面板）、性能（Stats 面板确认 60fps 与 draw call）、异常注入（断网/坏 JSON/删 glTF）。

## 12. 分层架构与目录结构

依赖规则（**强制**）：

- `domain`：纯 TS，不 import three / react / config；需要的常量（如 FACTORY_MARGIN）以参数传入；
- `rendering`：可 import three，**禁止 import infrastructure**；通过 domain 类型交换数据；
- `infrastructure`：IO 层（fetch、Worker、glTF loader），可依赖 domain；
- `ui` / `scene`：React 层，组合以上三层；
- z 翻转只在 `domain/coordinates.ts`（见 §4.3）。

```
src/
├─ main.tsx / App.tsx
├─ config/            # constants.ts（尺寸/阈值）、theme.ts（色彩）
├─ domain/            # 纯 TS：types.ts, coordinates.ts, normalize.ts,
│                     #   corridors.ts, graph.ts, bezier.ts, simulator.ts
├─ rendering/         # three 几何与材质纯函数
│  └─ scene/
│     ├─ map/         # instanceGeometry.ts（节点/AGV 实例几何）、ribbonGeometry.ts
│     └─ factory/     # shellGeometry.ts、interiorGeometry.ts
├─ infrastructure/    # mapLoader.ts（fetch+Worker）、normalize.worker.ts、assetLoader.ts
├─ state/             # zustand store（选中、图层、相机模式、AGV 快照）
├─ scene/             # R3F 组件：FactoryBuilding / MapLayer / AgvLayer / CameraRig / Effects
└─ ui/                # DOM 面板：AgvList / LayerToggles / StatsPanel / DetailPanel / TopBar
```

## 13. 里程碑拆分

| # | 任务 | 产出 |
| --- | --- | --- |
| TASK-001 | 脚手架：装依赖（drei/zustand/vitest）、分层目录、lint | 空场景可运行 |
| TASK-002 | 数据层：Worker 加载 + normalize + coordinates + 单测 | NormalizedMap 可用 |
| TASK-003 | 走廊配对 + 折线/贝塞尔细分 + ribbon 几何 | 地面通道可见 |
| TASK-004 | 节点 InstancedMesh + 类型造型 | 全图静态可见 |
| TASK-005 | 标签图集 + 距离分级 | 标签可读不糊 |
| TASK-006 | 建筑外壳（地坪/墙/柱/屋顶/天窗） | 完整厂房轮廓 |
| TASK-007 | 内部元素（货架/充电区/标线/卷帘门）+ glTF 点缀与降级 | 室内有内容 |
| TASK-008 | schematic 材质与光照氛围 | 风格成型 |
| TASK-009 | 遮挡：屋顶/墙体自动淡出 + 手动覆盖 | 视线无死角 |
| TASK-010 | 模拟器（图规划 + 任务流状态机）+ 单测 | AGV 逻辑可跑 |
| TASK-011 | AGV 渲染 + 运动学（朝向约束/倒车） | AGV 真实巡航 |
| TASK-012 | 相机三模式 + 平滑切换 | 视角完整 |
| TASK-013 | 拾取 + 详情面板 + 高亮 | 可查看属性 |
| TASK-014 | UI 面板（列表/开关/统计） | 功能闭环 |
| TASK-015 | 性能验证与调优、异常注入验收 | 达成 §9 预算 |

## 14. 访谈决策速查表

| 主题 | 决策 |
| --- | --- |
| 数据源 | 静态 JSON（`public/map.json`） |
| 设计规模 | 中型：~1000+ 节点 / ~3000 边 / ≤100 AGV |
| 坐标对齐 | 规范化模型自带 calibration；z 翻转收敛单一模块 |
| 楼层 | 单层；数据预留 `floor` 与 `elevator` 类型 |
| 建筑来源 | 程序化外壳 + 少量 glTF 点缀 |
| 内部元素 | 墙/柱/卷帘门、货架工作台、充电区与地面标线、天窗照明（全要） |
| 视觉风格 | Schematic 示意风 |
| 遮挡 | 屋顶自动隐藏 + 相机穿透淡出 |
| AGV 驱动 | 前端任务流模拟 |
| 路径渲染 | 有宽度 ribbon + 单向箭头；区分倒车边；不区分曲线/直线 |
| 节点类型 | work / charge / park / node / elevator（预留） |
| 标签 | 缩放阈值 + hover/选中强制显示 |
| 定位 | 纯查看器 |
| 相机 | 自由 / 正交俯视 / AGV 跟随 |
| 选中展示 | 右侧详情面板 + 场景高亮 |
| UI 面板 | AGV 列表定位、图层开关、统计 |
| 性能目标 | 桌面 1080p @60fps |
| 异常策略 | 分级降级 |
| 测试 | 核心逻辑单测 + 手动验收 |
| 扩展预留 | 不预留（数据模型层的 floor/elevator 除外） |

## 15. 开放问题与假设

1. **calibration 默认值**：当前按"米制 + 包围盒居中"处理；若后续更换地图导出格式，需在 normalize 层填入真实 scale/rotation。
2. **单向边可信度**：1049 条无配对边按数据原样渲染为单向；若实际是数据遗漏（本该双向），表现为"看起来能双向走的路画了箭头"——以数据为准，不做猜测性修复。
3. **走廊配对几何不一致**：配对边若几何偏差超过阈值（默认 0.3m），取短者渲染并警告计数；本期不做双 ribbon。
4. **AGV/ribbon 尺寸**：AGV 1.6×1.0m、ribbon 1.5m 为经验默认值，首版视觉走查后可调（均为常量）。
5. **任务随机性**：模拟器任务分配用种子随机数，保证演示可复现（种子常量，调试时可固定）。
