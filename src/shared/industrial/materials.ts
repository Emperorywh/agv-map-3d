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

export function createStatusMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.65, roughness: 0.34 })
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance *= vColor.rgb;
      #endif
    `)
  }
  material.customProgramCacheKey = () => 'industrial-status-instance-v1'
  return material
}
