/**
 * 状态灯与地面投光共用颜色和呼吸节奏，地面光斑复用车辆实例槽位。
 * 一张解析渐变平面模拟前后双灯光束、近车光池与侧灯漫射，每批只增加一次绘制。
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
 * 在线与空闲保持强光常亮，运行和充电缓慢呼吸，阻塞及异常加快提醒。
 * 异常的业务色为深红，单独补偿发光能量，让深色也能越过光晕提取阈值。
 * 离线与过期仍压低亮度，中断保留蓝灰呼吸，避免沿用最后的运行色。
 */
export const STATUS_LIGHT_STYLES: Readonly<Record<VehiclePrimaryDisplayState, StatusLightStyle>> = {
  ONLINE: { pulseHz: 0, minimum: 1, lamp: 1.45, ground: 1.7 },
  IDLE: { pulseHz: 0, minimum: 1, lamp: 1.5, ground: 1.8 },
  TRAFFIC_WAIT: { pulseHz: 0.75, minimum: 0.52, lamp: 1.8, ground: 2.1 },
  EXECUTING: { pulseHz: 0.45, minimum: 0.76, lamp: 1.7, ground: 2 },
  CHARGING: { pulseHz: 0.35, minimum: 0.48, lamp: 1.65, ground: 1.9 },
  AVOIDING: { pulseHz: 1.4, minimum: 0.42, lamp: 1.8, ground: 2.1 },
  FAULT: { pulseHz: 2, minimum: 0.38, lamp: 12, ground: 14 },
  BRAKED: { pulseHz: 0, minimum: 1, lamp: 1.8, ground: 2 },
  PAUSED: { pulseHz: 0.5, minimum: 0.58, lamp: 1.6, ground: 1.9 },
  DISCONNECTED: { pulseHz: 0, minimum: 1, lamp: 0.28, ground: 0.3 },
  CONNECTION_BROKEN: { pulseHz: 1.1, minimum: 0.3, lamp: 1.15, ground: 1.2 },
  STALE: { pulseHz: 0, minimum: 1, lamp: 0.2, ground: 0.18 },
  UNKNOWN: { pulseHz: 0, minimum: 1, lamp: 0.4, ground: 0.4 },
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
 * 五倍车体范围容纳更远的柔光，实例矩阵继续跟随真实长宽、位置与朝向。
 */
export function createStatusLightGround(): { geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } {
  const geometry = new THREE.PlaneGeometry(5, 5)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    /**
     * 在浅色地坪上混合饱和灯色，光束中心仍输出高动态范围能量供光晕提取。
     * 避免纯加色把红、黄等业务配色全部冲成白色，同时保留边缘的透明衰减。
     */
    blending: THREE.NormalBlending,
    toneMapped: false,
    vertexShader: `
      /*
       * 自定义投光也使用场景的深度编码，避免开启对数深度后被地坪错误遮挡。
       * 普通深度模式下这些片段由宏关闭，设备样板仍可共用同一材质。
       */
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #include <batching_pars_vertex>
      varying vec2 vGroundPosition;
      varying vec3 vLightColor;
      void main() {
        /*
         * 多绘制批次从数据纹理读取当前实例矩阵和颜色，保留原照地形状与呼吸节奏。
         * 普通实例路径继续可用，两种方式都在世界变换前应用局部车辆位姿。
         */
        #include <batching_vertex>
        vGroundPosition = position.xz;
        vLightColor = vec3(1.0);
        vec4 worldPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          worldPosition = instanceMatrix * worldPosition;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vLightColor = instanceColor;
        #endif
        #ifdef USE_BATCHING
          worldPosition = batchingMatrix * worldPosition;
        #endif
        #ifdef USE_BATCHING_COLOR
          vLightColor = getBatchingColor(getIndirectIndex(gl_DrawID)).rgb;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      /*
       * 即使关闭深度写入，深度测试仍必须与地坪采用相同的对数深度值。
       * 接续顶点阶段输出，保持光斑与车体的正确遮挡关系。
       */
      #include <logdepthbuf_pars_fragment>
      varying vec2 vGroundPosition;
      varying vec3 vLightColor;
      void main() {
        /*
         * 设计一前后各有两段车身灯，四束光从车体边缘向外逐渐展开并融合。
         * 光束、近车光池和两侧柔光各自衰减，边界在几何范围内完全淡出。
         * 横向距离用乘法平方，避免负数幂在部分显卡上导致半侧光斑失效。
         */
        vec2 p = vGroundPosition;
        float forward = max(abs(p.x) - 0.46, 0.0);
        float beamWidth = 0.12 + forward * 0.62;
        float left = (p.y - 0.29) / beamWidth;
        float right = (p.y + 0.29) / beamWidth;
        float beam = min(1.0, exp(-2.5 * left * left) + exp(-2.5 * right * right));
        beam *= smoothstep(0.42, 0.55, abs(p.x)) * (1.0 - smoothstep(0.85, 2.4, abs(p.x)));
        vec2 outside = max(abs(p) - vec2(0.43, 0.40), vec2(0.0));
        float distanceToBody = length(outside);
        float halo = exp(-2.6 * distanceToBody) * (1.0 - smoothstep(0.95, 1.9, distanceToBody));
        float sides = (1.0 - smoothstep(0.3, 0.85, abs(p.x)))
          * exp(-2.3 * max(abs(p.y) - 0.44, 0.0))
          * (1.0 - smoothstep(1.3, 2.4, abs(p.y)));
        float outsideBody = smoothstep(0.0, 0.07, distanceToBody);
        /*
         * 加强近车彩色光池，前后光束保持较长的渐变尾部，形成明显的照地范围。
         * 低亮状态同步降低覆盖率，离线时地面自然淡出，避免出现不透明的灰色贴片。
         * 超亮能量集中在车身边缘，远处光束保留饱和色，防止蓝光被光晕冲成白色。
         */
        float energy = max(vLightColor.r, max(vLightColor.g, vLightColor.b));
        float opacity = min(0.84, beam * 0.72 + halo * 0.76 + sides * 0.5) * outsideBody;
        opacity *= smoothstep(0.0, 0.75, energy);
        if (opacity < 0.003) discard;
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(vLightColor * (0.72 + exp(-10.0 * distanceToBody) * 0.65), opacity);
        #include <colorspace_fragment>
      }
    `,
  })
  return { geometry, material }
}
