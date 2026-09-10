"""
从交付原模型生成充电塔和货架的中远景资产，原始文件保持不变。
每档重新导入并保留材质、贴图、层级和米制变换，车载与地面货架共用派生文件。
"""
import json
import sys
from pathlib import Path
import bpy

root = Path(__file__).resolve().parent.parent
sources = [
    root / 'assets/agv_charge_tower_20260907_01/agv_charge_tower.glb',
    root / 'assets/agv_shelf_20260907_01/shelf_empty.glb',
    root / 'assets/agv_shelf_20260907_01/shelf_loaded.glb',
]
"""
允许在 Blender 的双横线之后指定资产名称，只重建本次替换的模型。
不传名称时保留原来的全量行为，指定名称不会改写其他设施的派生文件。
"""
selected = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if selected:
    unknown = set(selected) - {source.stem for source in sources}
    if unknown:
        raise ValueError('未知设施资产：' + ', '.join(sorted(unknown)))
    sources = [source for source in sources if source.stem in selected]
report = []
for source in sources:
    for level, ratio in [(1, 0.22), (2, 0.055)]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(source))
        reduced = {}
        for obj in list(bpy.context.scene.objects):
            if obj.type != 'MESH':
                continue
            identity = obj.data.as_pointer()
            if identity in reduced:
                obj.data = reduced[identity]
                continue
            triangles = sum(len(face.vertices) - 2 for face in obj.data.polygons)
            # 标签、灯面和低面数水晶保持完整；复杂部件保留最低面数以维持轮廓。
            # 同源部件只处理一次，修改器只作用于副本，避免多实例网格相互污染。
            crystal = any(material and material.name == 'Crystal_Blue_Translucent' for material in obj.data.materials)
            if triangles > 80 and not crystal:
                original_mesh = obj.data
                original_counts = {}
                for face in original_mesh.polygons:
                    original_counts[face.material_index] = original_counts.get(face.material_index, 0) + len(face.vertices) - 2
                bpy.context.view_layer.objects.active = obj
                obj.select_set(True)
                current_ratio = max(ratio, 48 / triangles)
                # 同一个网格上的小材质分区可能被整体减面吞掉，逐步提高该网格的保留率。
                # 每次从原网格重新处理，确保装饰金属、灯面和标签至少保留可辨认的面。
                while True:
                    obj.data = original_mesh.copy()
                    if current_ratio >= 1:
                        break
                    modifier = obj.modifiers.new('设施中远景减面', 'DECIMATE')
                    modifier.ratio = current_ratio
                    modifier.use_collapse_triangulate = True
                    bpy.ops.object.modifier_apply(modifier=modifier.name)
                    counts = {}
                    for face in obj.data.polygons:
                        counts[face.material_index] = counts.get(face.material_index, 0) + len(face.vertices) - 2
                    if all(counts.get(material, 0) >= min(12, count) for material, count in original_counts.items()):
                        break
                    current_ratio = min(1, current_ratio * 2)
                obj.select_set(False)
            obj.data.validate(clean_customdata=False)
            obj.data.update()
            reduced[identity] = obj.data
        output = source.with_name(f'{source.stem}_LOD{level}.glb')
        bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_animations=False, export_cameras=False, export_lights=False)
        triangles = sum(sum(len(face.vertices) - 2 for face in obj.data.polygons) for obj in bpy.context.scene.objects if obj.type == 'MESH')
        report.append({'file': str(output.relative_to(root)), 'triangles': triangles, 'bytes': output.stat().st_size})
print('FACILITY_LOD_RESULT=' + json.dumps(report))
