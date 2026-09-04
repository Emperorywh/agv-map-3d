# 工业设备外观升级交付记录

完成日期：2026-09-04。保留任务开始时已有暂存修改，没有修改地坪、地图坐标、车辆运动或业务状态推导；没有添加单元测试或测试框架。

## 查看样板

项目根目录运行 `pnpm dev`，打开 [工业资产预览](http://127.0.0.1:5173/?assets=industrial)。默认入口仍为真实地图；预览代码只在开发环境启用，生产构建不包含该页面。

- 三个固定机位：近景检查 AGV 倒角与材质，中景检查整套设施，远景检查轮廓。
- 支持载货、90° 转向、连续转向、异尺寸程序回退、运行/充电/故障/离线/过期状态、200 辆车及资源重建。
- 过期选项会停止上报，等待现有运行时在 10 秒后判定过期。
- 悬停显示简要标签，点击显示完整标签，Esc 或空白单击取消选择。双击与拖拽使用正式相机跟随逻辑。
- 预览中的资源数量、绘制次数、三角形和 FPS 来自实际渲染器。绘制次数及三角形包含阴影通道，不等同于仅车体的主通道预算。

预览设施位置与尺寸位于 `src/app/preview/sampleLayout.ts`。充电柜和货架的通用建模参数位于 `src/shared/industrial/facilities.ts`，货架可配置跨数、跨宽、层数、层间距和深度。

## 模型与真实场景接入

实际使用已存在的 `public/models/agv_industrial.glb`。请求中给出的 `public/models/agv/_industrial.glb` 不存在，因此没有引用该路径，也没有覆盖已有模型资源。

精修资产为 1.8 × 0.7 × 0.35 米，Y 向上，车头 +X，车体中心的地面投影为原点，轮底 Y=0，平台顶面 Y=0.342。`centerOffset` 只由现有世界位姿函数应用一次。

GLB 读取后二进制按 URL 缓存，GPU 资源每代创建一套；各节点的层级变换烘焙后按八种材质合批。状态灯通过实例颜色调制受光色和发光色，不为每辆车创建材质。车壳、底盘、橡胶、平台和金属保持工业材质。

车型配置位于 `vehicleModelConfig.ts`：当前明确允许 1.8 × 0.7 米尺寸档案（容差 1 毫米）使用精修资源，不解释不透明车辆 ID 或未确认的车型枚举。可在 `VEHICLE_TYPE_MODELS` 添加确认过的原始车型映射；尺寸明显不符始终回退，GLB 不做非等比拉伸。

为了控制多车开销，16 米以内进入精修档，20 米以外退出精修档，中间区间保留上一档位以避免闪切。远景、异尺寸和加载失败使用有圆角、轮胎、轮毂、平台、传感器与局部灯带的程序模型。切换只改变外观细节，复用原来的车辆槽位、坐标和载货数据。

| 资产 | 真实场景状态 |
| --- | --- |
| AGV | 已接入所有车辆实例，按配置、尺寸及距离选择 GLB 或程序模型 |
| 充电柜 | 已替换地图充电节点原有桩体、光环和闪电，沿用节点位置；当前操作面朝世界 +Z，不推测缺失朝向 |
| 托盘及货箱 | 已接入车辆载荷，复用 loadLength/loadWidth 与 loaded，仅有一套载货实例 |
| 独立货架、地面托盘和货箱 | 仅独立预览，未加入真实通行路线 |

精修平台实际宽 0.51 米。托盘底部支撑内收，落在平台有效面内；上部面板保留载荷比例与合理悬挑。平台始终显示，纸箱底面接触托盘顶面。

## 标签与交互

普通车辆默认没有完整名称和状态条；悬停显示摘要，选中显示完整信息，异常保持简要提示。标签继续使用原图集和实例槽位，最多 20 个候选，质量降级时最多 12 个，并执行优先级排序和屏幕碰撞避让。屏幕宽度限制为摘要最多 176 像素、完整标签最多 240 像素，远景重点保留最低可读尺寸。

修复了点击事件中的 `isPrimary=false` 导致有效左键点击被忽略的问题。主指针限制仅用于指针会话事件；点击和双击按按钮判定。多部件重叠时选取最近车辆，拖拽不触发选中或清除操作。悬停状态独立于选中和告警，删除实体时同步清理。

## 验证结果与边界

- `pnpm lint`：通过，无 lint 警告。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，发布产物完整性检查通过。主 JS 包约 1.29 MB，构建器仍有大于 500 kB 的体积提示。
- GLB 经项目 Three.js 实际加载，核对尺寸、接地、平台高度与模型部件。发布目录与源 GLB 的 SHA-256 一致：`7796468fd1f904ebd7db15668199758a880747342b7fb7c1afef46282f00710d`。
- 浏览器检查了样板中景和近景、真实地图远近景、转向后部件及货物对齐、载货显隐、普通/悬停/选中/故障/离线/过期标签，以及正式相机逻辑的双击跟随与拖拽退出。
- 200 辆全精修远景曾显示约 721 万三角形、17 FPS；加入距离细节切换后，同一车队远景约 86.5 万三角形，仍为 19 次绘制，后续单页观测约 58 FPS。FPS 受视口、后台页面和本机负载影响，不作为严格性能基准。近距离同时显示大量精修车辆仍有较高顶点开销。
- 反复资源代重建检查发现并修复了原标签图集的 StrictMode 释放问题：GPU 纹理在清理后可以重新上传，不能用永久的“已释放”标志跳过最终卸载。重建后模型、标签和载货重新回填，纹理数量不随重建递增。
- 没有主动触发真实 WebGL 上下文丢失；本次验证覆盖同一资源代重建入口和释放代码，不宣称已完成硬件上下文恢复视觉验证。没有现场 WebSocket 接入数据，真实地图检查使用项目现有 Mock 数据源。

后续仍需提供各车型的明确枚举含义及对应模型、货架/独立托盘/货箱的现场布局、充电柜的实际朝向或安装偏移。未获得这些数据前不猜测布局或车型。

## 本次修改的文件

既有文件：

- `src/main.tsx`
- `src/features/fleet-monitoring/components/FleetMonitoringFeature.tsx`
- `src/features/fleet-monitoring/components/VehicleInstances.tsx`
- `src/features/fleet-monitoring/hooks/useFleetFrameSync.ts`
- `src/features/fleet-monitoring/hooks/useFleetLabelFrameSync.ts`
- `src/features/fleet-monitoring/hooks/useVehicleSelection.ts`
- `src/features/fleet-monitoring/model/createFleetRuntime.ts`
- `src/features/fleet-monitoring/model/fleetMonitoringStore.ts`
- `src/features/fleet-monitoring/scene/createVehicleGeometry.ts`
- `src/features/fleet-monitoring/scene/fleetAppearance.ts`
- `src/features/fleet-monitoring/scene/labelAtlas.ts`
- `src/features/fleet-monitoring/scene/labelLod.ts`
- `src/features/map-visualization/components/LandmarksLayer.tsx`

新增代码：

- `src/app/preview/IndustrialPreview.tsx`
- `src/app/preview/industrialPreview.css`
- `src/app/preview/previewSource.ts`
- `src/app/preview/sampleLayout.ts`
- `src/features/fleet-monitoring/hooks/useVehicleResources.ts`
- `src/features/fleet-monitoring/scene/industrialVehicleModel.ts`
- `src/features/fleet-monitoring/scene/vehicleModelConfig.ts`
- `src/shared/industrial/facilities.ts`
- `src/shared/industrial/geometry.ts`
- `src/shared/industrial/materials.ts`

新增交付记录与浏览器截图保存在本目录。没有修改原有暂存模型、Blender 源文件或原型截图。
