"""
直接调用 Blender 构建参考图中的低矮概念运输机器人。
所有长度均为米，车头朝 Blender 负 Y；导出后对应 Three.js 正 Z。
生成文件只包含车体，摄影棚仅用于离线检查且不写入交付文件。
"""

import bpy
import bmesh
import json
import math
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion


HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
GLB = PROJECT / "public" / "models" / "AGV_FUTURE.glb"
BLEND = HERE / "AGV_FUTURE.blend"
PI = math.pi


def material(name, hex_color, metallic, roughness, emission=None):
    """
    仅构建可导出的标准金属度、粗糙度和自发光节点。
    发光颜色独立设置，车身的基础色不含任何烘焙光晕。
    """
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    rgb = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*rgb, 1)
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = 4
    return mat


def mesh(name, vertices, faces, mat):
    """
    根据轮廓建立真实封闭网格，并统一外向法线。
    每个独立可控部件直接挂到统一的车体根节点。
    """
    data = bpy.data.meshes.new(name + '_Mesh')
    data.from_pydata(vertices, [], faces)
    data.update()
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data)
    bm.free()
    obj = bpy.data.objects.new(name, data)
    ASSET.objects.link(obj)
    obj.parent = ROOT
    if mat:
        obj.data.materials.append(mat)
    return obj


def activate(obj):
    """
    显式指定当前操作对象，防止批量操作误选其他部件。
    所有变换和修改器都在明确的对象上下文中应用。
    """
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def finish(obj, bevel=0, segments=3, smooth=True):
    """
    小尺度真实倒角提供边缘高光，加权法线保持大平面的工业质感。
    应用修改器后再导出，保证其他引擎读到相同的几何形状。
    """
    # 按零件尺度限制倒角分段，细小紧固件保留一段即可表达高光。
    # 外壳保留两段倒角，弧面精度主要由轮廓决定，避免无效细分。
    segments = min(segments, 1 if bevel < .002 else 2)
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if bevel:
        mod = obj.modifiers.new('工业边缘倒角', 'BEVEL')
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(24)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
        mod = obj.modifiers.new('加权面法线', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
        mod.weight = 40
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def cube(name, loc, size, mat, bevel=0.004, segments=3):
    """
    方形零部件在真实尺寸下倒角，避免缩放影响倒角宽度。
    所有尺寸在网格中固化，对象缩放保持为一。
    """
    x, y, z = [v / 2 for v in size]
    obj = mesh(name, [(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),
                            (-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)],
                     [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], mat)
    obj.location = loc
    return finish(obj, bevel, segments)


def octagon(hx, hy, cut):
    """
    平面轮廓以四角切削建立整车的统一设计语言。
    所有高度截面保持一致的顶点顺序，便于生成斜肩与腰线。
    """
    return [(-hx+cut,-hy),(hx-cut,-hy),(hx,-hy+cut),(hx,hy-cut),
            (hx-cut,hy),(-hx+cut,hy),(-hx,hy-cut),(-hx,-hy+cut)]


def loft(name, levels, mat, bevel=0.004, segments=3):
    """
    连续连接等点数截面形成封闭外壳，支持四角切削和肩部收分。
    截面的层级变化构成真实体积，不用贴图伪造结构。
    """
    count = len(levels[0][1])
    verts = [(x, y, z) for z, points in levels for x, y in points]
    faces = [tuple(reversed(range(count))), tuple((len(levels)-1)*count+i for i in range(count))]
    for k in range(len(levels)-1):
        for i in range(count):
            j = (i+1) % count
            faces.append((k*count+i,k*count+j,(k+1)*count+j,(k+1)*count+i))
    return finish(mesh(name, verts, faces, mat), bevel, segments)


def prism(name, points, low, high, mat, axis='Z', bevel=0.003, segments=3):
    """
    沿指定轴挤出二维面板，适合前脸凹面、侧面轮拱和分块顶板。
    正反面以及边缘完整封闭，避免浏览器背面剔除造成缺面。
    """
    count = len(points)
    if axis == 'X':
        verts = [(d,a,b) for d in (low,high) for a,b in points]
    elif axis == 'Y':
        verts = [(a,d,b) for d in (low,high) for a,b in points]
    else:
        verts = [(a,b,d) for d in (low,high) for a,b in points]
    faces = [tuple(reversed(range(count))),tuple(count+i for i in range(count))]
    faces += [(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]
    return finish(mesh(name,verts,faces,mat),bevel,segments)


def ring(name, outer, inner, low, high, mat, bevel=0.002):
    """
    使用内外轮廓建立实心环形边框，中间保留真实面板嵌入空间。
    该结构同时用于顶盖金属边轨和底部防撞包边。
    """
    n = len(outer)
    verts = [(x,y,z) for z in (low,high) for loop in (outer,inner) for x,y in loop]
    faces = []
    for i in range(n):
        j = (i+1)%n
        faces.extend([(i,j,2*n+j,2*n+i),(n+j,n+i,3*n+i,3*n+j),
                      (2*n+i,2*n+j,3*n+j,3*n+i),(j,i,n+i,n+j)])
    return finish(mesh(name,verts,faces,mat),bevel,3)


def lathe(name, profile, mat, segments=64, axis='Z', loc=(0,0,0)):
    """
    通过径向截面构建轮胎、轮毂和雷达旋转体，保留合理的弧面分段。
    轮子的几何直接绕本地横轴生成，对象旋转可以保持为零。
    """
    # 六十四个径向分段足以保证车轮近景轮廓平滑。
    # 环形状态灯共享相同精度，避免把预算浪费在不可见的背面。
    segments = min(segments,64)
    verts = []
    for r,d in profile:
        for i in range(segments):
            a = 2*PI*i/segments
            if axis == 'X':
                verts.append((d,r*math.cos(a),r*math.sin(a)))
            else:
                verts.append((r*math.cos(a),r*math.sin(a),d))
    faces = []
    for k in range(len(profile)):
        q = (k+1)%len(profile)
        for i in range(segments):
            j = (i+1)%segments
            faces.append((k*segments+i,k*segments+j,q*segments+j,q*segments+i))
    obj = mesh(name,verts,faces,mat)
    obj.location = loc
    return finish(obj,0,3)


def cylinder(name, loc, radius, depth, mat, axis='Z', vertices=48, bevel=0.002):
    """
    传感器与紧固件使用有限边数圆柱，并在应用方向变换后处理边缘。
    不保留无法导出的 Blender 专属材质或几何节点。
    """
    # 根据实际半径设置分段预算，小孔和螺栓不使用传感器外壳的精度。
    # 轮廓最大四十八段，配合加权法线满足实时模型近距离观察。
    vertices = min(vertices,12 if radius < .015 else 24 if radius < .04 else 48)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    ASSET.objects.link(obj)
    obj.parent = ROOT
    obj.data.materials.append(mat)
    if axis == 'X':
        obj.rotation_euler[1] = PI/2
    elif axis == 'Y':
        obj.rotation_euler[0] = PI/2
    return finish(obj,bevel,3)


def ribbon(name, path, z, height, thickness, mat, bevel=0.0015):
    """
    沿车体外缘挤出独立灯带，转角处保持连续的真实发光表面。
    灯罩、发光芯和车壳相互独立，后续可直接按对象名称控制。
    """
    outer, inner = [], []
    for i,p in enumerate(path):
        prev = Vector(path[max(0,i-1)])
        nxt = Vector(path[min(len(path)-1,i+1)])
        tangent = (nxt-prev).normalized()
        normal = Vector((-tangent.y,tangent.x))
        outer.append(tuple(Vector(p)+normal*thickness/2))
        inner.append(tuple(Vector(p)-normal*thickness/2))
    return prism(name,outer+list(reversed(inner)),z-height/2,z+height/2,mat,bevel=bevel)


def join(objects, name, origin=(0,0,0)):
    """
    将同一功能部件的静态细节合并以降低浏览器绘制调用。
    车轮中心与雷达轴心单独设置，合并不会破坏其旋转控制。
    """
    objects = [o for o in objects if o and o.name in bpy.data.objects]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    bpy.context.scene.cursor.location = origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    obj.parent = ROOT
    return obj


def bolt(loc, axis='Z', radius=0.0055):
    """
    面板紧固件采用有限六边形凹槽和金属帽，表达可维护结构。
    紧固件最终按材质归并，不为装饰产生大量独立对象。
    """
    METAL_DETAILS.append(cylinder('Captive_Fastener',loc,radius,0.0022,METAL_DARK,axis,24,0.0006))
    delta = {'X':(0.0013,0,0),'Y':(0,-0.0013,0),'Z':(0,0,0.0013)}[axis]
    target = tuple(loc[i]+delta[i] for i in range(3))
    BLACK_DETAILS.append(cylinder('Hex_Drive',target,radius*.40,0.0008,BLACK,axis,6,0.00015))


def label(name, text, loc, size, mat, rot=(0,0,0)):
    """
    必要的编号和铭牌使用少量真实矢量字形，完全自包含。
    转成网格后纳入静态标识对象，无字体或外部纹理依赖。
    """
    curve = bpy.data.curves.new(name,'FONT')
    curve.body = text
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.size = size
    curve.space_character = 1.2
    curve.extrude = 0.0001
    curve.resolution_u = 3
    obj = bpy.data.objects.new(name,curve)
    ASSET.objects.link(obj)
    obj.parent = ROOT
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    activate(obj)
    bpy.ops.object.convert(target='MESH')
    obj = bpy.context.object
    finish(obj,0,smooth=False)
    LABELS.append(obj)
    return obj


"""
初始化独立的资产场景，米制比例和统一根节点写入自定义属性。
不读取或修改项目已有模型，也不修改应用逻辑。
"""
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
ASSET = bpy.data.collections.new('AGV_FUTURE_ASSET')
scene.collection.children.link(ASSET)
ROOT = bpy.data.objects.new('AGV_ROOT',None)
ASSET.objects.link(ROOT)
ROOT.empty_display_type = 'PLAIN_AXES'
ROOT.empty_display_size = .25
ROOT['asset'] = 'AGV_FUTURE'
ROOT['units'] = 'meter'
ROOT['forward_axis_gltf'] = '+Z'
ROOT['up_axis_gltf'] = '+Y'
ROOT['forward_axis_blender'] = '-Y'
ROOT['origin'] = 'ground contact plane, footprint center'
ROOT['wheel_spin_axis'] = 'local X'
ROOT['reference_design'] = 'Low-profile chamfered silver AGV; cyan front and sides; red rear'
SILVER = material('Body_Metal_Silver','9AA8B8',.82,.28)
METAL_DARK = material('Body_Metal_Graphite','303C4A',.75,.32)
BLACK = material('Panel_Black','101821',.46,.26)
RUBBER = material('Rubber_Black','13171B',.02,.78)
GLASS = material('Sensor_Dark_Glass','071725',.32,.115)
MARKING = material('Marking_Satin_Silver','A7B5C5',.52,.38)
CYAN = material('Cyan_Emissive','063F57',.10,.26,(0.006,.70,1.0))
RED = material('Red_Emissive','570809',.05,.28,(1.0,.009,.004))
BLUE = material('LiDAR_Blue_Emissive','092754',.10,.24,(.004,.22,1.0))
METAL_DETAILS, BLACK_DETAILS, LABELS = [], [], []


"""
第一阶段建立底盘与承载平台，内部核心向内收缩以给轮组留出空间。
轮胎接地点位于零高度，底盘保持约六厘米离地间隙。
"""
loft('Chassis_Core',[(.062,octagon(.526,1.10,.11)),(.092,octagon(.552,1.137,.115)),
                     (.345,octagon(.552,1.137,.115)),(.378,octagon(.578,1.149,.12))],BLACK,.007)
loft('Underbody_Belly',[(.058,octagon(.487,1.015,.12)),(.071,octagon(.519,1.045,.12))],METAL_DARK,.003)
ring('Deck_Perimeter_Gasket',octagon(.624,1.174,.141),octagon(.555,1.106,.13),.394,.407,RUBBER,.004)
ring('Deck_Silver_Edge',octagon(.617,1.167,.142),octagon(.575,1.124,.137),.407,.425,SILVER,.0045)
loft('Deck_Inset_Base',[(.387,octagon(.578,1.128,.14)),(.417,octagon(.578,1.128,.14))],BLACK,.004)


"""
四角外壳用多高度截面形成切削肩线，前后共用同一设计轮廓。
上下银色外壳由深色细缝分开，轮位附近保留清晰的机械分区。
"""
corner_path = [(.445,-1.20),(.500,-1.20),(.650,-1.05),(.650,-.934),(.578,-.934),(.578,-1.010),(.462,-1.126),(.445,-1.126)]
for sx in (-1,1):
    for sy in (-1,1):
        name = ('L' if sx<0 else 'R')+('F' if sy<0 else 'R')
        def section(z, inset):
            """
            沿前后与左右两个对称方向复用同一转角设计。
            上段同时内收横向和纵向，形成概念车式斜肩。
            """
            return (z,[(sx*(x-inset),(-sy)*(y+inset)) for x,y in corner_path])
        loft('Armor_Corner_'+name,[section(.086,.008),section(.102,0),section(.326,0)],SILVER,.007,4)
        loft('Shoulder_Corner_'+name,[section(.329,.001),section(.351,.012),section(.393,.033)],SILVER,.0045,3)
        path = [(sx*.447,sy*1.193),(sx*.501,sy*1.193),(sx*.644,sy*1.048),(sx*.644,sy*.937)]
        ribbon('Bumper_Corner_'+name,path,.079,.025,.031,RUBBER,.005)


"""
侧板的轮拱直接从二维工业面板轮廓中建立，避免轮子穿出完整盒体。
连续上腰线将前后金属切角连接成低矮长车身。
"""
side_points = [(-.949,.335),(-.894,.363),(.894,.363),(.949,.335),(.949,.080)]
arc_start = math.asin((.080-.147)/.170)
for wheel_y in (.766,-.766):
    for i in range(29):
        a = arc_start+(PI-2*arc_start)*i/28
        side_points.append((wheel_y+.170*math.cos(a),.147+.170*math.sin(a)))
side_points.append((-.949,.080))
for sx in (-1,1):
    side = 'L' if sx<0 else 'R'
    prism('Side_Panel_'+side,side_points,min(sx*.584,sx*.638),max(sx*.584,sx*.638),METAL_DARK,'X',.004,3)
    rail = cube('Shoulder_Rail_'+side,(sx*.601,0,.380),(.060,1.877,.065),BLACK,.010,3)
    rail.rotation_euler[1] = sx*math.radians(-20)
    finish(rail,0)
    cube('Side_Light_Recess_'+side,(sx*.642,0,.172),(.007,.995,.038),BLACK,.011,4)
    cube('Light_Side_'+side,(sx*.647,0,.173),(.008,.931,.013),CYAN,.005,4)
    cube('Rocker_Rail_'+side,(sx*.625,0,.091),(.031,1.160,.028),RUBBER,.005,3)
    cube('Rocker_Edge_'+side,(sx*.638,0,.109),(.007,1.14,.009),SILVER,.002,2)
    for wheel_y in (-.766,.766):
        path = []
        for i in range(41):
            a = -.35+(PI+.70)*i/40
            path.append((wheel_y+.173*math.cos(a),.147+.173*math.sin(a)))
        inner = [(wheel_y+.163*math.cos(-.35+(PI+.70)*i/40),.147+.163*math.sin(-.35+(PI+.70)*i/40)) for i in range(41)]
        BLACK_DETAILS.append(prism('Wheel_Arch_Seal',path+list(reversed(inner)),min(sx*.639,sx*.644),max(sx*.639,sx*.644),RUBBER,'X',.001,2))


"""
前脸采用嵌入式黑色面板与大跨度青蓝灯带，车尾以红色识别灯区分。
灯芯均为独立封闭网格，其材质自发光不依赖任何预览灯光。
"""
face = [(-.452,.345),(.452,.345),(.452,.150),(.430,.126),(-.430,.126),(-.452,.150)]
frame = [(-.472,.355),(.472,.355),(.472,.139),(.441,.111),(-.441,.111),(-.472,.139)]
for sy in (-1,1):
    end = 'Front' if sy<0 else 'Rear'
    prism('Fascia_Seal_'+end,frame,min(sy*1.177,sy*1.188),max(sy*1.177,sy*1.188),RUBBER,'Y',.010,4)
    prism('Fascia_Black_'+end,face,min(sy*1.180,sy*1.193),max(sy*1.180,sy*1.193),BLACK,'Y',.009,4)
    cube('Lower_Chin_'+end,(0,sy*1.172,.101),(.913,.047,.043),SILVER,.009,4)
    cube('Bumper_'+end,(0,sy*1.183,.072),(.938,.040,.024),RUBBER,.008,3)
    for sx in (-1,1):
        path = [(sx*.465,sy*1.201),(sx*.50,sy*1.201),(sx*.651,sy*1.05),(sx*.651,sy*.979)]
        ribbon('Light_Bezel_'+end+('_L' if sx<0 else '_R'),path,.275,.037,.010,BLACK,.003)
        ribbon('Light_'+end+('_Wrap_L' if sx<0 else '_Wrap_R'),path,.275,.020,.013,CYAN if sy<0 else RED,.002)
cube('Front_Light_Black_Recess',(0,-1.196,.341),(1.033,.014,.040),BLACK,.012,4)
cube('Light_Front_Main',(0,-1.205,.342),(.984,.010,.018),CYAN,.006,5)
cube('Light_Front_Lower',(0,-1.196,.082),(.694,.005,.007),CYAN,.002,3)
cube('Rear_Charge_Hatch',(0,1.199,.143),(.300,.028,.143),BLACK,.012,4)
cube('Rear_Charge_Trim',(0,1.216,.144),(.108,.009,.064),METAL_DARK,.008,3)
cube('Rear_Charge_Socket',(0,1.222,.144),(.078,.005,.038),RUBBER,.004,3)
for x in (-.020,0,.020):
    METAL_DETAILS.append(cube('Charge_Contact',(x,1.226,.143),(.010,.003,.019),SILVER,.002,3))


"""
顶面由承载盖板、前部传感器面板与后部服务面板构成。
窄分缝、少量锁扣和固定孔沿对称轴安排，避免无意义细节堆叠。
"""
deck_front = [(-.562,-.789),(-.562,-.993),(-.448,-1.108),(.448,-1.108),(.562,-.993),(.562,-.789)]
prism('Deck_Front_Service',deck_front,.417,.430,METAL_DARK,bevel=.003)
prism('Deck_Rear_Service',[(x,-y) for x,y in deck_front],.417,.430,METAL_DARK,bevel=.003)
for idx,(y0,y1) in enumerate([(-.781,-.267),(-.258,.258),(.267,.781)]):
    panel = [(-.551,y0+.032),(-.520,y0),(.520,y0),(.551,y0+.032),(.551,y1-.032),(.520,y1),(-.520,y1),(-.551,y1-.032)]
    prism('Deck_Cargo_Panel_'+str(idx+1).zfill(2),panel,.417,.433,BLACK,bevel=.003)
    for sx in (-1,1):
        for y in (y0+.057,y1-.057):
            bolt((sx*.514,y,.434))
    for x in (-.352,.352):
        BLACK_DETAILS.append(cube('Flush_Latch_Pocket',(x,y0+.039,.434),(.104,.048,.002),RUBBER,.008,3))
        METAL_DETAILS.append(cube('Flush_Latch',(x,y0+.039,.436),(.066,.017,.003),METAL_DARK,.004,3))
for x in (-.563,.563):
    for y in (-.948,-.62,0,.62,.948):
        bolt((x,y,.428),radius=.0046)
for y in (-1.070,1.070):
    for x in (-.436,.436):
        METAL_DETAILS.append(cylinder('Lifting_Insert',(x,y,.432),.014,.004,SILVER,'Z',32,.001))
        BLACK_DETAILS.append(cylinder('Lifting_Insert_Bore',(x,y,.4345),.008,.002,BLACK,'Z',24,.0006))
for sx in (-1,1):
    for y in (-.43,.43):
        bolt((sx*.642,y,.320),'X')
        bolt((sx*.642,y,.131),'X')
    for sy in (-1,1):
        for k in range(3):
            vent = cube('Shoulder_Cooling_Slot',(sx*(.570+.010*k),sy*(1.076-.010*k),.369),(.004,.018,.010),BLACK,.001,2)
            vent.rotation_euler[2] = sx*sy*PI/4
            finish(vent,0)
            BLACK_DETAILS.append(vent)
label('Front_Logotype','A G V',(0,-1.1955,.216),.075,MARKING,(PI/2,0,0))
label('Front_Subtitle','AUTONOMOUS  /  MOBILE  PLATFORM',(0,-1.1958,.174),.010,MARKING,(PI/2,0,0))
for sx in (-1,1):
    rotation = (PI/2,0,PI/2 if sx>0 else -PI/2)
    label('Side_Unit_Number','01',(sx*.640,-.365 if sx>0 else .365,.279),.085,MARKING,rotation)
    label('Side_Unit_Type','AGV  /  E-240',(sx*.641,-.352 if sx>0 else .352,.221),.017,MARKING,rotation)
label('Deck_Service_Label','AUTONOMOUS  TRANSPORT',(0,.980,.431),.018,MARKING)


"""
传感器使用独立光学窗、安装座和雷达组件，主雷达原点在旋转轴上。
顶部蓝色状态环独立于雷达主体，可单独调色或控制亮灭。
"""
sensor_parts = []
for sy in (-1,1):
    end = 'Front' if sy<0 else 'Rear'
    z = .290 if sy<0 else .310
    sensor_parts.append(cube('Camera_Frame_'+end,(0,sy*1.199,z),(.094,.015,.060),METAL_DARK,.009,4))
    sensor_parts.append(cube('Camera_Window_'+end,(0,sy*1.208,z),(.075,.006,.043),GLASS,.007,4))
    sensor_parts.append(cylinder('Camera_Lens_Rim_'+end,(0,sy*1.214,z),.017,.006,SILVER,'Y',48,.002))
    lens = cylinder('Sensor_Camera_'+end,(0,sy*1.218,z),.012,.004,GLASS,'Y',48,.001)
    lens['component'] = 'camera_optics'
    sensor_parts.append(cylinder('Camera_Optical_Center_'+end,(0,sy*1.221,z),.005,.001,BLACK,'Y',32,.0004))
for sx in (-1,1):
    for sy in (-1,1):
        sensor_parts.append(cylinder('Proximity_Rim',(sx*.652,sy*.966,.175),.018,.008,METAL_DARK,'X',32,.002))
        cylinder('Sensor_Proximity_'+('L' if sx<0 else 'R')+('F' if sy<0 else 'R'),(sx*.657,sy*.966,.175),.013,.006,GLASS,'X',32,.001)
lidar_origin = (0,-.868,.433)
lidar_parts = [cylinder('Lidar_Plinth',(0,-.868,.438),.097,.010,BLACK,'Z',80,.003),
               cylinder('Lidar_Base',(0,-.868,.447),.084,.013,SILVER,'Z',80,.002)]
lidar_parts.append(lathe('Lidar_Casing',[(.069,.455),(.076,.458),(.078,.465),(.078,.513),(.076,.523),(.068,.529),(.010,.529),(.010,.455)],GLASS,96,loc=(0,-.868,0)))
lidar_parts.append(cylinder('Lidar_Crown',(0,-.868,.530),.079,.009,METAL_DARK,'Z',96,.003))
lidar_parts.append(cylinder('Lidar_Cap_Inlay',(0,-.868,.535),.064,.003,BLACK,'Z',80,.001))
lidar = join(lidar_parts,'LiDAR_Top',lidar_origin)
lidar['component'] = 'lidar_rotor'
lidar['spin_axis_blender'] = '+Z'
lidar['spin_axis_gltf'] = '+Y'
lathe('Light_LiDAR_Ring',[(.078,.457),(.079,.458),(.079,.463),(.078,.464),(.076,.464),(.076,.457)],BLUE,96,loc=(0,-.868,0))
cube('Light_LiDAR_Front',(0,-.947,.481),(.009,.003,.025),BLUE,.002,3)
cylinder('Rear_Localization_Base',(0,.901,.439),.045,.014,METAL_DARK,'Z',64,.002)
cylinder('Rear_Localization_Cap',(0,.901,.451),.036,.012,GLASS,'Z',64,.002)
lathe('Light_Rear_Localization',[(.036,.443),(.038,.444),(.038,.447),(.036,.448)],BLUE,64,loc=(0,.901,0))
join(sensor_parts,'Sensor_Mounts')


"""
四个相同尺寸的驱动轮采用有侧壁曲率的实心工业橡胶胎。
轮毂、轴帽、螺栓与轮胎合并到各自轮子对象，绕本地横轴即可转动。
"""
tire_profile = [(.091,-.047),(.116,-.050),(.132,-.047),(.141,-.039),(.146,-.028),(.147,-.014),
                (.147,.014),(.146,.028),(.141,.039),(.132,.047),(.116,.050),(.091,.047)]
for sx in (-1,1):
    for sy in (-1,1):
        center = (sx*.589,sy*.766,.147)
        name = 'Wheel_'+('F' if sy<0 else 'R')+('L' if sx<0 else 'R')
        parts = [lathe('Solid_Industrial_Tire',tire_profile,RUBBER,80,'X',center)]
        rim_profile = [(.012,sx*.032),(.090,sx*.032),(.104,sx*.041),(.108,sx*.045),(.108,sx*.049),
                       (.100,sx*.052),(.086,sx*.053),(.078,sx*.046),(.035,sx*.047),(.012,sx*.047)]
        parts.append(lathe('Cast_Alloy_Wheel',rim_profile,METAL_DARK,80,'X',center))
        parts.append(lathe('Machined_Rim',[(.105,sx*.050),(.109,sx*.051),(.109,sx*.053),(.105,sx*.054)],SILVER,80,'X',center))
        parts.append(cylinder('Axle_Cap',(center[0]+sx*.052,center[1],center[2]),.036,.012,BLACK,'X',64,.002))
        parts.append(cylinder('Axle_Center',(center[0]+sx*.059,center[1],center[2]),.014,.003,METAL_DARK,'X',48,.001))
        for i in range(6):
            a = 2*PI*i/6
            y,z = center[1]+.058*math.cos(a),center[2]+.058*math.sin(a)
            parts.append(cylinder('Wheel_Bolt',(center[0]+sx*.050,y,z),.0055,.004,SILVER,'X',12,.0007))
            y,z = center[1]+.080*math.cos(a+PI/6),center[2]+.080*math.sin(a+PI/6)
            inset = cube('Wheel_Radial_Pocket',(center[0]+sx*.050,y,z),(.002,.014,.023),BLACK,.005,3)
            inset.rotation_euler[0] = a+PI/6
            finish(inset,0)
            parts.append(inset)
        wheel = join(parts,name,center)
        wheel['component'] = 'wheel'
        wheel['radius_m'] = .147
        wheel['spin_axis'] = '+X'


"""
最终合并紧固件与标识，保留灯光、传感器、轮组的控制边界。
所有对象应用旋转和缩放，根节点位于车体底部中心且为单位变换。
"""
join(METAL_DETAILS,'Fasteners_Metal')
join(BLACK_DETAILS,'Seals_And_Service_Details')
join(LABELS,'Identification_Markings')
# 使用真正的镜像修改器统一左右侧板，并在导出前应用到实体网格。
# 对称基准就是根节点横向零平面，因此不会引入负缩放或反向法线。
left_panel = bpy.data.objects.get('Side_Panel_L')
bpy.data.objects.remove(left_panel,do_unlink=True)
side_panel = bpy.data.objects.get('Side_Panel_R')
activate(side_panel)
mirror = side_panel.modifiers.new('左右结构镜像','MIRROR')
mirror.use_axis = (True,False,False)
mirror.use_clip = True
bpy.ops.object.modifier_apply(modifier=mirror.name)
side_panel.name = 'Body_Side_Panels'
finish(side_panel,0)

# 按功能归并无需动画的静态结构，降低多车场景的基础绘制调用。
# 灯光、主雷达、光学传感器和四个车轮继续保留独立控制节点。
static_groups = {
    'Body_Silver_Armor': ['Armor_Corner_','Shoulder_Corner_','Lower_Chin_','Rocker_Edge_','Deck_Silver_Edge'],
    'Body_Deck_Panels': ['Deck_Front_Service','Deck_Rear_Service','Deck_Cargo_Panel_','Deck_Inset_Base'],
    'Body_Shoulder_Rails': ['Shoulder_Rail_'],
    'Body_Bumpers': ['Bumper_','Rocker_Rail_'],
    'Body_Light_Housings': ['Light_Bezel_','Side_Light_Recess_','Front_Light_Black_Recess'],
    'Body_Panel_Seals': ['Fascia_Seal_','Deck_Perimeter_Gasket'],
    'Body_Black_Fascias': ['Fascia_Black_'],
    'Rear_Charge_Interface': ['Rear_Charge_Hatch','Rear_Charge_Trim','Rear_Charge_Socket'],
}
for name,prefixes in static_groups.items():
    parts = [obj for obj in ASSET.objects if any(obj.name.startswith(prefix) for prefix in prefixes)]
    join(parts,name)

# 前后相同的轮子复用同一网格定义，旋转轴心仍属于各自对象。
# 雷达状态灯随雷达主体一起旋转，也能按其独立名称控制亮灭。
for name in ('Light_LiDAR_Ring','Light_LiDAR_Front'):
    obj = bpy.data.objects[name]
    world_matrix = obj.matrix_world.copy()
    obj.parent = lidar
    obj.matrix_world = world_matrix
for obj in list(ASSET.objects):
    if obj.type == 'MESH':
        finish(obj,0,smooth=False)
        obj.data.name = obj.name+'_Mesh'
        if obj.name.startswith('Light_') and not obj.name.startswith('Light_Bezel_'):
            obj['component'] = 'emissive_light'
            obj['control'] = 'material.emissive / material.emissiveIntensity'
        obj.data.calc_loop_triangles()
# 等所有对象完成变换应用后再共享网格，避免多用户网格阻止应用操作。
# 共享仅改变资源复用关系，不改变任何轮轴的位置和方向。
bpy.data.objects['Wheel_RL'].data = bpy.data.objects['Wheel_FL'].data
bpy.data.objects['Wheel_RR'].data = bpy.data.objects['Wheel_FR'].data
bpy.context.scene.cursor.location = (0,0,0)
activate(ROOT)
ROOT.select_set(True)
scene.world = bpy.data.worlds.new('Neutral_Environment')
scene.world.color = (.12,.12,.12)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_distance = 3.4
            area.spaces.active.region_3d.view_location = (0,0,.20)
            area.spaces.active.region_3d.view_rotation = Quaternion((.866,.358,.143,.318)).normalized()
            area.spaces.active.shading.type = 'MATERIAL'
            area.spaces.active.overlay.show_extras = False

asset_meshes = [obj for obj in ASSET.objects if obj.type == 'MESH']
triangles = sum(len(obj.data.loop_triangles) for obj in asset_meshes)
points = [obj.matrix_world@Vector(corner) for obj in asset_meshes for corner in obj.bound_box]
mins = [min(p[i] for p in points) for i in range(3)]
maxs = [max(p[i] for p in points) for i in range(3)]
stats = {'triangles':triangles,'mesh_objects':len(asset_meshes),'objects_including_root':len(ASSET.objects),
         'materials':len({mat.name for obj in asset_meshes for mat in obj.data.materials}),
         'dimensions_blender_xyz':[maxs[i]-mins[i] for i in range(3)],'bounds_min':mins,'bounds_max':maxs,
         'forward_blender':'-Y','forward_gltf':'+Z','units':'meter','glb':str(GLB),'blend':str(BLEND)}
print('ASSET_STATS',json.dumps(stats),flush=True)
print('MESH_BUDGET',json.dumps(sorted([(obj.name,len(obj.data.loop_triangles)) for obj in asset_meshes],key=lambda item:-item[1])),flush=True)
assert 20000 <= triangles <= 60000, f'三角形数量超出预算：{triangles}'
assert all(abs(s-1)<1e-6 for obj in ASSET.objects for s in obj.scale), '存在未应用缩放'
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
bpy.ops.object.select_all(action='DESELECT')
for obj in ASSET.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = ROOT
bpy.ops.export_scene.gltf(filepath=str(GLB),export_format='GLB',use_selection=True,
                          export_yup=True,export_apply=True,export_extras=True,
                          export_cameras=False,export_lights=False,export_texcoords=False,
                          export_normals=True,export_materials='EXPORT',export_animations=False)
(HERE/'build_report.json').write_text(json.dumps(stats,indent=2,ensure_ascii=False),encoding='utf-8')
print('EXPORT_COMPLETE',flush=True)
