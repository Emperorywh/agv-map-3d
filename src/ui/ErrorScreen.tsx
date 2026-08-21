import { uiColors } from '../config/theme'

interface ErrorScreenProps {
  /** 失败原因（map.json 请求失败 / JSON 损坏 / 顶层结构缺失） */
  reason: string
  onRetry: () => void
}

/**
 * 全屏错误页（SPEC §10）：map.json 请求失败 / JSON 损坏 / 顶层结构缺失
 * 且主线程回退也失败时展示，给出原因与重试按钮，不进入场景。
 */
export function ErrorScreen({ reason, onRetry }: ErrorScreenProps) {
  return (
    <div className="overlay-screen" style={{ color: uiColors.textPrimary }}>
      <div className="overlay-title" style={{ color: uiColors.danger }}>
        地图加载失败
      </div>
      <div className="error-reason" style={{ color: uiColors.textSecondary }}>
        {reason}
      </div>
      <button
        type="button"
        className="retry-button"
        style={{ background: uiColors.accent, color: uiColors.textPrimary }}
        onClick={onRetry}
      >
        重试
      </button>
    </div>
  )
}
