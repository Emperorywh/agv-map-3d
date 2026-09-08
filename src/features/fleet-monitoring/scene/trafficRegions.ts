/**
 * 交管区域以脉冲能量场、连续流光边缘和渐隐光幕表达，每种状态各占两个绘制调用。
 * 后端四点先规范化，再合并同色重叠轮廓；几何更新与逐帧时间更新相互独立。
 * 本模块拥有全部区域几何和材质；不改变车辆、地图或路权的业务状态。
 */
import * as THREE from 'three'
import type { WorldTransform } from '@/shared/spatial'
import type { ReadonlyFleetEntity } from '../model/createFleetRuntime'
import { normalizeTrafficRectangle, type NormalizedTrafficRectangle } from '../model/trafficRectangle'
import { buildTrafficRegionGeometry } from './trafficRegionGeometry'
import {
  createTrafficRegionMaterial,
  TRAFFIC_REGION_STYLES,
  type TrafficAnimationUniforms,
  type TrafficRegionKind,
} from './trafficRegionMaterials'

/**
 * 两个固定网格分别承载地面和立体边缘，材质均由本批次持有。
 * 几何签名不含动画时间，持续流动不会触发缓冲重建。
 */
interface TrafficRegionBatch {
  readonly group: THREE.Group
  readonly field: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  readonly edge: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  signature: string
}

export interface TrafficRegions {
  readonly group: THREE.Group
  sync(entities: readonly ReadonlyFleetEntity[], worldTransform: WorldTransform): void
  animate(delta: number, reducedMotion: boolean): void
  dispose(): void
}

/**
 * 两组对象在整个资源代内稳定；车辆增加、删除与矩形变化只替换有变化的批次几何。
 * 同色同位置的重复矩形只保留一次，重叠区域通过并集消除内部边框与反复叠色。
 */
export function createTrafficRegions(): TrafficRegions {
  const group = new THREE.Group()
  group.name = 'traffic-regions'
  /**
   * 能量场和边缘光幕整体退出地坪镜像采集，避免双重光圈和额外绘制开销。
   * 主画面的高动态范围颜色仍会被既有光晕通道采集。
   */
  group.userData['excludeFromGroundReflection'] = true
  const animation: TrafficAnimationUniforms = { time: { value: 0 } }
  const locked = createBatch('locked', animation)
  const applying = createBatch('applying', animation)
  group.add(locked.group, applying.group)
  let disposed = false

  return {
    group,
    sync(entities, worldTransform) {
      if (disposed) return
      const lockedRectangles = new Map<string, NormalizedTrafficRectangle>()
      const applyingRectangles = new Map<string, NormalizedTrafficRectangle>()
      for (const entity of entities) {
        const resources = entity.snapshot.trafficShapeResources
        if (resources === null) continue
        collectRectangles(resources.lockedRectangles, lockedRectangles)
        collectRectangles(resources.applyingRectangles, applyingRectangles)
      }
      updateBatch(locked, 'locked', lockedRectangles, worldTransform)
      updateBatch(applying, 'applying', applyingRectangles, worldTransform)
    },
    /**
     * 返回前台时限制单帧推进，避免后台时间差造成能量波突然跳过很长距离。
     * 减少动态效果偏好仅冻结动画，区域和路权更新仍正常显示。
     */
    animate(delta, reducedMotion) {
      if (disposed || reducedMotion || !Number.isFinite(delta)) return
      animation.time.value += Math.max(0, Math.min(delta, 0.05))
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const batch of [locked, applying]) {
        batch.field.geometry.dispose()
        batch.field.material.dispose()
        batch.edge.geometry.dispose()
        batch.edge.material.dispose()
        batch.group.clear()
      }
      group.clear()
    },
  }
}

/**
 * 复用入口已有的点排序、去重、面积和凸性裁决，防止后端非环形点序画出交叉边。
 * 无效条目不参与渲染，其余有效矩形与其他车辆继续正常显示。
 */
function collectRectangles(raw: readonly unknown[], target: Map<string, NormalizedTrafficRectangle>): void {
  for (const item of raw) {
    const rectangle = normalizeTrafficRectangle(item)
    if (rectangle !== null) target.set(rectangle.hash, rectangle)
  }
}

/**
 * 高动态范围着色器复用场景光晕，能量场始终在车辆与设备的正常深度遮挡之下。
 * 区域不接收拾取、不投射阴影，也不写深度，保持既有车辆交互和透明标签行为。
 */
function createBatch(kind: TrafficRegionKind, animation: TrafficAnimationUniforms): TrafficRegionBatch {
  const style = TRAFFIC_REGION_STYLES[kind]
  const field = new THREE.Mesh(new THREE.BufferGeometry(), createTrafficRegionMaterial(kind, 'field', animation))
  const edge = new THREE.Mesh(new THREE.BufferGeometry(), createTrafficRegionMaterial(kind, 'edge', animation))
  field.name = `traffic-${kind}-field`
  edge.name = `traffic-${kind}-edge`
  field.renderOrder = style.fillOrder
  edge.renderOrder = style.edgeOrder
  for (const mesh of [field, edge]) {
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    mesh.raycast = () => {}
  }
  const group = new THREE.Group()
  group.name = `traffic-${kind}-regions`
  group.add(field, edge)
  return { group, field, edge, signature: '' }
}

/**
 * 哈希排序使消息里的车辆顺序、矩形顺序及原始四点顺序变化不触发几何重建。
 * 区域坐标是地图绝对坐标，不叠加车辆位置或朝向，车辆驶离不会拖动已锁定区域。
 */
function updateBatch(
  batch: TrafficRegionBatch,
  kind: TrafficRegionKind,
  rectangles: ReadonlyMap<string, NormalizedTrafficRectangle>,
  worldTransform: WorldTransform,
): void {
  const hashes = [...rectangles.keys()].sort()
  const signature = hashes.join('|')
  if (batch.signature === signature) return
  const style = TRAFFIC_REGION_STYLES[kind]
  const geometry = buildTrafficRegionGeometry(
    hashes.map((hash) => rectangles.get(hash)!), worldTransform, style.height, style.wallHeight,
  )

  /**
   * 空集合也替换旧几何并立即隐藏，覆盖路径清空、车辆移除和全量快照缺席情况。
   * 先构建后释放旧缓冲；材质及场景对象继续复用，避免持续推送造成资源积累。
   */
  batch.field.geometry.dispose()
  batch.edge.geometry.dispose()
  batch.field.geometry = geometry.field
  batch.edge.geometry = geometry.edge
  batch.field.visible = (geometry.field.index?.count ?? 0) > 0
  batch.edge.visible = (geometry.edge.index?.count ?? 0) > 0
  batch.signature = signature
}
