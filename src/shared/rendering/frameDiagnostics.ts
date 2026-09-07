/**
 * 完整帧采样为常驻性能面板提供每秒一次的快照，不触发场景逐帧更新。
 * 网址参数 perf=1 额外开放原有全局诊断入口，供开发取证使用。
 * 主画面、阴影、透射、反射及后处理统一累计，避免只读取最后一个通道的数据。
 */
import type { WebGLRenderer } from 'three'

export interface FrameMetrics {
  fps: number
  frameMs: number
  p95FrameMs: number
  cpuSubmitMs: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
  programs: number
  samples: number
  multiDraw: boolean
}

/**
 * 面板订阅独立快照，避免性能数值更新传播到三维场景组合根。
 * 快照只在整秒采样完成或资源释放时更换，满足外部存储的稳定引用要求。
 */
let snapshot: FrameMetrics | null = null
const listeners = new Set<() => void>()
export const getFrameMetrics = () => snapshot
export function subscribeFrameMetrics(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publishFrameMetrics(metrics: FrameMetrics | null) {
  snapshot = metrics
  listeners.forEach((listener) => listener())
}

declare global {
  interface Window { __AGV_PERFORMANCE__?: FrameMetrics }
}

export function createFrameDiagnostics(renderer: WebGLRenderer) {
  const exposeGlobal = new URLSearchParams(window.location.search).get('perf') === '1'
  const previousAutoReset = renderer.info.autoReset
  renderer.info.autoReset = false
  const frames: number[] = []
  let startedAt = 0
  let cpuMs = 0
  let calls = 0
  let triangles = 0
  let totalMs = 0
  let published: FrameMetrics | undefined
  const multiDraw = renderer.extensions.has('WEBGL_multi_draw')
  /**
   * 切换前后台后丢弃首个间隔，避免暂停时间污染统计。
   * 正常前台的慢帧仍计入，低于四帧每秒时也能显示真实负载。
   */
  let skipInterval = true
  const resetSamples = () => {
    frames.length = 0
    cpuMs = calls = triangles = totalMs = 0
    skipInterval = true
    publishFrameMetrics(null)
  }
  document.addEventListener('visibilitychange', resetSamples)

  return {
    /**
     * 在所有业务帧回调之前重置，统计包含车辆提交与标签布局的同步耗时。
     * 该耗时不等于 GPU 执行时间；真实卡顿通过帧间隔及其百分位观察。
     */
    begin() { renderer.info.reset(); startedAt = performance.now() },
    end(delta: number) {
      if (skipInterval || delta <= 0 || !Number.isFinite(delta) || document.hidden) {
        frames.length = 0
        cpuMs = calls = triangles = totalMs = 0
        skipInterval = false
        return
      }
      const frameMs = delta * 1000
      frames.push(frameMs)
      totalMs += frameMs
      cpuMs += performance.now() - startedAt
      calls += renderer.info.render.calls
      triangles += renderer.info.render.triangles
      if (totalMs < 1000) return
      frames.sort((a, b) => a - b)
      const count = frames.length
      published = {
        fps: Math.round(count * 100000 / totalMs) / 100,
        frameMs: totalMs / count,
        p95FrameMs: frames[Math.max(0, Math.ceil(count * 0.95) - 1)],
        cpuSubmitMs: cpuMs / count,
        drawCalls: calls / count,
        triangles: triangles / count,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
        samples: count,
        multiDraw,
      }
      if (exposeGlobal) window.__AGV_PERFORMANCE__ = published
      publishFrameMetrics(published)
      frames.length = 0
      cpuMs = calls = triangles = totalMs = 0
    },
    /**
     * 资源换代恢复原统计模式，只删除本句柄发布的数据。
     * 严格模式重新挂载不会把新所有者的诊断快照误删。
     */
    dispose() {
      document.removeEventListener('visibilitychange', resetSamples)
      renderer.info.autoReset = previousAutoReset
      if (snapshot === published) publishFrameMetrics(null)
      if (window.__AGV_PERFORMANCE__ === published) delete window.__AGV_PERFORMANCE__
    },
  }
}
