"""汇总已经实际验证的成品，生成中文说明与压缩交付包。
通过文件哈希防止把旧验证报告与新 GLB 混装，并保留白模检查证据。
"""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

OUT = Path(__file__).resolve().parent
validation = json.loads((OUT / 'validation_report.json').read_text(encoding='utf-8'))
three = json.loads((OUT / 'three_validation.json').read_text(encoding='utf-8'))
asset = json.loads((OUT / 'asset_report.json').read_text(encoding='utf-8'))
digest = hashlib.sha256((OUT / 'agv_design1.glb').read_bytes()).hexdigest()
assert validation['status'] == 'PASS' and three['status'] == 'PASS'
assert validation['glb_sha256'] == digest == three['glbSha256']


def white_background(source, destination):
    """交付白底预览，同时保留原始透明 PNG 供场景合成。
    不调整车辆颜色和局部结构，只处理预览背景。
    """
    image = Image.open(source).convert('RGBA')
    base = Image.new('RGBA', image.size, 'white')
    base.alpha_composite(image)
    base.convert('RGB').save(destination, quality=95)


for name in ('front', 'rear', 'left', 'right', 'top', 'bottom', 'front_right', 'rear_left', 'reimport_front_right'):
    white_background(OUT / 'previews' / f'{name}.png', OUT / 'previews' / f'{name}_white.jpg')
original = Image.open(OUT / 'previews' / 'front_right_white.jpg').convert('RGB')
reimport = Image.open(OUT / 'previews' / 'reimport_front_right_white.jpg').convert('RGB')
delta = ImageStat.Stat(ImageChops.difference(original, reimport)).mean
validation['reimport_preview_mean_absolute_rgb_difference_0_255'] = delta
(OUT / 'validation_report.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding='utf-8')
size = three['boundsGltfMeters']['size']
readme = f'''# 设计一 AGV 三维资产交付

已在本地 Blender 5.2.1 LTS 实际运行建模脚本，完成白模检查、细节和材质、八个角度渲染、GLB 重新导入和当前项目 Three.js 加载验证。八张参考原图均已读取。所有尺寸均为参考比例推断，并非制造尺寸。

## 文件

- `agv_design1.blend`：可编辑源工程，{asset['editable_blend_mesh_count']} 个独立网格，保留主要倒角修改器；内嵌脚本和参数文本。
- `agv_design1.glb`：自包含车辆资产；无相机、摄影灯、地面、参考图或外部贴图。
- `build_agv.py` 与 `parameters.json`：实际运行的建模脚本及主要尺寸。
- `agv_design1_white.blend`、`white_preview/`：第一轮白模及检查渲染。它们为过程记录，成品修正以最终工程为准。
- `previews/`：正、后、左、右、俯、仰、前右斜视和后左斜视；提供透明 PNG 与白底 JPG。另有 GLB 重导入的实际渲染。
- `final_contact_sheet.jpg`：八视角总览。
- `final_reference_comparison.jpg`：裁去留白、保持比例的参考与成品并列对照。
- `validation_reimport.blend`：重新导入 GLB 后保存的验证工程。
- `validation_report.json`、`three_validation.json`：实际验证数据；报告带成品 SHA-256。

项目静态资源副本位于 `public/models/agv_design1.glb`，可通过 `/models/agv_design1.glb` 加载。

## 假设尺寸与坐标

| 项目 | 米 |
| --- | ---: |
| 主车身长度 | 1.000 |
| 主车身宽度 | 0.610 |
| 壳体顶部离地 | 0.212 |
| 底部防撞边离地 | 0.035 |
| 平台长 × 宽 | 0.944 × 0.545 |
| 平台顶面高度 / 厚度 | 0.287 / 0.019 |
| 立柱宽 × 深 | 0.171 × 0.099 |
| 立柱中心 Y（Blender） | -0.395 |
| 整车高度 | 1.640 |
| 驱动轮半径 | 0.077 |
| 四角辅助轮半径 | 0.033 |
| 屏幕宽 × 高 / 倾角 | 0.305 × 0.203 / 14° |

包括屏幕伸出、灯条与急停按钮后的实际外包尺寸：长 {size[2]:.4f} × 宽 {size[0]:.4f} × 高 {size[1]:.4f} 米。

Blender：X 为横向，车头朝 -Y，Z 向上。正视相机位于 -Y，右视相机位于 +X。
GLB / Three.js：X 保持横向，Y 向上，车头朝 +Z。导出器完成轴转换，加载后无须补偿旋转。命名中的左右沿用参考视图对应侧。
根节点 `AGV_Design1_ROOT` 位于车身平面中心对应的地面点，位置 (0, 0, 0)，比例 (1, 1, 1)。七个轮子均单独建模，轮轴沿本地 X，原点位于轴心。驱动轮轮毂及紧固件跟随对应车轮父节点。

## 模型与材质

银灰曲面空心外壳、深色前包围与第二层防撞面、底部防撞边、悬空平台、深灰立柱、倾斜屏幕、两侧握把、青色灯、双侧红色急停、前部单窗口和后部双窗口均为真实网格。
右侧保留检修盖，左侧不补对称盖板。底部保留两驱动轮、四角辅助轮、前端中央辅助轮架、纵梁、主底板、中心模块及左右不同的底部检修结构。

五个发光网格：`LED_Body_Front_Left`、`LED_Body_Front_Right`、`LED_Body_Rear_Left`、`LED_Body_Rear_Right`、`LED_Mast_Top_Ring`。
发光材质统一为 `LED_Cyan_Emission`，初始强度 2.0，支持 `KHR_materials_emissive_strength`。发光与后期 Bloom 独立，车身没有烘焙光晕。若各灯需要不同颜色，先克隆相应节点的材质。

GLB 静态小零件按材质合并以减少绘制调用，合并节点使用 `Static_` 前缀，`source_parts_json` 记录源零件。源 `.blend` 不做此合并。
实际资产：{validation['triangles']:,} 个三角形、{validation['glb_nodes']} 个 glTF 节点、{validation['export_mesh_count']} 个 glTF 网格、{three['meshCount']} 个 Three.js 网格渲染对象、{validation['materials']} 种材质，GLB {validation['glb_bytes'] / 1048576:.2f} MiB。

```js
/*
 * 按模型自带坐标直接加载车辆，不添加额外轴补偿。
 * 根节点位于地面中心，可用作整车平移与转向节点。
 */
import {{ GLTFLoader }} from 'three/addons/loaders/GLTFLoader.js';
const gltf = await new GLTFLoader().loadAsync('/models/agv_design1.glb');
scene.add(gltf.scene);
const vehicle = gltf.scene.getObjectByName('AGV_Design1_ROOT');

/*
 * 共用材质会同时修改五段灯；需要分区控制时先克隆材质。
 * Bloom 由场景后处理配置，未包含在车辆资产中。
 */
const led = vehicle.getObjectByName('LED_Body_Front_Left');
led.material.emissive.set('#9effff');
led.material.emissiveIntensity = 2;

/*
 * 驱动轮本地 X 轴与轮轴重合，正向角速度对应朝 +Z 滚动。
 * 每帧传入实际速度与时间差，即可避免轮胎滑动。
 */
const wheel = vehicle.getObjectByName('Wheel_Drive_Right');
wheel.rotateX(speedMetersPerSecond * deltaSeconds / 0.077);
```

## 已完成核对及仍有差异的部分

| 视角 | 已核对内容 | 推断或简化 |
| --- | --- | --- |
| 正视 | 高宽比、平台厚度、立柱与屏幕、把手、左右灯条和按钮 | 前窗口内部无可辨认器件，采用黑色玻璃 |
| 后视 | 连续立柱背面、双传感器、银色后壳、短灯带 | 双窗口支架与浅槽仅按可见轮廓建立 |
| 左右 | 立柱位置、屏幕倾斜与支座连接、平台间隙、轮拱、右侧检修盖差异 | 包围倒角及轮拱曲率为视觉拟合 |
| 俯视 | 圆角底盘与平台轮廓、立柱截面、屏幕和握把投影 | 原图前后圆角略有差异，采用统一圆角轮廓 |
| 仰视 | 两驱动轮、四角轮、前中央轮架、纵梁和中心模块 | 内部线束、弹簧、微型紧固件及不可见机构未完整还原 |
| 两斜视 | 车壳曲面、部件连接、前后包围与平台关系 | 中性预览灯光不同于原始渲染，反光不会逐像素相同 |

参考 PNG 透明区域在某些预览器中显示为拉伸异常面；对照图先正确合成透明通道，再裁掉留白。未将异常背景或被裁切的区域建成实体。
没有真实 CAD、制造尺寸和屏幕界面，不能视为制造级精确模型。顶端支座曲面、底部中央模块用途、辅助轮内部结构及螺钉规格仍为保守推定；屏幕保持参考中的熄屏外观，没有虚构界面或科幻装饰。

## 验证与复现

GLB 重新导入 Blender：{validation['status']}，{validation['source_parts_matched']} 个源网格部件全部对应，最大部件包围误差 {validation['maximum_part_bounds_drift_m']:.3g} 米。
项目当前 Three.js 的 `GLTFLoader` 实际解析：{three['status']}，五段独立发光网格、七个轮轴原点、米制总高、+Z 车头、地面根节点均通过检查。GLB 不含相机、摄影灯或纹理图片。
重新导入渲染与导出前相同机位预览的 RGB 平均绝对差：{', '.join(f'{v:.3f}' for v in delta)} / 255；渲染器采样与导出后法线插值可产生小差异。

在当前目录运行：

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --python build_agv.py -- white
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --python build_agv.py -- final
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --python validate_agv.py
node verify_three.mjs
python compose_previews.py final
python finalize_delivery.py
```

`verify_three.mjs` 需要能解析项目已安装的 `three`。预览排版脚本需要 Pillow；模型生成与 GLB 导出不依赖参考图路径。主要尺寸集中在 `parameters.json`，更换尺寸后应重新运行白模与最终验证。

成品 SHA-256：`{digest}`
'''
(OUT / 'README_交付说明.md').write_text(readme, encoding='utf-8')
public = OUT.parents[1] / 'public' / 'models' / 'agv_design1.glb'
public.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(OUT / 'agv_design1.glb', public)
files = [p for p in OUT.iterdir() if p.suffix in ('.py', '.json', '.mjs', '.md', '.jpg') or p.name in
         ('agv_design1.blend', 'agv_design1.glb', 'agv_design1_white.blend', 'validation_reimport.blend')]
files += list((OUT / 'previews').glob('*')) + list((OUT / 'white_preview').glob('*.png'))
with zipfile.ZipFile(OUT / 'AGV_Design1_交付包.zip', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in files:
        archive.write(file, 'AGV_Design1/' + file.relative_to(OUT).as_posix())
print(json.dumps({'zip': str(OUT / 'AGV_Design1_交付包.zip'), 'files': len(files),
                  'public_glb': str(public), 'glb_sha256': digest, 'preview_rgb_delta': delta}, ensure_ascii=False))
