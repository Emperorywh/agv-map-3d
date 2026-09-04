# 工业 AGV 模型

最终模型：`public/models/agv_industrial.glb`。可编辑源文件和实际 GLB 重新导入后的渲染图位于本目录。

| 文件 | 用途 |
| --- | --- |
| `agv_industrial.blend` | 米制 Blender 源文件，保留分件和主要倒角修改器 |
| `agv_industrial_preview.png` | 1600 × 1100 斜俯视预览，由重新导入的 GLB 渲染 |
| `build_agv_industrial.py` | 带多行简体中文注释的完整建模、导出与重新导入脚本 |
| `inspect_glb.mjs` | 使用项目 Three.js 实际加载模型并输出资产检查结果 |
| `blender_validation.json` | Blender 重新导入检查记录 |
| `three_validation.json` | Three.js 加载结果、尺寸、部件、性能统计和文件摘要 |

## 尺寸与坐标

长 **1.8 米**、宽 **0.7 米**，来自 `json/vehicle.json` 的 `agvDimension`。车辆数据没有提供高度，因此总高采用 **0.35 米**。项目现有程序化模型的高度常量注明为经验值，未将其作为车辆真实尺寸。

GLB 采用 **Y 向上、车头 +X**。包围盒为 `[-0.9, 0, -0.35]` 至 `[0.9, 0.35, 0.35]`。根节点 `AGV_Industrial` 为单位变换，原点位于车体中心的地面投影；四轮最低点均为 `Y=0`。无需额外旋转或抬高模型。

Blender 源文件为 Z 向上，导出器按 `(x, y, z) → (x, z, -y)` 转换到 glTF。载物平台顶面位于 GLB 的 `Y=0.342`，比浅灰上沿低 8 毫米。

项目中的 `centerOffset=0.25` 没有烘焙进网格。集成时使用项目已有的车体中心定位结果设置模型位置，避免重复添加偏移。

## 部件与材质

| 部件名 | 功能 |
| --- | --- |
| `Body_Shell` | 有厚度的浅灰罩壳、真实圆角和检修凹口 |
| `Chassis`、`Body_Assembly_Seam` | 内收底盘和装配接缝 |
| `Top_Platform`、`Platform_Gasket` | 空载哑光平台和周围密封圈 |
| `Bumper_Front`、`Bumper_Rear` | 沿前后轮廓包覆的橡胶防撞条 |
| `Wheel_FL`、`Wheel_FR`、`Wheel_RL`、`Wheel_RR` | 四个独立车轮节点，原点在轮心，共享几何 |
| `Service_Cover_Left`、`Service_Cover_Right` | 两侧浅嵌式检修盖 |
| `Sensor_Lidar_Front` | 正向车头的小型扫描窗 |
| `Interface_Panel_Rear`、`Interface_Connectors` | 车尾接口面板和接触端子 |
| `Emergency_Stop` | 小型红色急停按钮 |
| `StatusLight_Front_Left/Right` | 车头两条独立状态灯 |
| `StatusLight_Rear_Left/Right` | 车尾两条较短辅助灯 |

左右按站在车尾朝 +X 车头观察定义：左侧为 GLB 的 -Z，右侧为 +Z。车轮在 Three.js 中为包含三个材质子网格的组，通过 `getObjectByName` 获取组后绕本地 Z 轴转动。

共 8 种 PBR 材质：`Paint_LightGray`、`Chassis_DarkGray`、`Platform_Matte`、`Rubber_Black`、`Sensor_Glass`、`Hardware_SatinMetal`、`Emergency_Red`、`Status_Emission`。灯带共享专用发光材质。橡胶、平台、底盘使用可选的 `KHR_materials_specular` 控制反射，项目 Three.js r185 已成功加载。

没有外部纹理、动画、相机、灯光、地面或解码器依赖；阴影和反射均由场景实时计算。源文件的摄影棚保存在 `Studio_Preview_DO_NOT_EXPORT` 集合，导出时仅选择 `AGV_Asset`。

## Three.js 加载示例

```js
/**
 * 模型从 Vite 的公开资源目录加载，兼容以子目录部署的项目。
 * 根节点已经完成坐标转换和落地处理，直接添加到场景即可。
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const modelUrl = new URL('./models/agv_industrial.glb', document.baseURI)
const gltf = await new GLTFLoader().loadAsync(modelUrl.href)
const agv = gltf.scene
scene.add(agv)

/**
 * 每辆车只复制一份灯光材质，让同车四条灯带同步变色。
 * 复制整车时重复这一处理，避免修改某辆车影响其他车辆。
 */
const firstLight = agv.getObjectByName('StatusLight_Front_Left')
const stateMaterial = firstLight.material.clone()
stateMaterial.color.set('#10c9b5')
stateMaterial.emissive.set('#10c9b5')
stateMaterial.emissiveIntensity = 1
agv.traverse((object) => {
  if (object.isMesh && object.name.startsWith('StatusLight_')) {
    object.material = stateMaterial
  }
})

/**
 * 车轮半径为 0.098 米，正向行驶对应本地 Z 轴负向滚动。
 * travelledMeters 应为沿车头方向累计的有符号行驶距离。
 */
function updateWheelRotation(travelledMeters) {
  for (const name of ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']) {
    agv.getObjectByName(name).rotation.z = -travelledMeters / 0.098
  }
}
```

## 性能与检查

最终 GLB 为 **508,908 字节，约 497 KiB**；每辆车 **18,170 个三角形**，27 个分件节点、21 份 glTF 网格定义。四轮以及成对的状态灯、检修盖复用几何。

按普通 Mesh 加载，单车基础绘制调用为 **35 次**，不包含阴影通道。大量同屏车辆建议按共享几何与材质使用 `InstancedMesh` 批量绘制；仅复制普通对象不会自动减少绘制调用。这里交付的模型保持可控制的分件结构，未替换项目原有的车辆渲染代码。

Blender 重新导入与项目 `GLTFLoader.parseAsync` 检查均已通过：尺寸、水平中心、根节点、四轮接地、正向车头、材质、部件名称、共享网格、有限顶点和法线、无外部资源、无摄影棚对象。预览图使用重新导入的最终 GLB 渲染。

## 重新生成

在项目根目录运行：

```powershell
# 使用独立后台 Blender 进程重新生成模型及预览。
# 生成过程只写本资产目录和 public/models/agv_industrial.glb。
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python-exit-code 1 --python 'assets/agv_industrial/build_agv_industrial.py'

# 使用项目现有的 Three.js 加载结果进行资产检查。
# 详细结果写入本目录中的 three_validation.json。
node 'assets/agv_industrial/inspect_glb.mjs'
```
