/**
 * 烟熏蓝玻璃、实体金属框架和局部灯带分别建模与着色，沿用真实建筑边界。
 * 不透明结构继续实例化，所有玻璃面板统一合批并按当前绘制相机从远到近排序。
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { FactoryLayout } from '../model/factoryLayout'
import { NAVIGATION_STYLE as S, WALL_MATERIAL_STYLE as W } from './navigationAppearance'
import { GROUND_SURFACE_Y } from './mapAppearance'

export interface FactoryShellHandle {
  readonly id: number
  readonly group: THREE.Group
  dispose(): void
}
let shellSequence = 0
export function createFactoryShell(layout: FactoryLayout): FactoryShellHandle {
  const group = new THREE.Group()
  group.name = 'factory-shell'
  /**
   * 只有玻璃使用普通透明混合并关闭深度写入，深度测试仍开启。
   * 闭合倒角薄板仅绘制朝向相机的表面，避免同一面板前后表面重复混合变黑。
   */
  const materials = {
    glass: new THREE.MeshStandardMaterial({ color: W.glass.color, transparent: true, opacity: W.glass.opacity, roughness: W.glass.roughness, metalness: W.glass.metalness, envMapIntensity: W.glass.envIntensity, depthWrite: false, depthTest: true, side: THREE.FrontSide, blending: THREE.NormalBlending }),
    frame: new THREE.MeshStandardMaterial({ color: W.frame.color, roughness: W.frame.roughness, metalness: W.frame.metalness }),
    inset: new THREE.MeshStandardMaterial({ color: W.base.color, roughness: W.base.roughness, metalness: W.base.metalness }),
    trim: new THREE.MeshStandardMaterial({ color: W.trim.color, roughness: W.trim.roughness, metalness: W.trim.metalness }),
    lamp: new THREE.MeshStandardMaterial({ color: W.lamp.color, emissive: W.lamp.color, emissiveIntensity: W.lamp.emission, roughness: W.lamp.roughness }),
    core: new THREE.MeshStandardMaterial({ color: W.core.color, emissive: W.core.color, emissiveIntensity: W.core.emission, roughness: W.core.roughness }),
  }
  const unit = new THREE.BoxGeometry(1, 1, 1)
  const column = new RoundedBoxGeometry(0.22, S.wallHeight, 0.3, 2, 0.025)
  const panelWidth = 1.25
  const panel = new RoundedBoxGeometry(panelWidth - 0.05, S.wallHeight - 0.48, W.glass.thickness, 2, W.glass.bevel)
  const geometries: THREE.BufferGeometry[] = [unit, column, panel]
  const batches: THREE.InstancedMesh[] = []
  const glassParts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = []
  const matrix = new THREE.Object3D()
  /**
   * 内部地坪下增加深蓝沙盘底座，外部网格位于更低的独立平面。
   * 底座尺寸直接读取建筑边界，顶面低于地坪，不改变导航高度或相机约束。
   */
  const foundation = new THREE.Mesh(unit, materials.inset)
  foundation.name = 'factory-foundation'
  foundation.scale.set(layout.bounds.maxWorldX - layout.bounds.minWorldX, 0.82, layout.bounds.maxWorldZ - layout.bounds.minWorldZ)
  foundation.position.set(layout.bounds.centerWorldX, GROUND_SURFACE_Y - 0.43, layout.bounds.centerWorldZ)
  foundation.receiveShadow = true
  group.add(foundation)
  for (const wall of layout.walls) {
    const side = new THREE.Group()
    side.position.set(wall.x, 0, wall.z)
    side.rotation.y = wall.rotation
    side.updateMatrix()
    group.add(side)
    const upper = new THREE.Group()
    side.add(upper)
    const parts = new Map<string, { geometry: THREE.BufferGeometry; material: keyof typeof materials; low: boolean; matrices: THREE.Matrix4[] }>()
    const add = (material: keyof typeof materials, geometry: THREE.BufferGeometry, low: boolean, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const key = `${material}-${geometry.id}-${low}`
      if (!parts.has(key)) parts.set(key, { geometry, material, low, matrices: [] })
      matrix.position.set(x, y, z)
      matrix.scale.set(sx, sy, sz)
      matrix.updateMatrix()
      parts.get(key)!.matrices.push(matrix.matrix.clone())
    }
    const length = wall.length - 4
    const count = Math.max(1, Math.floor(length / panelWidth))
    add('frame', unit, true, 0, 0.21, -0.15, length, 0.42, 0.4)
    add('trim', unit, true, 0, 0.4, -0.22, length, 0.035, 0.46)
    /**
     * 底座外缘用暗金属侧板和两道细蓝收边表达实体厚度，各观察方向都保留。
     * 灯带保持米制宽度，缩近时可辨结构，缩远时只留下简洁轮廓。
     */
    add('frame', unit, true, 0, -0.44, -0.08, length, 0.76, 0.2)
    add('trim', unit, true, 0, -0.76, 0.035, length, 0.045, 0.045)
    add('lamp', unit, true, 0, -0.12, 0.035, length, 0.025, 0.035)
    /**
     * 原整墙背板移除，玻璃背后不能再有不透明遮挡；顶部仅保留窄金属压条。
     * 透明墙保持完整结构，不再随观察方向整面隐藏，通透性由材料本身提供。
     */
    add('frame', unit, false, 0, S.wallHeight - 0.015, -0.12, length, 0.08, 0.22)
    add('trim', unit, false, 0, S.wallHeight + 0.024, -0.12, length, 0.018, 0.24)
    for (let i = 0; i < count; i += 1) {
      const x = -length / 2 + (i + 0.5) * length / count
      /**
       * 每片玻璃有独立的世界变换和十厘米倒角厚度，进入跨墙向的统一排序批次。
       * 框架与玻璃之间保留装配间隙，透过墙体仍能看到真实货架、车辆与路线。
       */
      matrix.position.set(x, S.wallHeight / 2 + 0.18, -0.15)
      matrix.scale.set(length / count / panelWidth, 1, 1)
      matrix.updateMatrix()
      glassParts.push({ geometry: panel, matrix: matrix.matrix.clone().premultiply(side.matrix) })
      /**
       * 面板下方保留矮护板与细竖缝，金属夹条包住玻璃侧边以强调厚度。
       * 所有表层向室内错开数毫米，避免远近切换时出现共面闪烁。
       */
      add('inset', unit, true, x, 0.3, -0.229, length / count - 0.13, 0.18, 0.025)
      add('trim', unit, false, x - length / count / 2 + 0.025, S.wallHeight / 2 + 0.18, -0.15, 0.016, S.wallHeight - 0.48, 0.13)
      if (i % 4 === 0) {
        /**
         * 每组墙板设置细金属立柱，局部灯槽与状态灯形成克制的照明节奏。
         * 仅少量顶部边缘设置短灯条，竖向蓝光进入已有地面倒影。
         */
        const columnX = x - length / count / 2 + 0.11
        add('frame', column, false, columnX, S.wallHeight / 2, -0.15)
        add('trim', unit, false, columnX - 0.1, S.wallHeight / 2, -0.312, 0.018, S.wallHeight - 0.12, 0.025)
        add('trim', unit, false, columnX + 0.1, S.wallHeight / 2, -0.312, 0.018, S.wallHeight - 0.12, 0.025)
        add('inset', unit, false, columnX, 1.9, -0.308, 0.12, 2.6, 0.018)
        add('lamp', unit, false, columnX, 1.22, -0.33, 0.032, 0.62, 0.018)
        add('core', unit, false, columnX, 2.85, -0.33, 0.045, 0.09, 0.018)
        if (i % 12 === 0) add('lamp', unit, false, columnX + 0.42, S.wallHeight - 0.04, -0.24, 0.65, 0.025, 0.024)
        add('frame', unit, true, columnX, 0.22, -0.18, 0.3, 0.42, 0.4)
      }
      add('lamp', unit, true, x, 0.13, -0.367, length / count - 0.1, 0.028, 0.032)
    }
    for (const part of parts.values()) {
      const mesh = new THREE.InstancedMesh(part.geometry, materials[part.material], part.matrices.length)
      part.matrices.forEach((value, index) => mesh.setMatrixAt(index, value))
      /**
       * 发光灯芯与灯带不投影，避免细小光源几何产生锯齿阴影。
       * 实体墙板和结构框架仍参与阴影及地面反射。
       */
      mesh.castShadow = mesh.receiveShadow = part.material !== 'lamp' && part.material !== 'core'
      mesh.computeBoundingSphere()
      ;(part.low ? side : upper).add(mesh)
      batches.push(mesh)
    }
  }
  /**
   * 四角弧墙位于地图外扩的建筑余量内，完全不侵入真实节点包围盒。
   * 分段轮廓拉伸形成细缝，小倒角和独立金属压顶提供边缘高光。
   */
  const arc = (inner: number, outer: number, height: number, start: number, end: number) => {
    const shape = new THREE.Shape()
    shape.absarc(0, 0, outer, start, end, false)
    shape.absarc(0, 0, inner, end, start, true)
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 12 })
    geometry.rotateX(-Math.PI / 2)
    geometries.push(geometry)
    return geometry
  }
  const segments = Array.from({ length: 8 }, (_, i) => arc(1.68, 2.02, 0.65, i * Math.PI / 16 + 0.006, (i + 1) * Math.PI / 16 - 0.006))
  const cap = arc(1.65, 2.04, 0.036, 0, Math.PI / 2)
  const strip = arc(1.638, 1.657, 0.024, 0, Math.PI / 2)
  const { minWorldX: x0, maxWorldX: x1, minWorldZ: z0, maxWorldZ: z1 } = layout.bounds
  const corners = [[x1 - 2, z0 + 2, 0], [x0 + 2, z0 + 2, Math.PI / 2], [x0 + 2, z1 - 2, Math.PI], [x1 - 2, z1 - 2, Math.PI * 1.5]]
  if (layout.walls.length > 1) for (const [x, z, rotation] of corners) {
    const corner = new THREE.Group()
    corner.position.set(x, 0, z)
    corner.rotation.y = rotation
    for (const geometry of segments) {
      /**
       * 弧形转角也进入同一玻璃排序批次，不另开透明队列覆盖相邻直墙。
       * 转角的金属压顶仍不透明，圆弧尺寸与原建筑布局一致。
       */
      corner.updateMatrix()
      glassParts.push({ geometry, matrix: corner.matrix.clone() })
    }
    const top = new THREE.Mesh(cap, materials.trim)
    top.position.y = 0.66
    const light = new THREE.Mesh(strip, materials.lamp)
    light.position.y = 0.6
    corner.add(top, light)
    group.add(corner)
  }
  /**
   * 普通实例网格不会排序实例，改用现有 Three.js 的可排序合批网格。
   * 四面直墙和转角统一按相机深度排序，主相机与镜像相机各自剔除、各自排序。
   */
  const glassGeometries = [...new Set(glassParts.map((part) => part.geometry))]
  const glass = new THREE.BatchedMesh(Math.max(1, glassParts.length), glassGeometries.reduce((sum, geometry) => sum + geometry.getAttribute('position').count, 0), glassGeometries.reduce((sum, geometry) => sum + (geometry.index?.count ?? 0), 0), materials.glass)
  const glassIds = new Map(glassGeometries.map((geometry) => [geometry, glass.addGeometry(geometry)]))
  for (const part of glassParts) glass.setMatrixAt(glass.addInstance(glassIds.get(part.geometry)!), part.matrix)
  glass.name = 'factory-glass-panels'
  glass.sortObjects = true
  glass.perObjectFrustumCulled = true
  glass.renderOrder = W.glassRenderOrder
  glass.castShadow = glass.receiveShadow = false
  glass.raycast = () => {}
  glass.computeBoundingSphere()
  group.add(glass)
  /**
   * 合批数据纹理和源几何归本句柄所有，严格模式重建时只释放一次。
   * 灯带、框架和玻璃共用生命周期，但保持独立材质与深度行为。
   */
  let disposed = false
  return { id: ++shellSequence, group, dispose() {
    if (disposed) return
    disposed = true
    glass.dispose()
    for (const batch of batches) batch.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const material of Object.values(materials)) material.dispose()
  } }
}
