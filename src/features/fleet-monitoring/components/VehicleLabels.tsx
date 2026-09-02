/**
 * 车辆标签批次图层（SPEC §5.1、§6.4、§7.2、§12.5；TASK-011）。
 *
 * 职责：把图集化 billboard 标签以「批次 × (背景 + 名称) 两层 InstancedMesh」
 *       挂载到场景——每个批次独享一份 2048×2048 名称图集（256 个 256×64
 *       名称槽，槽位与实例槽位一一对应）与一组实例属性几何；共享状态芯片
 *       图集由本组件单一持有；逐帧提交交给 useFleetLabelFrameSync。批次扩
 *       容只发生在车队超过当前容量时（≤1 次重建），属结构性低频变化，批次
 *       数由 FleetMonitoringFeature 持有并与车体图层共享同一槽位表。
 * 边界：本组件只拥有标签批次的对象（网格实例缓冲、每批次几何/材质/图集）
 *       与共享芯片图集；槽位表归 FleetMonitoringFeature，车体几何归
 *       VehicleResources 所有者——本组件绝不触碰。标签不可拾取（拾取仅外壳，
 *       SPEC §5.2）。图集工厂可注入：生产默认真实 Canvas 工厂，无 2D 上下
 *       文环境（如单元测试）降级为不渲染标签层并记录结构化诊断，绝不阻断
 *       车体渲染。
 * 关键不变量：
 * 1. 每批次恒为 2 个 InstancedMesh（背景 + 名称）= 2 个标签 Draw Call：
 *    200 台（单批次）标签 Draw Call = 2，257 台（两批次）= 4（SPEC §6.4）；
 * 2. 渲染顺序：背景 renderOrder=10、名称 renderOrder=11（同位置透明层按序
 *    合成，文字始终叠于底板之上），两层 depthWrite=false 防止透明排序瑕疵；
 * 3. 全部实例矩阵初始零缩放：空槽位与超硬上限车辆绝不以单位阵出现在原点
 *    （与车体同口径）；两层网格矩阵恒同步写（可见性一体）；
 * 4. key 携带批次数：批次数变化时全部批次走卸载/挂载路径（R3F 对已挂载
 *    primitive 换 object 的重建依赖兄弟序列尾部探测，条件子树下会被静默
 *    丢弃——TASK-005 实测结论，key 变化强制干净重建）；
 * 5. 高频车辆事件不触碰本组件任何 React 状态，实例属性与图集单元永远在
 *    Hook 自有对象中（SPEC §4/§12.5）。
 */
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { DiagnosticsReporter } from '@/shared/diagnostics'
import type { WorldTransform } from '@/shared/spatial'
import type { FleetRuntime } from '../model/createFleetRuntime'
import type { InstanceSlotTable } from '../model/instanceSlots'
import { SLOT_BATCH_CAPACITY } from '../model/instanceSlots'
import {
  createVehicleBadgeAtlas,
  createVehicleLabelAtlas,
  LABEL_ATLAS_CELLS,
  type VehicleBadgeAtlas,
  type VehicleLabelAtlas,
} from '../scene/labelAtlas'
import {
  createLabelBackgroundGeometry,
  createLabelBackgroundMaterial,
  createLabelTextGeometry,
  createLabelTextMaterial,
  LABEL_BG_ATTRIBUTE_NAMES,
  LABEL_TEXT_ATTRIBUTE_NAME,
} from '../scene/labelMaterials'
import {
  useFleetLabelFrameSync,
  type FleetLabelBatchMeshes,
} from '../hooks/useFleetLabelFrameSync'

export interface VehicleLabelsProps {
  /** 高频车队运行时（来自 FleetRuntimeProvider 的稳定引用） */
  runtime: FleetRuntime
  /** 地图世界变换；null 时不提交任何标签（等待地图就绪） */
  worldTransform: WorldTransform | null
  /** 与车体共享的实例槽位表（标签槽位 = 车体槽位，单元即槽位） */
  table: InstanceSlotTable
  /** 当前批次数（与车体图层一致；由 Feature 根组件持有） */
  batchCount: number
  /**
   * 标签降级能力开关（SPEC §6.5 行动 1；TASK-014）：true 时中距离纯名称档
   * 隐藏，仅保留重点标签与近景完整档；默认 false。
   */
  importantLabelsOnly?: boolean
  /** 名称图集工厂（可注入；默认真实 Canvas 工厂） */
  createLabelAtlas?: () => VehicleLabelAtlas
  /** 状态芯片图集工厂（可注入；默认真实 Canvas 工厂） */
  createBadgeAtlas?: () => VehicleBadgeAtlas
  /** 图集不可用降级诊断通道 */
  diagnostics?: DiagnosticsReporter
}

/** 图集不可用时的降级诊断码（结构化记录，页面无任何 DOM 提示） */
const LABEL_ATLAS_FAILED_CODE = 'VEHICLE_LABEL_ATLAS_FAILED'

export function VehicleLabels({
  runtime,
  worldTransform,
  table,
  batchCount,
  importantLabelsOnly = false,
  createLabelAtlas = createVehicleLabelAtlas,
  createBadgeAtlas = createVehicleBadgeAtlas,
  diagnostics,
}: VehicleLabelsProps) {
  // 生产前提守护：名称槽容量必须与批次容量一致（单元即槽位的不变量根基）
  if (LABEL_ATLAS_CELLS !== SLOT_BATCH_CAPACITY) {
    throw new Error(
      `名称图集槽容量 ${LABEL_ATLAS_CELLS} 必须等于实例批次容量 ${SLOT_BATCH_CAPACITY}`,
    )
  }

  const diagnosticsRef = useMemo(() => ({ current: diagnostics }), [diagnostics])

  // 共享芯片图集：组件生命周期内只创建一次；失败降级为 null（无标签层）
  const badge = useMemo<VehicleBadgeAtlas | null>(() => {
    try {
      return createBadgeAtlas()
    } catch (error) {
      diagnosticsRef.current?.report(
        LABEL_ATLAS_FAILED_CODE,
        'warn',
        '状态芯片图集不可用，车辆标签层降级为不显示',
        { reason: error instanceof Error ? error.message : String(error) },
      )
      return null
    }
  }, [createBadgeAtlas, diagnosticsRef])

  // 标签批次按 batchCount 构建：任一批次图集失败即整层降级（部分标签会因
  // 图集内容缺失显示空白名称，宁可整层不显示，保证状态语义一致）
  const batches = useMemo<FleetLabelBatchMeshes[]>(() => {
    if (badge === null) {
      return []
    }
    try {
      const built: FleetLabelBatchMeshes[] = []
      for (let b = 0; b < batchCount; b += 1) {
        built.push(createLabelBatch(badge.texture, b, createLabelAtlas))
      }
      return built
    } catch (error) {
      diagnosticsRef.current?.report(
        LABEL_ATLAS_FAILED_CODE,
        'warn',
        '名称图集不可用，车辆标签层降级为不显示',
        { reason: error instanceof Error ? error.message : String(error) },
      )
      return []
    }
  }, [badge, batchCount, createLabelAtlas, diagnosticsRef])

  // 对称释放：批次数组身份变化或卸载时释放本组件拥有的 GPU 对象与图集
  useEffect(() => () => disposeBatches(batches), [batches])
  useEffect(
    () => () => {
      badge?.dispose()
    },
    [badge],
  )

  useFleetLabelFrameSync({
    runtime,
    table,
    worldTransform,
    batches,
    importantLabelsOnly,
    diagnostics,
  })

  if (batches.length === 0) {
    // 图集不可用或无批次：整层降级不渲染（ Hook 已安全空转）
    return null
  }

  return (
    <group name="fleet-labels">
      {/* key 含 batchCount：批次数变化时强制全部批次卸载/挂载（不变量 4） */}
      {batches.map((batch, index) => (
        <group key={`fleet-label-batch-${index}-${batchCount}`} name={`fleet-label-batch-${index}`}>
          <primitive object={batch.background} dispose={null} />
          <primitive object={batch.text} dispose={null} />
        </group>
      ))}
    </group>
  )
}

/** 创建单个标签批次：两层网格 + 每批次图集/几何/材质（失败时抛出由上层降级） */
function createLabelBatch(
  badgeTexture: THREE.Texture,
  batchIndex: number,
  createAtlas: () => VehicleLabelAtlas,
): FleetLabelBatchMeshes {
  const atlas = createAtlas()
  const backgroundGeometry = createLabelBackgroundGeometry(SLOT_BATCH_CAPACITY)
  const textGeometry = createLabelTextGeometry(SLOT_BATCH_CAPACITY)
  const backgroundMaterial = createLabelBackgroundMaterial(badgeTexture)
  const textMaterial = createLabelTextMaterial(atlas.texture)

  const background = new THREE.InstancedMesh(
    backgroundGeometry,
    backgroundMaterial,
    SLOT_BATCH_CAPACITY,
  )
  const text = new THREE.InstancedMesh(textGeometry, textMaterial, SLOT_BATCH_CAPACITY)

  const bgAttrs = LABEL_BG_ATTRIBUTE_NAMES.map((name) =>
    backgroundGeometry.getAttribute(name),
  ) as THREE.InstancedBufferAttribute[]
  const nameAttr = textGeometry.getAttribute(
    LABEL_TEXT_ATTRIBUTE_NAME,
  ) as THREE.InstancedBufferAttribute

  for (const mesh of [background, text]) {
    mesh.count = SLOT_BATCH_CAPACITY
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.raycast = () => {} // 标签不参与拾取（拾取仅车体外壳，SPEC §5.2）
  }
  background.name = `fleet-label-bg-b${batchIndex}`
  background.renderOrder = 10
  text.name = `fleet-label-text-b${batchIndex}`
  text.renderOrder = 11

  // 实例矩阵零缩放初始化：空槽位绝不以单位阵出现在原点（不变量 3）
  for (const mesh of [background, text]) {
    const matrices = mesh.instanceMatrix.array as unknown as number[]
    for (let s = 0; s < SLOT_BATCH_CAPACITY; s += 1) {
      const base = s * 16
      for (let i = 0; i < 15; i += 1) {
        matrices[base + i] = 0
      }
      matrices[base + 15] = 1
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }

  return { background, text, atlas, bgAttrs, nameAttr }
}

/** 释放批次对象：实例缓冲、每批次几何/材质与名称图集（幂等由各 dispose 保证） */
function disposeBatches(batches: readonly FleetLabelBatchMeshes[]): void {
  for (const batch of batches) {
    batch.background.dispose()
    batch.text.dispose()
    batch.background.geometry.dispose()
    batch.text.geometry.dispose()
    ;(batch.background.material as THREE.Material).dispose()
    ;(batch.text.material as THREE.Material).dispose()
    batch.atlas.dispose()
  }
}
