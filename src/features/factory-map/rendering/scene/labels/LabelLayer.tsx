/**
 * LabelLayer：标签层（SPEC §5 场景架构树、§5.2、§8、§9.3、§10.1、§10.3）。
 *
 * 职责边界：
 * - createLabelLayerDriver（纯逻辑，node 可测）：每个实际重绘帧先经
 *   LabelRecalcScheduler 判定是否重算（相机位姿超 0.25m/0.25° 阈值才重算，
 *   运动期 ≤10Hz、停止即终算），重算时调 selectVisibleLabels 选择器并把
 *   选中集合差分（attach/detach 仅变化项，不清空重建 DOM）应用到
 *   Css2dLabelRendererAdapter；选中缓冲区/差分缓冲全部预分配复用（§10.1
 *   稳态零逐帧分配）；
 * - LabelLayer（薄 React 壳）：独占 Css2dLabelRendererAdapter 生命周期
 *   （挂载到 WebGL canvas 父宿主、卸载完整清理，StrictMode 幂等）；以
 *   useFrame(priority=1) 接管渲染——R3F 因此关闭自动渲染，本组件在每个
 *   实际重绘帧（frameloop='demand' 下即 invalidate 驱动的帧）先差分
 *   attach/detach，再执行 WebGL render，最后调用一次 CSS2D render（§8.1
 *   「WebGL 完成后」）；viewport 尺寸变化经 forceRecalc + invalidate 触发
 *   重算（§8.3）；labels/occluders 变化（地图变更）重建选择器清空迟滞状态。
 *
 * 无对象级交互（§1.2/§9.3）：不注册任何 R3F 对象事件；遮挡检测由选择器
 * 内部 Raycaster 只对 occluders 引用列表执行，不经过场景根 group。
 */

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { Object3D, PerspectiveCamera } from 'three'

import type { LabelMetadataDto } from '../../../application/factorySceneModel'
import { LABEL_MAX_COUNT } from '../../../config/labelPolicy'
import { createCss2dLabelRendererAdapter } from './Css2dLabelRendererAdapter'
import type { Css2dLabelRendererAdapter } from './Css2dLabelRendererAdapter'
import {
  createLabelRecalcScheduler,
  createLabelSelectionDiffer,
  createVisibleLabelSelector,
} from './selectVisibleLabels'
import type {
  LabelRecalcScheduler,
  VisibleLabelSelector,
} from './selectVisibleLabels'

// ---------------------------------------------------------------------------
// 帧驱动（纯逻辑）：重算判定 → 选择 → 差分 → attach/detach（§8.3、§5.2）
// ---------------------------------------------------------------------------

export interface LabelLayerDriverDeps {
  readonly adapter: Css2dLabelRendererAdapter
  readonly selector: VisibleLabelSelector
  readonly scheduler: LabelRecalcScheduler
  /** CSS2DObject 挂载点（R3F 场景根） */
  readonly scene: Object3D
  readonly camera: PerspectiveCamera
  readonly labels: readonly LabelMetadataDto[]
}

export interface LabelLayerDriver {
  /** 每个实际重绘帧在 WebGL render 前调用：按调度器判定重算并差分应用 */
  onFrame(): void
  /** 每个实际重绘帧在 WebGL render 后调用一次（§8.1） */
  renderLabels(): void
}

// §12 固定 labels/ 仅三个文件：帧驱动与组件同文件存放（node 可测的纯逻辑出口）
// oxlint-disable-next-line react/only-export-components
export function createLabelLayerDriver(deps: LabelLayerDriverDeps): LabelLayerDriver {
  const { adapter, selector, scheduler, scene, camera, labels } = deps

  // 预分配选中/差分缓冲（§10.1：稳态零逐帧分配；双缓冲交换承载上次/本次选中集）
  let previousSelection: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
  let nextSelection: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
  let previousCount = 0
  const attachBuffer: LabelMetadataDto[] = new Array(LABEL_MAX_COUNT)
  const detachBuffer: string[] = new Array(LABEL_MAX_COUNT)
  const differ = createLabelSelectionDiffer()

  return {
    onFrame(): void {
      if (!scheduler.onFrame(camera.position, camera.quaternion)) return

      const nextCount = selector.select(labels, camera, nextSelection)
      const diff = differ.diff(
        previousSelection,
        previousCount,
        nextSelection,
        nextCount,
        attachBuffer,
        detachBuffer,
      )
      // 先 detach 再 attach：释放的池元素可供同帧新标签复用（§8.1 DOM 池）
      for (let i = 0; i < diff.detachCount; i += 1) adapter.detach(detachBuffer[i])
      for (let i = 0; i < diff.attachCount; i += 1) adapter.attach(attachBuffer[i], scene)

      const swap = previousSelection
      previousSelection = nextSelection
      nextSelection = swap
      previousCount = nextCount
    },

    renderLabels(): void {
      adapter.render(scene, camera)
    },
  }
}

// ---------------------------------------------------------------------------
// LabelLayer（薄 React 壳）
// ---------------------------------------------------------------------------

export interface LabelLayerProps {
  /** 全量标签元数据（§5.1 契约；锚点含 LABEL_ANCHOR_Y=0.5m 高度） */
  readonly labels: readonly LabelMetadataDto[]
  /** §9.3 不透明遮挡 mesh 引用（TASK-008 labelOccluders：实墙/墙柱/主梁/檩条） */
  readonly occluders: readonly Object3D[]
}

export function LabelLayer({ labels, occluders }: LabelLayerProps): ReactElement | null {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)

  const driverRef = useRef<LabelLayerDriver | null>(null)
  const schedulerRef = useRef<LabelRecalcScheduler | null>(null)

  // §10.3：本组件是 Css2dLabelRendererAdapter 唯一 React owner——挂载时创建并
  // mount 到 WebGL canvas 父宿主（§1.4 同一 position:relative 宿主覆盖 canvas），
  // 卸载完整清理；setup/cleanup 幂等，StrictMode 重复挂载不产生重复容器。
  // labels/occluders 变化 = 地图变更：整体重建（选择器迟滞状态清零）并强制重算
  useEffect(() => {
    const host = gl.domElement.parentElement
    if (host === null) return undefined

    const adapter = createCss2dLabelRendererAdapter()
    adapter.mount(host)
    // 遮挡 mesh 为静态几何：首帧 render 前 matrixWorld 尚未刷新，此处一次性
    // 带父链更新，保证选择器内部 Raycaster 使用正确世界矩阵（§9.3）
    for (const occluder of occluders) occluder.updateWorldMatrix(true, false)
    const selector = createVisibleLabelSelector({ occluders })
    const scheduler = createLabelRecalcScheduler({ now: () => performance.now() })
    // Canvas camera prop 固定创建 PerspectiveCamera（同 CameraRig 的断言）
    driverRef.current = createLabelLayerDriver({
      adapter,
      selector,
      scheduler,
      scene,
      camera: camera as PerspectiveCamera,
      labels,
    })
    schedulerRef.current = scheduler
    scheduler.forceRecalc()
    return () => {
      driverRef.current = null
      schedulerRef.current = null
      adapter.dispose()
    }
  }, [gl, scene, camera, labels, occluders])

  // §8.3：viewport 尺寸变化重算候选；invalidate 保证 demand 模式下产生实际重绘帧
  useEffect(() => {
    schedulerRef.current?.forceRecalc()
    invalidate()
  }, [size.width, size.height, invalidate])

  // §8.1：每个实际重绘帧在 WebGL 完成后调用一次 CSS2D render。
  // priority=1 接管渲染循环（R3F 关闭自动渲染），demand 模式下本回调只随
  // invalidate 产生的实际重绘帧执行（§5.2）
  useFrame(() => {
    const driver = driverRef.current
    if (driver !== null) driver.onFrame()
    gl.render(scene, camera)
    if (driver !== null) driver.renderLabels()
  }, 1)

  return null
}
