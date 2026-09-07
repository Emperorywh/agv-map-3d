"""科幻 AGV 能量塔的实际建模脚本。
所有模型均由封闭网格生成；参考图片不参与模型材质或几何。
Blender 正面为负 Y，Z 向上，米制，根节点位于底面中心。
"""
import bpy
import bmesh
import math
import json
import sys
from pathlib import Path
from mathutils import Vector, Quaternion

OUT = Path(__file__).resolve().parent
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'final'
TAU = math.tau

# 仅清理本次独立启动的空工程，不接触用户现有工程。
# 源工程、导出主体及展示布景使用不同集合管理。
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
model = bpy.data.collections.new('AGV_CHARGE_TOWER | 模型主体')
scene.collection.children.link(model)
studio = bpy.data.collections.new('STUDIO | 仅预览不导出')
scene.collection.children.link(studio)
root = bpy.data.objects.new('AGV_Charge_Tower_ROOT', None)
model.objects.link(root)
root['front_blender'] = '-Y'
root['front_gltf'] = '+Z'
root['units'] = 'meters'
root['description'] = '底面中心原点；总高 3 米；科幻 AGV 充电能量塔'
groups = {}

def material(name, color, metal=0, rough=.35, emission=0, transmission=0, alpha=1):
    """使用可导出为 glTF 的 Principled 材质。
    发光分区分别命名，方便前端按名称控制强度。
    """
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, alpha)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    p.inputs['Alpha'].default_value = alpha
    p.inputs['Transmission Weight'].default_value = transmission
    p.inputs['IOR'].default_value = 1.45
    p.inputs['Emission Color'].default_value = (*color, 1)
    p.inputs['Emission Strength'].default_value = emission
    if alpha < 1:
        m.surface_render_method = 'DITHERED'
    m['low_emission'] = emission
    return m

white = material('Armor_White_Ceramic', (.73,.79,.85), .55, .29)
dark = material('Frame_Graphite_Metal', (.039,.052,.070), .78, .30)
panel = material('Panel_Black_Composite', (.012,.022,.036), .35, .33)
silver = material('Trim_Titanium', (.30,.39,.47), .85, .24)
gold = material('Accent_Champagne_Metal', (.49,.30,.09), .8, .3)
glass = material('Crystal_Blue_Translucent', (.006,.13,.64), .05, .13, .20, .72, .32)
inner = material('Crystal_Inner_Emission', (.006,.21,1.0), .05, .2, 2.0)
lattice = material('Crystal_Lattice_Emission', (.15,.66,1.0), .1, .3, 1.9)
halo = material('Halo_Strip_Emission', (.24,.55,1), .1, .25, 2.0)
boltmat = material('Lightning_Emission', (.40,.70,1), .05, .25, 2.8)
baseglow = material('Base_Strip_Emission', (.06,.29,1), .1, .27, 2.0)
channel = material('Frame_Channel_Emission', (.035,.38,1), .1, .26, 1.3)

def register(obj, name, mat, group, bevel=0):
    """为零件赋材质并归入可独立编辑的逻辑分组。
    倒角在导出前应用，以确保 GLB 与 Blender 几何一致。
    """
    obj.name = name
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    model.objects.link(obj)
    obj.parent = root
    if mat:
        obj.data.materials.append(mat)
    groups.setdefault(group, []).append(obj)
    if bevel:
        mod = obj.modifiers.new('真实边缘倒角', 'BEVEL')
        mod.width = bevel
        mod.segments = 1 if group in ('15_Mechanical_Details','19_Rear_Service','13_Base_Lights') else 2
        mod.affect = 'EDGES'
    return obj

def mesh(name, verts, faces, mat, group, bevel=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(data)
    bm.free()
    obj = bpy.data.objects.new(name, data)
    model.objects.link(obj)
    return register(obj, name, mat, group, bevel)

def cube(name, loc, scale, mat, group, bevel=.003, angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.rotation_euler.z = angle
    return register(o, name, mat, group, bevel)

def cylinder(name, loc, radius, depth, mat, group, sides=16, bevel=.002):
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=depth, location=loc)
    return register(bpy.context.object, name, mat, group, bevel)

def radial(u, r, z, a):
    return (math.cos(a)*r-math.sin(a)*u, math.sin(a)*r+math.cos(a)*u, z)

def radialbox(name, u, r, z, dims, a, mat, group, bevel=.003):
    return cube(name, radial(u,r,z,a), dims, mat, group, bevel, a-math.pi/2)

def prism(name, polygon, depth, convert, mat, group, bevel=.003):
    """将二维轮廓挤出成有实际厚度的封闭装甲。
    坐标变换使同一工具可用于侧甲、正面面板和底座。
    """
    n = len(polygon)
    verts = [convert(u,v,d) for d in (-depth/2,depth/2) for u,v in polygon]
    faces = [tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,verts,faces,mat,group,bevel)

def faceplate(name, x, r, z, w, h, depth, a, mat, group, bevel=.004):
    c = min(w*.15,.045,h*.15)
    poly = [(-w/2+c,-h/2),(w/2-c,-h/2),(w/2,-h/2+c),(w/2,h/2-c),
            (w/2-c,h/2),(-w/2+c,h/2),(-w/2,h/2-c),(-w/2,-h/2+c)]
    return prism(name,poly,depth,lambda u,v,d:radial(u+x,r+d,z+v,a),mat,group,bevel)

def tube(name, points, radius, mat, group, sides=5):
    verts, faces = [], []
    previous_normal=None
    for i,p in enumerate(points):
        p = Vector(p)
        tangent = Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize()
        # 使用连续投影的截面基向量，防止折点处三棱管突然翻转。
        # 这能消除高亮细线在弯折处产生的退化或扭转面。
        if previous_normal is None:
            previous_normal=Vector((1,0,0)) if abs(tangent.x)<.8 else Vector((0,1,0))
        normal=(previous_normal-tangent*previous_normal.dot(tangent)).normalized()
        binormal=tangent.cross(normal).normalized()
        previous_normal=normal
        for j in range(sides):
            verts.append(p+radius*(normal*math.cos(TAU*j/sides)+binormal*math.sin(TAU*j/sides)))
    faces.append(tuple(range(sides-1,-1,-1)))
    for i in range(len(points)-1):
        for j in range(sides):
            faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    faces.append(tuple(range((len(points)-1)*sides,len(points)*sides)))
    return mesh(name,verts,faces,mat,group)

def ring(name, ri, ro, z, height, mat, group, segments=96):
    verts=[]
    for zz,rr in [(z-height/2,ri),(z-height/2,ro),(z+height/2,ri),(z+height/2,ro)]:
        verts += [(rr*math.cos(TAU*i/segments),rr*math.sin(TAU*i/segments),zz) for i in range(segments)]
    faces=[]
    for i in range(segments):
        j=(i+1)%segments
        faces.extend([(i,j,j+segments,i+segments),(i+2*segments,i+3*segments,j+3*segments,j+2*segments),
                      (i,i+2*segments,j+2*segments,j),(i+segments,j+segments,j+3*segments,i+3*segments)])
    return mesh(name,verts,faces,mat,group)

def crystal(name, levels, mat, group, angle=math.pi/8):
    verts=[(r*math.cos(TAU*j/8+angle),r*math.sin(TAU*j/8+angle),z) for z,r in levels for j in range(8)]
    faces=[tuple(range(7,-1,-1))]
    for i in range(len(levels)-1):
        for j in range(8):
            k=i*8+j; l=i*8+(j+1)%8
            faces.extend([(k,l,k+8),(l,l+8,k+8)])
    faces.append(tuple(range((len(levels)-1)*8,len(levels)*8)))
    return mesh(name,verts,faces,mat,group)

# 先建立核心、底座和骨架，固定轮廓及部件连接关系。
# 水晶主壳与内芯保持可见间距，顶端高于光环约 0.42 米。
crystal('Crystal_Outer_Faceted',[(.31,.015),(.43,.09),(.86,.10),(1.43,.097),(2.10,.104),(2.83,.103),(3,.001)],glass,'01_Crystal_Shell')
crystal('Crystal_Inner_Pointed',[(.36,.008),(.49,.042),(2.80,.044),(2.958,.001)],inner,'02_Crystal_Inner')
cylinder('Base_Central_Foot',(0,0,.029),.385,.058,dark,'10_Base_Frame',48,.008)
cylinder('Base_Reactor_Hub',(0,0,.168),.30,.23,dark,'10_Base_Frame',32,.007)
ring('Base_Hub_Trim',.265,.303,.293,.019,silver,'10_Base_Frame',64)
ring('Base_Hub_Luminous_Gasket',.24,.266,.305,.009,baseglow,'13_Base_Lights',64)
ring('Core_Lower_Clamp',.108,.155,.365,.08,dark,'04_Internal_Frame',16)

def pod(name, a, r0, r1, w0, w1, zb, z0, z1, mat, group, bevel=.004):
    # 模块外端展开成宽扇形，减少底座之间过大的空隙。
    # 内端仅略微拓宽，避免与相邻扇区重叠。
    w0 *= 1.06
    w1 *= 1.55
    verts=[radial(-w0,r0,zb,a),radial(w0,r0,zb,a),radial(w1,r1,zb,a),radial(-w1,r1,zb,a),
           radial(-w0,r0,z0,a),radial(w0,r0,z0,a),radial(w1,r1,z1,a),radial(-w1,r1,z1,a)]
    return mesh(name,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],mat,group,bevel)

def slope_armor(name,a,u,r0,r1,w,z0,z1,mat,group):
    """薄装甲上下表面同时沿底座坡度变化。
    避免把坡面装饰误建为厚实楔块，保留底座分层。
    """
    verts=[radial((u+du)*(1.06 if r==r0 else 1.55),r,z+dz,a) for dz in (-.017,0) for du,r,z in
           [(-w/2,r0,z0),(w/2,r0,z0),(w/2,r1,z1),(-w/2,r1,z1)]]
    return mesh(name,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],mat,group,.003)

for i in range(8):
    a=-math.pi/2+i*math.pi/4
    pod(f'Foot_{i:02}',a,.265,.738,.090,.146,0,.070,.051,silver,'10_Base_Frame',.006)
    pod(f'Pod_{i:02}_Body',a,.285,.72,.082,.136,.053,.285,.12,dark,'10_Base_Frame',.007)
    pod(f'Pod_{i:02}_UnderArmor',a,.322,.695,.080,.123,.084,.291,.145,panel,'11_Base_Panels',.004)
    for s in (-1,1):
        # 两侧装甲条沿坡面延伸，中央留出接口或维护盖。
        # 条带使用实体挤出，不以贴图模拟结构分层。
        slope_armor(f'Pod_{i:02}_WhiteShoulder_{s}',a,s*.099,.325,.692,.041,.308,.158,white,'12_Base_Armor')
    pod(f'Pod_{i:02}_CenterLid',a,.365,.644,.068,.082,.123,.286,.168,panel,'11_Base_Panels',.004)
    radialbox(f'Pod_{i:02}_OuterSocket',0,.715,.098,(.276,.02,.051),a,panel,'11_Base_Panels')
    for s in (-1,1):
        radialbox(f'Pod_{i:02}_Contact_{s}',s*.113,.729,.1,(.019,.009,.015),a,gold,'15_Mechanical_Details',.001)
    tube(f'Pod_{i:02}_BlueStrip',[radial(-.110,.653,.178,a),radial(.110,.653,.178,a)],.006,baseglow,'13_Base_Lights')
    radialbox(f'Pod_{i:02}_Inset',0,.368,.303,(.135,.04,.015),a,dark,'11_Base_Panels')
    radialbox(f'Pod_{i:02}_TopLight',0,.370,.313,(.104,.022,.006),a,baseglow,'13_Base_Lights',.001)

for i in range(4):
    a=math.pi/4+i*math.pi/2
    railpoly=[(-.025,.32),(.025,.32),(.025,2.73),(.009,2.77),(-.025,2.75)]
    prism(f'Strut_{i}_Longitudinal',railpoly,.038,lambda u,z,d:radial(u,.158+d,z,a),dark,'04_Internal_Frame',.004)
    prism(f'Strut_{i}_MetalSpine',[(u*.38,z) for u,z in railpoly],.007,lambda u,z,d:radial(u,.181+d,z,a),silver,'05_Frame_Trim',.002)
    for z in (.46,.85,1.42,2.03,2.23):
        radialbox(f'Strut_{i}_CrossTie_{z}',0,.148,z,(.055,.111,.027),a,dark,'04_Internal_Frame')
    tube(f'Strut_{i}_EnergyRail',[radial(-.028,.183,.4,a),radial(-.028,.183,1.08,a),radial(-.023,.173,1.13,a),radial(-.023,.173,2.2,a)],.004,channel,'06_Frame_Lights')
    bracket=[(.16,2.41),(.22,2.41),(.32,2.52),(.424,2.52),(.424,2.556),(.30,2.556),(.195,2.455),(.16,2.455)]
    prism(f'Halo_{i}_ConnectedBracket',bracket,.029,lambda r,z,d:radial(d,r,z,a),dark,'07_Halo_Metal',.003)
    radialbox(f'Halo_{i}_BracketCap',0,.18,2.542,(.045,.065,.061),a,silver,'07_Halo_Metal')

ring('Halo_Thick_Metal_Annulus',.404,.46,2.563,.036,dark,'07_Halo_Metal')
ring('Halo_Upper_Titanium',.409,.461,2.582,.009,silver,'07_Halo_Metal')
ring('Halo_Outer_LowerTrim',.453,.463,2.544,.009,silver,'07_Halo_Metal')
ring('Halo_Inner_BlueBand',.401,.407,2.558,.014,halo,'08_Halo_Lights')
ring('Halo_Underside_BlueBand',.411,.446,2.541,.006,halo,'08_Halo_Lights')

# 侧甲由独立折线轮廓组成，上端收束、下端外展。
# 正面两侧薄翼与侧面大装甲之间保留骨架和能量开窗。
sidepoly=[(-.18,.30),(-.24,.39),(-.24,.76),(.12,1.025),(.12,1.865),
          (-.255,2.18),(-.245,2.055),(-.025,1.815),(-.025,1.10),(-.35,.84),(-.35,.43),(-.28,.30)]
for s in (-1,1):
    prism(f'Side_{s}_Armor_Substructure',sidepoly,.035,lambda y,z,d:(s*.213+d,y,z),dark,'04_Internal_Frame',.006)
    prism(f'Side_{s}_White_Zigzag',sidepoly,.031,lambda y,z,d:(s*.243+d,y,z),white,f'09_Armor_Side_{s}',.005)
    # 正面细长翼片不是整块封闭壳，留出可看穿的内部层次。
    # 顶端外张的尖角延续参考图的纵向折线语言。
    fp=[(.176,.32),(.215,.32),(.215,.92),(.193,1.025),(.193,1.97),(.271,2.17),
        (.264,2.025),(.230,1.91),(.230,.99),(.255,.86),(.255,.39),(.219,.29)]
    prism(f'Front_{s}_White_Blade',[(s*x,z) for x,z in fp],.03,lambda x,z,d:(x,-.16+d,z),white,f'09_Armor_Front_{s}',.004)
    prism(f'Rear_{s}_White_Blade',[(s*x,z) for x,z in fp],.03,lambda x,z,d:(x,.16+d,z),white,f'09_Armor_Back_{s}',.004)
    for a in (-math.pi/2,math.pi/2):
        fin=[(.28,.31),(.33,.34),(.37,.56),(.365,.83),(.305,1.00),(.314,.84),(.32,.54),(.28,.43)]
        prism(f'Lower_{s}_{a}_Outrigger_Armor',[(s*x,z) for x,z in fin],.047,lambda u,z,d:radial(u,.174+d,z,a),white,'09_Armor_Lower_Fins',.004)
        tube('Outrigger_LoadPath',[radial(s*.29,.17,.33,a),radial(s*.328,.17,.61,a),radial(s*.315,.17,.87,a)],.021,dark,'04_Internal_Frame',8)
        tube('Outrigger_LuminousSeam',[radial(s*.257,.196,.36,a),radial(s*.272,.196,.53,a),radial(s*.272,.196,.84,a)],.005,channel,'06_Frame_Lights')

# 正面控制板与充电舱有独立背壳、边框和内凹接触区。
# 闪电采用实体多边形，可独立换色、隐藏或驱动动画。
front=-math.pi/2
faceplate('Front_Panel_BackHousing',0,.196,1.265,.293,.701,.084,front,dark,'16_Front_Panel')
faceplate('Front_Panel_Titanium_Bezel',0,.243,1.265,.279,.678,.013,front,silver,'16_Front_Panel')
faceplate('Front_Panel_Recessed_Glass',0,.255,1.265,.244,.636,.019,front,panel,'16_Front_Panel')
bolt=[(.032,.164),(-.069,-.018),(-.009,-.018),(-.044,-.165),(.069,.04),(.005,.04)]
prism('Lightning_Front_IndependentMesh',bolt,.008,lambda x,z,d:(x,-.272+d,1.26+z),boltmat,'17_Lightning_Symbol',.001)
for z in (.968,1.56):
    radialbox('Panel_Blue_Status_Line',0,.27,z,(.065,.004,.004),front,channel,'06_Frame_Lights',.001)
faceplate('Dock_MainHousing',0,.207,.68,.254,.438,.109,front,dark,'18_Charging_Bay')
faceplate('Dock_Silver_Rim',0,.267,.68,.225,.385,.016,front,silver,'18_Charging_Bay')
faceplate('Dock_InnerRecess',0,.278,.68,.193,.346,.016,front,panel,'18_Charging_Bay')
faceplate('Dock_ContactPlate',0,.291,.671,.137,.225,.014,front,dark,'18_Charging_Bay')
for s in (-1,1):
    radialbox('Dock_Gold_Contact',s*.071,.303,.671,(.009,.009,.168),front,gold,'18_Charging_Bay',.001)
for z in (.536,.824):
    faceplate('Dock_Status_Housing',0,.30,z,.163,.040,.016,front,dark,'18_Charging_Bay',.002)
    for j in range(5):
        radialbox('Dock_Status_LED',(j-2)*.022,.311,z,(.015,.004,.007),front,baseglow,'13_Base_Lights',.001)
faceplate('Dock_Lower_Latch',0,.236,.399,.222,.095,.078,front,dark,'18_Charging_Bay')
for s in (-1,1):
    faceplate('Dock_RoundLock',s*.068,.282,.4,.03,.038,.012,front,silver,'18_Charging_Bay',.002)

if STAGE != 'blockout':
    # 两侧下部增加嵌入框架的能量观察窗及金属边框。
    # 窗体由半透明实体组成，与中轴水晶保持空间间隔。
    for a in (0,math.pi):
        faceplate('Side_EnergyWindow_Frame',0,.176,.93,.195,1.30,.026,a,dark,'04_Internal_Frame')
        faceplate('Side_EnergyWindow_Crystal',0,.195,.93,.148,1.235,.016,a,glass,'21_Side_Energy_Windows')
        for s in (-1,1):
            tube('Side_Window_Light',[radial(s*.054,.209,.36,a),radial(s*.061,.209,1.38,a),radial(s*.042,.209,1.49,a)],.003,channel,'06_Frame_Lights')
        for z in (.34,1.50):
            radialbox('Side_Window_EndCap',0,.211,z,(.18,.027,.048),a,silver,'05_Frame_Trim')
    # 前方底座的指示符与主闪电共享材质，但保留独立网格。
    # 符号沿坡面放置，实际导出几何而非贴附参考图片。
    small=[(x*.23,z*.23) for x,z in bolt]
    prism('Lightning_Base_Docking',small,.003,
          lambda x,v,d:(x,-(.506-v*.90),.229+v*.39+d),boltmat,'22_Base_Lightning',.0005)
    # 为外壳切面增加稀疏菱形能量网，避免粗线遮住水晶。
    # 每条发光线都是封闭三棱细管，可直接随 GLB 导出。
    for j in range(8):
        aa=TAU*j/8+math.pi/8
        bb=TAU*(j+1)/8+math.pi/8
        for k in range(14):
            z0=.48+k*.162
            z1=z0+.162
            rr=.1045 if z0>1.9 else .1015
            pa=Vector((rr*math.cos(aa),rr*math.sin(aa),z0))
            pb=Vector((rr*math.cos(bb),rr*math.sin(bb),z0))
            pc=(pa+pb)/2+Vector((0,0,.081))
            if (j+k)%3 != 0:
                tube('Crystal_Diamond_Trace',[pa,pc,pa+Vector((0,0,.162))],.00095,lattice,'03_Crystal_Lattice',3)
                tube('Crystal_Diamond_Branch',[pb,pc],.00085,lattice,'03_Crystal_Lattice',3)
        tube('Crystal_Crown_FacetEdge',[(.104*math.cos(aa),.104*math.sin(aa),2.829),(0,0,3.0)],.0012,lattice,'03_Crystal_Lattice',4)
        tube('Crystal_Longitudinal_Edge',[(.104*math.cos(aa),.104*math.sin(aa),2.829),(.105*math.cos(aa),.105*math.sin(aa),2.1),(.102*math.cos(aa),.102*math.sin(aa),.45)],.0008,lattice,'03_Crystal_Lattice',3)
    for i in range(4):
        a=math.pi/4+i*math.pi/2
        faceplate(f'Upper_{i}_GuideArmor',0,.192,2.217,.064,.47,.025,a,silver,'05_Frame_Trim')
        faceplate(f'Upper_{i}_GuideInset',0,.208,2.226,.028,.332,.011,a,panel,'15_Mechanical_Details',.002)
        faceplate(f'Lower_{i}_Actuator',0,.225,.564,.073,.427,.055,a,dark,'15_Mechanical_Details')
        tube(f'Lower_{i}_HydraulicRod',[radial(.026,.248,.40,a),radial(.026,.248,.80,a)],.008,silver,'15_Mechanical_Details',8)
        faceplate(f'Lower_{i}_CylinderCollar',0,.24,.795,.056,.062,.04,a,silver,'15_Mechanical_Details',.002)
        for z in (1.13,1.76,2.16):
            faceplate('Frame_ServiceBlock',0,.188,z,.058,.16,.042,a,dark,'15_Mechanical_Details',.003)
            for j in range(4):
                radialbox('Frame_VentSlot',0,.214,z-.052+j*.030,(.034,.008,.009),a,panel,'15_Mechanical_Details',.001)
    for a in (0,math.pi,math.pi/2):
        faceplate('RearSide_ServiceSpine',0,.205,.643,.14,.61,.048,a,dark,'19_Rear_Service')
        faceplate('RearSide_Connector',0,.238,.61,.10,.35,.015,a,panel,'19_Rear_Service')
        for j in range(7):
            radialbox('RearSide_VentLouver',0,.251,.48+j*.038,(.077,.014,.012),a,silver,'19_Rear_Service',.001)
        faceplate('RearSide_TopLatch',0,.24,1.99,.083,.55,.061,a,dark,'19_Rear_Service')
        for z in (1.79,2.16):
            radialbox('RearSide_Latch_Mount',0,.167,z,(.045,.184,.027),a,dark,'04_Internal_Frame')
    for i in range(8):
        a=-math.pi/2+i*math.pi/4
        for s in (-1,1):
            tube('Pod_Inlaid_Gold_Rail',[radial(s*.203,.682,.107,a),radial(s*.173,.577,.152,a)],.0022,gold,'15_Mechanical_Details',4)
            for r,z in ((.404,.279),(.617,.19)):
                c=cylinder('Pod_Captive_Fastener',radial(s*.098*(1.06+(r-.325)/(.692-.325)*.49),r,z,a),.007,.006,silver,'15_Mechanical_Details',8,0)
        for j in range(3):
            radialbox('Base_Cooling_Fin',0,.30,.115+j*.041,(.134,.035,.01),a,silver,'15_Mechanical_Details',.001)
        radialbox('Halo_Joint_Clip',0,.435,2.59,(.019,.052,.009),a,dark,'07_Halo_Metal',.001)
    for s in (-1,1):
        for z in (.47,.67,1.14,1.62,1.78):
            # 装甲外表面的短面板分缝使用微薄深色网格。
            # 不增加无效布尔切割，仍能在中距离看出维护分区。
            cube('Side_Armor_Seam',(s*.260,-.18 if z<.8 else .026,z),(.0015,.065,.002),panel,'20_Armor_Seams',0)
        for j in range(5):
            cube('Side_Armor_Vent',(s*.260,-.287,.53+j*.027),(.002,.021,.011),dark,'20_Armor_Seams',0)
    # 下接口中央采用两层端子轮廓，保留插接结构辨识度。
    # 少量紧固件和后部维护舱补足各视角的机械关系。
    faceplate('Dock_Center_Pin',0,.305,.671,.061,.101,.015,front,panel,'18_Charging_Bay',.002)
    faceplate('Dock_Center_Pin_Contact',0,.315,.671,.029,.057,.006,front,silver,'18_Charging_Bay',.001)

# 同类零件合并为命名网格，降低实时渲染的节点和绘制负担。
# 各主要装甲、独立闪电、水晶层、光环灯带仍可分别编辑。
for group,objects in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        bpy.context.view_layer.objects.active=o
        o.select_set(True)
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    if len(objects)>1:
        bpy.ops.object.join()
    ob=bpy.context.object
    ob.name=group
    bpy.context.scene.cursor.location=(0,0,0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    # 法线只在实体生成及倒角完成后统一校正。
    # 保留硬表面和水晶的可辨识平面，不施加细分曲面。
    bm=bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob['part_description']=group

def studio_link(o):
    for c in list(o.users_collection):
        c.objects.unlink(o)
    studio.objects.link(o)
    return o

def camera_at(name,loc,target,ortho):
    data=bpy.data.cameras.new(name)
    ob=bpy.data.objects.new(name,data)
    studio.objects.link(ob)
    ob.location=loc
    ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
    data.type='ORTHO'
    data.ortho_scale=ortho
    data.lens=55
    return ob

def area(name,loc,power,color,size,target=(0,0,1.35)):
    data=bpy.data.lights.new(name,'AREA')
    ob=bpy.data.objects.new(name,data)
    studio.objects.link(ob)
    ob.location=loc
    ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
    data.energy=power
    data.color=color
    data.shape='DISK'
    data.size=size
    return ob

# 展示地面、相机与灯光仅位于 STUDIO 集合中。
# GLB 通过选择模型集合导出，不包含任何展示资源。
groundmat=material('STUDIO_Floor',(.017,.023,.033),.15,.48)
bpy.ops.mesh.primitive_plane_add(size=200)
ground=studio_link(bpy.context.object)
ground.name='STUDIO_Ground_Excluded'
ground.location.z=-.006
ground.data.materials.append(groundmat)
scene.world=bpy.data.worlds.new('STUDIO_World')
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.12,.16,.22,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
area('STUDIO_Key',(-3,-4,6),750,(.83,.9,1),4)
area('STUDIO_Fill',(3,-2,3),500,(.62,.78,1),3)
area('STUDIO_Rim',(1,3,5),900,(.82,.9,1),3)
cameras={
    'front':camera_at('CAM_Front',(0,-8,2.6),(0,0,1.5),3.38),
    'side':camera_at('CAM_Right',(8,0,2.6),(0,0,1.5),3.38),
    'back':camera_at('CAM_Back',(0,8,2.6),(0,0,1.5),3.38),
    'top':camera_at('CAM_Top',(0,0,7),(0,0,0),1.8),
    'three_quarter':camera_at('CAM_ThreeQuarter',(4,-6,3.25),(0,0,1.5),3.47),
}
scene.render.engine='CYCLES'
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.cycles.max_bounces=8
scene.cycles.transmission_bounces=6
scene.render.resolution_x=920
scene.render.resolution_y=1120
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.render.film_transparent=False
scene.camera=cameras['three_quarter']

def render(name,cam):
    scene.camera=cam
    scene.render.filepath=str(OUT/name)
    bpy.ops.render.render(write_still=True)

if STAGE=='blockout':
    scene.cycles.samples=12
    scene.render.resolution_percentage=60
    render('stage_01_front.png',cameras['front'])
    render('stage_01_three_quarter.png',cameras['three_quarter'])
else:
    bpy.ops.object.select_all(action='DESELECT')
    for o in model.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active=root
    bpy.ops.export_scene.gltf(filepath=str(OUT/'agv_charge_tower.glb'),export_format='GLB',
        use_selection=True,export_apply=True,export_yup=True,export_extras=True,
        export_cameras=False,export_lights=False)
    for o in studio.objects:
        o.hide_set(True)
    for o in model.objects:
        o.select_set(False)
    root.select_set(True)
    # 保存工程时采用结构清晰的低光效材质。
    # 窗口启动后直接进入可旋转观察的材质预览。
    for screen in bpy.data.screens:
        for a in screen.areas:
            if a.type=='VIEW_3D':
                a.spaces.active.region_3d.view_distance=4.4
                a.spaces.active.region_3d.view_location=(0,0,1.5)
                a.spaces.active.region_3d.view_rotation=cameras['three_quarter'].rotation_euler.to_quaternion()
                a.spaces.active.clip_end=200
                a.spaces.active.shading.type='MATERIAL'
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'agv_charge_tower.blend'))
    for view,cam in cameras.items():
        scene.render.resolution_x=1120 if view=='top' else 920
        render(f'check_{view}.png',cam)
    # 强光展示使用额外合成光晕；其后处理不包含在 GLB。
    # 原有发光材质的颜色分区保持一致，避免过曝盖住结构。
    for m in (inner,lattice,halo,boltmat,baseglow,channel):
        m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value=m['low_emission']*3.0
    tree=bpy.data.node_groups.new('STUDIO_Hero_Bloom','CompositorNodeTree')
    scene.compositing_node_group=tree
    tree.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
    rl=tree.nodes.new('CompositorNodeRLayers')
    glare=tree.nodes.new('CompositorNodeGlare')
    glare.inputs['Type'].default_value='Fog Glow'
    glare.inputs['Quality'].default_value='High'
    glare.inputs['Threshold'].default_value=1.5
    output=tree.nodes.new('NodeGroupOutput')
    tree.links.new(rl.outputs['Image'],glare.inputs['Image'])
    tree.links.new(glare.outputs['Image'],output.inputs['Image'])
    scene.render.resolution_x=1120
    scene.render.resolution_y=1400
    scene.cycles.samples=48
    render('hero_energy.png',cameras['three_quarter'])
    print('TOWER_BUILD_COMPLETE',str(OUT),flush=True)
