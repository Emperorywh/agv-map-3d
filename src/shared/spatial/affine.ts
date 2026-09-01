/**
 * 业务无关二维仿射变换（SPEC §2.5、§12.2 shared/spatial；TASK-003）。
 *
 * 职责：按固定顺序的仿射参数把平面坐标映射为另一平面坐标，并给出平面内
 *       「数学方向角」经同一仿射后的像；后端坐标系差异（缩放、旋转、镜像、
 *       平移）只通过参数表达，地图、车辆、交通矩形必须共用同一实现。
 * 边界：纯数学函数，不含任何 AGV 业务语义；不涉及 Three.js 世界轴映射
 *       （平面坐标 → 世界坐标由 worldTransform.ts 负责）。
 * 关键不变量：
 * 1. 变换顺序固定为「镜像 Y → 旋转 → 缩放 → 平移」；该顺序是跨模块合同，
 *    测试基准值与所有调用方都必须遵守，不得局部调换；
 * 2. scale 必须为正有限（翻转语义由 mirrorY 表达，禁止负 scale），rotation
 *    与平移量必须有限——构造时即拒绝非法参数，保证有限输入必得有限输出；
 * 3. transformAngle 只在平面内换算方向角：先镜像（θ → -θ）再加旋转
 *    （+rotation）；「平面角 → 世界 rotation.y」的符号翻转属于世界映射层。
 */

/** 仿射参数（与运行时配置 coordinateTransform 字段同构，但无业务含义） */
export interface AffineParams {
  scale: number
  rotation: number
  mirrorY: boolean
  translateX: number
  translateY: number
}

/** 平面内的点（单位与业务无关） */
export interface PlanePoint {
  x: number
  y: number
}

export interface PlaneTransform {
  /** 点映射：先镜像 Y，再旋转，再缩放，最后平移（顺序见模块不变量 1） */
  transformPoint(x: number, y: number): PlanePoint
  /** 平面内数学方向角（0 指向 +x，逆时针为正）经同一仿射后的方向角 */
  transformAngle(theta: number): number
}

/** 恒等仿射参数：scale=1、无旋转、不镜像、无平移 */
export const IDENTITY_AFFINE: AffineParams = {
  scale: 1,
  rotation: 0,
  mirrorY: false,
  translateX: 0,
  translateY: 0,
}

export function createPlaneTransform(params: AffineParams): PlaneTransform {
  if (!Number.isFinite(params.scale) || params.scale <= 0) {
    throw new RangeError(`仿射 scale 必须为正有限数值，收到 ${params.scale}`)
  }
  if (!Number.isFinite(params.rotation)) {
    throw new RangeError(`仿射 rotation 必须为有限数值，收到 ${params.rotation}`)
  }
  if (!Number.isFinite(params.translateX) || !Number.isFinite(params.translateY)) {
    throw new RangeError('仿射平移量必须为有限数值')
  }
  const cos = Math.cos(params.rotation)
  const sin = Math.sin(params.rotation)
  const { scale, translateX, translateY, mirrorY, rotation } = params
  return {
    transformPoint(x, y) {
      if (mirrorY) {
        y = -y
      }
      const rx = x * cos - y * sin
      const ry = x * sin + y * cos
      return { x: rx * scale + translateX, y: ry * scale + translateY }
    },
    transformAngle(theta) {
      return (mirrorY ? -theta : theta) + rotation
    },
  }
}
