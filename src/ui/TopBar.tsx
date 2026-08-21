import { uiColors } from '../config/theme'
import { useAppStore } from '../state/appStore'

/**
 * 顶部栏（SPEC §8.3，DOM、Canvas 外）：相机三模式切换按钮
 * （自由 Orbit / 正交俯视 / AGV 跟随，SPEC §8.1）。
 *
 * - 与 CameraRig 的交互全部经 store（cameraMode / followTargetId + setCameraMode /
 *   setFollowTarget），行为与 TASK-011 的 store 不变量一致：
 *   follow 模式仅经 setFollowTarget 携带目标进入（setCameraMode('follow') 为空操作），
 *   切自由 / 俯视自动清空跟随目标；
 * - 跟随进入的目标解析：优先当前选中的 AGV（§8.1 选中 AGV 触发），否则列表首台；
 *   跟随中再次点击按钮退出跟随回自由 Orbit（同 Esc，§8.1）；
 * - 分层：只消费 store 与 config 色值，不 import rendering（SPEC §12）。
 */

/** 跟随按钮可用性 / 目标解析（渲染期只订阅布尔量，点击时经 getState 取瞬时值） */
function enterFollow(): void {
  const state = useAppStore.getState()
  // 优先跟随当前选中的 AGV（SPEC §8.1：从 AGV 列表或选中 AGV 触发）
  if (state.selection !== null && state.selection.kind === 'agv') {
    state.setFollowTarget(Number(state.selection.id))
    return
  }
  const first = state.agvSnapshot[0]
  if (first !== undefined) {
    state.setFollowTarget(first.id)
  }
}

export function TopBar() {
  const cameraMode = useAppStore((state) => state.cameraMode)
  const followTargetId = useAppStore((state) => state.followTargetId)
  // 布尔订阅：快照 0.5s 低频刷新时仅在有 / 无 AGV 翻转时才重渲染
  const hasAgvs = useAppStore((state) => state.agvSnapshot.length > 0)
  const setCameraMode = useAppStore((state) => state.setCameraMode)

  const following = cameraMode === 'follow' && followTargetId !== null
  const modes: { key: 'orbit' | 'topdown'; label: string }[] = [
    { key: 'orbit', label: '自由视角' },
    { key: 'topdown', label: '正交俯视' },
  ]

  return (
    <header
      className="top-bar"
      style={
        {
          background: uiColors.panelBackground,
          borderColor: uiColors.progressTrack,
          '--panel-row-hover': uiColors.rowHover,
        } as React.CSSProperties
      }
    >
      <span className="top-bar-title" style={{ color: uiColors.textPrimary }}>
        AGV 调度地图
      </span>
      <div className="top-bar-modes" role="group" aria-label="相机模式">
        {modes.map((mode) => {
          const active = cameraMode === mode.key
          return (
            <button
              key={mode.key}
              type="button"
              className="panel-button"
              aria-pressed={active}
              onClick={() => setCameraMode(mode.key)}
              style={{
                color: active ? uiColors.panelBackground : uiColors.textPrimary,
                background: active ? uiColors.accent : undefined,
              }}
            >
              {mode.label}
            </button>
          )
        })}
        <button
          type="button"
          className="panel-button"
          aria-pressed={following}
          disabled={!following && !hasAgvs}
          title={following ? '退出跟随（Esc）' : '跟随选中 AGV，无选中时跟随首台'}
          onClick={() => (following ? setCameraMode('orbit') : enterFollow())}
          style={{
            color: following ? uiColors.panelBackground : uiColors.textPrimary,
            background: following ? uiColors.accent : undefined,
          }}
        >
          {following ? `跟随中 #${String(followTargetId).padStart(2, '0')}` : 'AGV 跟随'}
        </button>
      </div>
    </header>
  )
}
