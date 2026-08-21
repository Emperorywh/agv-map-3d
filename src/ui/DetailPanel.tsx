import { agvStatusColors, uiColors } from '../config/theme'
import { useAppStore } from '../state/appStore'
import type { AgvStatus } from '../domain/simulator'
import {
  AGV_STATUS_LABELS,
  NODE_KIND_LABELS,
  buildAgvDetails,
  buildCorridorDetails,
  buildNodeDetails,
} from './detailModel'
import type {
  AgvDetails,
  CorridorDetails,
  CorridorDirectionDetails,
  NodeDetails,
} from './detailModel'

/**
 * 右侧详情面板（SPEC §8.2，DOM、Canvas 外）：显示选中对象的完整属性。
 *
 * - 数据流：store.selection + store.mapData（节点 / 走廊字段）与
 *   store.agvSnapshot（AGV 字段，0.5s 低频快照节流刷新，不订阅每帧瞬时值，SPEC §9）；
 * - 分层：只消费 domain 类型、store 与 config 色值，不 import rendering（SPEC §12）；
 *   字段解析全部收敛于 detailModel 纯函数，本组件只做展示；
 * - 布局 / 色彩：布局类在 index.css，色值经 uiColors / agvStatusColors 内联注入。
 */

/** 数值展示：源数据可为 null 的字段显示「缺省」（SPEC §7.2 缺省兜底由模拟器处理） */
function formatNullable(value: number | null, digits = 2): string {
  return value === null ? '缺省' : value.toFixed(digits)
}

/** 朝向角展示：弧度原始值 + 度数（数据为弧度，SPEC §4.1） */
function formatAngle(angleRad: number): string {
  return `${((angleRad * 180) / Math.PI).toFixed(1)}°（${angleRad.toFixed(3)} rad）`
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span className="detail-label" style={{ color: uiColors.textSecondary }}>
        {label}
      </span>
      <span className="detail-value" style={{ color: uiColors.textPrimary }}>
        {value}
      </span>
    </div>
  )
}

function SectionTitle({ text }: { text: string }) {
  return (
    <div className="detail-section-title" style={{ color: uiColors.textSecondary }}>
      {text}
    </div>
  )
}

function StatusDot({ status }: { status: AgvStatus }) {
  return (
    <span
      className="detail-status-dot"
      style={{ background: agvStatusColors[status] }}
      aria-hidden
    />
  )
}

function NodeSection({ details }: { details: NodeDetails }) {
  return (
    <>
      <DetailRow label="名称" value={details.name} />
      <DetailRow label="类型" value={NODE_KIND_LABELS[details.nodeKind]} />
      <DetailRow label="节点 ID" value={details.id} />
      <DetailRow label="坐标" value={`(${details.x.toFixed(2)}, ${details.y.toFixed(2)}) m`} />
      <DetailRow
        label="angle"
        value={details.angle === null ? '无' : formatAngle(details.angle)}
      />
      <SectionTitle text={`关联边（${details.edges.length}）`} />
      <div className="detail-edge-list">
        {details.edges.map((edge) => (
          <div key={edge.id} className="detail-edge-item">
            <span style={{ color: uiColors.textPrimary }}>
              {edge.name}
              {edge.isBackEdge ? '（倒车）' : ''}
            </span>
            <span style={{ color: uiColors.textSecondary }}>
              {edge.fromName} → {edge.toName}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

function DirectionGroup({
  direction,
  index,
}: {
  direction: CorridorDirectionDetails
  index: number
}) {
  return (
    <div className="detail-direction">
      <SectionTitle
        text={`方向 ${index + 1}：${direction.fromName} → ${direction.toName}${
          direction.isBack ? '（倒车）' : ''
        }`}
      />
      <DetailRow label="边名称" value={direction.edgeName} />
      <DetailRow label="边 ID" value={direction.edgeId} />
      <DetailRow label="是否倒车" value={direction.isBack ? '倒车通过' : '正向行驶'} />
      <DetailRow label="长度" value={`${direction.length.toFixed(2)} m`} />
      <DetailRow label="cost" value={direction.cost.toFixed(2)} />
      <DetailRow
        label="限速 载货 / 空载"
        value={`${formatNullable(direction.maxSpeedLoad)} / ${formatNullable(
          direction.maxSpeedFree,
        )} m/s`}
      />
      <DetailRow
        label="加速度 载货 / 空载"
        value={`${formatNullable(direction.maxAccelerationLoad)} / ${formatNullable(
          direction.maxAccelerationFree,
        )} m/s²`}
      />
      <DetailRow
        label="减速度 载货 / 空载"
        value={`${formatNullable(direction.maxDecelerationLoad)} / ${formatNullable(
          direction.maxDecelerationFree,
        )} m/s²`}
      />
      <DetailRow
        label="旋转速度 载货 / 空载"
        value={`${formatNullable(direction.maxRotationSpeedLoad)} / ${formatNullable(
          direction.maxRotationSpeedFree,
        )} rad/s`}
      />
      <DetailRow label="入边朝向" value={formatAngle(direction.sFacing)} />
      <DetailRow label="出边朝向" value={formatAngle(direction.eFacing)} />
    </div>
  )
}

function CorridorSection({ details }: { details: CorridorDetails }) {
  return (
    <>
      <DetailRow label="名称" value={`${details.nodeAName} ⇄ ${details.nodeBName}`} />
      <DetailRow label="走廊 ID" value={details.id} />
      <DetailRow label="方向" value={details.bidirectional ? '双向' : '单向'} />
      <DetailRow label="长度" value={`${details.length.toFixed(2)} m`} />
      {details.directions.map((direction, index) => (
        <DirectionGroup key={direction.edgeId} direction={direction} index={index} />
      ))}
    </>
  )
}

function AgvSection({ details }: { details: AgvDetails }) {
  const battery = Math.max(0, Math.min(100, details.battery))
  return (
    <>
      <DetailRow label="编号" value={String(details.id).padStart(2, '0')} />
      <div className="detail-row">
        <span className="detail-label" style={{ color: uiColors.textSecondary }}>
          状态
        </span>
        <span className="detail-value" style={{ color: uiColors.textPrimary }}>
          <StatusDot status={details.status} />
          {AGV_STATUS_LABELS[details.status]}
        </span>
      </div>
      <DetailRow label="当前任务" value={details.task ?? '无'} />
      <DetailRow
        label="所在边"
        value={details.edgeName === null ? '—（停靠中）' : details.edgeName}
      />
      {details.nodeName !== null && <DetailRow label="停靠节点" value={details.nodeName} />}
      <div className="detail-row">
        <span className="detail-label" style={{ color: uiColors.textSecondary }}>
          电量
        </span>
        <span className="detail-value" style={{ color: uiColors.textPrimary }}>
          {battery.toFixed(1)}%
        </span>
      </div>
      <div className="detail-battery-track" style={{ background: uiColors.progressTrack }}>
        <div
          className="detail-battery-fill"
          style={{ background: uiColors.accent, width: `${battery}%` }}
        />
      </div>
    </>
  )
}

export function DetailPanel() {
  const selection = useAppStore((state) => state.selection)
  const mapData = useAppStore((state) => state.mapData)
  const agvSnapshot = useAppStore((state) => state.agvSnapshot)
  const setSelection = useAppStore((state) => state.setSelection)

  if (selection === null || mapData === null) {
    return null
  }

  let title = ''
  let content: React.ReactNode = null
  if (selection.kind === 'node') {
    const details = buildNodeDetails(mapData, selection.id)
    if (details === null) {
      return null
    }
    title = `节点 · ${details.name}`
    content = <NodeSection details={details} />
  } else if (selection.kind === 'corridor') {
    const details = buildCorridorDetails(mapData, selection.id)
    if (details === null) {
      return null
    }
    title = `走廊 · ${details.nodeAName} ⇄ ${details.nodeBName}`
    content = <CorridorSection details={details} />
  } else {
    const details = buildAgvDetails(agvSnapshot, mapData, Number(selection.id))
    if (details === null) {
      return null
    }
    title = `AGV · ${String(details.id).padStart(2, '0')}`
    content = <AgvSection details={details} />
  }

  return (
    <aside
      className="detail-panel"
      style={{
        background: uiColors.panelBackground,
        color: uiColors.textPrimary,
        borderLeft: `1px solid ${uiColors.progressTrack}`,
      }}
    >
      <div className="detail-panel-header" style={{ borderBottomColor: uiColors.progressTrack }}>
        <span className="detail-panel-title">{title}</span>
        <button
          type="button"
          className="detail-panel-close"
          style={{ color: uiColors.textSecondary }}
          onClick={() => setSelection(null)}
          aria-label="关闭详情面板"
        >
          ×
        </button>
      </div>
      <div className="detail-panel-body">{content}</div>
    </aside>
  )
}
