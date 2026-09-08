"""在真实 Blender 中重新导入 GLB，核对导出前后车辆结构。
使用数值检查与重新渲染共同验证，结果保存在独立验证文件中。
"""
import bpy
import bmesh
import json
import math
import struct
import hashlib
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
bpy.ops.wm.open_mainfile(filepath=str(OUT / 'agv_design1.blend'))
scene = bpy.context.scene


def bounds(objects):
    """根据求值后的真实网格计算世界包围盒。
    这样倒角、父节点和坐标转换都会参与检查。
    """
    points = []
    dg = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type == 'MESH':
            evaluated = obj.evaluated_get(dg)
            evaluated_mesh = evaluated.to_mesh()
            points.extend(evaluated.matrix_world @ v.co for v in evaluated_mesh.vertices)
            evaluated.to_mesh_clear()
    low = [min(v[i] for v in points) for i in range(3)]
    high = [max(v[i] for v in points) for i in range(3)]
    return {'min': low, 'max': high, 'size': [high[i] - low[i] for i in range(3)]}


source = list(bpy.data.collections['AGV_Design1_Asset'].objects)
source_bounds = bounds(source)
source_names = sorted(o.name for o in source if o.type == 'MESH')
source_parts = {o.name: bounds([o]) for o in source if o.type == 'MESH'}
source_wheels = {o.name: list(o.matrix_world.translation) for o in source if o.name.startswith('Wheel_') and o.get('wheel_role')}
source_leds = sorted(o.name for o in source if o.name.startswith('LED_'))
for obj in source:
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(OUT / 'agv_design1.glb'))
imported_root = bpy.data.objects['AGV_Design1_ROOT']
imported = [imported_root, *imported_root.children_recursive]
imported_names = sorted(o.name for o in imported if o.type == 'MESH')
imported_bounds = bounds(imported)
errors = []
expanded_names = []
for obj in imported:
    if obj.type == 'MESH':
        expanded_names.extend(json.loads(obj['source_parts_json']) if obj.get('source_parts_json') else [obj.name])
if source_names != sorted(expanded_names):
    errors.append({'missing_parts': sorted(set(source_names) - set(expanded_names)), 'extra_parts': sorted(set(expanded_names) - set(source_names))})
max_part_error = 0
for obj in imported:
    if obj.type != 'MESH':
        continue
    previous = source_parts.get(obj.name)
    if obj.get('source_parts_json'):
        parts = [source_parts[name] for name in json.loads(obj['source_parts_json'])]
        previous = {'min': [min(p['min'][i] for p in parts) for i in range(3)],
                    'max': [max(p['max'][i] for p in parts) for i in range(3)]}
    if previous:
        after = bounds([obj])
        max_part_error = max(max_part_error, *(abs(a - b) for key in ('min', 'max') for a, b in zip(previous[key], after[key])))
if max_part_error > .00001:
    errors.append({'part_bounds_drift': max_part_error})
for name, position in source_wheels.items():
    actual = bpy.data.objects[name]
    if (actual.matrix_world.translation - Vector(position)).length > .00001:
        errors.append({'wheel_origin_drift': name})
if imported_root.location.length > 1e-7 or any(abs(v - 1) > 1e-7 for v in imported_root.scale):
    errors.append('根节点位置或比例异常')
for name in source_leds:
    obj = bpy.data.objects.get(name)
    if obj is None or not obj.data.materials:
        errors.append('灯带或灯带材质丢失：' + name)
        continue
    material = obj.data.materials[0]
    node = material.node_tree.nodes.get('Principled BSDF')
    if node.inputs['Emission Strength'].default_value <= 0:
        errors.append('灯带发光强度为零：' + name)

# 二进制层检查限定为车辆数据：无外部贴图、相机、摄影灯光和布景。
# 同时读取三角形数和材质数，记录网页加载的实际资产规模。
raw = (OUT / 'agv_design1.glb').read_bytes()
magic, version, total = struct.unpack_from('<4sII', raw, 0)
length, kind = struct.unpack_from('<I4s', raw, 12)
gltf = json.loads(raw[20:20 + length])
triangles = 0
for m in gltf.get('meshes', []):
    for primitive in m['primitives']:
        accessor = gltf['accessors'][primitive['indices']]
        triangles += accessor['count'] // 3
if magic != b'glTF' or version != 2 or total != len(raw):
    errors.append('GLB 二进制头部异常')
if gltf.get('cameras') or 'KHR_lights_punctual' in gltf.get('extensions', {}):
    errors.append('包含摄影相机或灯光')
if gltf.get('images') or gltf.get('textures'):
    errors.append('出现非预期贴图')
if any('STUDIO' in n.get('name', '') or n.get('name', '').startswith('Camera_') for n in gltf['nodes']):
    errors.append('包含摄影棚节点')
invalid_vertices = 0
for obj in imported:
    if obj.type == 'MESH':
        invalid_vertices += sum(not all(math.isfinite(v) for v in vert.co) for vert in obj.data.vertices)
if invalid_vertices:
    errors.append({'invalid_vertices': invalid_vertices})
report = {'status': 'PASS' if not errors else 'FAIL', 'errors': errors,
          'source_bounds_blender_m': source_bounds, 'reimport_bounds_blender_m': imported_bounds,
          'maximum_part_bounds_drift_m': max_part_error, 'source_parts_matched': len(expanded_names),
          'export_mesh_count': len(imported_names),
          'wheel_origins_blender_m': source_wheels, 'led_nodes': source_leds,
          'triangles': triangles, 'glb_nodes': len(gltf['nodes']), 'materials': len(gltf['materials']),
          'glb_bytes': len(raw), 'external_textures': 0, 'cameras_exported': 0, 'lights_exported': 0,
          'glb_sha256': hashlib.sha256(raw).hexdigest(),
          'extensions_used': gltf.get('extensionsUsed', [])}
(OUT / 'validation_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
scene.camera = bpy.data.objects['Camera_front_right']
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'validation_reimport.blend'))
scene.cycles.samples = 24
scene.render.resolution_x = 900
scene.render.resolution_y = 1100
scene.render.filepath = str(OUT / 'previews' / 'reimport_front_right.png')
bpy.ops.render.render(write_still=True)
print(json.dumps(report, ensure_ascii=False, indent=2))
if errors:
    raise RuntimeError('GLB 验证失败，详情参阅 validation_report.json')
