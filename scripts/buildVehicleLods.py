"""
使用 Blender 后台生成车辆中远景资产，原始精修模型始终保留。
每档重新导入原文件，保留材质名、层级、米制坐标和发光分区，避免累积减面误差。
运行：blender --background --python scripts/buildVehicleLods.py
"""
import json
from pathlib import Path
import bpy

root = Path(__file__).resolve().parent.parent
source = root / 'public/models/AGV_FUTURE.glb'
report = []
for level, ratio in [(1, 0.22), (2, 0.055)]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    # 按共享网格处理一次，车轮等复用部件仍然共享同一份低模。
    # 灯带和小零件保留最低面数，避免远景丢失状态颜色及车头识别特征。
    reduced = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != 'MESH':
            continue
        identity = obj.data.as_pointer()
        if identity in reduced:
            obj.data = reduced[identity]
            continue
        triangles = sum(len(face.vertices) - 2 for face in obj.data.polygons)
        if triangles > 80:
            # 修改器只能应用到单用户数据；先复制再让同源实例复用处理结果。
            # 原网格仍由尚未处理的实例持有，指针键在本轮遍历期间保持有效。
            obj.data = obj.data.copy()
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            modifier = obj.modifiers.new('监控场景距离减面', 'DECIMATE')
            modifier.ratio = max(ratio, 48 / triangles)
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            obj.select_set(False)
        # 减面可能产生重复或退化面，导出前清理几何拓扑并保留可用法线数据。
        # 该清理只作用于派生资产，不回写原始 GLB。
        obj.data.validate(clean_customdata=False)
        obj.data.update()
        reduced[identity] = obj.data
    output = root / f'public/models/AGV_FUTURE_LOD{level}.glb'
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_animations=False, export_cameras=False, export_lights=False)
    triangles = sum(sum(len(face.vertices) - 2 for face in obj.data.polygons) for obj in bpy.context.scene.objects if obj.type == 'MESH')
    report.append({'level': level, 'ratio': ratio, 'triangles': triangles, 'bytes': output.stat().st_size})
print('LOD_RESULT=' + json.dumps(report))
