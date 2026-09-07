/**
 * 资产登记倒影专用材质，地面采集前替换，采集结束或异常时恢复原材质。
 * 弱引用不延长模型生命周期；实际材质始终由创建它的资产句柄释放。
 */
import type { Material, Mesh } from 'three'

const materials = new WeakMap<Mesh, Material>()
export function setReflectionMaterial(mesh: Mesh, material: Material) { materials.set(mesh, material) }
export function getReflectionMaterial(mesh: Mesh) { return materials.get(mesh) }
