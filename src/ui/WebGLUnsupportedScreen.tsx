import { uiColors } from '../config/theme'

/**
 * WebGL 不可用提示页（SPEC §10）：当前环境不支持 WebGL2 时展示，
 * 说明浏览器不支持并给出建议，不进入场景。
 */
export function WebGLUnsupportedScreen() {
  return (
    <div className="overlay-screen" style={{ color: uiColors.textPrimary }}>
      <div className="overlay-title" style={{ color: uiColors.danger }}>
        当前浏览器不支持 WebGL
      </div>
      <div className="error-reason" style={{ color: uiColors.textSecondary }}>
        本应用需要 WebGL2 渲染 3D 场景。请使用最新版本的 Chrome / Edge 等桌面浏览器，
        并确认已开启硬件加速。
      </div>
    </div>
  )
}
