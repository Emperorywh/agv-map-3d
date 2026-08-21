import { agvStatusColors, uiColors } from '../config/theme'
import { useAppStore } from '../state/appStore'
import { buildDataSkipCounts, buildMapTotals, countAgvByStatus } from './statsModel'

/**
 * 统计信息面板（SPEC §8.3 / §10，DOM、Canvas 外）：
 * AGV 各状态数量、节点 / 走廊 / 边总数、加载期坏数据跳过计数、FPS 与 draw call（§9 预算口径）。
 *
 * - 数据流：store.agvSnapshot 与 store.fps / store.drawCalls 均为 0.5s 低频写入
 *   （≤2Hz 节流刷新），不订阅每帧瞬时值（SPEC §9）；地图规模与跳过计数在加载完成后
 *   恒定（mapData / normalizeStats 引用不变，不引起重复渲染）；
 * - 字段派生收敛于 statsModel 纯函数，本组件只做展示；
 * - 分层：只消费 domain 类型、store 与 config 色值，不 import rendering（SPEC §12）；
 * - 跳过 / 降级计数非零时用 danger 色标出（SPEC §10：便于发现数据问题）。
 */
export function StatsPanel() {
  const agvSnapshot = useAppStore((state) => state.agvSnapshot)
  const mapData = useAppStore((state) => state.mapData)
  const normalizeStats = useAppStore((state) => state.normalizeStats)
  const fps = useAppStore((state) => state.fps)
  const drawCalls = useAppStore((state) => state.drawCalls)

  if (mapData === null || normalizeStats === null) {
    return null
  }

  const statusCounts = countAgvByStatus(agvSnapshot)
  const mapTotals = buildMapTotals(mapData)
  const skipCounts = buildDataSkipCounts(normalizeStats)

  return (
    <section
      className="panel stats-panel"
      aria-label="统计信息"
      style={{ background: uiColors.panelBackground, borderColor: uiColors.progressTrack }}
    >
      <header
        className="panel-header"
        style={{ color: uiColors.textPrimary, borderBottomColor: uiColors.progressTrack }}
      >
        统计信息
      </header>
      <div className="panel-body">
        <div className="detail-row">
          <span className="detail-label" style={{ color: uiColors.textSecondary }}>
            FPS
          </span>
          <span className="detail-value" style={{ color: uiColors.textPrimary }}>
            {fps === null ? '—' : fps}
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label" style={{ color: uiColors.textSecondary }}>
            Draw Calls
          </span>
          <span className="detail-value" style={{ color: uiColors.textPrimary }}>
            {drawCalls === null ? '—' : drawCalls}
          </span>
        </div>

        <div className="detail-section-title" style={{ color: uiColors.textSecondary }}>
          AGV 状态（共 {agvSnapshot.length} 台）
        </div>
        {statusCounts.map((row) => (
          <div key={row.status} className="detail-row">
            <span className="detail-label" style={{ color: uiColors.textSecondary }}>
              <span
                className="detail-status-dot"
                style={{ background: agvStatusColors[row.status] }}
                aria-hidden
              />
              {row.label}
            </span>
            <span className="detail-value" style={{ color: uiColors.textPrimary }}>
              {row.count}
            </span>
          </div>
        ))}

        <div className="detail-section-title" style={{ color: uiColors.textSecondary }}>
          地图规模
        </div>
        {mapTotals.map((row) => (
          <div key={row.key} className="detail-row">
            <span className="detail-label" style={{ color: uiColors.textSecondary }}>
              {row.label}
            </span>
            <span className="detail-value" style={{ color: uiColors.textPrimary }}>
              {row.count}
            </span>
          </div>
        ))}

        <div className="detail-section-title" style={{ color: uiColors.textSecondary }}>
          数据跳过计数
        </div>
        {skipCounts.map((row) => (
          <div key={row.key} className="detail-row">
            <span className="detail-label" style={{ color: uiColors.textSecondary }}>
              {row.label}
            </span>
            <span
              className="detail-value"
              style={{ color: row.count > 0 ? uiColors.danger : uiColors.textPrimary }}
            >
              {row.count}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
