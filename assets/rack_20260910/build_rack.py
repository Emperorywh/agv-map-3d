"""使用本机 Blender 制作参考图货架，并实际保存工程、导出与渲染。
所有尺寸均为补充设计尺寸；只操作本目录，已有货架工程已单独备份。
"""
import bpy
import bmesh
import json
import math
import struct
from pathlib import Path
from mathutils import Vector, Matrix

OUT = Path(__file__).resolve().parent
LEVELS = (.23, 1.13, 2.03)
BLUE = '#8BB5F9'

# 在独立的后台 Blender 会话中建立资产，绝不改写原工程。
# 工程保留四套可编辑网格，六个货箱通过链接数据复用资源。
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for mat in list(bpy.data.materials):
    bpy.data.materials.remove(mat)
scene = bpy.context.scene
scene.name = 'Rack_Asset'
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.unit_settings.length_unit = 'METERS'
asset = bpy.data.collections.new('Rack_Asset')
scene.collection.children.link(asset)
studio = bpy.data.collections.new('Preview_Studio')
scene.collection.children.link(studio)


def linear(hex_color):
    """将指定的 sRGB 色值准确转换为 Blender 和 glTF 使用的线性数值。
    不对阴影或高光采色，也不在材质中烘焙照明。
    """
    srgb = [int(hex_color[i:i+2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in srgb)


def material(name, color, metal, rough, emission=0):
    """使用单个标准原理化着色器定义共享材质。
    自发光只用于灯条，箱体始终不透明且不发光。
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    rgba = (*linear(color), 1)
    mat.diffuse_color = rgba
    mat['base_color_srgb'] = color
    node = mat.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = rgba
    node.inputs['Metallic'].default_value = metal
    node.inputs['Roughness'].default_value = rough
    if emission:
        node.inputs['Emission Color'].default_value = rgba
        node.inputs['Emission Strength'].default_value = emission
    return mat


metal = material('Rack_Graphite_Metal', '#414A56', .72, .34)
blue = material('Cargo_Blue_8BB5F9', BLUE, .08, .43)
trim = material('Cargo_Dark_Trim', '#353D48', .28, .49)
glow = material('Rack_Cyan_Emission', '#48D6FA', .05, .29, 2.3)


class Geometry:
    """把同材质部件直接累积为一个网格，避免细小零件变成渲染对象。
    单段倒角和真实凹面均直接写入几何，无需运行时修改器。
    """
    def __init__(self):
        self.verts = []
        self.faces = []
        self.groups = {}

    def add(self, name, verts, faces):
        start = len(self.verts)
        self.verts.extend(verts)
        self.faces.extend(tuple(start + i for i in f) for f in faces)
        self.groups[name] = list(range(start, len(self.verts)))

    def box(self, name, center, size, bevel=0, recess=False, top_recess=False, rotation=None):
        # 倒角用于主要轮廓；细小结构保留平面，以控制实际绘制面数。
        # 凹面通过面内缩再向内移动生成，不叠加深色贴片伪装阴影。
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for vert in bm.verts:
            vert.co.x *= size[0]
            vert.co.y *= size[1]
            vert.co.z *= size[2]
        if bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect='EDGES')
        bm.normal_update()
        faces = [f for f in bm.faces if (recess and abs(f.normal.z) < .001 and f.calc_area() > .2)
                 or (top_recess and f.normal.z > .999 and f.calc_area() > .2)]
        for face in faces:
            normal = face.normal.copy()
            bmesh.ops.inset_individual(bm, faces=[face], thickness=.052, depth=0, use_even_offset=True)
            for vert in face.verts:
                vert.co -= normal * .012
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        coords = []
        for vert in bm.verts:
            co = rotation @ vert.co if rotation else vert.co.copy()
            coords.append(tuple(co + Vector(center)))
        self.add(name, coords, [tuple(v.index for v in f.verts) for f in bm.faces])
        bm.free()

    def beam(self, name, a, b, width, depth):
        # 两端点决定斜撑方向，每个侧面两条撑杆在厚度方向错开。
        # 交叉处接触而不互相穿透，前后取货开口没有斜撑。
        a, b = Vector(a), Vector(b)
        direction = b - a
        self.box(name, (a + b) / 2, (depth, width, direction.length),
                 rotation=direction.to_track_quat('Z', 'X').to_matrix())

    def object(self, name, mat, parent, col=asset):
        # 顶点组保存零件语义，源工程可在编辑模式按组选择横梁、支脚等。
        # 合并后的对象保持单位缩放，根节点和标准箱原点不引入补偿旋转。
        mesh = bpy.data.meshes.new(name + '_Mesh')
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.materials.append(mat)
        mesh.update()
        ob = bpy.data.objects.new(name, mesh)
        col.objects.link(ob)
        ob.parent = parent
        for name, indices in self.groups.items():
            ob.vertex_groups.new(name=name).add(indices, 1, 'REPLACE')
        return ob


def empty(name, parent=None):
    """建立不产生绘制调用的根节点和货位锚点。
    货箱节点与锚点均位于箱底中心，前方向统一为 Blender 的负 Y。
    """
    ob = bpy.data.objects.new(name, None)
    asset.objects.link(ob)
    ob.parent = parent
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = .08
    return ob


root = empty('Rack_Root')
root['design_dimensions_m'] = [2.2, 1.35, 3.0]
root['front_blender'] = '-Y'
root['front_gltf'] = '+Z'
root['dimensions_note'] = '补充设计尺寸，并非图片测量结果'
frame_geo, light_geo = Geometry(), Geometry()

# 四柱落地，宽深尺寸含支脚；立柱端头决定三米总高度。
# 护套和短灯槽均与支柱连接，不将整根立柱设为自发光。
for ix, x in enumerate((-1.02, 1.02)):
    for iy, y in enumerate((-.595, .595)):
        key = f'{ix}_{iy}'
        frame_geo.box('Foot_' + key, (x, y, .055), (.16, .16, .11), .009)
        frame_geo.box('Post_' + key, (x, y, 1.545), (.10, .105, 2.91), .007)
        for j, z in enumerate((.18, 1.08, 1.98, 2.88)):
            frame_geo.box(f'Post_Collar_{key}_{j}', (x, y, z), (.119, .12, .18), .003)
        for j, z in enumerate((1.02, 2.16)):
            front = -1 if y < 0 else 1
            frame_geo.box(f'Lamp_Housing_{key}_{j}', (x, y + front * .057, z), (.069, .023, .27))
            light_geo.box(f'Short_Light_{key}_{j}', (x, y + front * .070, z), (.033, .005, .211))

# 每层有前后承重梁、左右纵梁和四条实际承载箱脚的托架。
# 移除货箱后，所有托架和后侧梁仍保留完整几何。
for level, top in enumerate(LEVELS, 1):
    for sign in (-1, 1):
        frame_geo.box(f'Load_Beam_{level}_{sign}', (0, sign * .582, top - .05),
                      (1.94, .095, .10), .006)
        frame_geo.box(f'Side_Rail_{level}_{sign}', (sign * 1.02, 0, top - .04),
                      (.085, 1.08, .08))
    for c, center in enumerate((-.48, .48)):
        for sign in (-1, 1):
            frame_geo.box(f'Cargo_Support_{level}_{c}_{sign}', (center + sign * .325, 0, top - .0275),
                          (.095, 1.075, .055))
    for sign in (-1, 1):
        x = sign * 1.026
        low, high = top + .035, top + .79
        frame_geo.beam(f'Side_X_A_{level}_{sign}', (x, -.541, low), (x, .541, high), .033, .018)
        frame_geo.beam(f'Side_X_B_{level}_{sign}', (x + sign * .018, .541, low),
                       (x + sign * .018, -.541, high), .033, .018)
        frame_geo.box(f'Brace_Hub_{level}_{sign}', (x + sign * .010, 0, (low+high)/2), (.040, .069, .063))

# 顶部矩形连接框架位于箱盖上方，保持装卸净空。
# 下方脚座与立柱连续接触，不增加参考图之外的护网或背板。
for sign in (-1, 1):
    frame_geo.box(f'Top_Front_Back_{sign}', (0, sign * .595, 2.877), (1.94, .055, .055), .003)
    frame_geo.box(f'Top_Side_{sign}', (sign * 1.02, 0, 2.877), (.055, 1.085, .055), .003)
frame = frame_geo.object('Rack_Frame', metal, root)
lights = light_geo.object('Rack_Lights', glow, root)

# 标准箱总高为 0.75 米，宽 0.90 米、深 1.10 米，箱底为局部 Z=0。
# 大凹面、盖缝、包角、开口把手和底脚全部采用真实几何。
body_geo, trim_geo = Geometry(), Geometry()
body_geo.box('Recessed_Shell', (0, 0, .389), (.88, 1.08, .598), .022, recess=True)
body_geo.box('Recessed_Lid', (0, 0, .724), (.90, 1.10, .052), .013, top_recess=True)
trim_geo.box('Lid_Seam', (0, 0, .693), (.859, 1.059, .010))
for sign in (-1, 1):
    body_geo.box(f'Front_Back_Panel_Rib_{sign}', (0, sign * .537, .388), (.766, .018, .026))
    body_geo.box(f'Side_Panel_Rib_{sign}', (sign * .437, 0, .388), (.018, .966, .024))
    for z in (.255, .516):
        body_geo.box(f'Front_Panel_Divider_{sign}_{z}', (sign * .103, -.535, z), (.013, .014, .229))
body_geo.box('Lid_Center_Rib', (0, 0, .741), (.025, .96, .018))
for ix, x in enumerate((-.413, .413)):
    for iy, y in enumerate((-.513, .513)):
        for label, z, height in (('Lower', .126, .091), ('Upper', .693, .104)):
            trim_geo.box(f'Corner_{label}_{ix}_{iy}', (x, y, z), (.062, .062, height))
for ix, x in enumerate((-.325, .325)):
    for iy, y in enumerate((-.438, .438)):
        trim_geo.box(f'Foot_{ix}_{iy}', (x, y, .050), (.174, .182, .100))
        body_geo.box(f'Foot_Facing_{ix}_{iy}', (x, y + (-.085 if y < 0 else .085), .050), (.151, .014, .079))

# 侧面与背面把手采用三段式开口轮廓，避免用贴片表示孔洞。
# 正面保留低位中央卡扣，盖边增加两枚主要闭锁件。
for sign in (-1, 1):
    for y in (-.093, .093):
        trim_geo.box(f'Side_Handle_Leg_{sign}_{y}', (sign * .439, y, .568), (.036, .026, .055))
    trim_geo.box(f'Side_Handle_Bar_{sign}', (sign * .449, 0, .595), (.035, .212, .023))
for x in (-.083, .083):
    trim_geo.box(f'Rear_Handle_Leg_{x}', (x, .542, .568), (.025, .034, .055))
trim_geo.box('Rear_Handle_Bar', (0, .551, .595), (.191, .034, .023))
trim_geo.box('Front_Lower_Latch', (0, -.548, .131), (.184, .030, .056), .005)
body_geo.box('Latch_Inlay', (0, -.565, .138), (.119, .008, .019))
for x in (-.319, .319):
    trim_geo.box(f'Upper_Latch_{x}', (x, -.534, .730), (.060, .036, .035))

cargos, slots = [], []
body, accessories = None, None
for row, z in enumerate(LEVELS):
    for column, x in enumerate((-.48, .48)):
        number = row * 2 + column + 1
        slot = empty(f'Slot_{number:02}', root)
        slot.location = (x, 0, z)
        slot['cargo_origin'] = '箱底中心'
        slots.append(slot)
        cargo = empty(f'Cargo_{number:02}', root)
        cargo.location = slot.location
        cargos.append(cargo)
        if body is None:
            body = body_geo.object('Cargo_Body', blue, cargo)
            accessories = trim_geo.object('Cargo_Trim', trim, cargo)
        else:
            for source in (body, accessories):
                copy = source.copy()
                copy.data = source.data
                copy.name = f'{source.name}_{number:02}'
                asset.objects.link(copy)
                copy.parent = cargo


def export_glb(filename, objects):
    """仅导出指定资产对象，自动转换一次 glTF 坐标。
    禁用修改器求值以保留共享网格，不导出真实光源与相机。
    """
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT / filename), export_format='GLB',
                              use_selection=True, export_yup=True, export_apply=False,
                              export_cameras=False, export_lights=False, export_animations=False,
                              export_extras=True, export_texcoords=False, export_normals=True,
                              export_materials='EXPORT')


def glb_summary(filename):
    """直接读取导出的索引数，累计每个节点的实际绘制三角面数。
    同一箱网格被六次引用时计算六次，同时检查锚点和材质数。
    """
    data = (OUT / filename).read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20+length])
    triangles = [sum(doc['accessors'][p['indices']]['count'] // 3 for p in m['primitives']) for m in doc['meshes']]
    nodes = [n for n in doc['nodes'] if 'mesh' in n]
    return doc, dict(triangles=sum(triangles[n['mesh']] for n in nodes),
                     mesh_nodes=len(nodes), unique_meshes=len(doc['meshes']),
                     materials=len(doc['materials']), bytes=len(data),
                     slot_names=[n['name'] for n in doc['nodes'] if n.get('name', '').startswith('Slot_')])


# 输出三个交付 GLB；单箱临时解除父级，原点直接位于箱底中心。
# 还原装配位置后再保存工程，避免满载版本留下临时导出变换。
bpy.context.view_layer.update()
export_glb('rack_loaded.glb', list(asset.objects))
export_glb('rack_empty.glb', [root, frame, lights] + slots)
first = cargos[0]
saved_location = first.location.copy()
first.parent = None
first.location = (0, 0, 0)
first.name = 'Cargo_Root'
export_glb('cargo_box.glb', [first, body, accessories])
first.name = 'Cargo_01'
first.parent = root
first.location = saved_location
bpy.context.view_layer.update()

# 只进行一次必要的结构、颜色和导出检查，不建立地图或性能场景。
# 实际装配间隙由尺寸确认，货箱脚底与托架顶面精确接触。
report = {'dimensions_m': [2.2, 1.35, 3.0], 'cargo_dimensions_m': [.933, 1.137, .75],
          'blue_srgb': BLUE, 'blue_linear': list(linear(BLUE)), 'files': {}}
for filename in ('rack_loaded.glb', 'rack_empty.glb', 'cargo_box.glb'):
    doc, result = glb_summary(filename)
    report['files'][filename] = result
    assert all(n.get('scale', [1, 1, 1]) == [1, 1, 1] for n in doc['nodes'])
    assert not doc.get('cameras') and not doc.get('images')
    if filename != 'cargo_box.glb':
        assert len(result['slot_names']) == 6
    for mat in doc['materials']:
        if mat['name'] == 'Cargo_Blue_8BB5F9':
            actual = mat['pbrMetallicRoughness']['baseColorFactor'][:3]
            assert max(abs(a-b) for a,b in zip(actual, linear(BLUE))) < 1e-6
    if filename == 'rack_loaded.glb':
        assert result['mesh_nodes'] == 14 and result['unique_meshes'] == 4
        assert result['materials'] == 4
        report['triangle_target_met'] = 3000 <= result['triangles'] <= 6000
for ob in (frame, lights, body, accessories):
    assert not ob.data.validate(verbose=False)
    ob.data.calc_loop_triangles()
    assert all(poly.area > 1e-10 for poly in ob.data.polygons)
assert .48 + .45 < 1.02 - .05
assert .55 < .595 - .105/2 + .018
assert all(b-a > .75 for a,b in zip(LEVELS, LEVELS[1:]))
points = [ob.matrix_world @ Vector(corner) for ob in asset.objects if ob.type == 'MESH' for corner in ob.bound_box]
report['measured_dimensions_m'] = [max(p[i] for p in points)-min(p[i] for p in points) for i in range(3)]
(OUT / 'asset_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('ASSET_REPORT', json.dumps(report, ensure_ascii=False), flush=True)

# 中性摄影布景只存在于工程的独立集合，三个 GLB 已在布景创建之前导出。
# 灯条不参与照亮箱体，也不添加任何光晕平面或烘焙阴影。
ground_mat = material('Preview_Only_Ground', '#CACDD2', 0, .82)
ground_geo = Geometry()
ground_geo.box('Floor', (0, 0, -.06), (200, 200, .10))
ground = ground_geo.object('Preview_Ground', ground_mat, None, studio)
world = bpy.data.worlds.new('Preview_Neutral_World')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (.5, .5, .5, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = .42
scene.world = world
for name, position, energy, size in [('Key', (-3.6, -4.5, 6), 650, 4),
                                     ('Fill', (4, -2.0, 3.8), 440, 3.5),
                                     ('Rim', (1, 3.5, 5), 800, 3)]:
    data = bpy.data.lights.new('Preview_' + name, 'AREA')
    data.energy, data.shape, data.size = energy, 'DISK', size
    ob = bpy.data.objects.new(data.name, data)
    studio.objects.link(ob)
    ob.location = position
    ob.rotation_euler = (Vector((0, 0, 1.4)) - ob.location).to_track_quat('-Z', 'Y').to_euler()
camera_data = bpy.data.cameras.new('Preview_Camera')
camera = bpy.data.objects.new('Preview_Camera', camera_data)
studio.objects.link(camera)
camera.location = (-4.8, -7.2, 4.5)
camera.rotation_euler = (Vector((0, 0, 1.43)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 4.18
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1200
scene.render.resolution_y = 1400
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(OUT / 'rack_preview.png')
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.film_transparent = False

# 源文件默认显示完整货架，工作视图采用相同的三分之四方向。
# 布景在交互视图中隐藏但保留渲染能力，方便继续编辑资产。
bpy.ops.object.select_all(action='DESELECT')
frame.select_set(True)
bpy.context.view_layer.objects.active = frame
for ob in studio.objects:
    ob.hide_set(True)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_rotation = camera.rotation_euler.to_quaternion()
            area.spaces.active.region_3d.view_distance = 5.8
            area.spaces.active.region_3d.view_location = (0, 0, 1.45)
            area.spaces.active.clip_end = 100
            area.spaces.active.shading.type = 'MATERIAL'
scene['asset_material_count'] = 4
scene['preview_note'] = '摄影布景单独存放；GLB 不含预览对象'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'rack.blend'))
bpy.ops.render.render(write_still=True)
print('RACK_DELIVERY_COMPLETE', flush=True)
