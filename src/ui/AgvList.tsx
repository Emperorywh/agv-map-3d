import { agvStatusColors, uiColors } from '../config/theme'
import { useAppStore } from '../state/appStore'
import { AGV_STATUS_LABELS } from './detailModel'

/**
 * AGV 列表（SPEC §8.3，DOM、Canvas 外）：编号 + 状态色点 + 总数计数；
 * 点击某台切跟随模式定位到该 AGV（setFollowTarget，SPEC §8.1 列表触发跟随），
 * 当前跟随目标行高亮，再次点击其他行切换跟随目标。
 *
 * - 数据流：store.agvSnapshot（0.5s 低频快照，≤2Hz 节流刷新，不订阅每帧瞬时值，SPEC §9）；
 * - 分层：只消费 domain 类型、store 与 config 色值，不 import rendering（SPEC §12）；
 * - 布局 / 色彩：布局类在 index.css，色值经 uiColors / agvStatusColors 内联注入
 *   （行 hover 底色经 --panel-row-hover CSS var 注入，CSS 中不放色值）。
 */
export function AgvList() {
  const agvSnapshot = useAppStore((state) => state.agvSnapshot)
  const cameraMode = useAppStore((state) => state.cameraMode)
  const followTargetId = useAppStore((state) => state.followTargetId)
  const setFollowTarget = useAppStore((state) => state.setFollowTarget)

  return (
    <section
      className="panel agv-list"
      aria-label="AGV 列表"
      style={
        {
          background: uiColors.panelBackground,
          borderColor: uiColors.progressTrack,
          '--panel-row-hover': uiColors.rowHover,
        } as React.CSSProperties
      }
    >
      <header
        className="panel-header"
        style={{ color: uiColors.textPrimary, borderBottomColor: uiColors.progressTrack }}
      >
        AGV 列表（共 {agvSnapshot.length} 台）
      </header>
      <div className="agv-list-body">
        {agvSnapshot.map((agv) => {
          const followed = cameraMode === 'follow' && followTargetId === agv.id
          const label = String(agv.id).padStart(2, '0')
          return (
            <button
              key={agv.id}
              type="button"
              className="agv-list-item"
              aria-pressed={followed}
              title={`跟随 AGV #${label}`}
              onClick={() => setFollowTarget(agv.id)}
              style={{
                color: uiColors.textPrimary,
                background: followed ? uiColors.rowActive : undefined,
              }}
            >
              <span
                className="detail-status-dot"
                style={{ background: agvStatusColors[agv.status] }}
                aria-hidden
              />
              <span
                className="agv-list-id"
                style={{ color: followed ? uiColors.accent : uiColors.textPrimary }}
              >
                #{label}
              </span>
              <span className="agv-list-status" style={{ color: uiColors.textSecondary }}>
                {AGV_STATUS_LABELS[agv.status]}
              </span>
              {followed && (
                <span className="agv-list-followed" style={{ color: uiColors.accent }}>
                  跟随中
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
