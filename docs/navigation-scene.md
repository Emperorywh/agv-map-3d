# 暗色工业导航场景

本次只实现地坪、模块墙/立柱/弧形矮墙、导航路线和贴地节点。四类元素均由代码生成；沿用 React Three Fiber 9.6.1、Three.js 0.185.1、Drei 10.7.8、现有相机导航、地面反射和唯一 SceneBloom。未增加依赖，未修改真实地图或业务方向，未新增车辆和设施资产。

## 运行

- 开发：`pnpm dev --host 127.0.0.1`。
- 四元素完整场景：[http://127.0.0.1:5173/?scene=navigation](http://127.0.0.1:5173/?scene=navigation)。读取 `public/config.json` 指定的地图和坐标变换，不连接车辆 WebSocket。
- 材质小样：[http://127.0.0.1:5173/?scene=sample](http://127.0.0.1:5173/?scene=sample)。仅两个节点、一条曲线、一块地坪和一段墙；演示数据集中在 `NavigationPreview.tsx` 的 `sample`。
- 生产：`pnpm build`，然后 `pnpm preview --host 127.0.0.1 --port 4173`；使用同样的查询参数。
- 原监控入口 `/` 保留已有设施与车辆，复用本次更新的地坪、墙体、路线和节点。四元素专用入口无这些设施或外围统计面板，底部只有验收控件。

## 代码与调节入口

| 内容 | 文件（相对于项目根目录） |
| --- | --- |
| 场景与小样入口、固定视角、状态控件 | `src/app/preview/NavigationPreview.tsx`、`src/main.tsx` |
| 发光、路线米制宽度、箭头间距、节点比例、墙面材质 | `src/features/map-visualization/scene/navigationAppearance.ts` |
| 地坪颜色、粗糙度、纹理密度、法线幅度 | `src/features/map-visualization/scene/mapAppearance.ts` |
| 周期颜色/粗糙度/法线纹理与标准 PBR | `src/features/map-visualization/scene/groundSurface.ts` |
| 受控九点模糊反射、环境灯箱 | `src/features/map-visualization/scene/groundReflection.ts`、`createSceneEnvironment.ts` |
| 墙板、立柱、弧形墙与剖切 | `src/features/map-visualization/scene/factoryShell.ts`、`model/factoryLayout.ts` |
| 路线和方向箭头合批 | `src/features/map-visualization/scene/navigationGeometry.ts`、`components/PhysicalPathsLayer.tsx` |
| 实例化节点、悬停、选中、单标签 | `src/features/map-visualization/components/NavigationNodesLayer.tsx` |
| 状态输入 | `src/features/map-visualization/model/navigationState.ts` |
| 原监控场景接入与统一后期 | `src/features/map-visualization/components/MapVisualizationFeature.tsx`、`SceneBloom.tsx` |

## 数据和运行时状态

完整场景使用现有 4,291 个节点、9,265 条有向逻辑边。只进行几何去重，方向依据真实逻辑边的起止节点，忽略 `isBackEdge` 的视觉猜测。贝塞尔控制点保持原值，沿曲线弧长排布箭头。原始数据检查：全部边端点与节点坐标一致，最大误差为 0；`json/map.json` 没有改动。

```ts
import { useNavigationState } from '@/features/map-visualization/model/navigationState'

/**
 * 由业务订阅回调传入实际逻辑边 ID，仅改变展示状态。
 * 未提供状态的路径保持正常通行，不回写业务地图或发出调度命令。
 */
useNavigationState.getState().setPathStates({
  '实际逻辑边ID': 'blocked',
})
```

支持 `clear`（青蓝）、`reserved` / `waiting`（琥珀）、`blocked`（曲线中段红色渐变）。重合物理路径按最高状态优先级着色，双向箭头各自读取对应逻辑边的状态。状态变化只更新颜色缓冲，不重建几何。现有后端未提供路径状态订阅合同，因此没有编造自动状态；专用页面下拉框只用于切换焦点曲线的展示状态。

节点默认统一尺寸，悬停变亮，选中变为琥珀色；仅当前关注节点显示标签。点击相同节点或按 Esc 取消选择。

## 材质和性能

地坪现已更新为深蓝灰缎面金属，金属度为 1，粗糙度贴图基准为 0.36。接缝纹理每 12 米重复、接缝间距 6 米，拉丝与浅划痕的数据纹理每 2 米重复；1024 像素纹理按世界尺寸铺设。周期高度差分生成微弱线性法线纹理，颜色图使用 sRGB 且不含光照。地面专用 PMREM 环境、最终参数和同机位截图见 [金属地板验收](floor-satin-metal.md)。

墙板为非金属喷涂，包边为独立金属材质。重复墙板与立柱实例化，弧墙用轮廓拉伸和小倒角生成，位于原地图外扩建筑范围。近侧上墙沿用相机方向剖切，保留低位边界。

路线和箭头各一个合批网格，节点共用四个实例批次（核心、细环、光晕、拾取）。地坪、路线、箭头和节点按高度分层，贴花关闭深度写入并保留深度测试。路线交汇使用普通透明合成抑制过曝叠加。

没有按节点或路径创建灯光。导航带外缘为低亮度渐变光斑，属于近似受光；屏幕 Bloom、PBR 受光和场景反射分别处理。继续使用原反射目标和显式画质预算，四元素入口采用均衡档。所有几何与材质在生命周期内复用并释放，不逐帧创建业务对象。

## 验收记录（2026-09-09）

- 先运行两节点材质小样，降低过亮的环境光/倒影，再扩展到真实地图。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过，发布产物完整性检查通过；未新增单元测试。构建仍提示主包超过 500 kB。
- 浏览器实测：节点悬停标签、选中、移开鼠标后保留选中、Esc 清除；正常/等待/受阻状态切换；资源重建后保留路径状态。
- 实际拖动旋转、滚轮缩放，检查双向箭头、曲线接合和贴地层次，未观察到明显共面闪烁或方向反转。
- 全图按钮改用既有相机总览命令，覆盖真实路网。固定参考机位保留俯视斜角，允许继续自由操作。
- 生产场景首次加载无控制台错误。开发热更新期间有过修改依赖数组引起的 React 提示，完整刷新和生产构建不再复现；Three.js/驱动仍可能输出已有弃用或着色器警告。

截图存放于 `docs/screenshots/`：`navigation-reference.png`（真实路网斜视）、`navigation-full-map.png`（完整地图）、`navigation-node-selected.png`（节点交互）、`navigation-waiting.png`（等待）、`navigation-blocked.png`（局部受阻）。

与参考图相比，真实路网密度和连接结构不同；不能为了构图移动节点或删减连接。地坪仍比参考图的照片式磨损更均匀，墙体构造更简化，512 像素模糊反射对远处细灯条的表现有限。四元素场景不包含参考图中的车辆、货物、充电塔和绿植，因此空间遮挡及反射层次更少。
