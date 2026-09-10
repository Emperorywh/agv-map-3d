# 当前满载资源：蓝色八箱托盘

`shelf_loaded.glb` 已替换为 `../../cargo_pallet/cargo_pallet.glb` 的同字节副本。可编辑源模型及建模脚本位于 `../../cargo_pallet/`；旧的 `build_shelf.py` 与 `shelf_master.blend` 属于原货架，不能用于重建当前托盘模型。

| 网页资源 | 三角面 | 文件大小 |
| --- | --- | --- |
| shelf_loaded.glb | 15,160 | 745,464 字节 |
| shelf_loaded_LOD1.glb | 5,238 | 335,496 字节 |
| shelf_loaded_LOD2.glb | 4,232 | 266,064 字节 |

三档均使用托盘货物的六种材质，保留嵌入图像；主体基础色为 #9AB5F6，粗糙度 0.45。主模型米制尺寸为宽 1.203、深 1.007、高 1.1875，底面中心为原点。车载资源沿用原有九十度旋转和平台抬升；库区站点沿用整体宽度 1.2 m 的等比适配。

共享加载器已适配六种新材质；库区加载器跳过旧货架的统一材质覆盖。地面设施使用 0.61 m 的保守半宽进行边界和道路避让。空架资源保持原样。

原主模型及两份 LOD 备份于 `../../cargo_pallet/replaced_shelf_backup/`。重建当前满载 LOD 时运行本机 Blender，指定 `--python scripts/buildFacilityLods.py -- shelf_loaded`，仅更新这两份派生模型。

生产构建使用 Three.js GLTFLoader 解析三档实际产物，检查材质、顶点属性、内嵌贴图范围、包围盒与减面比例。未把该检查等同于浏览器像素显示或帧率验证。
