# 参考图金属地面实现

2026-09-09。本轮以用户提供的原型图为目标，地面改为石墨灰缎面钢板。本说明取代历史验收中关于全方向等亮环境、固定观察方向的设置；历史截图保留。

## 材质与光照

- 使用 `MeshStandardMaterial`，金属度 `1`、底色 `#727980`，粗糙度图基准 `0.42`，材质粗糙度乘子 `1`。
- 恢复 Three.js 原生观察方向与金属受光，不再将观察方向固定为 45°。反光会随相机角度正常变化。
- 三张 `1024×1024` 程序纹理：颜色与粗糙度按 `24 m` 平铺，微法线按 `2 m` 平铺；纹理锚定世界原点，修改厂房范围不拉伸或移动纹理。
- 颜色纹理只记录轻微反射率差异；粗糙度记录各块钢板及方向性抛磨差异；法线记录细拉丝与浅划痕，强度 `0.16`。颜色图为 sRGB，粗糙度与法线为非颜色数据。
- `3×3 m` 板缝宽 `8 mm`，直接在世界空间计算，使用屏幕导数估计覆盖率。接缝降低反射率、提高粗糙度，远景按像素覆盖率淡化，不使用几何网格或烘焙亮边。
- 地面专用室内渐变与三块宽柔光箱通过 PMREM 一次预过滤，环境强度 `0.78`。设备环境、全局灯光、曝光和 Bloom 参数沿用原值。
- 实体倒影继续复用现有镜像相机、低分辨率反射目标、mip 与九点滤波；权重结合真实视角与粗糙度，缝隙反射更弱。

采用 Three.js 官方推荐的 [Metallic–Roughness 材质流程](https://threejs.org/docs/pages/MeshStandardMaterial.html)和[颜色空间区分](https://threejs.org/manual/en/color-management.html)。不需要 Blender 或外部贴图下载。

## 成本与边界

地坪仍为一个平面、两个三角形、一个基础绘制调用、三张源纹理，未新增逐帧反射通道或实时灯光。沿用既有画质档位：均衡档反射 `512×512`，静止镜头按原来的 30 FPS 上限更新。

纹理噪声只在资源创建时生成。保留专用环境失败时的回退，以及地坪、纹理、环境、反射的对称释放。

这是实时缎面金属近似。设备倒影仍受现有反射分辨率限制，不能等同于参考图的离线渲染；整张大地图的性能也没有在本轮重新优化。

## 验证

- `pnpm build` 通过：含 TypeScript 与发布产物校验；仍有现有的大包体提示。
- `pnpm lint` 通过。
- `pnpm verify:space` 5 项通过，包含反射显隐、异常恢复与卸载恢复。
- 实际监控入口检查斜视、缩放近景、俯视；材质小样检查板缝、拉丝和墙灯倒影。
- 厂房样板重建前后均为 40 个几何体、11 张纹理，未观察到资源累积或新的着色器错误。
- 生产预览服务中验证材质近景与真实导航地图，未捕获控制台错误。

截图直接来自浏览器，未做后期调色。`before-navigation.png` 为本轮修改前的导航样板，`after-navigation.png` 为相同入口默认参考机位的最终效果。

![修改前](screenshots/floor-reference/before-navigation.png)

![修改后](screenshots/floor-reference/after-navigation.png)

![实际监控近景](screenshots/floor-reference/after-main-near.png)

![实际监控俯视](screenshots/floor-reference/after-main-overhead.png)

![地板近景](screenshots/floor-reference/after-sample-near.png)

![低角度实体倒影](screenshots/floor-reference/after-reflection.png)
