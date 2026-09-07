/**
 * 使用当前项目实际安装的 Three.js 加载成品 GLB。
 * 仅核对资产加载、坐标和材质属性，不改动业务代码或创建单元测试。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3, REVISION } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const file = new URL('./agv_charge_tower.glb', import.meta.url);
const buffer = await readFile(file);
const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const gltf = await new GLTFLoader().parseAsync(array, '');
gltf.scene.updateMatrixWorld(true);
const box = new Box3().setFromObject(gltf.scene);
const materials = new Map();
let meshes = 0;
let triangles = 0;
let cameras = 0;
let lights = 0;
gltf.scene.traverse((object) => {
  /**
   * GLTFLoader 会按材质拆分绘制网格，因此这里的网格数量
   * 可大于 Blender 命名部件数，三角形总数应保持相同。
   */
  if (object.isCamera) cameras += 1;
  if (object.isLight) lights += 1;
  if (!object.isMesh) return;
  meshes += 1;
  triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  const list = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of list) {
    materials.set(material.name, {
      name: material.name,
      type: material.type,
      transparent: material.transparent,
      opacity: material.opacity,
      transmission: material.transmission ?? 0,
      emissive: material.emissive.toArray(),
      emissiveIntensity: material.emissiveIntensity,
    });
  }
});
const report = {
  three_revision: REVISION,
  file: fileURLToPath(file),
  loaded: true,
  dimensions_xyz_m: box.getSize(new Vector3()).toArray(),
  bounds_min: box.min.toArray(),
  bounds_max: box.max.toArray(),
  meshes,
  triangles,
  cameras,
  lights,
  materials: [...materials.values()],
  renderer_checked: false,
  note: '已用项目安装的 GLTFLoader 实际加载；没有在目标业务场景运行 WebGL 渲染或性能压测。',
};
await writeFile(new URL('./threejs_validation.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
