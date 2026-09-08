"""根据设计一八张多视图参考，在本地 Blender 生成可编辑车辆。
运行方式：blender --background --python build_agv.py -- white 或 final。
参数单位为米，横向为 X，车头为负 Y，竖直为正 Z；仅导出车辆集合。
"""
import bpy
import bmesh
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

OUT = Path(__file__).resolve().parent
P = json.loads((OUT / 'parameters.json').read_text(encoding='utf-8'))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'final'
PI = math.pi
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 5
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = True
scene.view_settings.view_transform = 'AgX'
scene.render.resolution_percentage = 100
scene.world = bpy.data.worlds.new('Studio_World')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.35
model = bpy.data.collections.new('AGV_Design1_Asset')
studio = bpy.data.collections.new('STUDIO_Preview_Only')
scene.collection.children.link(model)
scene.collection.children.link(studio)
root = bpy.data.objects.new('AGV_Design1_ROOT', None)
model.objects.link(root)
root['units'] = 'meters'
root['front_blender'] = '-Y'
root['front_gltf'] = '+Z'
root['origin'] = '车身平面中心对应地面，Z=0'
root['dimensions_assumed'] = True
root['parameters_json'] = json.dumps(P)


def mat(name, color, metal=0, rough=0.4, emission=0):
    """使用标准金属度粗糙度材质，保证 Blender 和网页均可加载。
    发光只存在于独立灯带材质，未使用贴图或烘焙光晕。
    """
    rgb = [int(color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [v / 12.92 if v < 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*linear, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*linear, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if metal < .3:
        bsdf.inputs['Specular IOR Level'].default_value = .22
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*linear, 1)
        bsdf.inputs['Emission Strength'].default_value = emission
    return m


M = {
    'silver': mat('Body_Silver_Satin', 'A9AAAE', 0.48, 0.31),
    'dark': mat('Structure_Charcoal', '272729', 0.17, 0.34),
    'platform': mat('Platform_DarkGray', '29292A', 0.03, 0.64),
    'fascia': mat('Fascia_Graphite', '2B2B2E', 0.12, 0.35),
    'rubber': mat('Rubber_Black', '151517', 0, 0.62),
    'under': mat('Chassis_Powdercoat', '1C1D1F', 0.22, 0.46),
    'steel': mat('Hardware_Satin', '727579', 0.72, 0.3),
    'glass': mat('Screen_Sensor_Glass', '030405', 0.05, 0.22),
    'red': mat('Emergency_Stop_Red', 'D50915', 0.05, 0.27),
    'led': mat('LED_Cyan_Emission', '9EFFFF', 0, 0.26, P['emission_strength']),
    'white': mat('White_Clay_Check', 'B8BABD', 0, 0.6)
}


def link(obj, material=None, parent=None):
    """车辆对象集中在资产集合，并挂到唯一的整车根节点。
    摄影棚单独管理，避免相机和灯光进入 GLB。
    """
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    model.objects.link(obj)
    obj.parent = parent or root
    if material:
        obj.data.materials.append(M['white'] if STAGE == 'white' else material)
    return obj


def mesh(name, vertices, faces, material):
    """根据真实三维顶点建立封闭体，并重新计算外向法线。
    圆弧轮廓由截面采样生成，减少大量细分带来的网页负担。
    """
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata(vertices, [], faces)
    data.update()
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00000001)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(data)
    bm.free()
    obj = bpy.data.objects.new(name, data)
    link(obj, material)
    return obj


def smooth(obj):
    """平滑曲面并保留锐角的分面法线。
    大平面保持平直，避免全局平滑造成平台和屏幕反光扭曲。
    """
    for f in obj.data.polygons:
        f.use_smooth = True
    obj.data.set_sharp_from_angle(angle=math.radians(40))
    return obj


def bevel(obj, width=0.002, segments=3):
    """仅添加当前新建零件所需的物理倒角。
    修改器在源文件保留，导出时求值；不改动项目其他代码或资产。
    """
    mod = obj.modifiers.new('Edge_Radius', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.harden_normals = True
    smooth(obj)
    norm = obj.modifiers.new('Surface_Normals', 'WEIGHTED_NORMAL')
    norm.keep_sharp = True
    norm.weight = 40
    return obj


def box(name, dims, loc, material, radius=0.002):
    """生成具有真实厚度的矩形结构件。
    尺寸烘焙进网格，保持对象比例为一，方便网页使用。
    """
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    link(obj, material)
    if radius:
        bevel(obj, radius)
    return obj


def rr(width, length, radius, n=12):
    """生成逆时针圆角矩形截面。
    长直边额外采样，供前包围分层和弧形轮拱使用。
    """
    r = min(radius, width / 2, length / 2)
    corners = [(width / 2 - r, length / 2 - r, 0),
               (-width / 2 + r, length / 2 - r, 90),
               (-width / 2 + r, -length / 2 + r, 180),
               (width / 2 - r, -length / 2 + r, 270)]
    points = []
    for x, y, a in corners:
        for i in range(n + 1):
            t = math.radians(a + 90 * i / n)
            points.append((x + r * math.cos(t), y + r * math.sin(t)))
    return points


def loft(name, rings, material, center=(0, 0, 0), caps=True):
    """叠加不同尺寸和高度的圆角截面，形成有曲率的外壳。
    截面参数为宽、长、圆角半径、高度，可模拟侧壁收分和肩部圆润过渡。
    """
    vertices = []
    for w, l, r, z in rings:
        vertices.extend((x + center[0], y + center[1], z + center[2]) for x, y in rr(w, l, r))
    n = len(vertices) // len(rings)
    faces = []
    for j in range(len(rings) - 1):
        for i in range(n):
            faces.append((j * n + i, j * n + (i + 1) % n, (j + 1) * n + (i + 1) % n, (j + 1) * n + i))
    if caps:
        faces.extend([tuple(reversed(range(n))), tuple((len(rings) - 1) * n + i for i in range(n))])
    obj = mesh(name, vertices, faces, material)
    smooth(obj)
    for f in obj.data.polygons:
        if len(f.vertices) > 4:
            f.use_smooth = False
    return obj


def slab(name, width, length, radius, z0, z1, material, xy=(0, 0), edge=0.001):
    """薄平台也采用封闭圆角实体，不使用零厚度平面。
    几何轮廓与倒角独立，避免普通立方体倒角改变平面圆角半径。
    """
    obj = loft(name, [(width, length, radius, z0), (width, length, radius, z1)], material, (*xy, 0))
    return bevel(obj, edge, 2) if edge else obj


def cylinder(name, radius, depth, loc, material, axis='Z', segments=48, edge=0.001):
    """圆柱默认本地 Z 轴，按实际轮轴旋转到车辆 X 轴。
    车轮网格中心和对象原点均位于轮轴中心。
    """
    bpy.ops.mesh.primitive_cylinder_add(vertices=segments, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    if axis == 'X':
        obj.rotation_euler[1] = PI / 2
    elif axis == 'Y':
        obj.rotation_euler[0] = PI / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    link(obj, material)
    if edge:
        bevel(obj, edge)
    return obj


def cut(obj, cutter):
    """使用布尔切削产生真实轮拱空间。
    切削器为本脚本临时对象，完成后清理，避免随资产导出。
    """
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new('Wheel_Arch_Cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def tube(name, points, radius, material, cyclic=False, sides=10):
    """沿空间路径生成实体圆管，适用于把手和独立弧形灯带。
    使用低截面边数和连续法线，保留外轮廓而限制三角形数量。
    """
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.resolution_u = 1
    data.bevel_depth = radius
    data.bevel_resolution = 2
    data.resolution_u = 1
    data.use_fill_caps = True
    spline = data.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for vert, pos in zip(spline.points, points):
        vert.co = (*pos, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, data)
    link(obj, material)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    return smooth(bpy.context.object)


# 第一阶段：校准长宽高、车轮位置、平台间隙和立柱屏幕。
# 白模与成品共用同一份几何参数，避免检查后重新生成时出现比例漂移。
W, L, R = P['body_width'], P['body_length'], P['body_corner_radius']
Z0, Z1 = P['body_bottom'], P['body_top']
shell = loft('Body_Silver_Shell', [
    (W - .006, L - .006, R, Z0 + .010),
    (W, L, R, Z0 + .018),
    (W - .005, L - .004, R, Z1 - .047),
    (W - .009, L - .009, R, Z1 - .028),
    (W - .017, L - .017, R - .005, Z1 - .015),
    (W - .029, L - .029, R - .010, Z1 - .006),
    (W - .048, L - .048, R - .017, Z1),
    (W - .063, L - .063, R - .024, Z1 + .001)
], M['silver'])
# 壳体内部挖空，保留顶板厚度和侧壁，不用整块银色实体封住底部。
# 仰视图中的纵梁、轮架和底板由下方独立结构网格呈现。
inner_void = loft('TEMP_Inner_Cavity', [(W - .040, L - .040, R - .020, -.080),
                                      (W - .040, L - .040, R - .020, Z1 - .027)], M['under'])
cut(shell, inner_void)
bumper = slab('Bumper_Lower_Perimeter', W + .004, L + .004, R + .004, Z0, Z0 + .020, M['rubber'], edge=.006)
cut(bumper, loft('TEMP_Bumper_Cavity', [(W - .025, L - .025, R - .014, -.080),
                                      (W - .025, L - .025, R - .014, .080)], M['under']))
for side in (-1, 1):
    for obj in (shell, bumper):
        cutter = cylinder('TEMP_Arch', P['drive_radius'] + .012, .124,
                          (side * .284, P['drive_center_y'], P['drive_radius']), M['under'], 'X', 64, 0)
        cut(obj, cutter)
bevel(shell, .001, 2)
# 壳体底缘的内返面采用深色内衬，避免仰视时出现参考中没有的银白亮圈。
# 外侧银色曲面仍使用原材质，分配只作用于朝下的低处面。
if STAGE != 'white':
    shell.data.materials.append(M['under'])
    for face in shell.data.polygons:
        if face.normal.z < -.3 and face.center.z < .09:
            face.material_index = len(shell.data.materials) - 1
pedestal = slab('Platform_Recessed_Support', P['pedestal_width'], P['pedestal_length'], .10,
                Z1, P['platform_top'] - P['platform_thickness'] - .003, M['dark'], edge=.005)
platform = slab('Load_Platform', P['platform_width'], P['platform_length'], P['platform_corner_radius'],
                P['platform_top'] - P['platform_thickness'], P['platform_top'], M['platform'], edge=.0015)
for x in (-.214, .214):
    for y in (-.376, .360):
        cylinder(f'Platform_Spacer_{x}_{y}', .022, .036, (x, y, .232), M['rubber'], edge=.002)
        cylinder(f'Platform_Spacer_Cap_{x}_{y}', .018, .013, (x, y, .256), M['steel'], edge=.001)

mast_y = P['mast_center_y']
mast_w, mast_d, top = P['mast_width'], P['mast_depth'], P['overall_height']
mast = loft('Mast_Main_Column', [(mast_w, mast_d, .025, P['platform_top']),
                               (mast_w, mast_d, .025, top - .005)], M['dark'], (0, mast_y, 0))
bevel(mast, .001, 2)
slab('Mast_Foot_Collar', mast_w + .010, mast_d + .014, .023, .273, .295, M['dark'], (0, mast_y))
pod = loft('Display_Integrated_Neck', [(.130, .070, .022, 1.340), (.154, .094, .026, 1.378),
                                    (.166, .166, .029, 1.425), (.169, .145, .029, 1.535),
                                    (.168, .120, .028, 1.621)], M['dark'], (0, mast_y - .025, 0))
# 显示屏支座仅向车头伸出，后轮廓与立柱背面齐平。
# 各截面独立移动，消除第一轮预览中柱背面多出的凸块。
for ring_index, depth in enumerate((.070, .094, .166, .145, .120)):
    delta = mast_y + mast_d / 2 - .0015 - depth / 2 - (mast_y - .025)
    for vert in list(pod.data.vertices)[ring_index * 52:(ring_index + 1) * 52]:
        vert.co.y += delta
screen_pivot = bpy.data.objects.new('Display_Tilt_Mount', None)
model.objects.link(screen_pivot)
screen_pivot.parent = root
screen_pivot.location = (0, P['screen_center_y'], P['screen_center_z'])
screen_pivot.rotation_euler[0] = math.radians(-P['screen_tilt_degrees'])
screen = slab('Display_Enclosure', P['screen_width'], P['screen_height'], .011, -.010, .010, M['dark'], edge=.002)
screen.parent = screen_pivot
screen.rotation_euler[0] = PI / 2
screen.location = (0, 0, 0)
for side, label in ((-1, 'Left'), (1, 'Right')):
    center_x = side * P['drive_center_x']
    tire = cylinder(f'Wheel_Drive_{label}', P['drive_radius'], P['drive_width'],
                    (center_x, P['drive_center_y'], P['drive_radius']), M['rubber'], 'X', 64, .009)
    tire['rotation_axis_local'] = 'X'
    tire['radius_m'] = P['drive_radius']
    tire['wheel_role'] = 'drive'
    for y, end in ((P['caster_front_y'], 'Front'), (P['caster_rear_y'], 'Rear')):
        wheel = cylinder(f'Wheel_Caster_{end}_{label}', P['caster_radius'], .045,
                         (side * P['caster_center_x'], y, P['caster_radius']), M['rubber'], 'X', 40, .005)
        wheel['rotation_axis_local'] = 'X'
        wheel['radius_m'] = P['caster_radius']
        wheel['wheel_role'] = 'caster'
cylinder('Wheel_Aux_Front_Center', .042, .040, (0, -.396, .042), M['rubber'], 'X', 40, .004)


def make_fascia():
    """前部包围绕过两角延伸到驱动轮，后半车壳保持银色。
    顶缘在轮轴后侧下弯，复现侧视图中不对称的包围终止轮廓。
    """
    path = [(W / 2, .11 - i * (.11 + L / 2 - R) / 28) for i in range(29)]
    for i in range(1, 25):
        a = -PI / 2 * i / 24
        path.append((W / 2 - R + R * math.cos(a), -L / 2 + R + R * math.sin(a)))
    path.extend([(W / 2 - R - (W - 2 * R) * i / 15, -L / 2) for i in range(1, 16)])
    for i in range(1, 25):
        a = -PI / 2 - PI / 2 * i / 24
        path.append((-W / 2 + R + R * math.cos(a), -L / 2 + R + R * math.sin(a)))
    path.extend([(-W / 2, -L / 2 + R + (.11 + L / 2 - R) * i / 28) for i in range(1, 29)])
    vertices = []
    for x, y in path:
        ztop = .194 if y <= 0 else .078 + math.sqrt(max(0, .116 ** 2 - y ** 2))
        vertices.extend([(x * 1.004, y * 1.004, .051), (x * 1.004, y * 1.004, ztop),
                         (x * .963, y * .973, ztop), (x * .963, y * .973, .051)])
    faces = []
    for i in range(len(path) - 1):
        for j in range(4):
            faces.append((i * 4 + j, (i + 1) * 4 + j, (i + 1) * 4 + (j + 1) % 4, i * 4 + (j + 1) % 4))
    faces.extend([(3, 2, 1, 0), tuple((len(path) - 1) * 4 + j for j in range(4))])
    obj = mesh('Fascia_Front_Wrap', vertices, faces, M['fascia'])
    for side in (-1, 1):
        cut(obj, cylinder('TEMP_Fascia_Arch', .086, .110, (side * .286, 0, .077), M['under'], 'X', 64, 0))
    bevel(obj, .004, 3)
    return obj


def body_light(side, front):
    """沿车壳转角铺设独立灯槽与青色灯带网格。
    前方灯带较长，后方灯带较短；两端倒圆且不添加额外装饰。
    """
    end = -1 if front else 1
    x0 = .110 if front else .182
    pts = [(side * x0, end * .504, P['body_light_z'])]
    if front:
        pts.extend((side * (.110 + .020 * i / 4), end * .504, P['body_light_z']) for i in range(1, 5))
    start_angle = PI / 2 if front else math.radians(72)
    for i in range(30):
        a = start_angle + (math.radians(25) - start_angle) * i / 29
        x = W / 2 - R + (R + .005) * math.cos(a)
        y = end * (L / 2 - R + (R + .005) * math.sin(a))
        pts.append((side * x, y, P['body_light_z']))
    pts = pts if front else pts[1:]
    tag = ('Front_' if front else 'Rear_') + ('Left' if side < 0 else 'Right')
    tube('Light_Channel_' + tag, pts, P['body_light_height'] / 2 + .0022, M['under'])
    ledpts = [(x * 1.022, y * 1.014, z) for x, y, z in pts]
    obj = tube('LED_Body_' + tag, ledpts, P['body_light_height'] / 2, M['led'])
    obj['light_group'] = 'body'


if STAGE != 'white':
    # 第二阶段：真实结构细节，包括两侧不同检修盖和前后不同的传感器。
    # 所有细节基于多视图可见证据，底部不可辨认的小件使用简化结构。
    make_fascia()
    # 前防撞面板沿圆角车头贴合，厚度单独建模。
    # 其端部在急停按钮之前收口，不跨越侧面轮拱和后壳。
    path = [(x, y) for x, y in rr(W, L, R, 22) if y < -.346]
    verts, faces = [], []
    for i, (x, y) in enumerate(path):
        prev = Vector(path[max(0, i - 1)])
        nxt = Vector(path[min(len(path) - 1, i + 1)])
        tangent = (nxt - prev).normalized()
        normal = Vector((tangent.y, -tangent.x))
        for depth, z in ((.001, .074), (.005, .069), (.012, .078), (.012, .159), (.005, .169), (.001, .164)):
            verts.append((x + normal.x * depth, y + normal.y * depth, z))
    for i in range(len(path) - 1):
        for j in range(6):
            faces.append((i * 6 + j, (i + 1) * 6 + j, (i + 1) * 6 + (j + 1) % 6, i * 6 + (j + 1) % 6))
    faces.extend([tuple(reversed(range(6))), tuple((len(path) - 1) * 6 + j for j in range(6))])
    bevel(mesh('Bumper_Front_Secondary_Wrap', verts, faces, M['fascia']), .003, 3)
    for side, label in ((-1, 'Left'), (1, 'Right')):
        for front in (True, False):
            body_light(side, front)
        tube('Wheel_Arch_Rounded_Lip_' + label,
             [(side * .302, .087 * math.cos(a), .077 + .087 * math.sin(a))
              for a in [i * PI / 36 for i in range(37)]], .009, M['fascia'])
        cylinder('Emergency_Recess_' + label, .024, .003, (side * .303, P['emergency_center_y'], .119), M['under'], 'X')
        cylinder('Emergency_Base_' + label, .015, .009, (side * .3045, P['emergency_center_y'], .119), M['steel'], 'X')
        cylinder('Emergency_Stop_' + label, .016, .015, (side * .308, P['emergency_center_y'], .119), M['red'], 'X', 40, .004)
        hub = cylinder('Drive_Hub_' + label, .060, .005, (side * .287, 0, .077), M['fascia'], 'X', 48, .002)
        wheel = bpy.data.objects['Wheel_Drive_' + label]
        hub.parent = wheel
        hub.matrix_parent_inverse = wheel.matrix_world.inverted()
        for j in range(3):
            a = j * 2 * PI / 3 + PI / 2
            bolt = cylinder('Hub_Fastener_' + label + str(j), .0024, .0015,
                            (side * .291, .069 * math.cos(a), .077 + .069 * math.sin(a)), M['steel'], 'X', 12, .0004)
            bolt.parent = wheel
            bolt.matrix_parent_inverse = wheel.matrix_world.inverted()
        cylinder('Drive_Axle_' + label, .011, .075, (side * .180, 0, .077), M['steel'], 'X', 24)
        box('Drive_Mount_' + label, (.015, .205, .058), (side * .178, -.040, .093), M['under'])
        box('Suspension_Arm_' + label, (.030, .140, .021), (side * .190, -.171, .052), M['under'])
        cylinder('Suspension_Pivot_' + label, .016, .103, (side * .191, -.151, .048), M['steel'], 'X', 24)
        for y, end in ((P['caster_front_y'], 'Front'), (P['caster_rear_y'], 'Rear')):
            cx = side * P['caster_center_x']
            cylinder('Caster_Swivel_' + end + label, .029, .011, (cx, y + .011, .064), M['under'], edge=.001)
            for dx in (-.026, .026):
                box('Caster_Fork_' + end + label + str(dx), (.006, .046, .024), (cx + dx, y, .044), M['steel'], .002)
            cylinder('Caster_Axle_' + end + label, .0045, .062, (cx, y, .033), M['steel'], 'X', 16)
            wh = bpy.data.objects[f'Wheel_Caster_{end}_{label}']
            for dx in (-.023, .023):
                h = cylinder('Caster_Hub_' + end + label + str(dx), .009, .0015, (cx + dx, y, .033), M['under'], 'X', 20)
                h.parent = wh
                h.matrix_parent_inverse = wh.matrix_world.inverted()
    hatch = slab('Service_Hatch_Right_Gasket', .088, .047, .022, -.001, .001, M['under'])
    hatch.rotation_euler = (PI / 2, 0, PI / 2)
    hatch.location = (.303, .300, .114)
    cover = slab('Service_Hatch_Right', .085, .044, .021, -.001, .001, M['silver'])
    cover.rotation_euler = hatch.rotation_euler
    cover.location = (.305, .300, .114)
    sensor = slab('Sensor_Front_Bezel', .120, .032, .015, -.004, .004, M['steel'], edge=.001)
    sensor.rotation_euler[0] = math.radians(59)
    sensor.location = (0, -.487, .199)
    pane = slab('Sensor_Front_Window', .104, .021, .010, -.001, .001, M['glass'])
    pane.rotation_euler = sensor.rotation_euler
    pane.location = (0, -.492, .202)
    bezel = slab('Sensor_Rear_Dual_Bezel', .137, .039, .018, -.003, .003, M['steel'])
    bezel.rotation_euler[0] = PI / 2
    bezel.location = (0, .499, .172)
    for x in (-.033, .033):
        pane = slab('Sensor_Rear_Window_' + str(x), .044, .024, .011, -.002, .002, M['glass'])
        pane.rotation_euler[0] = PI / 2
        pane.location = (x, .503, .172)
    for z in (.101, .131):
        vent = slab('Rear_Subtle_Vent_' + str(z), .063, .010, .005, -.001, .001, M['silver'])
        vent.rotation_euler[0] = PI / 2
        vent.location = (0, .500, z)
    glass = slab('Display_Glass', P['screen_width'] - .007, P['screen_height'] - .007, .008,
                 -.001, .001, M['glass'], edge=.0007)
    glass.parent = screen_pivot
    glass.rotation_euler[0] = PI / 2
    glass.location = (0, -.0115, 0)
    tube('Handle_Continuous_Loop', [(x, mast_y, y + P['handle_center_z']) for x, y in rr(
         P['handle_outer_width'] - P['handle_diameter'], P['handle_outer_height'] - P['handle_diameter'], .066, 12)],
         P['handle_diameter'] / 2, M['dark'], True)
    for side in (-1, 1):
        oval = slab('Handle_Joint_' + str(side), .026, .075, .013, -.004, .004, M['fascia'])
        oval.rotation_euler = (PI / 2, 0, PI / 2)
        oval.location = (side * .090, mast_y - .009, 1.386)
    slab('Mast_Top_Black_Insert', mast_w - .010, mast_d - .010, .025,
         top - .004, top - .0005, M['glass'], (0, mast_y), .0005)
    # 顶部灯带为闭合实体环，保留黑色顶盖。
    # 灯带高度由截面确定，侧视也能看到连续青色边缘。
    led = loft('LED_Mast_Top_Ring', [(mast_w + .001, mast_d + .001, .026, top - .007),
              (mast_w + .001, mast_d + .001, .026, top),
              (mast_w - .009, mast_d - .009, .022, top),
              (mast_w - .009, mast_d - .009, .022, top - .007),
              (mast_w + .001, mast_d + .001, .026, top - .007)], M['led'], (0, mast_y, 0), caps=False)
    led['light_group'] = 'mast'
    cylinder('Mast_Front_Service_Lock', .009, .003, (0, mast_y - mast_d / 2 - .001, .940), M['glass'], 'Y', 24)
    cradle = slab('Display_Underside_Cradle', .113, .033, .014, -.006, .006, M['fascia'])
    cradle.location = (0, mast_y - .051, 1.365)
    under_pan = slab('Underbody_Outer_Pan', W - .028, L - .028, R - .014, .060, .072, M['under'], edge=.001)
    for side in (-1, 1):
        cut(under_pan, cylinder('TEMP_Under_Arch', .085, .136, (side * .278, 0, .077), M['under'], 'X', 48, 0))
    slab('Underbody_Main_Pan', .248, .870, .032, .052, .063, M['under'], edge=.002)
    for side in (-1, 1):
        slab('Underbody_Side_Pan_' + str(side), .120, .550, .020, .057, .067, M['under'], (side * .202, .018))
        box('Longitudinal_Rail_' + str(side), (.010, .837, .017), (side * .126, .005, .054), M['under'])
        for y in (-.341, .362):
            for x in (.164, .230):
                cylinder('Under_Fastener_' + str((side, y, x)), .0028, .002, (side * x, y, .058), M['steel'], segments=12, edge=.0003)
    plate = slab('Underbody_Center_Module', .160, .085, .010, .048, .061, M['steel'])
    cylinder('Underbody_Center_Lens_Bezel', .033, .008, (0, 0, .046), M['under'], segments=40)
    cylinder('Underbody_Center_Lens', .023, .002, (0, 0, .041), M['glass'], segments=40)
    slab('Underbody_Left_Service_Plate', .070, .105, .008, .053, .060, M['under'], (-.205, .170))
    box('Underbody_Right_Latch', (.026, .086, .020), (.203, .159, .050), M['steel'])
    box('Underbody_Rear_Crossmember', (.318, .040, .032), (0, .427, .065), M['under'])
    box('Underbody_Rear_Sill', (.312, .025, .012), (0, .454, .061), M['steel'])
    cylinder('Aux_Front_Swivel', .043, .012, (0, -.447, .087), M['steel'], segments=32)
    box('Aux_Front_Neck', (.073, .047, .026), (0, -.434, .072), M['steel'])
    for x in (-.030, .030):
        box('Aux_Front_Fork_' + str(x), (.009, .094, .023), (x, -.389, .048), M['steel'], .004)
        for y in (-.428, -.351):
            cylinder('Aux_Front_Fork_Bolt_' + str((x, y)), .006, .003, (x, y, .034), M['steel'], segments=16)


def studio_link(obj):
    """把预览辅助对象放入独立集合。
    车辆根节点只包含模型部件，可用选择导出严格隔离布景。
    """
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    studio.objects.link(obj)


def area(name, loc, power, size, target, shape='DISK'):
    """布置中性柔光以判断银色曲面与深色零件的关系。
    辉光不参与车身材质，也不随 GLB 导出。
    """
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.shape = shape
    data.size = size
    obj = bpy.data.objects.new(name, data)
    studio.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


area('Key_Softbox', (-3, -4, 5), 450, 4, (0, 0, .8))
area('Fill_Softbox', (3, -1, 2.5), 250, 3, (0, 0, .7))
area('Rim_Softbox', (0, 3, 4), 380, 3, (0, 0, .8))
area('Underbody_Inspection', (0, 0, -3), 130, 3, (0, 0, 0))


def camera(name, loc, target, scale, up='Y'):
    """使用正交机位对齐六个标准方向，立体图机位仅核对连接结构。
    顶视图车头朝上，仰视图也将车头固定朝上，方便逐项对照。
    """
    data = bpy.data.cameras.new('Camera_' + name)
    data.type = 'ORTHO'
    data.ortho_scale = scale
    data.lens = 55
    obj = bpy.data.objects.new('Camera_' + name, data)
    studio.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', up).to_euler()
    return obj


CAMERAS = {
    'front': camera('front', (0, -5, .82), (0, 0, .82), 1.85),
    'rear': camera('rear', (0, 5, .82), (0, 0, .82), 1.85),
    'right': camera('right', (5, 0, .82), (0, 0, .82), 1.85),
    'left': camera('left', (-5, 0, .82), (0, 0, .82), 1.85),
    'top': camera('top', (0, 0, 5), (0, 0, 0), 1.17),
    'bottom': camera('bottom', (0, 0, -5), (0, 0, 0), 1.17),
    'front_right': camera('front_right', (3, -4, 3.0), (0, 0, .80), 1.94),
    'rear_left': camera('rear_left', (-3, 4, 3.0), (0, 0, .80), 1.94)
}
CAMERAS['top'].rotation_euler = (0, 0, PI)
CAMERAS['bottom'].rotation_euler = (PI, 0, 0)


def render(view, folder, resolution=1100):
    """实际渲染到透明背景 PNG，便于与参考白底公平对照。
    每张图保存相机名称和尺寸，交付时可重新渲染。
    """
    scene.camera = CAMERAS[view]
    scene.render.resolution_x = 900 if view not in ('top', 'bottom') else 800
    scene.render.resolution_y = resolution
    scene.render.filepath = str(folder / f'{view}.png')
    bpy.ops.render.render(write_still=True)


def optimize_export():
    """源文件保存后，仅在导出副本中按材质合并静态小零件。
    灯带、车轮、轮毂、屏幕及主要外观件仍独立，源文件保持全部可编辑部件。
    合并节点记录原始部件名，重导入时按组计算包围盒并验证完整性。
    """
    preserved = {'Body_Silver_Shell', 'Mast_Main_Column', 'Load_Platform',
                 'Fascia_Front_Wrap', 'Handle_Continuous_Loop'}
    groups = {}
    for obj in list(model.objects):
        if obj.type != 'MESH' or obj.parent != root or obj.name in preserved:
            continue
        if obj.name.startswith(('LED_', 'Wheel_')) or obj.get('wheel_role'):
            continue
        key = obj.data.materials[0].name
        groups.setdefault(key, []).append(obj.name)
    for key, names in groups.items():
        if len(names) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for name in names:
            bpy.data.objects[name].select_set(True)
        bpy.context.view_layer.objects.active = bpy.data.objects[names[0]]
        bpy.ops.object.convert(target='MESH')
        bpy.ops.object.join()
        merged = bpy.context.object
        merged.name = 'Static_' + key
        merged['source_parts_json'] = json.dumps(names)
        # 合并后应用旋转，避免倾斜传感器成为整组局部坐标基准。
        # 这样网页的默认包围盒查询也能得到紧贴车辆的正确尺寸。
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        scene.cursor.location = (0, 0, 0)
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')


# 参数和建模脚本嵌入源工程，便于离线编辑与后续尺寸更新。
# 材质阶段与白模分别保存，不覆盖白模检查证据。
bpy.data.texts.load(str(OUT / 'parameters.json'))
bpy.data.texts.load(str(Path(__file__).resolve()))
scene.camera = CAMERAS['front_right']
for screen_area in bpy.context.screen.areas if bpy.context.screen else []:
    if screen_area.type == 'VIEW_3D':
        screen_area.spaces.active.region_3d.view_distance = 2.8
        screen_area.spaces.active.region_3d.view_location = (0, 0, .80)
        screen_area.spaces.active.region_3d.view_rotation = CAMERAS['front_right'].rotation_euler.to_quaternion()
        screen_area.spaces.active.shading.color_type = 'MATERIAL'
        screen_area.spaces.active.clip_end = 100
bpy.ops.object.select_all(action='DESELECT')
root.select_set(True)
bpy.context.view_layer.objects.active = root
stage_dir = OUT / ('white_preview' if STAGE == 'white' else 'previews')
stage_dir.mkdir(exist_ok=True)
if STAGE == 'white':
    scene.cycles.samples = 12
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'agv_design1_white.blend'))
    for view in ('front', 'right', 'top', 'bottom', 'front_right'):
        render(view, stage_dir, 850)
else:
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'agv_design1.blend'))
    editable_mesh_count = len([o for o in model.objects if o.type == 'MESH'])
    optimize_export()
    bpy.ops.object.select_all(action='DESELECT')
    for obj in model.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(filepath=str(OUT / 'agv_design1.glb'), export_format='GLB',
                              use_selection=True, export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False, export_extras=True)
    for view in (ARGS[1].split(',') if len(ARGS) > 1 else CAMERAS):
        render(view, stage_dir)
    stats = {'object_count': len(model.objects), 'mesh_count': len([o for o in model.objects if o.type == 'MESH']),
             'editable_blend_mesh_count': editable_mesh_count,
             'material_names': [m.name for m in bpy.data.materials if m.users and m.name != 'White_Clay_Check'],
             'glb_bytes': (OUT / 'agv_design1.glb').stat().st_size,
             'coordinates': {'blender': 'X右 Y后 Z上', 'gltf': 'X右 Y上 Z前'}, 'parameters': P}
    (OUT / 'asset_report.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')
print('AGV_BUILD_DONE', STAGE, flush=True)
