import { create } from 'zustand'

import type { NormalizeStats } from '../domain/normalize'
import type { AgvSnapshot } from '../domain/simulator'
import type { NormalizedMap } from '../domain/types'

/**
 * 全局 zustand store 骨架（SPEC §3 / §12）。
 * 承载 UI 状态与模拟状态快照；本任务只定义初始类型与默认值，
 * 具体字段由后续任务按需扩展。
 *
 * 注意（SPEC §3）：禁止在 React 渲染路径上放每帧更新的状态——
 * 每帧数据（如 AGV 实时位姿）应走 ref / store 瞬时值读取，不触发 React 重渲染。
 */

/** 相机模式（SPEC §8.1） */
export type CameraMode = 'orbit' | 'topdown' | 'follow'

/** 可拾取对象类别（SPEC §8.2） */
export type SelectableKind = 'node' | 'corridor' | 'agv'

export interface Selection {
  kind: SelectableKind
  id: string
}

/** 选中 / 悬停目标同一性判定（kind + id 相同即同一目标；null 两侧等价） */
export function sameSelectionTarget(
  a: Selection | null,
  b: Selection | null,
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.kind === b.kind && a.id === b.id
}

/** 屋顶手动覆盖三态（SPEC §5.5） */
export type RoofOverride = 'auto' | 'show' | 'hide'

/** 图层开关（SPEC §8.3） */
export interface LayerVisibility {
  nodes: boolean
  corridors: boolean
  labels: boolean
  interior: boolean
  groundMarkings: boolean
  roof: RoofOverride
}

/**
 * AGV 对外状态与快照类型唯一定义在 domain/simulator（SPEC §7.1 / §12）：
 * 状态集合 空闲 / 去取货 / 载货中 / 去充电 / 充电中 / 装卸中；快照含编号、状态、
 * 任务、所在边、电量、世界坐标与 yaw（模拟器任务落地，渲染与面板经 store 读取）。
 */
export type { AgvSnapshot, AgvStatus } from '../domain/simulator'

/** 地图加载阶段（SPEC §4.4 / §10）：idle → loading → ready / error，error 可重试回 idle */
export type MapLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 加载进度（与 infrastructure/mapLoader 的进度结构一致，store 不反向依赖 IO 层细节） */
export interface MapLoadProgress {
  /** fetch = 下载中（按字节推进）；normalize = 解析与规范化中（不定进度） */
  phase: 'fetch' | 'normalize'
  loadedBytes: number
  /** 响应 Content-Length；未知时为 null，UI 按不定进度展示 */
  totalBytes: number | null
}

export interface AppState {
  cameraMode: CameraMode
  /** 跟随模式目标 AGV 编号；非跟随模式恒为 null（SPEC §8.1，CameraRig 据此驱动场景行为） */
  followTargetId: number | null
  selection: Selection | null
  /** 悬停目标（SPEC §8.2 弱高亮 + 强制标签）；与 selection 相互独立，渲染侧选中优先 */
  hover: Selection | null
  layers: LayerVisibility
  agvSnapshot: AgvSnapshot[]

  /** 地图加载阶段（SPEC §4.4 / §10） */
  mapLoadPhase: MapLoadPhase
  /** 加载进度（loading 阶段有效） */
  mapLoadProgress: MapLoadProgress | null
  /** 加载失败原因（error 阶段有效，展示于全屏错误页） */
  mapLoadError: string | null
  /** 规范化后的地图数据（ready 阶段有效） */
  mapData: NormalizedMap | null
  /** 规范化统计：跳过 / 降级计数（SPEC §10 计数要求；统计面板见 TASK-014） */
  normalizeStats: NormalizeStats | null
  /** true = Worker 中完成规范化；false = 回退主线程 */
  mapLoadUsedWorker: boolean

  /**
   * 切换自由 / 俯视模式；切出跟随会同时清空 followTargetId。
   * 跟随模式仅经 setFollowTarget 携带目标进入（'follow' 实参为空操作，保证
   * cameraMode = 'follow' ⟺ followTargetId ≠ null 的不变量）。
   */
  setCameraMode: (mode: CameraMode) => void
  /** 进入跟随模式：设定目标 AGV 编号并把相机模式切为 follow（SPEC §8.1 列表 / 选中触发） */
  setFollowTarget: (agvId: number) => void
  setSelection: (selection: Selection | null) => void
  /** 设定悬停目标；与当前悬停相同则为空操作（pointermove 高频触发，同值不引起订阅方重渲染） */
  setHover: (hover: Selection | null) => void
  /** 仅当当前悬停即 target 时清除（pointerout 与 pointermove 乱序到达时不清掉新悬停目标） */
  clearHover: (target: Selection) => void
  setLayer: <K extends keyof LayerVisibility>(key: K, value: LayerVisibility[K]) => void
  setAgvSnapshot: (snapshot: AgvSnapshot[]) => void

  /** 仅 idle 阶段可发起加载（防 StrictMode 双调用 / 重复请求） */
  beginMapLoad: () => void
  setMapLoadProgress: (progress: MapLoadProgress) => void
  /** 仅 loading 阶段生效（迟到的完成不覆盖重试后的新状态） */
  completeMapLoad: (result: {
    map: NormalizedMap
    stats: NormalizeStats
    usedWorker: boolean
  }) => void
  failMapLoad: (reason: string) => void
  /** 错误页重试：回到 idle，由加载入口重新发起 */
  resetMapLoad: () => void
}

const DEFAULT_LAYERS: LayerVisibility = {
  nodes: true,
  corridors: true,
  labels: true,
  interior: true,
  groundMarkings: true,
  roof: 'auto',
}

export const useAppStore = create<AppState>()((set) => ({
  cameraMode: 'orbit',
  followTargetId: null,
  selection: null,
  hover: null,
  layers: DEFAULT_LAYERS,
  agvSnapshot: [],

  mapLoadPhase: 'idle',
  mapLoadProgress: null,
  mapLoadError: null,
  mapData: null,
  normalizeStats: null,
  mapLoadUsedWorker: false,

  setCameraMode: (mode) =>
    set((state) =>
      mode === 'follow' ? state : { cameraMode: mode, followTargetId: null },
    ),
  setFollowTarget: (agvId) => set({ followTargetId: agvId, cameraMode: 'follow' }),
  setSelection: (selection) =>
    set((state) => (sameSelectionTarget(state.selection, selection) ? state : { selection })),
  setHover: (hover) => set((state) => (sameSelectionTarget(state.hover, hover) ? state : { hover })),
  clearHover: (target) =>
    set((state) => (sameSelectionTarget(state.hover, target) ? { hover: null } : state)),
  setLayer: (key, value) => set((state) => ({ layers: { ...state.layers, [key]: value } })),
  setAgvSnapshot: (snapshot) => set({ agvSnapshot: snapshot }),

  beginMapLoad: () =>
    set((state) =>
      state.mapLoadPhase === 'idle'
        ? {
            mapLoadPhase: 'loading',
            mapLoadProgress: { phase: 'fetch', loadedBytes: 0, totalBytes: null },
            mapLoadError: null,
          }
        : state,
    ),
  setMapLoadProgress: (progress) =>
    set((state) => (state.mapLoadPhase === 'loading' ? { mapLoadProgress: progress } : state)),
  completeMapLoad: (result) =>
    set((state) =>
      state.mapLoadPhase === 'loading'
        ? {
            mapLoadPhase: 'ready',
            mapLoadProgress: null,
            mapData: result.map,
            normalizeStats: result.stats,
            mapLoadUsedWorker: result.usedWorker,
          }
        : state,
    ),
  failMapLoad: (reason) =>
    set((state) =>
      state.mapLoadPhase === 'loading'
        ? { mapLoadPhase: 'error', mapLoadProgress: null, mapLoadError: reason }
        : state,
    ),
  resetMapLoad: () =>
    set({
      mapLoadPhase: 'idle',
      mapLoadProgress: null,
      mapLoadError: null,
      mapData: null,
      normalizeStats: null,
    }),
}))
