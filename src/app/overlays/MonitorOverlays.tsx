/**
 * 监控辅助界面放在画布外，加载状态由应用启动流程驱动。
 * 性能面板单独订阅每秒快照，不因指标刷新重新渲染地图或车辆。
 */
import { useId, useState, useSyncExternalStore } from 'react'
import { getFrameMetrics, subscribeFrameMetrics } from '@/shared/rendering/frameDiagnostics'
import './monitorOverlays.css'

export function LoadingOverlay({ message, failed }: { message: string | null; failed: boolean }) {
  if (message === null) return null
  return (
    <div className={`monitor-loading${failed ? ' monitor-loading--failed' : ''}`} role="status" aria-live="polite" aria-busy={!failed}>
      <div className="monitor-loading__content">
        <div className="monitor-loading__symbol" aria-hidden="true"><span /><i /></div>
        <span className="monitor-loading__eyebrow">AGV · 三维监控</span>
        <h1>{failed ? '场景暂不可用' : '正在准备监控场景'}</h1>
        <p>{message}</p>
        {failed ? <button type="button" onClick={() => window.location.reload()}>重新加载</button> : (
          <div className="monitor-loading__track" aria-hidden="true"><span /></div>
        )}
      </div>
    </div>
  )
}

/**
 * 未形成有效采样或渲染暂停时显示占位符，不把旧数据当作实时状态。
 * 所有数值明确标注单位；绘制次数和三角形数均为完整帧的平均值。
 */
export function PerformancePanel({ active, debugPanelEnabled }: { active: boolean; debugPanelEnabled: boolean }) {
  /**
   * 显隐状态仅影响辅助面板，保持场景和性能采样的生命周期稳定。
   * 切换按钮始终保留，隐藏后仍可通过鼠标或键盘重新展开。
   */
  const [visible, setVisible] = useState(true)
  const contentId = useId()
  const snapshot = useSyncExternalStore(subscribeFrameMetrics, getFrameMetrics)
  const metrics = active ? snapshot : null
  const number = (value: number | undefined) => value === undefined ? '—' : Math.round(value).toLocaleString('zh-CN')
  const milliseconds = (value: number | undefined) => value === undefined ? '—' : `${value.toFixed(1)} ms`
  return (
    <aside className={`monitor-performance${debugPanelEnabled ? ' monitor-performance--debug' : ''}${visible ? '' : ' monitor-performance--collapsed'}`} aria-label="场景性能参数">
      <div className="monitor-performance__heading">
        {visible ? <span>渲染性能</span> : null}
        <button className="monitor-performance__toggle" type="button" aria-expanded={visible} aria-controls={contentId} onClick={() => setVisible((current) => !current)}>
          {visible ? '隐藏' : '显示性能'}
        </button>
      </div>
      <div id={contentId} hidden={!visible}>
      <div className="monitor-performance__fps">
        <strong>{metrics ? metrics.fps.toFixed(0) : '—'}</strong><span>FPS</span>
        <span className="monitor-performance__status">{!active ? '等待渲染' : metrics ? '实时 · 1 秒' : '采样中'}</span>
      </div>
      <dl>
        <div><dt>平均帧耗时</dt><dd>{milliseconds(metrics?.frameMs)}</dd></div>
        <div><dt>P95 帧耗时</dt><dd>{milliseconds(metrics?.p95FrameMs)}</dd></div>
        <div title="同步提交与渲染调用耗时，不代表 GPU 执行时间"><dt>CPU 提交</dt><dd>{milliseconds(metrics?.cpuSubmitMs)}</dd></div>
        <div><dt>绘制调用 / 帧</dt><dd>{number(metrics?.drawCalls)}</dd></div>
        <div><dt>三角形 / 帧</dt><dd>{number(metrics?.triangles)}</dd></div>
        <div><dt>几何体 / 纹理</dt><dd>{number(metrics?.geometries)} / {number(metrics?.textures)}</dd></div>
      </dl>
      </div>
    </aside>
  )
}
