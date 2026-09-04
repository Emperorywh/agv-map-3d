"""
重新导入实际交付的 GLB，核对真实几何、材质、命名和坐标约定。
摄影棚仅在内存中创建用于预览，不会保存进最终模型或重新导出。
"""

import bpy
import bmesh
import json
import math
import sys
from pathlib import Path
from mathutils import Vector


HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
GLB = PROJECT/'public'/'models'/'AGV_FUTURE.glb'
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(GLB))
objects = list(bpy.context.scene.objects)
meshes = [obj for obj in objects if obj.type == 'MESH']
points = [obj.matrix_world@Vector(v) for obj in meshes for v in obj.bound_box]
low = [min(p[i] for p in points) for i in range(3)]
high = [max(p[i] for p in points) for i in range(3)]
triangles = 0
issues = []
normals = []
for obj in meshes:
    obj.data.calc_loop_triangles()
    triangles += len(obj.data.loop_triangles)
    if not all(math.isfinite(v) for vertex in obj.data.vertices for v in vertex.co):
        issues.append(obj.name+': 顶点数值异常')
    if not all(abs(v-1)<1e-6 for v in obj.scale):
        issues.append(obj.name+': 缩放不为一')
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # glTF 为材质和法线拆分顶点；仅在检查副本中焊接重合顶点。
    # 不修改交付模型，也不会把不同部件在空间上的接触焊成整体。
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
    boundaries = sum(1 for edge in bm.edges if edge.is_boundary)
    nonmanifold = sum(1 for edge in bm.edges if not edge.is_manifold)
    volume = bm.calc_volume(signed=True)
    normals.append({'name':obj.name,'boundary_edges':boundaries,'nonmanifold_edges':nonmanifold,'signed_volume':volume})
    if volume < -1e-9:
        issues.append(obj.name+': 整体法线反向')
    bm.free()
root = bpy.data.objects.get('AGV_ROOT')
required = ['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR','LiDAR_Top',
            'Light_Front_Main','Light_Side_L','Light_Side_R','Light_Rear_Wrap_L','Light_Rear_Wrap_R','Light_LiDAR_Ring']
for name in required:
    if not bpy.data.objects.get(name):
        issues.append(name+': 缺少独立控制节点')
if not root or root.location.length > 1e-6:
    issues.append('AGV_ROOT 原点不正确')
if any(obj.type in ('CAMERA','LIGHT') for obj in objects):
    issues.append('导出包含摄影棚对象')
if not 20000 <= triangles <= 60000:
    issues.append('三角形数不符合预算')
report = {'reimported':True,'passed':not issues,'triangles':triangles,'objects_including_root':len(objects),
          'mesh_objects':len(meshes),'materials':len(bpy.data.materials),
          'dimensions_blender_xyz':[high[i]-low[i] for i in range(3)],'bounds_min':low,'bounds_max':high,
          'issues':issues,'topology':normals,'required_nodes':required}
(HERE/'blender_validation.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
print('REIMPORT_VALIDATION',json.dumps({k:v for k,v in report.items() if k != 'topology'}),flush=True)
if issues:
    raise RuntimeError('GLB 检查未通过')


def aim(obj, target):
    """
    统一将相机与面光源朝向车体中心，检查前、侧和顶部的结构连续性。
    摄影棚对象在验证完成后才创建，因此不会计入资产统计。
    """
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def area(name, loc, energy, color, size, target=(0,0,.15), size_y=None):
    """
    大尺寸面光源提供可读的金属边缘高光，不改变资产的 PBR 参数。
    该灯光只用于本地图片检查，完全不写入 GLB。
    """
    data = bpy.data.lights.new(name,'AREA')
    data.energy = energy
    data.color = color
    data.shape = 'RECTANGLE'
    data.size = size
    data.size_y = size_y or size
    obj = bpy.data.objects.new(name,data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = loc
    aim(obj,target)
    return obj


"""
使用实际导入的 glTF 材质生成前后两张预览，避免只检查 Blender 源场景。
光晕只存在于检查图片的合成器，不会烘焙到任何资产材质。
"""
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1440
scene.render.resolution_y = 1024
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.world = bpy.data.worlds.new('Preview_World')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.22,.27,.35,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .4
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002))
ground = bpy.context.object
ground.name = 'PREVIEW_ONLY_Ground'
mat = bpy.data.materials.new('PREVIEW_ONLY_Ground_Material')
mat.diffuse_color = (.025,.032,.046,1)
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Base Color'].default_value = (.025,.032,.046,1)
bsdf.inputs['Metallic'].default_value = .23
bsdf.inputs['Roughness'].default_value = .34
ground.data.materials.append(mat)
area('PREVIEW_ONLY_Key',(-2.6,-1.6,3.4),430,(.81,.89,1.0),3.1,size_y=2.4)
area('PREVIEW_ONLY_Side',(2.8,.4,2.0),360,(.63,.78,1.0),2.8,size_y=1.7)
area('PREVIEW_ONLY_Rim',(-.7,3.0,3.6),600,(.85,.91,1.0),2.6,size_y=1.2)
area('PREVIEW_ONLY_Front',(0,-3.2,1.0),90,(.92,.96,1.0),2.0,size_y=.8)
camera_data = bpy.data.cameras.new('PREVIEW_ONLY_Camera')
camera = bpy.data.objects.new('PREVIEW_ONLY_Camera',camera_data)
scene.collection.objects.link(camera)
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 3.24
scene.camera = camera
for suffix,loc in [('front',(3.3,-4.3,2.7)),('rear',(-3.1,4.0,2.3))]:
    camera.location = loc
    aim(camera,(0,0,.21))
    scene.render.filepath = str(HERE/('AGV_FUTURE_'+suffix+'.png'))
    bpy.ops.render.render(write_still=True)
print('PREVIEW_COMPLETE',flush=True)
