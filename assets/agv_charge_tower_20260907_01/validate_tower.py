"""验证实际保存的源工程与 GLB，并在空工程重新导入。
该脚本执行资产质量检查与渲染，不包含项目单元测试。
"""
import bpy
import bmesh
import json
import struct
from pathlib import Path
from mathutils import Vector

OUT=Path(__file__).resolve().parent

def inspect(objects):
    """统计世界坐标包围盒和基础网格拓扑。
    重复面与退化面逐网格检查；不将接触装配视为错误。
    """
    points=[]
    records=[]
    material_names=set()
    for ob in objects:
        if ob.type!='MESH':
            continue
        me=ob.data
        me.calc_loop_triangles()
        points.extend(ob.matrix_world@v.co for v in me.vertices)
        material_names.update(m.name for m in me.materials if m)
        bm=bmesh.new()
        bm.from_mesh(me)
        # glTF 为硬法线及材质边界拆分顶点，这不是模型破洞。
        # 仅在检查副本中焊接重合点，源文件与导入网格保持原状。
        raw_boundary_edges=sum(not e.is_manifold for e in bm.edges)
        bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
        nonmanifold=sum(not e.is_manifold for e in bm.edges)
        degenerate=sum(f.calc_area()<1e-12 for f in bm.faces)
        keys=set()
        duplicates=0
        for f in bm.faces:
            key=tuple(sorted(tuple(round(c,7) for c in v.co) for v in f.verts))
            duplicates += key in keys
            keys.add(key)
        records.append({'name':ob.name,'vertices':len(me.vertices),'triangles':len(me.loop_triangles),
                        'raw_split_boundary_edges':raw_boundary_edges,'welded_nonmanifold_edges':nonmanifold,
                        'degenerate_faces':degenerate,'duplicate_faces':duplicates})
        bm.free()
    lo=[min(p[i] for p in points) for i in range(3)]
    hi=[max(p[i] for p in points) for i in range(3)]
    return {'bounds_min':lo,'bounds_max':hi,'dimensions_m':[hi[i]-lo[i] for i in range(3)],
            'mesh_count':len(records),'triangles':sum(r['triangles'] for r in records),
            'material_count':len(material_names),'materials':sorted(material_names),'parts':records}

bpy.ops.wm.open_mainfile(filepath=str(OUT/'agv_charge_tower.blend'))
source=inspect(bpy.data.collections['AGV_CHARGE_TOWER | 模型主体'].objects)
blob=(OUT/'agv_charge_tower.glb').read_bytes()
json_length,kind=struct.unpack_from('<II',blob,12)
gltf=json.loads(blob[20:20+json_length])
gltf_triangles=sum(gltf['accessors'][p['indices']]['count']//3 for m in gltf['meshes'] for p in m['primitives'])
materials=[]
for m in gltf['materials']:
    materials.append({'name':m['name'],'alpha_mode':m.get('alphaMode','OPAQUE'),
        'base_color':m.get('pbrMetallicRoughness',{}).get('baseColorFactor'),
        'emissive_factor':m.get('emissiveFactor',[0,0,0]),'extensions':m.get('extensions',{})})

# 新建空场景再导入成品 GLB，以实际导入后的属性为准。
# 后续仅附加展示集合用于核对渲染，不借用源工程模型。
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(OUT/'agv_charge_tower.glb'))
imported=inspect(list(bpy.context.scene.objects))
report={'source':source,'reimported':imported,'glb_bytes':len(blob),'glb_triangles':gltf_triangles,
        'glb_materials':materials,'glb_meshes':len(gltf['meshes']),
        'glb_primitives':sum(len(m['primitives']) for m in gltf['meshes']),
        'glb_extensions':gltf.get('extensionsUsed',[]),
        'contains_cameras':bool(gltf.get('cameras')),
        'contains_lights':bool(gltf.get('extensions',{}).get('KHR_lights_punctual')),
        'dimension_delta_m':[abs(source['dimensions_m'][i]-imported['dimensions_m'][i]) for i in range(3)],
        'front_blender':'-Y','front_threejs':'+Z','up_blender':'+Z','up_threejs':'+Y',
        'limitations':['没有进行装配零件之间的全量碰撞求交检查；已按五个视角检查明显穿插。',
                      'Three.js 最终光照与透明排序仍取决于宿主场景，GLB 不携带屏幕空间 Bloom。']}
(OUT/'validation_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'validation_reimport.blend'))
with bpy.data.libraries.load(str(OUT/'agv_charge_tower.blend'),link=False) as (src,dst):
    dst.collections=['STUDIO | 仅预览不导出']
    dst.worlds=['STUDIO_World']
studio=dst.collections[0]
bpy.context.scene.collection.children.link(studio)
scene=bpy.context.scene
scene.world=dst.worlds[0]
scene.render.engine='CYCLES'
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.cycles.transmission_bounces=6
scene.view_settings.view_transform='AgX'
scene.camera=next(o for o in studio.objects if o.name.startswith('CAM_ThreeQuarter'))
scene.render.resolution_x=920
scene.render.resolution_y=1120
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath=str(OUT/'check_glb_reimport.png')
bpy.ops.render.render(write_still=True)
print('VALIDATION_REPORT',json.dumps({k:v for k,v in report.items() if k not in ('source','reimported','glb_materials')},ensure_ascii=False),flush=True)
