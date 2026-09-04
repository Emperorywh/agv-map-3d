/**
 * Canvas 内调试面板（项目开发宪法 §8 DEBUG MODE；仅开发环境，App 层经
 * import.meta.env.DEV + ?debug= 门控挂载，leva 依赖只存在于本模块的动态
 * import 分支，生产构建整段消除）。
 *
 * 职责：为视觉对齐迭代提供参数化调试工具——
 *       1. 图层开关：按 sceneLayerRegistry 的命名规则批量显隐场景图层
 *          （低频重申，覆盖车队批次的动态重建），逐层排除即可定位视觉
 *          artifact 的归属对象；
 *       2. Grid / Axes / BoundingBox / DirectionalLightHelper：声明式挂载
 *          的标准辅助对象（尺寸锚定地图包围盒与 5m 网格口径）；
 *       3. 相机位姿复制：把当前相机位置/FOV 与 OrbitControls 目标点输出
 *          为 JSON（剪贴板 + 控制台），作为截图取证与 FROZEN 机位记录。
 * 边界：只经 useThree 读取场景/相机、经组合层注入的 controlsRef 只读观察
 *       OrbitControls、经对象名匹配图层——不导入任何 Feature 内部模块，
 *       不改写业务对象属性（visible 除外），不持有逐帧业务数据；Leva 面板
 *       属 DOM，经自建宿主挂在 document.body（不得进入 Canvas 渲染树）。
 * 关键不变量：
 * 1. 面板挂载与否完全由 App 的门控决定；本组件挂载即生效、卸载对称清理
 *    自建辅助对象；
 * 2. 图层显隐每 30 帧低频重申一次：只写 visible，不触碰实例缓冲、不进
 *    React state（SPEC §4 高频禁令同样适用于调试路径）；
 * 3. 所有调试常量集中在文件头常量区，不散落 magic number。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { Leva, button, useControls } from 'leva'
import * as THREE from 'three'
import { GRID_Y } from '@/features/map-visualization'
import type { SceneBounds } from '@/features/map-visualization'
import {
  DEBUG_LAYERS,
  applyAllLayerVisibility,
} from './sceneLayerRegistry'
import { persistDebugPanelEnabled } from './debugGate'

/** OrbitControls 的最小观察接口（组合层注入只读引用，不导入实现） */
interface OrbitControlsLike {
  readonly target: THREE.Vector3
}

export interface DebugPanelProps {
  /** 地图包围盒（App bootstrap 种子）；null 时 Grid/BB 锚定不可用 */
  readonly sceneBounds: SceneBounds | null
  /** 相机导航 OrbitControls 只读引用（位姿取样的目标点来源） */
  readonly controlsRef?: { readonly current: OrbitControlsLike | null }
}

/* ==================== 调试视觉常量（集中在文件头，禁止散落） ==================== */
/** 调试 Grid 抬升：贴地参考高度（GRID_Y=0.02）之上再加一层，避免 z-fighting */
const DEBUG_GRID_LIFT_M = 0.01
/** 调试 Grid 单元（米）：与 Grid (5m) 标签一致 */
const DEBUG_GRID_CELL_M = 5
/** 调试 Grid 相对地图的扩展比例：包围盒外扩一点，边缘网格可辨 */
const DEBUG_GRID_EXTENSION_RATIO = 1.2
/** Grid 双色（分缝线用主色系区分：冷蓝调是「调试层」的语言） */
const DEBUG_GRID_CENTER_COLOR = '#4a7dbb'
const DEBUG_GRID_COLOR = '#2b3a4e'
/** Axes 三轴长度（米）：总览距离下可辨 */
const DEBUG_AXES_LENGTH_M = 20
/** BoundingBox 高度（米）：竖边可见即可 */
const DEBUG_BOUNDS_HEIGHT_M = 10
const DEBUG_BOUNDS_COLOR = '#e0b34d'
/** DirectionalLightHelper 图标尺寸（米） */
const DEBUG_LIGHT_HELPER_SIZE_M = 8
/** 地图方向光对象名（MapVisualizationFeature 的场景命名） */
const DEBUG_DIRECTIONAL_LIGHT_NAME = 'map-directional-light'
/** 图层显隐重申周期（帧）：覆盖车队批次动态重建 */
const DEBUG_LAYER_REAPPLY_FRAMES = 30
/** 面板根宽度：默认 280px 的标签列放不下「节点盘·工作站点」等中文标签 */
const DEBUG_PANEL_ROOT_WIDTH = '400px'
/** 自建面板宿主 id：与 leva 自动挂载的 leva__root 区分，避免两个根共用一个容器 */
const DEBUG_LEVA_HOST_ID = 'debug-leva-root'
/** 相机位姿小数位（米/度，取证记录口径） */
const DEBUG_POSE_DECIMALS = 2

/** 会话存储获取（隐私模式/无 DOM 环境降级为 null） */
function getSessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}
/** 会话记忆存储：面板挂载即记忆本次选择（刷新保持） */
const DEBUG_SESSION_STORE = getSessionStore()

/**
 * 在 Canvas 外挂载主题化 Leva 根面板。<Leva> 是 DOM 组件，放进 R3F 渲染树
 * 会被 reconciler 当作场景对象创建并崩溃（整页黑屏），因此按 leva 自动挂载
 * 的同款机制自建 body 宿主再渲染，并借主题把默认 280px 根宽度加宽。
 * 与 useControls 的自动挂载竞态安全：若自动面板先行创建，<Leva> 挂载时的
 * 接管逻辑会把它移除，最终只保留本宿主的面板。
 */
function useDebugLevaRoot(): void {
  useEffect(() => {
    const host = Object.assign(document.createElement('div'), {
      id: DEBUG_LEVA_HOST_ID,
    })
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(<Leva theme={{ sizes: { rootWidth: DEBUG_PANEL_ROOT_WIDTH } }} />)
    return () => {
      root.unmount()
      host.remove()
    }
  }, [])
}

export default function DebugPanel({ sceneBounds, controlsRef }: DebugPanelProps) {
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const [lightRebindTick, setLightRebindTick] = useState(0)
  useDebugLevaRoot()

  // 挂载即记忆（?debug=1 首次进入后，刷新无需再带参数）
  useEffect(() => {
    persistDebugPanelEnabled(true, DEBUG_SESSION_STORE)
  }, [])

  // —— 图层开关：schema 按注册表生成（键=图层键，标签=中文显示名） ——
  const layerSchema = useMemo(() => {
    const schema: Record<string, { value: boolean; label: string }> = {}
    for (const layer of DEBUG_LAYERS) {
      schema[layer.key] = { value: true, label: layer.label }
    }
    return schema
  }, [])
  const layerVisibility = useControls('图层开关', layerSchema)

  // 显隐应用：开关变化立即应用 + 低频重申（动态批次）
  const visibilityRef = useRef(layerVisibility)
  visibilityRef.current = layerVisibility
  useEffect(() => {
    applyAllLayerVisibility(scene, layerVisibility)
  }, [scene, layerVisibility])
  const frameRef = useRef(0)
  useFrame(() => {
    frameRef.current = (frameRef.current + 1) % DEBUG_LAYER_REAPPLY_FRAMES
    if (frameRef.current === 0) {
      applyAllLayerVisibility(scene, visibilityRef.current)
    }
  })

  // —— 辅助对象开关 ——
  const helpers = useControls('辅助', {
    grid: { value: false, label: 'Grid (5m)' },
    axes: { value: false, label: 'Axes' },
    bounds: { value: false, label: 'BoundingBox' },
    lightHelper: { value: false, label: 'Light Helper' },
    重新绑定灯光Helper: button(() => setLightRebindTick((tick) => tick + 1)),
  })

  const gridSpec = useMemo(() => {
    if (sceneBounds === null) {
      return null
    }
    const sizeX = sceneBounds.maxWorldX - sceneBounds.minWorldX
    const sizeZ = sceneBounds.maxWorldZ - sceneBounds.minWorldZ
    const size = Math.ceil(Math.max(sizeX, sizeZ) * DEBUG_GRID_EXTENSION_RATIO)
    return {
      size,
      divisions: Math.max(Math.round(size / DEBUG_GRID_CELL_M), 1),
      centerX: sceneBounds.centerWorldX,
      centerZ: sceneBounds.centerWorldZ,
    }
  }, [sceneBounds])

  const boundsBox = useMemo(() => {
    if (sceneBounds === null) {
      return null
    }
    return new THREE.Box3(
      new THREE.Vector3(sceneBounds.minWorldX, 0, sceneBounds.minWorldZ),
      new THREE.Vector3(
        sceneBounds.maxWorldX,
        DEBUG_BOUNDS_HEIGHT_M,
        sceneBounds.maxWorldZ,
      ),
    )
  }, [sceneBounds])

  // 灯光 Helper：按场景名绑定方向光；上下文恢复换代后可经按钮重绑
  const lightHelper = useMemo(() => {
    if (!helpers.lightHelper) {
      return null
    }
    const light = scene.getObjectByName(DEBUG_DIRECTIONAL_LIGHT_NAME)
    if (light === null || !(light as THREE.DirectionalLight).isDirectionalLight) {
      return null
    }
    const helper = new THREE.DirectionalLightHelper(
      light as THREE.DirectionalLight,
      DEBUG_LIGHT_HELPER_SIZE_M,
    )
    // 重绑代序号入名：换代重绑生成全新对象（旧对象随 effect 清理离场）
    helper.name = `debug-light-helper-g${lightRebindTick}`
    return helper
  }, [scene, helpers.lightHelper, lightRebindTick])
  useEffect(() => {
    if (lightHelper === null) {
      return
    }
    lightHelper.update()
    return () => {
      lightHelper.dispose()
    }
  }, [lightHelper])

  // —— 相机位姿取证 ——
  useControls('相机', {
    复制相机位姿JSON: button(() => {
      const perspective = camera as THREE.PerspectiveCamera
      const target = controlsRef?.current?.target
      const round = (values: number[]): number[] =>
        values.map((value) => Number(value.toFixed(DEBUG_POSE_DECIMALS)))
      const pose = {
        cameraPosition: round(camera.position.toArray()),
        fov: perspective.fov,
        ...(target !== undefined
          ? { controlsTarget: round(target.toArray()) }
          : {}),
      }
      const json = JSON.stringify(pose)
      console.info(`[debug] 相机位姿 ${json}`)
      void navigator.clipboard?.writeText(json).catch(() => {
        // 剪贴板权限不可用时控制台输出即为取证通道
      })
    }),
  })

  return (
    <>
      {helpers.grid && gridSpec !== null ? (
        <gridHelper
          args={[gridSpec.size, gridSpec.divisions, DEBUG_GRID_CENTER_COLOR, DEBUG_GRID_COLOR]}
          position={[gridSpec.centerX, GRID_Y + DEBUG_GRID_LIFT_M, gridSpec.centerZ]}
        />
      ) : null}
      {helpers.axes ? <axesHelper args={[DEBUG_AXES_LENGTH_M]} /> : null}
      {helpers.bounds && boundsBox !== null ? (
        <box3Helper args={[boundsBox, DEBUG_BOUNDS_COLOR]} />
      ) : null}
      {lightHelper !== null ? <primitive object={lightHelper} dispose={null} /> : null}
    </>
  )
}
