"""将成品 GLB 分别导入独立场景并记录交付检查结果。
同时解析 GLB 二进制，核对架体一致性、共享网格、贴图内嵌与导出层级。
这是一份实际资产验收脚本，不修改项目业务代码。
"""
import bpy
import bmesh
import json
import struct
import hashlib
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
P = json.loads((OUT/'parameters.json').read_text(encoding='utf-8'))
master = bpy.context.scene
report = dict(blender=bpy.app.version_string, files={}, checks={})

def glb_read(path):
    """直接读取 GLB 的 JSON 与二进制块。
    不依赖网络和外部解码服务，可验证资产能否自包含分发。
    """
    data = path.read_bytes()
    magic,version,total = struct.unpack_from('<4sII',data)
    assert magic == b'glTF' and version == 2 and total == len(data)
    offset = 12
    doc,blob = None,None
    while offset < len(data):
        size,kind = struct.unpack_from('<II',data,offset)
        chunk = data[offset+8:offset+8+size]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk)
        elif kind == 0x004E4942:
            blob = chunk
        offset += 8+size
    return doc,blob

def accessor_bytes(doc,blob,index):
    """按步长提取实际访问器内容。
    这样比较不受不同文件内二进制偏移位置影响。
    """
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    size = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}[a['componentType']]
    count = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
    item = size*count
    stride = v.get('byteStride',item)
    start = v.get('byteOffset',0)+a.get('byteOffset',0)
    return b''.join(blob[start+i*stride:start+i*stride+item] for i in range(a['count']))

def rack_signatures(doc,blob):
    """比较两份导出内每个架体部件的几何和变换。
    除了尺寸相同，还要求顶点、索引、法线和材质数值完全一致。
    """
    result = {}
    for node in doc['nodes']:
        if 'mesh' not in node or node['name'].startswith('Bin_'):
            continue
        h = hashlib.sha256()
        for p in doc['meshes'][node['mesh']]['primitives']:
            h.update(accessor_bytes(doc,blob,p['indices']))
            for key,index in sorted(p['attributes'].items()):
                h.update(key.encode())
                h.update(accessor_bytes(doc,blob,index))
            h.update(json.dumps(doc['materials'][p['material']],sort_keys=True).encode())
        result[node['name']] = dict(hash=h.hexdigest(),translation=node.get('translation'),
                                    rotation=node.get('rotation'),scale=node.get('scale'))
    return result

def bounds(objects):
    """读取导入后的世界空间包围盒。
    单位保持为米，Blender 坐标为 Z 向上。
    """
    points = [ob.matrix_world@Vector(v) for ob in objects if ob.type == 'MESH' for v in ob.bound_box]
    minimum = [min(v[i] for v in points) for i in range(3)]
    maximum = [max(v[i] for v in points) for i in range(3)]
    return dict(min=minimum,max=maximum,size=[maximum[i]-minimum[i] for i in range(3)])

signatures = {}
for variant in ('empty','loaded'):
    path = OUT/f'shelf_{variant}.glb'
    doc,blob = glb_read(path)
    signatures[variant] = rack_signatures(doc,blob)
    node_bins = [n for n in doc['nodes'] if n['name'].startswith('Bin_L')]
    root_nodes = [doc['nodes'][i] for i in doc['scenes'][doc.get('scene',0)]['nodes']]
    assert len(root_nodes) == 1 and root_nodes[0]['name'] == 'ShelfRoot'
    component_checks = json.loads(root_nodes[0]['extras']['rack_component_checks'])
    assert all(c['closed'] and c['signed_volume_m3']>0 for c in component_checks.values())
    assert root_nodes[0].get('translation',[0,0,0]) == [0,0,0]
    assert root_nodes[0].get('rotation',[0,0,0,1]) == [0,0,0,1]
    assert len(node_bins) == (9 if variant == 'loaded' else 0)
    assert not any('camera' in n or n.get('extensions',{}).get('KHR_lights_punctual') for n in doc['nodes'])
    assert all('bufferView' in i and 'uri' not in i for i in doc.get('images',[]))
    if variant == 'loaded':
        assert len({n['mesh'] for n in node_bins}) == 1
        assert len(doc.get('images',[])) == 1
        bin_group = next(n for n in doc['nodes'] if n['name'] == 'Bins')
        assert len(bin_group['children']) == 9
    else:
        assert not any(n['name'] == 'Bins' for n in doc['nodes'])

    # 每个文件导入到新的空场景中，避免沿用源模型造成误判。
    # 在导入内容检查完成后才添加预览布景，不污染资产统计。
    scene = bpy.data.scenes.new('Reimport_'+variant)
    bpy.context.window.scene = scene
    scene.unit_settings.system = 'METRIC'
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects = list(scene.objects)
    bpy.context.view_layer.update()
    model_bounds = bounds(objects)
    expected = [P['width'],P['depth'],P['height']+(P['bin_height'] if variant == 'loaded' else 0)]
    assert all(abs(a-b)<1e-5 for a,b in zip(model_bounds['size'],expected))
    assert abs(model_bounds['min'][2])<1e-6
    triangles = 0
    degenerate = 0
    duplicate_faces = 0
    mats = {}
    topology = {}
    for ob in objects:
        if ob.type != 'MESH':
            continue
        ob.data.calc_loop_triangles()
        triangles += len(ob.data.loop_triangles)
        for m in ob.data.materials:
            bsdf = m.node_tree.nodes.get('Principled BSDF')
            mats[m.name] = dict(metallic=bsdf.inputs['Metallic'].default_value,
                                roughness=bsdf.inputs['Roughness'].default_value,
                                textured=any(n.type == 'TEX_IMAGE' and n.image for n in m.node_tree.nodes))
        # glTF 会按法线和 UV 拆分顶点；焊接副本后检查几何边界。
        # 标签是有意保留的单面贴花，其边界单独记录。
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
        seen = set()
        for face in bm.faces:
            if face.calc_area()<1e-12:
                degenerate += 1
            key = tuple(sorted(tuple(round(c,7) for c in v.co) for v in face.verts))
            duplicate_faces += key in seen
            seen.add(key)
        topology[ob.name] = dict(boundary_edges=sum(e.is_boundary for e in bm.edges),
                                 nonmanifold_nonboundary=sum(not e.is_manifold and not e.is_boundary for e in bm.edges))
        bm.free()
    assert degenerate == 0 and duplicate_faces == 0
    for name,data in topology.items():
        # 方管端面之间存在设计接触；对整个组合强制焊接后，接缝可能成为多邻面边。
        # 独立料箱没有此类架体接缝，必须保持实体闭合且仅标签有开放边界。
        print('TOPOLOGY',name,data,flush=True)
        if name.startswith('Bin_L') or name.startswith('Rack_Rubber'):
            assert data['nonmanifold_nonboundary'] == 0
        assert data['boundary_edges'] == (4 if name.startswith('Bin_L') else 0)
    contacts = []
    for ob in objects:
        if not ob.name.startswith('Bin_L') or ob.type != 'MESH':
            continue
        level = int(ob.name.split('_')[1][1:])
        b = bounds([ob])
        gap = b['min'][2]-P['deck_tops'][level-1]
        overhead = P['deck_tops'][level]-P['sheet']-P['apron']-b['max'][2] if level<3 else None
        assert abs(gap)<1e-6 and (overhead is None or overhead>0)
        assert b['min'][0]>-P['width']/2+P['tube'] and b['max'][0]<P['width']/2-P['tube']
        assert b['min'][1]>-P['depth']/2+P['tube'] and b['max'][1]<P['depth']/2-P['tube']
        contacts.append(dict(name=ob.name,bottom_gap_m=gap,overhead_clearance_m=overhead))
    # 对内部空间和朝向进行实际射线探测。
    # 从箱内上方向下只能命中内底，前侧标签法线必须朝向负 Y。
    cavity_checks = []
    if variant == 'loaded':
        ob = next(o for o in objects if o.name.startswith('Bin_L03_C02') and o.type == 'MESH')
        hit,co,normal,face = ob.ray_cast(Vector((0,0,.3)),Vector((0,0,-1)))
        assert hit and abs(co.z-P['bin_floor'])<1e-5 and normal.z>.9
        cavity_checks.append(dict(inner_floor_local_z=co.z,normal=list(normal)))
        hit,co,normal,face = ob.ray_cast(Vector((0,-.4,.05)),Vector((0,1,0)))
        print('LABEL_RAYCAST',hit,list(co),list(normal),face,flush=True)
        assert hit and normal.y<-.9
        cavity_checks.append(dict(front_label_local_y=co.y,normal=list(normal)))
    report['files'][variant] = dict(path=str(path),bytes=path.stat().st_size,
        bounds_blender_xyz_m=model_bounds,triangles=triangles,material_count=len(mats),materials=mats,
        mesh_objects=sum(o.type=='MESH' for o in objects),bin_count=len(node_bins),
        shared_bin_meshes=len({n['mesh'] for n in node_bins}),embedded_images=len(doc.get('images',[])),
        root_origin=[0,0,0],front_blender='-Y',front_gltf='+Z',
        duplicate_faces=duplicate_faces,degenerate_faces=degenerate,topology=topology,
        bin_contacts=contacts,cavity_and_front_raycast=cavity_checks)
    report['files'][variant]['rack_component_checks'] = component_checks
    scene.collection.children.link(bpy.data.collections['PreviewStudio'])
    bpy.data.collections['PreviewStudio'].hide_viewport = False
    scene.camera = master.camera
    scene.world = master.world
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = 'AgX'
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(OUT/'previews'/f'reimport_{variant}_three_quarter.png')
    bpy.ops.render.render(write_still=True)

assert signatures['empty'] == signatures['loaded']
report['checks'] = dict(independent_blender_reimport=True,same_rack_geometry_and_materials=True,
    root_and_orientation=True,bin_count_and_shared_mesh=True,bin_floor_contacts=True,
    inner_cavity_and_front_normals=True,embedded_texture=True,no_preview_objects_in_glb=True,
    no_degenerate_or_duplicate_faces=True,closed_solids_except_four_label_edges=True,
    actual_threejs_webgl_render=False)
report['limits'] = ['参考图非工程图，采用假设尺寸；未进行实体承载计算。',
    '架体各零件均独立封闭；整架强制焊接后有 8 条多邻面接触边，属于装配接缝，未作制造级布尔融合。',
    '加强筋作为同一料箱网格内的嵌入式封闭几何保留，非制造级布尔融合实体。',
    '尚未在业务地图场景进行大规模实例化性能压测。']
(OUT/'validation_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'validation_reimport.blend'))
print(json.dumps({'checks':report['checks'],'stats':{k:{s:v[s] for s in ('triangles','material_count','bin_count','bytes')} for k,v in report['files'].items()}},ensure_ascii=False),flush=True)
