import { create } from 'zustand'

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

/** AGV 对外状态集合（SPEC §7.1） */
export type AgvStatus =
  | 'idle'
  | 'toPick'
  | 'hauling'
  | 'toCharge'
  | 'charging'
  | 'loading'

/** 单台 AGV 的模拟状态快照（前端模拟值，SPEC §12） */
export interface AgvSnapshot {
  id: number
  status: AgvStatus
  /** 电量百分比（模拟值，0~100） */
  battery: number
  /** 当前所在边；停靠时为 null */
  edgeId: string | null
  /** 当前任务描述（演示用） */
  task: string | null
}

export interface AppState {
  cameraMode: CameraMode
  /** 跟随模式目标 AGV；非跟随模式为 null */
  followAgvId: number | null
  selection: Selection | null
  layers: LayerVisibility
  agvSnapshot: AgvSnapshot[]

  setCameraMode: (mode: CameraMode) => void
  setFollowAgv: (agvId: number | null) => void
  setSelection: (selection: Selection | null) => void
  setLayer: <K extends keyof LayerVisibility>(key: K, value: LayerVisibility[K]) => void
  setAgvSnapshot: (snapshot: AgvSnapshot[]) => void
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
  followAgvId: null,
  selection: null,
  layers: DEFAULT_LAYERS,
  agvSnapshot: [],

  setCameraMode: (mode) => set({ cameraMode: mode }),
  setFollowAgv: (agvId) =>
    set(agvId === null ? { followAgvId: null } : { followAgvId: agvId, cameraMode: 'follow' }),
  setSelection: (selection) => set({ selection }),
  setLayer: (key, value) => set((state) => ({ layers: { ...state.layers, [key]: value } })),
  setAgvSnapshot: (snapshot) => set({ agvSnapshot: snapshot }),
}))
