/**
 * 显式通过网址参数 perf=1 开启完整帧采样，默认没有统计或控制台刷屏开销。
 * 主画面、阴影、透射、反射及后处理统一累计，避免只读取最后一个通道的数据。
 */
import type { WebGLRenderer } from 'three'

interface FrameMetrics {
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

declare global {
  interface Window { __AGV_PERFORMANCE__?: FrameMetrics }
}

export function createFrameDiagnostics(renderer: WebGLRenderer) {
  if (new URLSearchParams(window.location.search).get('perf') !== '1') return null
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

  return {
    /**
     * 在所有业务帧回调之前重置，统计包含车辆提交与标签布局的同步耗时。
     * 该耗时不等于 GPU 执行时间；真实卡顿通过帧间隔及其百分位观察。
     */
    begin() { renderer.info.reset(); startedAt = performance.now() },
    end(delta: number) {
      if (delta <= 0 || delta > 0.25) {
        frames.length = 0
        cpuMs = calls = triangles = totalMs = 0
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
      window.__AGV_PERFORMANCE__ = published
      frames.length = 0
      cpuMs = calls = triangles = totalMs = 0
    },
    /**
     * 资源换代恢复原统计模式，只删除本句柄发布的数据。
     * 严格模式重新挂载不会把新所有者的诊断快照误删。
     */
    dispose() {
      renderer.info.autoReset = previousAutoReset
      if (window.__AGV_PERFORMANCE__ === published) delete window.__AGV_PERFORMANCE__
    },
  }
}
