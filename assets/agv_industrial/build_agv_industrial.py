"""
使用 Blender 制作可编辑的工业背负式小车，并导出自包含的二进制模型。
长度、宽度读取项目车辆数据；建模采用米制，前方为正向横轴、竖直为高度轴。
导出器负责将 Blender 的高度轴转换为 glTF 的正向纵轴，不在根节点补偿旋转。
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
GLB_PATH = PROJECT / "public" / "models" / "agv_industrial.glb"
BLEND_PATH = HERE / "agv_industrial.blend"
vehicle_data = json.loads((PROJECT / "json" / "vehicle.json").read_text(encoding="utf-8"))
LENGTH = float(vehicle_data["agvDimension"]["length"])
WIDTH = float(vehicle_data["agvDimension"]["width"])
HEIGHT = 0.35
SCALE_X = LENGTH / 1.8
SCALE_Y = WIDTH / 0.7


def srgb(value):
    """
    将十六进制喷漆颜色转为材质节点所需的线性颜色。
    不使用烘焙高光、阴影或环境光，保证模型在工厂灯光下仍然正确着色。
    """
    values = [int(value[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values)


def material(name, color, roughness, metalness=0.0, emission=False):
    """
    全部车辆表面仅使用标准金属度与粗糙度材质节点。
    状态灯拥有专用发光材质，运行时修改颜色不会影响车壳或传感器。
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    color = (*srgb(color), 1.0)
    mat.diffuse_color = color
    node = mat.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = color
    node.inputs["Roughness"].default_value = roughness
    node.inputs["Metallic"].default_value = metalness
    if name in ("Platform_Matte", "Rubber_Black", "Chassis_DarkGray"):
        node.inputs["Specular IOR Level"].default_value = 0.20
    if emission:
        node.inputs["Emission Color"].default_value = color
        node.inputs["Emission Strength"].default_value = 1.0
    return mat


def collection(name):
    """
    车辆集合与摄影棚集合单独管理。
    导出只选车辆集合中的对象，避免导出预览相机、地面或灯光。
    """
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def relocate(obj, target):
    """
    显式设置对象所属集合，防止操作器将临时几何留在默认集合中。
    同一对象只保留一个集合归属，便于编辑和筛选导出。
    """
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)


def mesh_object(name, vertices, faces, mat, parent=None):
    """
    从精确轮廓生成网格并统一外法线方向。
    部件名称始终使用英文，便于 Three.js 通过名称查找。
    """
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    ASSET.objects.link(obj)
    obj.parent = parent or ROOT
    if mat:
        mesh.materials.append(mat)
    return obj


def rounded_outline(hx, hy, radius, segments=8, taper=0.0):
    """
    圆角矩形在每个角使用真实圆弧，前后端再进行轻微横向收分。
    所有截面使用相同顶点顺序，可直接连接形成连续的曲面倒角。
    """
    points = []
    for cx, cy, start in ((hx - radius, hy - radius, 0), (-hx + radius, hy - radius, 90),
                          (-hx + radius, -hy + radius, 180), (hx - radius, -hy + radius, 270)):
        for index in range(segments + 1):
            angle = math.radians(start + 90 * index / segments)
            x, y = cx + radius * math.cos(angle), cy + radius * math.sin(angle)
            y *= 1.0 - taper * max(0.0, (abs(x) - hx + radius) / radius)
            points.append((x, y))
    return points


def loft(name, profiles, mat, closed=False, cap=True, taper=0.0, segments=8):
    """
    由一系列水平轮廓构造有厚度的外壳或底座。
    闭合截面可形成真实壳体与平台凹口，无需使用法线贴图模拟轮廓。
    """
    contours = [rounded_outline(hx, hy, radius, segments=segments, taper=taper) for hx, hy, radius, z in profiles]
    size = len(contours[0])
    vertices = [(x, y, profile[3]) for contour, profile in zip(contours, profiles) for x, y in contour]
    faces = []
    for ring in range(len(profiles) if closed else len(profiles) - 1):
        following = (ring + 1) % len(profiles)
        for index in range(size):
            other = (index + 1) % size
            faces.append((ring * size + index, ring * size + other,
                          following * size + other, following * size + index))
    if not closed and cap:
        faces.extend((tuple(reversed(range(size))), tuple((len(profiles) - 1) * size + i for i in range(size))))
    obj = mesh_object(name, vertices, faces, mat)
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return obj


def bevel(obj, width=0.003, segments=3):
    """
    为板件添加真实边缘倒角，并以加权法线保持平面的干净反射。
    编辑源文件保留这些修改器，导出时使用修改器计算后的几何。
    """
    mod = obj.modifiers.new("Manufactured_Edge_Radius", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(35)
    mod.harden_normals = True
    normal = obj.modifiers.new("Surface_Normals", "WEIGHTED_NORMAL")
    normal.keep_sharp = True
    normal.weight = 40
    return obj


def box(name, dimensions, location, mat, radius=0.003):
    """
    按物理尺寸创建小型板件，先应用缩放再倒角。
    每个网格的局部原点位于部件中心，后续组合不会破坏根节点坐标。
    """
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + "_Mesh"
    relocate(obj, ASSET)
    obj.parent = ROOT
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    if radius:
        bevel(obj, radius)
    return obj


def plate(name, length, width, thickness, radius, location, mat, orientation="TOP"):
    """
    创建带圆角的薄板，可用于平台、检修盖、灯窗和接口面板。
    三种朝向使用同一套轮廓，保持所有制造圆角一致。
    """
    hx, hy = length / 2, width / 2
    obj = loft(name, [(hx, hy, radius, -thickness / 2), (hx, hy, radius, thickness / 2)], mat,
               segments=8 if length > 1.0 else 4)
    obj.location = location
    if orientation == "SIDE":
        obj.rotation_euler.x = math.pi / 2
    if orientation == "FRONT":
        obj.rotation_euler.x = math.pi / 2
        obj.rotation_euler.z = math.pi / 2
    if thickness > 0.008:
        bevel(obj, min(0.0015, thickness * 0.20), 2)
    return obj


def cylinder(name, radius, depth, location, mat, axis="Y", segments=32, edge=0.001, edge_segments=2):
    """
    圆柱用于轮毂、接口和急停按钮，分段数按可见尺寸控制。
    旋转和缩放在创建后应用，便于所有车轮最终共享同一网格数据。
    """
    bpy.ops.mesh.primitive_cylinder_add(vertices=segments, radius=radius, depth=depth, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + "_Mesh"
    relocate(obj, ASSET)
    obj.parent = ROOT
    if axis == "Y":
        obj.rotation_euler.x = math.pi / 2
    if axis == "X":
        obj.rotation_euler.y = math.pi / 2
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if mat:
        obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    if edge:
        bevel(obj, edge, edge_segments)
    return obj


def apply_modifiers(obj):
    """
    在合并零件和重复使用网格之前固定修改器结果。
    主要车壳和平台不经过这里，仍在源文件中保留可编辑的修改器。
    """
    bpy.context.view_layer.objects.active = obj
    for modifier in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)


def recess(obj, cutter):
    """
    真实切出浅凹槽和车轮空间，避免黑色贴片冒充凹陷。
    切割器只在建模过程中存在，不保存到最终车辆集合。
    """
    apply_modifiers(cutter)
    mod = obj.modifiers.new("Recess_" + cutter.name, "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def combine(objects, name, origin=(0, 0, 0)):
    """
    合并不需要独立控制的螺钉、密封条等固定细节，减少绘制调用。
    四个车轮分别保留节点，但轮胎与轮毂在各自车轮内组合。
    """
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        apply_modifiers(obj)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + "_Mesh"
    bpy.context.scene.cursor.location = origin
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    bpy.context.scene.cursor.location = (0, 0, 0)
    return obj


def bumper(name, front):
    """
    防撞橡胶沿前后轮廓包覆并在侧面短距离回折。
    截面有真实圆角，尺寸控制在车体总包围盒之内。
    """
    outline = rounded_outline(0.897, 0.338, 0.10, segments=10, taper=0.045)
    if front:
        outline = outline[33:] + outline[:11]
    else:
        outline = outline[11:33]
    vertices, faces = [], []
    for x, y in outline:
        delta = Vector((x / (0.897 ** 2), y / (0.338 ** 2)))
        delta.normalize()
        for depth, z in ((0, 0.082), (0, 0.121), (0.015, 0.121), (0.015, 0.082)):
            vertices.append((x - delta.x * depth, y - delta.y * depth, z))
    for ring in range(len(outline) - 1):
        for index in range(4):
            nxt = (index + 1) % 4
            faces.append((ring * 4 + index, (ring + 1) * 4 + index, (ring + 1) * 4 + nxt, ring * 4 + nxt))
    faces.extend(((3, 2, 1, 0), tuple((len(outline) - 1) * 4 + i for i in range(4))))
    obj = mesh_object(name, vertices, faces, RUBBER)
    bevel(obj, 0.004, 3)
    return obj


def build_wheels():
    """
    轮胎使用圆润截面和一条很浅的中央环形槽，避免复杂越野花纹。
    原点位于轮轴中心，四个节点共享一份含轮胎与轮毂的网格。
    """
    profile = [(-0.034, 0.058), (-0.034, 0.081), (-0.028, 0.094), (-0.022, 0.098),
               (-0.006, 0.098), (-0.004, 0.0965), (0.004, 0.0965), (0.006, 0.098),
               (0.022, 0.098), (0.028, 0.094), (0.034, 0.081), (0.034, 0.058)]
    segments = 32
    vertices = [(r * math.cos(2 * math.pi * i / segments), y, r * math.sin(2 * math.pi * i / segments))
                for y, r in profile for i in range(segments)]
    faces = []
    for ring in range(len(profile)):
        following = (ring + 1) % len(profile)
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((ring * segments + i, following * segments + i, following * segments + j, ring * segments + j))
    tire = mesh_object("Tire_Master", vertices, faces, RUBBER)
    for face in tire.data.polygons:
        face.use_smooth = True
    parts = [tire, cylinder("Hub_Barrel", 0.0595, 0.065, (0, 0, 0), CHASSIS_MAT, segments=24, edge=0.002, edge_segments=1)]
    for side in (-1, 1):
        parts.append(cylinder("Hub_Face", 0.048, 0.002, (0, side * 0.034, 0), ALLOY, segments=24, edge=0))
        parts.append(cylinder("Hub_Cap", 0.024, 0.004, (0, side * 0.035, 0), CHASSIS_MAT, segments=16, edge_segments=1))
        for i in range(5):
            angle = 2 * math.pi * i / 5
            parts.append(cylinder("Hub_Bolt", 0.004, 0.002, (0.035 * math.cos(angle), side * 0.036, 0.035 * math.sin(angle)), CHASSIS_MAT, segments=6, edge=0))
    master = combine(parts, "Wheel_FL")
    master.data.name = "Wheel_Assembly_Shared"
    for index, (name, x, y) in enumerate((
        ("Wheel_FL", 0.54, 0.300), ("Wheel_FR", 0.54, -0.300),
        ("Wheel_RL", -0.54, 0.300), ("Wheel_RR", -0.54, -0.300),
    )):
        obj = master if index == 0 else bpy.data.objects.new(name, master.data)
        if index:
            ASSET.objects.link(obj)
        obj.name = name
        obj.parent = ROOT
        obj.location = (x, y, 0.098)
        obj["role"] = "wheel"
        obj["rotation_axis_gltf"] = "Z"
        obj["radius_m"] = 0.098


def build_vehicle():
    """
    制作克制的工业外观：有厚度的喷漆罩壳、内收机械底座和空载工作平台。
    雷达窗口位于正向车头，接口面板位于负向车尾，几何轮廓可直接辨别方向。
    """
    shell = loft("Body_Shell", [
        (0.885, 0.338, 0.090, 0.135), (0.897, 0.348, 0.096, 0.141),
        (0.900, 0.350, 0.100, 0.151), (0.900, 0.350, 0.100, 0.294),
        (0.897, 0.348, 0.099, 0.316), (0.889, 0.341, 0.093, 0.334),
        (0.879, 0.331, 0.086, 0.346), (0.870, 0.323, 0.080, 0.350),
        (0.738, 0.271, 0.042, 0.350), (0.733, 0.266, 0.038, 0.346),
        (0.733, 0.266, 0.038, 0.328), (0.753, 0.286, 0.050, 0.316),
        (0.872, 0.322, 0.083, 0.302), (0.882, 0.332, 0.085, 0.144),
    ], SHELL_MAT, closed=True, taper=0.05)
    shell["role"] = "painted_shell"
    chassis = loft("Chassis", [(0.846, 0.310, 0.080, 0.042), (0.861, 0.326, 0.090, 0.055),
                                (0.867, 0.332, 0.090, 0.123), (0.861, 0.328, 0.090, 0.137)], CHASSIS_MAT)
    for x in (-0.54, 0.54):
        for y in (-0.317, 0.317):
            recess(chassis, cylinder("Wheel_Clearance", 0.113, 0.17, (x, y, 0.098), None, edge=0))
    bevel(chassis, 0.002, 2)
    gasket = loft("Body_Assembly_Seam", [(0.881, 0.336, 0.090, 0.129), (0.887, 0.340, 0.092, 0.136)], RUBBER, taper=0.05)
    gasket["role"] = "shell_chassis_gasket"
    bumper("Bumper_Front", True)
    bumper("Bumper_Rear", False)

    deck_seal = plate("Platform_Gasket", 1.463, 0.530, 0.010, 0.037, (0, 0, 0.333), RUBBER)
    platform = plate("Top_Platform", 1.443, 0.510, 0.014, 0.032, (0, 0, 0.335), DECK_MAT)
    platform["surface_height_m"] = 0.342
    for x in (-0.29, 0.29):
        recess(platform, box("Deck_Panel_Seam", (0.0018, 0.510, 0.003), (x, 0, 0.3425), None, radius=0.0005))

    fasteners, vents, bezels = [], [], []
    for side, label in ((-1, "Right"), (1, "Left")):
        recess(shell, box("Service_Recess", (0.592, 0.022, 0.114), (0, side * 0.353, 0.231), None, radius=0.009))
        panel = plate("Service_Cover_" + label, 0.578, 0.101, 0.003, 0.008, (0, side * 0.3455, 0.231), SHELL_MAT, "SIDE")
        for x in (-0.262, 0.262):
            for z in (0.195, 0.267):
                fasteners.append(cylinder("Service_Screw", 0.004, 0.002, (x, side * 0.3480, z), ALLOY, segments=8, edge=0))
        for z in (0.202, 0.216, 0.230):
            recess(shell, box("Vent_Recess", (0.103, 0.021, 0.005), (-0.706, side * 0.349, z), None, radius=0.002))
            vents.append(plate("Vent_Insert", 0.099, 0.0035, 0.001, 0.0014, (-0.706, side * 0.340, z), RUBBER, "SIDE"))

    recess(shell, box("Lidar_Recess", (0.035, 0.222, 0.079), (0.897, 0, 0.228), None, radius=0.012))
    bezels.append(plate("Lidar_Bezel", 0.213, 0.070, 0.008, 0.014, (0.889, 0, 0.228), RUBBER, "FRONT"))
    sensor = plate("Sensor_Lidar_Front", 0.186, 0.047, 0.005, 0.012, (0.895, 0, 0.229), GLASS_MAT, "FRONT")
    sensor["role"] = "lidar_window"

    for side, label in ((-1, "Right"), (1, "Left")):
        recess(shell, box("Front_Light_Recess", (0.033, 0.109, 0.026), (0.898, side * 0.245, 0.230), None, radius=0.005))
        bezels.append(plate("Front_Light_Bezel", 0.104, 0.024, 0.006, 0.006, (0.893, side * 0.245, 0.230), RUBBER, "FRONT"))
        light = plate("StatusLight_Front_" + label, 0.089, 0.012, 0.004, 0.005, (0.897, side * 0.245, 0.231), STATUS_MAT, "FRONT")
        light["role"] = "status_light"

    recess(shell, box("Rear_Interface_Recess", (0.033, 0.249, 0.093), (-0.897, 0, 0.224), None, radius=0.009))
    plate("Interface_Panel_Rear", 0.238, 0.081, 0.006, 0.009, (-0.891, 0, 0.224), RUBBER, "FRONT")
    connectors = []
    for y in (-0.067, -0.015):
        connectors.append(cylinder("Connector_Rim", 0.014, 0.003, (-0.896, y, 0.232), ALLOY, "X", 24, 0.0005))
        cylinder("Interface_Port_" + str(len(connectors)), 0.010, 0.003, (-0.898, y, 0.232), GLASS_MAT, "X", 20, 0.0005)
    for y in (0.045, 0.081):
        connectors.append(box("Charging_Contact", (0.002, 0.018, 0.023), (-0.897, y, 0.228), ALLOY, 0.001))
    combine(connectors, "Interface_Connectors")
    for side, label in ((-1, "Right"), (1, "Left")):
        recess(shell, box("Rear_Light_Recess", (0.033, 0.074, 0.024), (-0.898, side * 0.240, 0.234), None, radius=0.005))
        bezels.append(plate("Rear_Light_Bezel", 0.070, 0.022, 0.006, 0.006, (-0.893, side * 0.240, 0.234), RUBBER, "FRONT"))
        light = plate("StatusLight_Rear_" + label, 0.055, 0.010, 0.004, 0.004, (-0.897, side * 0.240, 0.234), STATUS_MAT, "FRONT")
        light["role"] = "status_light"

    recess(shell, cylinder("Emergency_Recess", 0.023, 0.030, (0.614, -0.351, 0.286), None, segments=32, edge=0.001))
    cylinder("Emergency_Stop_Base", 0.021, 0.004, (0.614, -0.339, 0.286), RUBBER, edge=0.001)
    cylinder("Emergency_Stop", 0.015, 0.008, (0.614, -0.346, 0.286), RED_MAT, edge=0.002)

    for x in (-0.788, 0.788):
        for y in (-0.240, 0.240):
            fasteners.append(cylinder("Top_Screw", 0.0042, 0.002, (x, y, 0.349), ALLOY, "Z", 8, 0))
    combine(fasteners, "Shell_Fasteners")
    combine(vents, "Side_Vent_Inserts")
    combine(bezels, "Sensor_Light_Bezels")
    """
    浅槽切割后的大平面采用平面法线，圆角段仍保持连续平滑法线。
    这样可以消除急停按钮和检修盖附近由布尔面三角化引起的斜向明暗条纹。
    """
    shell.data.update()
    for face in shell.data.polygons:
        if max(abs(component) for component in face.normal) > 0.99999:
            face.use_smooth = False
    build_wheels()
    """
    成对的灯带、检修盖和接口复用同一份几何数据。
    它们仍保留独立节点与位置，既支持单独控制，又减少文件内的重复网格。
    """
    for source_name, target_name in (
        ("StatusLight_Front_Left", "StatusLight_Front_Right"),
        ("StatusLight_Rear_Left", "StatusLight_Rear_Right"),
        ("Service_Cover_Left", "Service_Cover_Right"),
        ("Interface_Port_1", "Interface_Port_2"),
    ):
        bpy.data.objects[target_name].data = bpy.data.objects[source_name].data


def point_at(obj, point):
    """
    将预览相机或面光源朝向车辆中心。
    该方向仅影响摄影棚，不参与车辆坐标转换。
    """
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def make_studio():
    """
    创建中性摄影棚，柔和阴影和反射全部在渲染时计算。
    摄影棚单独归组，既便于源文件预览，也确保模型导出干净。
    """
    studio = collection("Studio_Preview_DO_NOT_EXPORT")
    floor_mat = material("Preview_Floor_Only", "a8b0b3", 0.83)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.001))
    floor = bpy.context.object
    floor.name = "Preview_Ground"
    floor.data.materials.append(floor_mat)
    relocate(floor, studio)
    for name, position, power, size, color in (
        ("Key_Softbox", (1.0, -2.5, 3.7), 480, 3.2, (1.0, 0.94, 0.88)),
        ("Fill_Softbox", (-1.0, 2.5, 2.8), 400, 2.8, (0.84, 0.92, 1.0)),
        ("Front_Softbox", (3.0, 0.4, 1.8), 150, 2.0, (1.0, 1.0, 1.0)),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.shape, data.size, data.color = power, "DISK", size, color
        obj = bpy.data.objects.new(name, data)
        studio.objects.link(obj)
        obj.location = position
        point_at(obj, (0, 0, 0.15))
    cam = bpy.data.objects.new("Preview_Camera", bpy.data.cameras.new("Preview_Camera"))
    studio.objects.link(cam)
    cam.location = (2.9, -3.65, 2.75)
    point_at(cam, (0, 0, 0.16))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.56
    scene = bpy.context.scene
    scene.camera = cam
    if scene.world is None:
        scene.world = bpy.data.worlds.new("Preview_World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.32, 0.36, 0.40, 1.0)
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.35
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.overlay.show_overlays = False
                space.shading.type = "MATERIAL"
                space.region_3d.view_distance = 2.55
                space.region_3d.view_location = (0, 0, 0.17)
                space.region_3d.view_rotation = cam.rotation_euler.to_quaternion()
    return studio


def verify_reimport():
    """
    将最终二进制模型导入全新场景并逐顶点核对尺寸和落地点。
    预览图也使用重新导入的模型生成，因此展示的是实际交付资产。
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for col in list(bpy.data.collections):
        bpy.data.collections.remove(col)
    bpy.ops.import_scene.gltf(filepath=str(GLB_PATH))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    points = [obj.matrix_world @ v.co for obj in objects for v in obj.data.vertices]
    low = [min(v[i] for v in points) for i in range(3)]
    high = [max(v[i] for v in points) for i in range(3)]
    wheels = {}
    for obj in objects:
        if obj.name.startswith("Wheel_"):
            wheels[obj.name] = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    root = bpy.data.objects.get("AGV_Industrial")
    actual = [high[i] - low[i] for i in range(3)]
    passed = all(abs(a - b) < 0.0001 for a, b in zip(actual, (LENGTH, WIDTH, HEIGHT)))
    passed = passed and all(abs(z) < 0.00001 for z in wheels.values()) and len(wheels) == 4
    passed = passed and root is not None and root.matrix_world.translation.length < 0.00001
    passed = passed and bpy.data.objects["Sensor_Lidar_Front"].matrix_world.translation.x > 0
    report = {
        "passed": passed,
        "dimensions_m_length_width_height": actual,
        "blender_bounds_min": low,
        "blender_bounds_max": high,
        "gltf_axis_conversion": "Blender (x,y,z) -> glTF (x,z,-y)",
        "gltf_forward": "+X",
        "wheel_ground_heights_m": wheels,
        "root_at_ground_center": root is not None and root.matrix_world.translation.length < 0.00001,
        "mesh_objects_after_reimport": len(objects),
        "dimension_source": "json/vehicle.json agvDimension.length and width; assumed height 0.35 m",
    }
    (HERE / "blender_validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("AGV_REIMPORT_CHECK", json.dumps(report))
    if not passed:
        raise RuntimeError("导出模型的尺寸、原点或轮胎落地检查未通过")
    make_studio()
    bpy.context.scene.render.filepath = str(HERE / "agv_industrial_preview.png")
    bpy.ops.render.render(write_still=True)


"""
脚本仅重置自身启动的独立 Blender 后台进程，不影响用户已有窗口。
车辆资产选中导出后再建立摄影棚，并保存包含可编辑部件的源文件。
"""
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene.unit_settings.scale_length = 1.0
ASSET = collection("AGV_Asset")
ROOT = bpy.data.objects.new("AGV_Industrial", None)
ASSET.objects.link(ROOT)
ROOT.empty_display_type = "PLAIN_AXES"
ROOT.empty_display_size = 0.18
ROOT["dimensions_m"] = [LENGTH, HEIGHT, WIDTH]
ROOT["forward_axis"] = "+X"
ROOT["up_axis_gltf"] = "+Y"
ROOT["origin"] = "ground_center"
ROOT["platform_height_m"] = 0.342
ROOT["center_offset_applied"] = False
SHELL_MAT = material("Paint_LightGray", "c8cfd0", 0.43, 0.10)
CHASSIS_MAT = material("Chassis_DarkGray", "343d43", 0.67, 0.30)
DECK_MAT = material("Platform_Matte", "262d31", 0.81, 0.12)
RUBBER = material("Rubber_Black", "171c20", 0.88)
GLASS_MAT = material("Sensor_Glass", "0b151b", 0.22, 0.13)
ALLOY = material("Hardware_SatinMetal", "65747c", 0.42, 0.72)
STATUS_MAT = material("Status_Emission", "10c9b5", 0.34, emission=True)
RED_MAT = material("Emergency_Red", "bd2926", 0.52)
build_vehicle()

"""
这里按项目的真实长宽调整几何与部件位置，根节点始终保持单位变换。
共享网格仅处理一次，避免四个车轮因为共用数据而被重复缩放。
"""
scaled_meshes = set()
for obj in ASSET.objects:
    if obj.type == "MESH":
        obj.location.x *= SCALE_X
        obj.location.y *= SCALE_Y
        if obj.data not in scaled_meshes:
            for vertex in obj.data.vertices:
                vertex.co.x *= SCALE_X
                vertex.co.y *= SCALE_Y
            scaled_meshes.add(obj.data)
bpy.context.view_layer.update()
GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for obj in ASSET.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = ROOT
bpy.ops.export_scene.gltf(filepath=str(GLB_PATH), export_format="GLB", use_selection=True,
                          export_yup=True, export_apply=True, export_animations=False,
                          export_cameras=False, export_lights=False, export_extras=True,
                          export_texcoords=False, export_normals=True, export_materials="EXPORT",
                          export_shared_accessors=True)
make_studio()
bpy.ops.object.select_all(action="DESELECT")
ROOT.select_set(True)
bpy.context.view_layer.objects.active = ROOT
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
verify_reimport()
print("AGV_COMPLETE", str(GLB_PATH))
