"""在本地 Blender 中生成同款空载与满载货架。
只重建本任务专用场景；参数、材质和共享料箱网格均可编辑。
运行方式：blender --background --factory-startup --python build_shelf.py -- final。
"""
import bpy
import bmesh
import math
import json
import sys
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'final'
P = dict(width=1.0, depth=.5, height=.9, tube=.03, foot=.008,
         deck_tops=[.24, .57, .9], sheet=.0025, apron=.024,
         lower_rail_top=.145, bin_width=.282, bin_depth=.420,
         bin_height=.220, bin_wall=.0035, bin_floor=.004,
         rim_extra=.004, rim_height=.009, column_pitch=.304,
         levels=3, columns=3, bevel=.0008)
# 参数修改后立即检查装配约束，避免默默生成穿插模型。
# 层数必须与板面列表一致，列数与料箱外包尺寸必须能放入立柱净宽。
assert P['levels'] == len(P['deck_tops'])
assert P['deck_tops'][-1] == P['height']
assert (P['columns']-1)*P['column_pitch']+P['bin_width']+2*P['rim_extra'] < P['width']-2*P['tube']
assert P['bin_depth']+2*P['rim_extra'] < P['depth']-2*P['tube']
assert all(b-a-P['sheet']-P['apron']>P['bin_height'] for a,b in zip(P['deck_tops'],P['deck_tops'][1:]))
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'previews').mkdir(exist_ok=True)

# 精确按任务标记移除旧生成内容，不删除其他场景或用户对象。
# 重复执行会替换本任务场景，并清理已经失去引用的任务数据块。
TAG = 'AGV_SHELF_20260907_01'
for old in list(bpy.data.scenes):
    if old.get('task_tag') == TAG:
        for ob in list(old.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.scenes.remove(old)
for collection in list(bpy.data.collections):
    if collection.get('task_tag') == TAG:
        bpy.data.collections.remove(collection)
for library in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights, bpy.data.worlds):
    for data in list(library):
        if data.get('task_tag') == TAG and data.users == 0:
            library.remove(data)
scene = bpy.data.scenes.new('AGV_Shelf_Asset')
scene['task_tag'] = TAG
bpy.context.window.scene = scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.unit_settings.length_unit = 'METERS'

def collection(name, parent=None):
    """建立专用集合并标记归属。
    布景与导出主体分离，料箱可通过集合整体隐藏。
    """
    c = bpy.data.collections.new(name)
    c['task_tag'] = TAG
    (parent or scene.collection).children.link(c)
    return c

asset = collection('ShelfAsset')
rack_col = collection('Rack', asset)
bins_col = collection('Bins', asset)
studio = collection('PreviewStudio')

def empty(name, col, parent=None):
    """建立轻量层级节点。
    所有根节点均保持零平移、零旋转和单位缩放。
    """
    obj = bpy.data.objects.new(name, None)
    col.objects.link(obj)
    obj.parent = parent
    obj.empty_display_size = .05
    return obj

root = empty('ShelfRoot', asset)
root['parameters_m'] = json.dumps(P)
root['front_blender'] = '-Y'
root['front_gltf'] = '+Z'
root['origin'] = '底部中心，脚底 Z=0；米制'
rack = empty('Rack', rack_col, root)
bins = empty('Bins', bins_col, root)

def material(name, color, roughness, metallic=0):
    """只使用可直接导出的标准 PBR 节点。
    喷涂钢材、塑料和橡胶分别控制粗糙度，不使用摄影阴影贴图。
    """
    m = bpy.data.materials.new(name)
    m['task_tag'] = TAG
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metallic
    return m

white = material('PowderCoat_OffWhite', (.77, .79, .80), .48)
rubber = material('Foot_Rubber', (.022, .026, .029), .82)
plastic = material('Bin_MatteGraphite', (.037, .041, .045), .65)
label = material('Label_Ivory', (.87, .88, .85), .76)
groundmat = material('Preview_Ground', (.23, .26, .30), .9)

def mesh(name, verts, faces, mat, col, parent=None, bevel=0):
    """创建实际封闭网格并统一法线。
    小倒角保持未应用以便源文件编辑，导出时求值应用。
    """
    data = bpy.data.meshes.new(name + '_Mesh')
    data['task_tag'] = TAG
    data.from_pydata(verts, [], faces)
    data.update()
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(data)
    bm.free()
    ob = bpy.data.objects.new(name, data)
    col.objects.link(ob)
    ob.parent = parent
    if mat:
        data.materials.append(mat)
    if bevel and STAGE != 'blockout':
        mod = ob.modifiers.new('工业微倒角', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    return ob

def box(name, center, size, mat, col=rack_col, parent=rack, bevel=None):
    """以真实米制尺寸生成长方体零件。
    几何在局部空间构建，避免非均匀缩放影响倒角。
    """
    x, y, z = [v / 2 for v in size]
    verts = [(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),
             (-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    ob = mesh(name, verts, faces, mat, col, parent, P['bevel'] if bevel is None else bevel)
    ob.location = center
    return ob

def deck(name, top, full):
    """薄钢板与下方矩形承重边框相接，形成轻型工业层板。
    下两层切除立柱占用的四角，避免板面穿过立柱。
    """
    w, d, t = P['width']/2, P['depth']/2, P['tube']
    if full:
        outline = [(-w,-d),(w,-d),(w,d),(-w,d)]
    else:
        outline = [(-w+t,-d),(w-t,-d),(w-t,-d+t),(w,-d+t),
                   (w,d-t),(w-t,d-t),(w-t,d),(-w+t,d),
                   (-w+t,d-t),(-w,d-t),(-w,-d+t),(-w+t,-d+t)]
    n = len(outline)
    verts = [(x,y,z) for z in (top-P['sheet'], top) for x,y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name, verts, faces, white, rack_col, rack, .0005)

# 四根方管贯通下两层，顶端与顶框下表面接触。
# 底部横梁及两根纵向支撑与参考图相同，不添加背板或侧板。
w, d, t = P['width'], P['depth'], P['tube']
post_top = P['height'] - P['sheet'] - P['apron']
for ix, x in enumerate((-(w-t)/2, (w-t)/2), 1):
    for iy, y in enumerate((-(d-t)/2, (d-t)/2), 1):
        box(f'Foot_{ix}_{iy}', (x,y,P['foot']/2), (t,t,P['foot']), rubber, bevel=.0005)
        box(f'Post_{ix}_{iy}', (x,y,(post_top+P['foot'])/2), (t,t,post_top-P['foot']), white)
for level, top in enumerate(P['deck_tops'], 1):
    deck(f'Deck_L{level:02}', top, level == P['levels'])
    z = top-P['sheet']-P['apron']/2
    for sign in (-1,1):
        box(f'DeckFrame_L{level:02}_FB_{sign}', (0,sign*(d-t)/2,z),
            (w if level == P['levels'] else w-2*t,t,P['apron']),white)
        box(f'DeckFrame_L{level:02}_Side_{sign}', (sign*(w-t)/2,0,z),
            (t,d-2*t,P['apron']),white)
z = P['lower_rail_top'] - .012
for sign in (-1,1):
    box(f'BaseRail_FB_{sign}', (0,sign*(d-t)/2,z), (w-2*t,t,.024), white)
    box(f'BaseRail_Side_{sign}', (sign*(w-t)/2,0,z), (t,d-2*t,.024), white)
for i, x in enumerate((-w*.19,w*.19),1):
    box(f'BaseCrossMember_{i}', (x,0,z), (.025,d-2*t,.024), white)

def setup_studio():
    """创建只供预览的相机、地面和柔光灯。
    所有这些对象位于独立集合，导出仅选择根节点下的主体。
    """
    box('PreviewFloor', (0,0,-.022), (200,200,.04), groundmat, studio, None, 0)
    world = bpy.data.worlds.new('Shelf_StudioWorld')
    world['task_tag'] = TAG
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.45,.50,.60,1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .45
    scene.world = world
    for name, loc, energy, size in [('Key', (1,-3,4), 450, 3), ('Fill',(-3,-1,2),260,3),('Rim',(1,3,3),420,2)]:
        data = bpy.data.lights.new('Preview_'+name, 'AREA')
        data['task_tag'] = TAG
        data.energy, data.shape, data.size = energy, 'DISK', size
        ob = bpy.data.objects.new(data.name, data)
        studio.objects.link(ob)
        ob.location = loc
        ob.rotation_euler = (Vector((0,0,.5))-ob.location).to_track_quat('-Z','Y').to_euler()
    data = bpy.data.cameras.new('PreviewCamera')
    data['task_tag'] = TAG
    cam = bpy.data.objects.new('PreviewCamera', data)
    studio.objects.link(cam)
    scene.camera = cam
    data.type = 'ORTHO'
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.render.film_transparent = False
    return cam

camera = setup_studio()

def render_views(prefix, views, target=(0,0,.55), scale=1.48):
    """输出来自当前模型的实际正交渲染。
    空架与满载采用一致构图，便于直接核对尺寸与层间距。
    """
    if '--no-render' in ARGS:
        return
    positions = dict(front=(0,-4,target[2]), side=(4,0,target[2]),
                     rear=(0,4,target[2]), top=(0,0,5), three_quarter=(2,-3,2.05))
    for view in views:
        # 正交平视图隐藏布景地面，避免地面厚度形成黑色横带。
        # 三维斜视图保留真实地面接触阴影，便于检查落地关系。
        bpy.data.objects['PreviewFloor'].hide_render = view in ('front','side','rear')
        camera.location = positions[view]
        camera.rotation_euler = (Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
        camera.data.ortho_scale = scale
        scene.render.filepath = str(OUT/'previews'/f'{prefix}_{view}.png')
        bpy.ops.render.render(write_still=True)

if STAGE == 'blockout':
    render_views('blockout_empty', ['front','side','three_quarter'])
    print('BLOCKOUT_COMPLETE', flush=True)
else:
    def rounded_loop(hx, hy, radius=.007, segments=3):
        """生成少量顶点的圆角矩形。
        外壁、内壁和箱口共用环结构，确保开口并具有连续壁厚。
        """
        points = []
        for cx,cy,angle in [(hx-radius,hy-radius,0),(-hx+radius,hy-radius,90),
                            (-hx+radius,-hy+radius,180),(hx-radius,-hy+radius,270)]:
            for i in range(segments+1):
                a = math.radians(angle+i*90/segments)
                points.append((cx+radius*math.cos(a),cy+radius*math.sin(a)))
        return points

    # 料箱自底至箱口轻微外张，箱口加厚但保持总高不变。
    # 环形网格形成外底、外壁、口沿、内壁和内底，绝非实心块。
    bw, bd, bh, wall = P['bin_width'],P['bin_depth'],P['bin_height'],P['bin_wall']
    loops = [(.5*bw-.003,.5*bd-.003,0),(.5*bw,.5*bd,bh-P['rim_height']),
             (.5*bw+P['rim_extra'],.5*bd+P['rim_extra'],bh-P['rim_height']),
             (.5*bw+P['rim_extra'],.5*bd+P['rim_extra'],bh),
             (.5*bw-wall,.5*bd-wall,bh),
             (.5*bw-.003-wall,.5*bd-.003-wall,P['bin_floor'])]
    verts = [(x,y,z) for hx,hy,z in loops for x,y in rounded_loop(hx,hy)]
    n = len(verts)//len(loops)
    faces = [tuple(reversed(range(n)))]
    for k in range(len(loops)-1):
        faces += [(k*n+i,k*n+(i+1)%n,(k+1)*n+(i+1)%n,(k+1)*n+i) for i in range(n)]
    faces.append(tuple(range((len(loops)-1)*n,len(loops)*n)))
    proto = mesh('Bin_Prototype',verts,faces,plastic,bins_col,bins,0)

    # 前后设置真实贯通把手孔，单次布尔只用于原型。
    # 应用后的网格由九个料箱共同引用，避免九次重复求值。
    cutter = box('Handle_Cutter',(0,0,bh-.039),(.090,bd+.04,.020),None,bins_col,None,.006)
    bpy.context.view_layer.objects.active = cutter
    bpy.ops.object.select_all(action='DESELECT')
    cutter.select_set(True)
    for mod in list(cutter.modifiers):
        mod.segments = 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = proto
    boolean = proto.modifiers.new('真实前后把手孔','BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.solver = 'EXACT'
    boolean.object = cutter
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter,do_unlink=True)
    bevel = proto.modifiers.new('塑料细倒角','BEVEL')
    bevel.width = .00065
    bevel.segments = 2
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    parts = [proto]

    # 少量加强筋合并到同一个料箱网格中，不形成大量场景节点。
    # 加强筋放置在外壁上，内部仍保留完整可见的收纳空间。
    for side in (-1,1):
        for x in (-bw*.36,bw*.36):
            rib = box('BinRib', (x,side*(bd/2-.0005),bh*.46),(.005,.004,bh*.82),plastic,bins_col,None,.0007)
            rib.rotation_euler.x = side*math.atan(.003/(bh-P['rim_height']))
            parts.append(rib)
        for y in (-bd*.35,bd*.35):
            rib = box('BinRibSide',(side*(bw/2-.0005),y,bh*.46),(.004,.005,bh*.82),plastic,bins_col,None,.0007)
            rib.rotation_euler.y = -side*math.atan(.003/(bh-P['rim_height']))
            parts.append(rib)
    for ob in parts[1:]:
        bpy.context.view_layer.objects.active = ob
        for mod in list(ob.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = proto
    bpy.ops.object.join()

    # 条码使用一张很小的 RGBA 图像，随源文件和 GLB 内嵌。
    # 内容为示意标签，不声称是具有业务含义的真实编码。
    image = bpy.data.images.new('Bin_Label_Barcode',width=256,height=128,alpha=True)
    image['task_tag'] = TAG
    pixels = [0.0]*(256*128*4)
    for y in range(128):
        for x in range(256):
            bar = 20<x<236 and 29<y<105 and ((x*13//7)%11 in (0,1,3,6,7))
            rule = 20<x<156 and 14<y<20
            value = .06 if bar or rule else .90
            i = (y*256+x)*4
            pixels[i:i+4] = [value,value,value*.97,1]
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(OUT/'bin_label.png')
    image.file_format = 'PNG'
    image.save()
    image.pack()
    tex = label.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    label.node_tree.links.new(tex.outputs['Color'],label.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    z0,z1 = .034,.074
    front_y = lambda z: -bd/2+.003*(1-z/(bh-P['rim_height']))-.00035
    sticker = mesh('BinLabel',[(-.049,front_y(z0),z0),(.049,front_y(z0),z0),
                              (.049,front_y(z1),z1),(-.049,front_y(z1),z1)],[(0,1,2,3)],label,bins_col,None)
    # 单面标签无法通过实体体积判断外侧，需明确令法线朝向货架正面。
    # 修正后可使用背面剔除，不依赖双面显示掩盖法线错误。
    bm = bmesh.new()
    bm.from_mesh(sticker.data)
    bm.normal_update()
    bmesh.ops.reverse_faces(bm,faces=[f for f in bm.faces if f.normal.y>0])
    bm.to_mesh(sticker.data)
    bm.free()
    label.use_backface_culling = True
    uv = sticker.data.uv_layers.new(name='UVMap')
    for index, value in enumerate(((0,0),(1,0),(1,1),(0,1))):
        uv.data[index].uv = value
    bpy.ops.object.select_all(action='DESELECT')
    proto.select_set(True)
    sticker.select_set(True)
    bpy.context.view_layer.objects.active = proto
    bpy.ops.object.join()
    proto.data.name = 'Bin_SharedMesh'
    # 合并几何后显式重设标签面的 UV，避免无 UV 的箱体成为活动对象时
    # 标签坐标被默认坐标覆盖，导致渲染中只出现纯白标签。
    uv = proto.data.uv_layers.get('UVMap') or proto.data.uv_layers.new(name='UVMap')
    proto.data.uv_layers.active = uv
    uv.active_render = True
    for face in proto.data.polygons:
        if proto.data.materials[face.material_index] == label:
            for loop_index in face.loop_indices:
                co = proto.data.vertices[proto.data.loops[loop_index].vertex_index].co
                uv.data[loop_index].uv = ((co.x+.049)/.098,(co.z-z0)/(z1-z0))
    for level, top in enumerate(P['deck_tops'],1):
        for column in range(1,P['columns']+1):
            ob = proto if level == 1 and column == 1 else bpy.data.objects.new('Bin',proto.data)
            if ob != proto:
                bins_col.objects.link(ob)
            ob.name = f'Bin_L{level:02}_C{column:02}'
            ob.parent = bins
            ob.location = ((column-(P['columns']+1)/2)*P['column_pitch'],0,top)
            ob['level'] = level
            ob['column'] = column
            ob['bin_size_m'] = [bw+2*P['rim_extra'],bd+2*P['rim_extra'],bh]
    bpy.context.view_layer.update()

    if STAGE == 'bin':
        rack_col.hide_render = True
        for ob in bins.children:
            ob.hide_render = ob.name != 'Bin_L01_C01'
        proto.location = (0,0,0)
        render_views('bin_prototype',['front','rear','three_quarter','top'],(0,0,.1),.60)
        print('BIN_COMPLETE',flush=True)
    else:
        # 静态架体按材质合并为两个网格，降低重复摆放时的绘制调用。
        # 源文件保留以原零件命名的顶点组，仍可选择和编辑单根梁或层板。
        component_checks = {}
        for mat, name in ((white,'Rack_FrameAndDecks'),(rubber,'Rack_RubberFeet')):
            pieces = [o for o in rack.children if o.type == 'MESH' and o.data.materials[0] == mat]
            for ob in pieces:
                bpy.context.view_layer.objects.active = ob
                group = ob.vertex_groups.new(name=ob.name)
                group.add(list(range(len(ob.data.vertices))),1.0,'REPLACE')
                for mod in list(ob.modifiers):
                    bpy.ops.object.modifier_apply(modifier=mod.name)
                # 合并前逐件确认封闭和正向体积。
                # 合并后各构件仍是独立几何岛，装配接触无需强制布尔融合。
                bm = bmesh.new()
                bm.from_mesh(ob.data)
                closed = all(e.is_manifold for e in bm.edges)
                volume = bm.calc_volume(signed=True)
                assert closed and volume>0, ob.name
                component_checks[ob.name] = dict(closed=closed,signed_volume_m3=volume)
                bm.free()
            bpy.ops.object.select_all(action='DESELECT')
            for ob in pieces:
                ob.select_set(True)
            bpy.context.view_layer.objects.active = pieces[0]
            bpy.ops.object.join()
            pieces[0].name = name
        root['rack_component_checks'] = json.dumps(component_checks)

        def export_version(name, include_bins):
            """只按显式选择导出模型节点，预览布景不参与。
            两个文件都复用当前同一架体并以 glTF 标准转换到 Y 向上。
            """
            bpy.ops.object.select_all(action='DESELECT')
            objects = [root,rack]+list(rack.children)
            if include_bins:
                objects += [bins]+list(bins.children)
            for ob in objects:
                ob.select_set(True)
            bpy.context.view_layer.objects.active = root
            bpy.ops.export_scene.gltf(filepath=str(OUT/name),export_format='GLB',
                                      use_selection=True,use_active_scene=True,export_apply=False,
                                      export_yup=True,export_extras=True,
                                      export_cameras=False,export_lights=False)

        export_version('shelf_empty.glb',False)
        export_version('shelf_loaded.glb',True)
        views = ['front','side','rear','top','three_quarter']
        bins_col.hide_render = True
        render_views('empty',views)
        bins_col.hide_render = False
        render_views('loaded',views)
        camera.location = (2,-3,2.05)
        # 即使跳过渲染进行快速重建，也保存相同的相机取景尺度。
        # 后续重导入验证沿用该相机时不会退回默认远景。
        camera.data.ortho_scale = 1.48
        camera.rotation_euler = (Vector((0,0,.55))-camera.location).to_track_quat('-Z','Y').to_euler()
        studio.hide_viewport = True
        bpy.ops.object.select_all(action='DESELECT')
        root.select_set(True)
        bpy.context.view_layer.objects.active = root
        for screen in bpy.data.screens:
            for area in screen.areas:
                if area.type == 'VIEW_3D':
                    area.spaces.active.region_3d.view_distance = 2.1
                    area.spaces.active.region_3d.view_location = (0,0,.55)
                    area.spaces.active.region_3d.view_rotation = camera.rotation_euler.to_quaternion()
                    area.spaces.active.clip_start = .01
                    area.spaces.active.shading.type = 'MATERIAL'
        scene['README'] = 'Bins 集合眼睛/相机开关可切换空满；正面 -Y；GLB 正面 +Z；标签已内嵌；PreviewStudio 不导出。'
        bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'shelf_master.blend'))
        (OUT/'parameters.json').write_text(json.dumps(P,ensure_ascii=False,indent=2),encoding='utf-8')
        print('FINAL_COMPLETE',flush=True)
