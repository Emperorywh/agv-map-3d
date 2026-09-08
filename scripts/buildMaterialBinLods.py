"""
为库区料箱生成独立的中远景资产，原始交付模型保持不变。
箱体和胶带按局部包围盒重建，托盘减面保留叉孔、木板轮廓与原有贴图。
运行：blender --background --python-exit-code 1 --python scripts/buildMaterialBinLods.py
"""
import json
from pathlib import Path
import bpy
from mathutils import Vector

root = Path(__file__).resolve().parent.parent
source = root / 'assets/shelf_20260908_01/shelf.glb'
report = []
for level, ratio in [(1, 0.15), (2, 0.05)]:
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
        materials = list(obj.data.materials)
        pallet = any(material and material.name == '3d66-CoronaLegacyMtl-18517304-092' for material in materials)
        if pallet:
            # 托盘按原拓扑减面，保留空隙与 UV，避免用实心长方体堵住叉孔。
            # 每档从原网格独立生成，原始资产和其他共享实例不会被修改。
            obj.data = obj.data.copy()
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            modifier = obj.modifiers.new('料箱托盘距离减面', 'DECIMATE')
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            obj.select_set(False)
        else:
            # 纸箱与胶带保留各自局部包围盒及对象变换，不改变堆叠位置与朝向。
            # 使用外向绕序的六个面，导出时由 glTF 三角化，近景继续使用原模型。
            corners = [Vector(corner) for corner in obj.bound_box]
            lower = [min(corner[axis] for corner in corners) for axis in range(3)]
            upper = [max(corner[axis] for corner in corners) for axis in range(3)]
            vertices = [(x, y, z) for z in (lower[2], upper[2]) for y in (lower[1], upper[1]) for x in (lower[0], upper[0])]
            faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
            mesh = bpy.data.meshes.new(f'{obj.data.name}_LOD{level}')
            mesh.from_pydata(vertices, [], faces)
            # 原资产所有材质分区都带 UV，低模补齐同样的顶点布局以兼容批内切档。
            # 纸箱与胶带没有颜色贴图，各面使用独立方形 UV，托盘继续保留原始 UV。
            uv = mesh.uv_layers.new(name='UVMap')
            for face in mesh.polygons:
                for loop, coordinate in zip(face.loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                    uv.data[loop].uv = coordinate
            for material in materials:
                mesh.materials.append(material)
            obj.data = mesh
        obj.data.validate(clean_customdata=False)
        obj.data.update()
        reduced[identity] = obj.data
    output = source.with_name(f'{source.stem}_LOD{level}.glb')
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_animations=False, export_cameras=False, export_lights=False)
    triangles = sum(sum(len(face.vertices) - 2 for face in obj.data.polygons) for obj in bpy.context.scene.objects if obj.type == 'MESH')
    report.append({'file': str(output.relative_to(root)), 'triangles': triangles, 'bytes': output.stat().st_size})
print('MATERIAL_BIN_LOD_RESULT=' + json.dumps(report))
