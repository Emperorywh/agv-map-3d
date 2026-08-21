import type { AgvSnapshot } from '../domain/simulator'

/**
 * AGV 每帧瞬时值通道（SPEC §3：每帧数据走 ref / 瞬时值读取，禁止进 React 渲染路径）。
 *
 * AgvLayer 每帧推进模拟器后把最新快照数组引用写入本通道（写引用，零拷贝零分配）；
 * CameraRig 跟随模式按 id 逐帧解析目标世界坐标（SPEC §8.1 跟随必须走瞬时值），
 * 后续遮挡淡出（TASK-012）/ 拾取（TASK-013）如需每帧位姿也经此读取。
 * store 中的 agvSnapshot 仍是 0.5s 低频快照（供 UI 面板节流读取），两者分工不变。
 */
export interface AgvRuntimeChannel {
  /** 最新一帧的 AGV 快照（模拟器步进结果）；模拟器未就绪 / 已卸载时为 null */
  snapshots: readonly AgvSnapshot[] | null
}

export const agvRuntime: AgvRuntimeChannel = { snapshots: null }
