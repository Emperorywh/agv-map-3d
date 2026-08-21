# AGV 调度地图 3D 可视化（agv-map-3d）

把真实 AGV 调度地图（`public/map.json`，"中环大地图"：1767 节点 / 3043 有向边 / 聚合 2046 条走廊）
渲染进一座程序化生成的工厂建筑内，AGV 沿路径网络模拟巡航作业（前端任务流模拟，默认 20 台），
形成可供演示与监控查看的纯查看器 3D 应用。规格说明见 `docs/SPEC.md`。

## 功能清单

- **工厂建筑场景**：程序化外壳（地坪 / 外墙 / 立柱 / 屋顶天窗）+ 内部元素（货架工作台、
  充电区、地面标线、吊灯、卷帘门）+ glTF 点缀资产（充电桩造型、卷帘门门框）；
- **调度地图渲染**：走廊 ribbon（单双向 / 倒车虚线 / 单向箭头）、四类节点实例化造型、
  Canvas 中文图集标签（距离 / 视野分级）；
- **AGV 模拟巡航**：任务流状态机（空闲 / 去取货 / 载货中 / 去充电 / 充电中 / 装卸中）、
  Dijkstra 路径规划、电量模型、充电位互斥、朝向约束与倒车规则遵守地图数据；
- **相机三模式**：自由 Orbit / 正交俯视 / AGV 跟随，0.5s 平滑切换；
- **拾取与详情**：点击节点 / 走廊 / AGV 查看属性详情（右侧面板），hover 弱高亮 + 强制标签；
- **UI 面板**：AGV 列表定位、图层开关（含屋顶三态）、统计信息（状态分布 / 规模 /
  跳过计数 / FPS / Draw Calls）；
- **遮挡处理**：屋顶 footprint 交集自动淡入、墙体双判定并集淡出、立柱俯角 / 正交淡出；
- **性能降级**：规模超限或实测帧率不足时按序启用降级（见下文"性能预算与降级策略"）；
- **分级异常处理**：错误页 + 重试、坏数据跳过计数、glTF / Worker / WebGL 降级（见下文"异常注入验收"）。

## 技术栈与分层架构

React 19 + TypeScript + Vite 8 / three 0.185 + @react-three/fiber 9 + @react-three/drei /
zustand / vitest / oxlint。分层依赖规则（SPEC §12，强制）：

```
src/
├─ config/            # 叶子层：constants.ts（尺寸/阈值）、theme.ts（色彩），不依赖任何层
├─ domain/            # 纯 TS：types / coordinates / normalize / corridors / graph / simulator 等
│                     #   不 import three / react / config；z 取反与朝向换算唯一收口于 coordinates.ts
├─ rendering/         # three 几何与材质纯函数；可 import three 与 config，禁止 import infrastructure
├─ infrastructure/    # IO 层：mapLoader（fetch+Worker）、normalize.worker、assetLoader、webglSupport
├─ state/             # zustand store（选中 / 图层 / 相机模式 / AGV 快照 / FPS / 降级等级）
├─ scene/             # R3F 组件：FactoryBuilding / FactoryInterior / MapLayer / AgvLayer /
│                     #   CameraRig / SceneLighting / FrameStats / DegradationController 等
└─ ui/                # DOM 面板（Canvas 外）：AgvList / LayerToggles / StatsPanel / DetailPanel / TopBar
                      #   不直接 import rendering，只消费 domain 类型与 store
```

每帧数据（AGV 位姿、遮挡不透明度）走 ref / store 瞬时值读取，不进 React 渲染路径；
store 仅承载 0.5s 低频快照。

## 环境要求与快速开始

- Node.js ≥ 20（推荐 LTS）、pnpm ≥ 9；桌面 Chrome / Edge（需支持 WebGL2）。

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发服务器（默认 http://localhost:5173）
pnpm build          # 类型检查 + 生产构建（输出 dist/）
pnpm preview        # 预览生产构建产物
```

## 测试与静态检查

```bash
pnpm test           # vitest 全部单测（domain / rendering 纯函数 + store，含真实 map.json 集成）
pnpm lint           # oxlint
node scripts/analyze-map.mjs      # 复跑 map.json 实测统计（SPEC §4.1 口径）
node scripts/generate-assets.mjs  # 重新生成 public/assets 下两个 glTF 并回读校验
```

## 性能预算与降级策略（SPEC §9）

| 指标 | 预算 | 工程手段 |
| --- | --- | --- |
| 帧率 | 桌面 Chrome/Edge 1080p（CSS 像素）稳定 60fps | 渲染分辨率按 `min(devicePixelRatio, 2)` 封顶 |
| Draw call | < 200 | 静态几何合并、InstancedMesh、标签单 mesh 批渲染 |
| 主线程帧耗时 | < 8ms | 每帧只写实例矩阵 / 颜色，几何零重建，UI 不订阅每帧状态 |
| 启动 | 地图解析 + 场景构建 < 3s | Worker 解析规范化、静态几何分帧构建、加载进度反馈 |
| 阴影 | 1 盏平行光，1024 shadow map | 仅建筑外壳与 AGV 投影 |

**降级策略**：规模（节点 / 有向边 / AGV 台数）超出 `DEGRADE_SCALE_MAX_*` 上限
（默认 2000 / 3600 / 100，按设计上限 ~1800 / ~3000 / 100 留余量）或 0.5s 窗口 FPS 均值
持续低于 `DEGRADE_FPS_THRESHOLD`（默认 55，热身 3s 后需持续 3s）时，按固定顺序逐级启用：

1. 关阴影（唯一投影光源 `castShadow` 关闭）；
2. 标签阈值收紧（透视 / 正交分级阈值切换为 `LABEL_*_DEGRADED` 组）；
3. 隐藏普通导航点（`node` 类整类恒隐藏）。

等级写入 `store.degradeLevel`，只升不降（防阈值附近抖动），每次升级 console 警告留痕；
全部阈值常量在 `src/config/constants.ts` 可调。当前数据（1767 / 3043 / 20 台）按设计
**不触发**降级；验证降级可用性可临时下调上述常量（如把 `DEGRADE_SCALE_MAX_NODES`
改为 1000 → 刷新后阴影关闭且 console 有降级警告）。

## 手动验收方法

以下步骤需人工在桌面 Chrome / Edge 执行（界面与性能无法自动化断言）。
建议用 `pnpm build && pnpm preview` 预览生产产物，1080p 窗口。

### 1. 性能验收（SPEC §9 / §11）

1. 打开应用，右侧"统计信息"面板读取 **FPS** 与 **Draw Calls**：巡航（旋转 / 缩放 /
   切模式 / 跟随 AGV）≥ 3 分钟，FPS 应稳定 60、Draw Calls < 200
   （当前场景静态盘点约 70，含阴影 pass）；
2. **主线程帧耗时**：DevTools → Performance 录制 10s 巡航，帧主线程耗时应 < 8ms；
3. **启动耗时**：DevTools → Network 停用缓存后硬刷新，计时从请求 map.json 到场景
   完整呈现（地图解析 + 场景构建）应 < 3s。

### 2. 视觉与交互走查（SPEC §11）

- **视觉**：schematic 风格（建筑低饱和、地图元素高饱和层级最高）；屋顶默认隐藏、
  进入建筑 footprint 内自动淡入；贴近 / 遮挡视线的墙段淡出；大俯角 / 正交俯视立柱淡出；
  标签分级（拉远仅 work/charge 关键标签，拉近逐级显示 park / node，俯视按视野宽度分级）；
- **交互**：顶部栏切换三相机模式（自由 / 俯视 / 跟随，过渡平滑）；点击节点 / 走廊 / AGV
  看右侧详情面板（双向走廊按方向分两组展示），点击空白取消选中，hover 弱高亮；
  AGV 列表点击切跟随定位；图层开关逐项实时生效（节点 / 路径 / 标签 / 室内陈设 /
  地面标线 / 屋顶三态）。

### 3. 异常注入矩阵（SPEC §10，逐组注入、验证后恢复现场再测下一组）

| 组 | 注入方法 | 预期行为 |
| --- | --- | --- |
| 断网 | DevTools Network 切 Offline 后刷新 | 全屏错误页（原因 + 重试按钮），不进场景；恢复网络点重试成功进入 |
| 坏 JSON | 临时在 `public/map.json` 开头插入非法字符后刷新 | 全屏错误页；恢复文件后重试成功 |
| 顶层结构缺失 | 临时副本移除 `data` 层或 `currentMapInfoVersion` 字段替换 map.json 后刷新 | 全屏错误页；恢复文件后重试成功 |
| 删 glTF | 临时移走 `public/assets/` 下两个 .gltf 后刷新 | 充电桩与门框以程序化占位体呈现，console 警告，场景照常打开；恢复文件 |
| 禁用 Worker | DevTools 以 CSP 禁用 Worker（或临时让 `new Worker` 抛错） | console 警告并回退主线程解析规范化，加载成功进入场景 |
| WebGL 不可用 | 完全退出浏览器后以 `--disable-webgl --user-data-dir=<临时目录>` 启动打开页面 | 显示"浏览器不支持 WebGL"提示页而非白屏；关闭后用正常浏览器确认恢复 |
| 坏节点 / 边 | 临时副本注入缺坐标节点 / 未知类型节点 / 引用不存在节点的边 / s=e 退化边 | 对应节点与边被跳过，console 警告，统计面板"数据跳过计数"非零可见；恢复文件 |
| 无可达充电位 | 观察充电位全被占用时的低电量 AGV | 该 AGV 留 IDLE 重试，console 告警计数，不拖垮全局；充电位释放后正常前往充电 |

## 目录结构

```
public/map.json           # 真实调度地图导出（6.5 MB）
public/assets/            # glTF 点缀资产（scripts/generate-assets.mjs 生成）
docs/SPEC.md              # 规格说明（权威需求）
scripts/                  # analyze-map.mjs（实测统计复跑）/ generate-assets.mjs（资产生成）
src/                      # 见上文分层架构
```
