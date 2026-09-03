/**
 * 充电桩闪电贴花资源（SPEC §2.1 charge 行；视觉差距分析 P2-1/8.4）。
 *
 * 职责：两件事——
 * 1. createChargeBoltTexture：单格 Canvas 图集，绘制青色闪电多边形（深色描边
 *    保证任意桩面可读）；Canvas 2D 不可得（无头测试环境）时返回 null，由
 *    调用方降级为不创建贴花网格（缺贴花不缺充电桩语义，与地坪贴图同口径）；
 * 2. buildChargeBoltGeometry：把贴花四边形烘焙到桩身四个侧面（桩为轴对齐
 *    盒、实例矩阵只含平移），一份几何 + 一个 InstancedMesh 渲染全部贴花。
 * 边界：本模块只产出纯资源（纹理/几何）；材质、实例缓冲与释放编排归
 *       LandmarksLayer。不进 React、不感知数据源。
 * 关键不变量：
 * 1. 贴花位于桩面之外 CHARGE_BOLT_FACE_OFFSET_M，且图层为其设置更高的
 *    renderOrder——透明队列中与桩身同距离时保证后绘制，不被桩色覆盖；
 * 2. 几何挂载在原点（桩位由实例矩阵平移），底面 y=0 与桩几何同基线；
 * 3. 纹理与几何由调用方 dispose（创建一次、随图层资源清单释放）。
 */
import * as THREE from 'three'
import {
  CHARGE_BOLT_CELL_PX,
  CHARGE_BOLT_COLOR,
  CHARGE_BOLT_FACE_OFFSET_M,
  CHARGE_BOLT_HEIGHT_M,
  CHARGE_PILE_DEPTH_M,
  CHARGE_PILE_HEIGHT_M,
  CHARGE_PILE_WIDTH_M,
  NAME_STROKE_COLOR,
} from './mapAppearance'

/**
 * 闪电贴花图集：单格 Canvas（POT 边长，mipmap 友好），青色填充 + 深描边。
 * Canvas 不可用时返回 null（贴花降级为不显示，不阻断挂载）。
 */
export function createChargeBoltTexture(): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = CHARGE_BOLT_CELL_PX
  canvas.height = CHARGE_BOLT_CELL_PX
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }
  // 单位闪电多边形（画布坐标 y 向下，0..1），顶点顺序沿轮廓一周
  const points: ReadonlyArray<readonly [number, number]> = [
    [0.6, 0.05],
    [0.26, 0.56],
    [0.46, 0.56],
    [0.34, 0.95],
    [0.74, 0.42],
    [0.53, 0.42],
    [0.68, 0.05],
  ]
  ctx.beginPath()
  for (let i = 0; i < points.length; i += 1) {
    const px = points[i][0] * CHARGE_BOLT_CELL_PX
    const py = points[i][1] * CHARGE_BOLT_CELL_PX
    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }
  ctx.closePath()
  ctx.lineJoin = 'round'
  ctx.lineWidth = CHARGE_BOLT_CELL_PX * 0.05
  ctx.strokeStyle = NAME_STROKE_COLOR
  ctx.stroke()
  ctx.fillStyle = CHARGE_BOLT_COLOR
  ctx.fill()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  return texture
}

/**
 * 桩身四面闪电贴花的合并几何：贴花为方形（边长 CHARGE_BOLT_HEIGHT_M），
 * 垂直居中于桩身，分别贴在 ±x / ±z 四个立面的外侧（外扩防 z-fighting）。
 * 竖直面片顶点序保证纹理直立（flipY 纹理 v=1 在上）。
 */
export function buildChargeBoltGeometry(): THREE.BufferGeometry {
  const size = CHARGE_BOLT_HEIGHT_M
  const half = size / 2
  const centerY = CHARGE_PILE_HEIGHT_M / 2
  const yTop = centerY + half
  const yBottom = centerY - half

  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // 追加一块竖直四边形：a→b 为贴花底边（左→右），uvs 全格
  const appendFace = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): void => {
    const base = positions.length / 3
    positions.push(ax, yBottom, az, bx, yBottom, bz, bx, yTop, bz, ax, yTop, az)
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const offsetX = CHARGE_PILE_WIDTH_M / 2 + CHARGE_BOLT_FACE_OFFSET_M
  const offsetZ = CHARGE_PILE_DEPTH_M / 2 + CHARGE_BOLT_FACE_OFFSET_M
  appendFace(-half, offsetZ, half, offsetZ) // +z 面
  appendFace(half, -offsetZ, -half, -offsetZ) // -z 面
  appendFace(offsetX, half, offsetX, -half) // +x 面
  appendFace(-offsetX, -half, -offsetX, half) // -x 面

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}
