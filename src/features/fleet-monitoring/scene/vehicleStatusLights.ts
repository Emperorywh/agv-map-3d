/**
 * 状态灯与地面投光共用颜色和呼吸节奏，地面光斑复用车辆实例槽位。
 * 一张解析渐变平面模拟前灯扇形照地与侧灯漫射，每批只增加一次绘制。
 * 不为每辆车分配实时光源或阴影贴图，避免车队增多时放大全场景照明成本。
 */
import * as THREE from 'three'
import type { VehiclePrimaryDisplayState } from '../model/types'

interface StatusLightStyle {
  readonly pulseHz: number
  readonly minimum: number
  readonly lamp: number
  readonly ground: number
}

/**
 * 常亮用于在线、空闲和抱闸；运行和充电缓慢呼吸，阻塞及异常加快提醒。
 * 离线与过期只留下低亮灰光，中断采用低亮蓝灰呼吸，避免沿用最后的运行色。
 */
export const STATUS_LIGHT_STYLES: Readonly<Record<VehiclePrimaryDisplayState, StatusLightStyle>> = {
  ONLINE: { pulseHz: 0, minimum: 1, lamp: 1, ground: 0.85 },
  IDLE: { pulseHz: 0, minimum: 1, lamp: 1, ground: 0.8 },
  TRAFFIC_WAIT: { pulseHz: 0.75, minimum: 0.42, lamp: 1, ground: 1 },
  EXECUTING: { pulseHz: 0.45, minimum: 0.72, lamp: 1, ground: 0.95 },
  CHARGING: { pulseHz: 0.35, minimum: 0.35, lamp: 1, ground: 0.9 },
  AVOIDING: { pulseHz: 1.4, minimum: 0.3, lamp: 1, ground: 1 },
  FAULT: { pulseHz: 2, minimum: 0.22, lamp: 1, ground: 1.15 },
  BRAKED: { pulseHz: 0, minimum: 1, lamp: 1, ground: 0.95 },
  PAUSED: { pulseHz: 0.5, minimum: 0.45, lamp: 1, ground: 0.85 },
  DISCONNECTED: { pulseHz: 0, minimum: 1, lamp: 0.22, ground: 0.16 },
  CONNECTION_BROKEN: { pulseHz: 1.1, minimum: 0.2, lamp: 0.6, ground: 0.5 },
  STALE: { pulseHz: 0, minimum: 1, lamp: 0.18, ground: 0.12 },
  UNKNOWN: { pulseHz: 0, minimum: 1, lamp: 0.3, ground: 0.2 },
}

/**
 * 平滑周期保留最低亮度，任何时刻都能识别告警车辆的位置与颜色。
 * 时间由车队唯一帧循环提供，状态切换不创建计时器或逐车 React 更新。
 */
export function statusLightBrightness(primary: VehiclePrimaryDisplayState, elapsed: number): number {
  const style = STATUS_LIGHT_STYLES[primary]
  if (style.pulseHz === 0) return 1
  return style.minimum + (1 - style.minimum) * (0.5 + 0.5 * Math.cos(elapsed * style.pulseHz * Math.PI * 2))
}

/**
 * 投光几何采用归一化车体坐标，车头为正 X，车体边界约为正负半个单位。
 * 实例矩阵按模型真实长宽缩放并跟随朝向，光斑不会在转弯时停留在旧位置。
 */
export function createStatusLightGround(): { geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } {
  const geometry = new THREE.PlaneGeometry(3, 3)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: `
      varying vec2 vGroundPosition;
      varying vec3 vLightColor;
      void main() {
        vGroundPosition = position.xz;
        vLightColor = vec3(1.0);
        vec4 worldPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          worldPosition = instanceMatrix * worldPosition;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vLightColor = instanceColor;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      varying vec2 vGroundPosition;
      varying vec3 vLightColor;
      void main() {
        /*
         * 前灯光束由窄到宽自然展开，端部与横向边缘均平滑衰减。
         * 原模型前灯位于车头边缘，侧灯形成更短的两侧漫射光。
         * 横向距离用乘法平方，避免负数幂在部分显卡上导致半侧光斑失效。
         */
        vec2 p = vGroundPosition;
        float forward = max(p.x - 0.48, 0.0);
        float beamWidth = 0.34 + forward * 0.82;
        float lateral = p.y / beamWidth;
        float beam = exp(-3.0 * lateral * lateral);
        beam *= smoothstep(0.44, 0.56, p.x) * (1.0 - smoothstep(0.6, 1.48, p.x));
        vec2 outside = max(abs(p) - vec2(0.43, 0.40), vec2(0.0));
        float distanceToBody = length(outside);
        float halo = exp(-4.2 * distanceToBody) * (1.0 - smoothstep(0.48, 0.98, distanceToBody));
        float sides = (1.0 - smoothstep(0.3, 0.68, abs(p.x)))
          * exp(-4.5 * max(abs(p.y) - 0.47, 0.0))
          * (1.0 - smoothstep(0.85, 1.45, abs(p.y)));
        float outsideBody = smoothstep(0.0, 0.09, distanceToBody);
        float opacity = min(0.72, beam * 0.6 + halo * 0.36 + sides * 0.24) * outsideBody;
        if (opacity < 0.003) discard;
        gl_FragColor = vec4(vLightColor, opacity);
        #include <colorspace_fragment>
      }
    `,
  })
  return { geometry, material }
}
