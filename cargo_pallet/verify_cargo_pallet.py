"""
在独立 Blender 进程中重新导入实际 GLB，检查资产而不是只检查导出返回值。
记录几何、材质、UV、法线、真实叉孔及导入后的渲染，不修改交付的 GLB。
"""
import bpy
import bmesh
import json
import struct
import math
from pathlib import Path
from mathutils import Vector

HERE=Path(__file__).resolve().parent
blob=(HERE/'cargo_pallet.glb').read_bytes()
length=struct.unpack_from('<I',blob,12)[0]
gltf=json.loads(blob[20:20+length])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(HERE/'cargo_pallet.glb'))
scene=bpy.context.scene
meshes=[o for o in scene.objects if o.type=='MESH']
points=[o.matrix_world@Vector(v) for o in meshes for v in o.bound_box]
lo=[min(p[i] for p in points) for i in range(3)]
hi=[max(p[i] for p in points) for i in range(3)]
issues=[]
triangles=0
open_components=0
closed_components=0
for ob in meshes:
    ob.data.calc_loop_triangles()
    triangles+=len(ob.data.loop_triangles)
    if not ob.data.uv_layers:
        issues.append(ob.name+': 缺少 UV')
    if any(not math.isfinite(c) for v in ob.data.vertices for c in v.co):
        issues.append(ob.name+': 顶点无效')
    if ob.matrix_world.determinant()<=0:
        issues.append(ob.name+': 负缩放或奇异变换')
    if any(abs(s-1)>1e-5 for s in ob.scale):
        issues.append(ob.name+': 缩放未归一')
    bm=bmesh.new(); bm.from_mesh(ob.data)
    # glTF 会按 UV 和法线拆顶点；只在临时验证网格中焊接接缝。
    # 不修改导入资产，以免验证流程掩盖实际交付文件的问题。
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6)
    remaining=set(bm.faces)
    while remaining:
        todo=[remaining.pop()]; component=[]
        while todo:
            f=todo.pop(); component.append(f)
            for edge in f.edges:
                for linked in edge.link_faces:
                    if linked in remaining:
                        remaining.remove(linked); todo.append(linked)
        closed=all(len(e.link_faces)==2 for f in component for e in f.edges)
        if not closed:
            open_components+=1
            if len(component)>2:
                issues.append(ob.name+': 非贴花结构存在非封闭边界')
            continue
        closed_components+=1
        volume=0
        for f in component:
            v0=f.verts[0].co
            for i in range(1,len(f.verts)-1):
                volume+=v0.dot(f.verts[i].co.cross(f.verts[i+1].co))/6
        if volume < -1e-10:
            issues.append(ob.name+': 封闭部件法线反向')
    bm.free()
box_nodes=[n for n in gltf['nodes'] if n.get('extras',{}).get('is_cargo_box')]
if len(box_nodes)!=8: issues.append('箱体数量不是八个')
if triangles>20000: issues.append('超过二万三角面')
if len(gltf['materials'])>8: issues.append('超过八种材质')
if len(gltf['scenes'])!=1: issues.append('GLB 包含无关场景')
if any(o.type in ['CAMERA','LIGHT'] for o in scene.objects): issues.append('GLB 包含相机或灯')
if abs(lo[2])>1e-5: issues.append('资产底部未贴地')
if not bpy.data.objects.get('Cargo_Pallet'): issues.append('根节点名称不正确')
body=next(m for m in gltf['materials'] if m['name']=='Cargo_Body_9AB5F6')
factor=body['pbrMetallicRoughness']['baseColorFactor']
srgb=[round((12.92*c if c<=.0031308 else 1.055*c**(1/2.4)-.055)*255) for c in factor[:3]]
if srgb!=[154,181,246]: issues.append('主体颜色偏离 #9AB5F6')
if any('bufferView' not in img or img.get('uri') for img in gltf['images']): issues.append('贴图未全部嵌入')
if next(m for m in gltf['materials'] if m['name']=='Cargo_Shared_Print_Atlas').get('alphaMode')!='MASK':
    issues.append('印刷材质未使用透明裁切')
deps=bpy.context.evaluated_depsgraph_get()
fork_checks=[]
for axis,positions in [('Y',[-.245,.245]),('X',[-.195,.195])]:
    for p in positions:
        origin=Vector((p,-.65,.075)) if axis=='Y' else Vector((-.75,p,.075))
        direction=Vector((0,1,0)) if axis=='Y' else Vector((1,0,0))
        hit,loc,normal,index,obj,matrix=scene.ray_cast(deps,origin,direction,distance=1.5)
        fork_checks.append({'axis':axis,'offset_m':p,'height_m':.075,'clear_through':not hit})
        if hit: issues.append(f'{axis}方向叉孔被 {obj.name} 阻挡')
report=dict(reimported=True,passed=not issues,issues=issues,triangles=triangles,material_count=len(gltf['materials']),
            box_count=len(box_nodes),unique_box_meshes=len({n['mesh'] for n in box_nodes}),
            gltf_mesh_resources=len(gltf['meshes']),gltf_mesh_instances=sum('mesh' in n for n in gltf['nodes']),
            gltf_primitive_instances=sum(len(gltf['meshes'][n['mesh']]['primitives']) for n in gltf['nodes'] if 'mesh' in n),
            dimensions_blender_xyz=[hi[i]-lo[i] for i in range(3)],bounds_min=lo,bounds_max=hi,
            body_srgb=srgb,body_linear_factor=factor,metallic=body['pbrMetallicRoughness']['metallicFactor'],
            roughness=body['pbrMetallicRoughness']['roughnessFactor'],images=[{'name':im.name,'size':list(im.size)} for im in bpy.data.images if im.type=='IMAGE'],
            embedded_images=len(gltf['images']),closed_components=closed_components,open_decal_components=open_components,
            fork_openings=fork_checks,glb_bytes=len(blob))
(HERE/'blender_validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
if issues: raise RuntimeError('GLB 重新导入验证失败')


"""
导入资产通过结构检查后，复制源场景的摄影棚配置，输出独立验收预览。
只渲染导入 GLB 的货物，不复制源货物网格，供视觉比对材质和朝向。
"""
with bpy.data.libraries.load(str(HERE/'cargo_pallet.blend'),link=False) as (source,target):
    target.collections=['Cargo_Render_Studio_Not_Exported']
studio=target.collections[0]
scene.collection.children.link(studio)
world=bpy.data.worlds.new('Validation_Neutral'); world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(1,1,1,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.65
scene.world=world
scene.camera=next(o for o in studio.objects if o.name.startswith('Camera_Perspective'))
scene.render.engine='CYCLES'; scene.cycles.samples=48; scene.cycles.use_denoising=True
scene.view_settings.view_transform='Standard'; scene.view_settings.look='None'
scene.view_settings.exposure=-.20
scene.render.resolution_x=1000; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
scene.render.filepath=str(HERE/'renders'/'GLB_Reimport_Check.png')
bpy.ops.render.render(write_still=True)
print('GLB_REIMPORT_RENDER_COMPLETE',flush=True)
