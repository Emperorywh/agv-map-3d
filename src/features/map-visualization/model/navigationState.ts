/**
 * 路径状态是独立展示输入，以逻辑边 ID 为键，绝不改写地图拓扑。
 * 接入方调用 setPathStates 增量更新，选择状态只供节点交互使用。
 */
import { create } from 'zustand'
export type NavigationStatus = 'clear' | 'reserved' | 'waiting' | 'blocked'
export type PathStates = Readonly<Record<string, NavigationStatus>>
interface NavigationState {
  pathStates: PathStates
  selectedNode: string | null
  setPathStates(patch: PathStates): void
  selectNode(id: string | null): void
  reset(): void
}
export const useNavigationState = create<NavigationState>((set) => ({
  pathStates: {}, selectedNode: null,
  setPathStates: (patch) => set((state) => ({ pathStates: { ...state.pathStates, ...patch } })),
  selectNode: (selectedNode) => set({ selectedNode }),
  reset: () => set({ pathStates: {}, selectedNode: null }),
}))
