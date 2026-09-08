/**
 * 喷漆、底盘、橡胶和金属各自保持固定物理材质，业务状态不能改写这些表面。
 * 状态灯使用共享受光材质，在着色器中以实例色同时调制基础色和发光色。
 */
import * as THREE from 'three'

export function createIndustrialMaterials() {
  return {
    paint: new THREE.MeshStandardMaterial({ color: '#d0d5d6', roughness: 0.43, metalness: 0.10 }),
    chassis: new THREE.MeshStandardMaterial({ color: '#30363c', roughness: 0.67, metalness: 0.30 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#15181b', roughness: 0.88, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: '#78838a', roughness: 0.41, metalness: 0.72 }),
    platform: new THREE.MeshStandardMaterial({ color: '#383f44', roughness: 0.81, metalness: 0.12 }),
    wood: new THREE.MeshStandardMaterial({ color: '#aa8657', roughness: 0.93, metalness: 0 }),
    cardboard: new THREE.MeshStandardMaterial({ color: '#b68d59', roughness: 0.94, metalness: 0 }),
    tape: new THREE.MeshStandardMaterial({ color: '#c7aa79', roughness: 0.61, metalness: 0 }),
  }
}

/**
 * 灯面以高强度自发光为主，明显越过场景光晕阈值，形成灯芯与外围柔光。
 * 减弱环境反射，避免白色照明冲淡不同状态的颜色，亮度由各车辆状态独立调节。
 * 关闭灯面的色调压缩，实例亮度与地面投光使用同一状态颜色和动画包络。
 * 同时读取普通实例色和多绘制批次色，切换剔除实现后状态灯保持原有颜色。
 */
export function createStatusMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 3.2, roughness: 0.34, toneMapped: false })
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        totalEmissiveRadiance *= vColor.rgb;
      #endif
    `)
  }
  material.customProgramCacheKey = () => 'industrial-status-instance-v2'
  return material
}
