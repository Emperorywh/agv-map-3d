/**
 * WebGL 能力探测（SPEC §10：WebGL 不可用 → 浏览器不支持说明页）。
 * three 0.185 渲染需要 WebGL2；探测抛错或上下文创建失败均视为不支持。
 */
export function isWebGLSupported(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl2') !== null
  } catch {
    return false
  }
}
