import { uiColors } from '../config/theme'
import type { MapLoadProgress } from '../state/appStore'

interface LoadingOverlayProps {
  progress: MapLoadProgress | null
}

/**
 * 加载进度页（SPEC §4.4）：map.json 下载期间显示百分比进度条；
 * 解析与规范化阶段（Worker 内，进度不可细分）显示不定进度动画。
 */
export function LoadingOverlay({ progress }: LoadingOverlayProps) {
  const percent =
    progress !== null &&
    progress.phase === 'fetch' &&
    progress.totalBytes !== null &&
    progress.totalBytes > 0
      ? // gzip 传输时 Content-Length 为压缩后大小，下载字节数可能超出，按 100% 封顶
        Math.min(100, Math.round((progress.loadedBytes / progress.totalBytes) * 100))
      : null

  const statusText =
    progress === null
      ? '准备加载地图数据…'
      : progress.phase === 'fetch'
        ? percent !== null
          ? `正在加载地图数据… ${percent}%`
          : `正在加载地图数据… ${formatBytes(progress.loadedBytes)}`
        : '正在解析与规范化地图…'

  return (
    <div className="overlay-screen" style={{ color: uiColors.textPrimary }}>
      <div className="overlay-title">AGV 调度地图</div>
      <div className="progress-track" style={{ background: uiColors.progressTrack }}>
        <div
          className={percent === null ? 'progress-bar progress-bar-indeterminate' : 'progress-bar'}
          style={{
            background: uiColors.accent,
            width: percent === null ? undefined : `${percent}%`,
          }}
        />
      </div>
      <div className="overlay-status" style={{ color: uiColors.textSecondary }}>
        {statusText}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
