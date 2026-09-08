/**
 * 用当前项目真实安装的 Three.js 加载 GLB。
 * 校验坐标、材质、独立灯带及车轮旋转原点，避免只检查 Blender 内部结果。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bytes = await fs.readFile(path.join(dir, 'agv_design1.glb'));
const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().parseAsync(array, '');
const vehicle = gltf.scene.getObjectByName('AGV_Design1_ROOT');
if (!vehicle) throw new Error('整车根节点丢失');
gltf.scene.updateMatrixWorld(true);
const bbox = new Box3().setFromObject(vehicle, true);
const meshes = [], lights = [], wheels = [], materials = new Set();
vehicle.traverse(object => {
  if (object.isMesh) {
    meshes.push(object.name);
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    materialList.forEach(material => materials.add(material.uuid));
  }
  if (object.name.startsWith('LED_')) {
    if (!object.material?.emissive || object.material.emissiveIntensity <= 0) throw new Error('灯带材质无效');
    lights.push({ name: object.name, material: object.material.name, intensity: object.material.emissiveIntensity });
  }
  if (object.name.startsWith('Wheel_') && (object.userData.wheel_role || object.name === 'Wheel_Aux_Front_Center')) {
    wheels.push({ name: object.name, worldOrigin: object.getWorldPosition(new Vector3()).toArray() });
  }
});
if (lights.length !== 5 || wheels.length !== 7) throw new Error('独立灯带或轮组数量异常');
if (Math.abs(bbox.min.y) > 0.001 || Math.abs(bbox.max.y - 1.64) > 0.001) throw new Error('地面原点或总高异常');
const mast = vehicle.getObjectByName('Mast_Main_Column');
const mastCenter = new Box3().setFromObject(mast).getCenter(new Vector3());
if (mastCenter.z <= 0) throw new Error('车头未朝向 glTF 正 Z');
const report = { status: 'PASS', loader: '项目已安装的 Three.js GLTFLoader',
  glbSha256: createHash('sha256').update(bytes).digest('hex'),
  boundsGltfMeters: { min: bbox.min.toArray(), max: bbox.max.toArray(), size: bbox.getSize(new Vector3()).toArray() },
  rootPosition: vehicle.position.toArray(), rootScale: vehicle.scale.toArray(),
  meshCount: meshes.length, materialCount: materials.size, lights, wheels,
  front: '+Z', up: '+Y', wheelRotationAxis: 'local X' };
await fs.writeFile(path.join(dir, 'three_validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
