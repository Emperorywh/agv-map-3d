"""
托盘货物单元的可重复构建入口，使用本机 Blender 实际建模、渲染并导出。
普通 Python 运行此文件会先生成共享图像，再启动 Blender；在 Blender 中运行亦可。
只替换带有本任务所有权标记的场景、数据及文件，不清理用户的其他资产。
"""
import sys
import os
import math
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
OWNER = 'cargo_pallet_generator_v1'
P = dict(blender=r'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
         python=r'C:\Users\12899\AppData\Local\Programs\Python\Python314\python.exe',
         box=(.55, .45, .50), gap=.010, pallet=(1.20, 1.00, .16),
         blue='#9AB5F6', roughness=.45, bevel=.006, belt_width=.060,
         belt_thickness=.003, belt_x=.414, resolution=1000, samples=48)


def guard_outputs():
    """
    只允许更新本生成器创建的输出，避免复用目录时覆盖同名的既有资产。
    所有权记录与资产文件一同保留，新的空目录可自动建立记录。
    """
    marker=HERE/'.cargo_generator.json'
    outputs=[HERE/'cargo_pallet.blend',HERE/'cargo_pallet.glb']
    if marker.exists():
        if json.loads(marker.read_text(encoding='utf-8')).get('generator')!=OWNER:
            raise RuntimeError('输出目录属于其他任务，请选择空目录')
    elif any(path.exists() for path in outputs):
        raise RuntimeError('已有同名资产且没有本任务所有权记录，已停止以避免覆盖')
    marker.write_text(json.dumps({'generator':OWNER},indent=2),encoding='utf-8')
    (HERE/'renders').mkdir(exist_ok=True)
    (HERE/'textures').mkdir(exist_ok=True)


guard_outputs()


def texture_assets():
    """
    生成可随 GLB 嵌入的印刷图集、低对比木纹和细微织带法线。
    箱体纯色不烘焙到图集内，确保以后独立修改主体颜色不会污染标识。
    """
    from PIL import Image, ImageDraw, ImageFont
    import random
    import numpy as np
    out = HERE / 'textures'
    out.mkdir(exist_ok=True)
    atlas = Image.new('RGBA', (2048, 2048), (0, 0, 0, 0))
    ink, blue = '#263F64', '#326CCB'
    font = r'C:\Windows\Fonts\arial.ttf'
    bold = r'C:\Windows\Fonts\arialbd.ttf'
    for tile in range(4):
        im = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for x, y, sx, sy in [(30,30,1,1),(994,30,-1,1),(30,994,1,-1),(994,994,-1,-1)]:
            d.line([(x,y+20*sy),(x,y),(x+20*sx,y)], fill=ink, width=5)
        rng = random.Random(2047)
        x = 352
        while x < 547:
            w = rng.choice([2,3,4,7])
            d.rectangle((x,859,x+w,952),fill=ink)
            x += w+rng.choice([3,4,6])
        d.text((352,960), 'AX2047  /  08', font=ImageFont.truetype(font,15), fill=ink)
        if tile in (0,2):
            d.polygon([(624,964),(745,964),(975,718),(975,585)],fill=blue)
            d.line([(627,984),(965,984)], fill=blue, width=3)
        if tile == 0:
            d.text((350,96),'AX-2047',font=ImageFont.truetype(bold,48),fill=ink)
            d.text((352,156),'LOGISTICS',font=ImageFont.truetype(bold,25),fill=ink)
            d.text((352,190),'STANDARD / UNIT',font=ImageFont.truetype(font,19),fill=ink)
            d.text((352,223),'SERIES 04   /   2026',font=ImageFont.truetype(font,15),fill=ink)
            for k in range(3):
                d.rectangle((353+k*30,57,369+k*30,80),fill=blue)
        elif tile == 1:
            d.rectangle((20,800,1000,985),fill=(0,0,0,0))
            for x in (92,151):
                d.polygon([(x,820),(x-22,855),(x-8,855),(x-8,932),(x+8,932),(x+8,855),(x+22,855)],fill=ink)
            d.line((62,947,181,947), fill=ink, width=9)
            d.polygon([(280,824),(341,824),(339,866),(324,887),(297,887),(281,866)],fill=ink)
            d.line((311,880,311,941),fill=ink,width=9)
            d.line((284,945,338,945),fill=ink,width=8)
            d.line((311,826,301,849,317,861,306,878),fill='#9AB5F6',width=4)
            d.text((717,839),'♻',font=ImageFont.truetype(r'C:\Windows\Fonts\seguisym.ttf',112),fill=ink)
            for k in range(45):
                if k%4 != 0:
                    d.rectangle((420+4*k,863,421+4*k,932),fill=ink)
            d.text((421,946),'HANDLE WITH CARE',font=ImageFont.truetype(font,15),fill=ink)
            # 运输符号放在两种绑带位置之间，保留近景可读的印刷尺寸。
            # 透明图集只改变油墨位置，不修改箱体的纯色底材。
            d.rectangle((20,730,1005,990),fill=(0,0,0,0))
            for x in (340,400):
                d.polygon([(x,825),(x-22,861),(x-8,861),(x-8,940),(x+8,940),(x+8,861),(x+22,861)],fill=ink)
            d.line((316,955,423,955),fill=ink,width=8)
            d.polygon([(464,831),(521,831),(519,870),(506,891),(479,891),(466,870)],fill=ink)
            d.line((493,884,493,948),fill=ink,width=8)
            d.line((467,952,519,952),fill=ink,width=8)
            d.line((493,832,484,852,501,867,490,884),fill='#9AB5F6',width=4)
            d.text((559,818),'♻',font=ImageFont.truetype(r'C:\Windows\Fonts\seguisym.ttf',119),fill=ink)
            for k in range(45):
                if k%4 !=0: d.rectangle((330+4*k,737,331+4*k,789),fill=ink)
            d.text((525,744),'HANDLE',font=ImageFont.truetype(font,18),fill=ink)
            d.text((525,767),'WITH CARE',font=ImageFont.truetype(font,18),fill=ink)
        elif tile == 3:
            d.text((351,653),'AX-2047',font=ImageFont.truetype(bold,46),fill=ink)
            d.text((353,717),'LOGISTICS',font=ImageFont.truetype(bold,25),fill=ink)
            d.text((353,758),'STACK / 02    UNIT / 08',font=ImageFont.truetype(font,18),fill=ink)
            d.line((45,180,45,720),fill=blue,width=3)
            d.line((977,180,977,720),fill=blue,width=3)
        atlas.paste(im, ((tile%2)*1024,(tile//2)*1024))
    atlas.save(out/'markings_atlas.png')
    rng = np.random.default_rng(2047)
    y,x = np.mgrid[0:512,0:512]
    grain = 2.1*np.sin(y*.42+np.sin(x*.022)*.9)+1.2*np.sin(y*1.11)+rng.normal(0,.7,(512,512))
    wood = np.clip(np.array([192,164,119])[None,None,:]+grain[:,:,None],0,255).astype('uint8')
    Image.fromarray(wood).save(out/'wood_basecolor.png')
    y,x = np.mgrid[0:256,0:256]
    normal = np.empty((256,256,3),dtype='uint8')
    normal[:,:,0] = 128+7*np.sin(x*math.tau/8)
    normal[:,:,1] = 128+7*np.sin(y*math.tau/8)
    normal[:,:,2] = 254
    Image.fromarray(normal).save(out/'webbing_normal.png')


def compose():
    """
    拼图直接使用六台相机的实际渲染结果，标题只绘制在图片外边距。
    不合成模型结构，不把参考图内容混入验收图。
    """
    from PIL import Image, ImageDraw, ImageFont
    names = ['Front','Back','Left','Right','Top','Perspective']
    sheet = Image.new('RGB',(1800,1340),'#ECEDEF')
    d=ImageDraw.Draw(sheet)
    font=ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf',27)
    for i,name in enumerate(names):
        im=Image.open(HERE/'renders'/f'{name}.png').convert('RGB').resize((600,600))
        x,y=(i%3)*600,(i//3)*670
        sheet.paste(im,(x,y))
        d.text((x+300,y+617),name,font=font,fill='#414852',anchor='mt')
    sheet.save(HERE/'renders'/'Six_Views.png')


def write_notes():
    """
    用最终重导入报告生成当前资产说明，避免把迭代过程写成堆积的修改日志。
    浏览器连接限制单独说明，不能把 HTTP 成功冒充实际 WebGL 验收。
    """
    r=json.loads((HERE/'blender_validation.json').read_text(encoding='utf-8'))
    dimensions=' × '.join(f'{v:.4f}' for v in r['dimensions_blender_xyz'])
    text=f'''# 托盘货物单元

## 交付与坐标

- 实际使用本机 Blender 5.2.1 LTS 的 Python API 构建、Cycles 渲染、glTF 导出和重新导入。
- 可编辑场景：`Cargo_Pallet_Source`；货物集合：`Cargo_Pallet_Asset`；统一根节点：`Cargo_Pallet`。
- 根原点为托盘底面中心，底部为 0 m，单位为米，所有网格对象均为正缩放。
- Blender：X 为宽，Y 为深，Z 向上；Front 朝向 -Y。GLB/Three.js：X 为宽，Y 向上，Front 朝向 +Z。仅由导出器执行一次坐标转换。
- 重新导入测得外包尺寸（宽 × 深 × 高）：**{dimensions} m**，包含角嵌件、织带厚度及顶部扣件。
- 托盘主体约 1.20 × 1.00 × 0.16 m；单箱 0.55 × 0.45 × 0.50 m；2 × 2 × 2 排列，八箱相互独立；留缝 10 mm。
- 箱体阵列为 1.11 × 0.91 × 1.01 m。托盘木板顶面 0.16 m，箱体阵列顶面 1.17 m。

## 几何与资源

| 项目 | 最终结果 |
| --- | --- |
| 实际三角面，含全部实例 | {r['triangles']:,} |
| 货物材质 | {r['material_count']} |
| 箱体节点 | {r['box_count']} |
| 导出箱体网格资源 | {r['unique_box_meshes']}，按上下层印刷复用，每份用于四个箱子 |
| GLB 网格资源 / 网格节点 | {r['gltf_mesh_resources']} / {r['gltf_mesh_instances']} |
| 按材质拆分后的绘制单元 | {r['gltf_primitive_instances']}，不含阴影等额外通道 |
| GLB 大小 | {r['glb_bytes']:,} 字节，约 {r['glb_bytes']/1024:.1f} KiB |
| 嵌入图像 | {r['embedded_images']} |

箱盖、底边、浅凹面板、提手槽和角部护边为真实几何。面板下凹约 3 mm，提手槽从外框下凹约 12 mm，相对面板约 9 mm。工业外缘使用毫米级小倒角，不建模箱体内部。源模型保留可编辑部件和倒角修改器；导出时评估独立副本、按功能分组合并。

托盘由实体支撑块、底部横梁、纵向承托及木板组成。正面两个叉孔有效宽约 0.27 m，高约 0.099 m，通道贯穿托盘；侧面也保留真实叉孔。底部脚与地面齐平。

两条黑色织带宽 60 mm、厚 3 mm，分别位于 X = ±0.414 m。每条为封闭连续实体，经过正面、箱顶、背面及托盘下方，沿外侧支撑区下降；下绕段留有实际空间。扣件为独立源对象，普通蓝色 PBR 材质，不发光。

普通逐个克隆不能自动减少绘制次数；批量场景可以按共享几何和材质构建 Three.js `InstancedMesh`。本交付未报告未经测量的 FPS，也未修改现有 AGV 业务代码。

## 材质与图像

箱体材质 `Cargo_Body_9AB5F6` 使用精确 sRGB **#9AB5F6 / RGB(154, 181, 246)**。Blender / glTF 中对应线性 RGB 为 **(0.323143214, 0.462076992, 0.921581864)**。Metallic = 0，Roughness = 0.45；未使用蓝色灯光或自发光，也未将参考图阴影烘焙到基础色。

六种材质为箱体主体、蓝色扣件及槽边、深灰托盘底座、浅木色木板、黑色织带和共享印刷图集。摄影棚灰材质只存在于源场景，未导出。

| 文件 | 规格 | 用途 |
| --- | --- | --- |
| `textures/markings_atlas.png` | 2048 × 2048，RGBA，sRGB | 四分区共享图集；AX-2047、LOGISTICS、条码、斜纹、向上箭头、易碎和回收标识 |
| `textures/wood_basecolor.png` | 512 × 512，RGB，sRGB | 低对比木纹 |
| `textures/webbing_normal.png` | 256 × 256，RGB，Non-Color | 已生成的细微切线空间织纹法线，强度 0.30 |

三张图像均已打包到 BLEND 并嵌入 GLB。箱体基础色不在图集中，可以单独调整。印刷使用 MASK 透明裁切，每个面只用一个四边形，与面板间隔约 0.35 mm；未将文字和条码拆成实体线条。

## 渲染与验证

- `renders/Front.png`、`Back.png`、`Left.png`、`Right.png`、`Top.png`：同一模型的正交渲染，正交尺度 1.52 m，四个立面为准确轴向且比例一致。
- `renders/Perspective.png`：同一模型的三分之四俯视透视图。六张独立图均为 1000 × 1000；`Six_Views.png` 为 1800 × 1340 拼图，标题仅存在于图片留白。
- 使用中性世界光及柔和白色面光源，Standard 色彩变换、曝光 -0.20、Cycles 48 采样及降噪；无景深、泛光或蓝色灯光。
- 实际打开六视图和重导入渲染进行视觉检查。当前图像未见黑块、明显悬空、表面重合闪烁或明显纹理拉伸；八箱的宽深排列可由俯视和透视图直接确认。
- 独立 Blender 进程重新导入最终 GLB，验证通过：箱体数量、尺寸、根节点、贴地、正变换、有限顶点、UV、材质、精确基础色、透明模式及嵌入贴图。
- 验证网格中检查到 {r['closed_components']} 个法线朝外的封闭构件，以及 {r['open_decal_components']} 个预期的开放贴花面。两条织带本身为闭合网格。四条跨越整个托盘的叉孔射线检查均畅通。
- `renders/GLB_Reimport_Check.png` 仅对实际导入的 GLB 货物渲染；摄影棚从源文件单独读取。GLB 只含一个资产场景，不含默认立方体、地面、相机、灯光或辅助节点。
- 复运行已实际在已保存源文件中执行；无关占位对象及原始场景得以保留，任务箱体仍恰好为八个、根节点为一个；验证占位对象已移除。原始报告见 `blender_validation.json` 与 `rerun_validation.json`。
- 项目的 `pnpm lint`、`pnpm typecheck` 已通过，没有新增单元测试。

## 参考图统一与当前限制

采用俯视图的两条平行绑带方案，取消参考侧视图互相矛盾的额外中间绑带。侧面因此不出现居中的第三条绑带；所有方向对应同一真实闭环结构。为避开叉孔，将两条绑带布置在托盘外侧支撑区，并把主要印刷移到不会被织带挡住的位置。模糊文字统一为 AX-2047、LOGISTICS 等清晰标识；未复制六视图标题，也未添加参考之外的机械附件。

**浏览器视觉验证尚未完成。** 项目已有 Three.js / Vite 环境，已提供 `preview.html` 并检查预览页、实际 GLB 均返回 HTTP 200；应用内浏览器连续两次无法附加页面，打开预览面板的请求处于排队状态。HTTP 成功只证明资源可访问，不代表 Three.js 已成功渲染。浏览器贴图显示、旋转时是否闪烁及 100 单元的 WebGL 性能尚未实测。

现有开发服务下的预览地址：<http://localhost:5173/cargo_pallet/preview.html>。页面可加载实际 GLB，并提供单个资产和 100 个普通克隆的检查入口。该页面不是生产场景集成，也不代表已完成浏览器验收。

## 重复构建

在工作目录运行 `python cargo_pallet/build_cargo_pallet.py`，会生成图像、启动本机 Blender、建模、导出、渲染、保存源文件、重导入检查并更新本说明。也可在 Blender 的脚本编辑器中运行同一文件；集中参数为文件开头的 `P`，包含单箱、托盘、缝隙、基础色、织带及渲染参数。图像生成使用本机 Python 的 Pillow 和 NumPy，路径可在 `P` 中调整。

`--skip-renders` 仅用于需要跳过图片的重建，会跳过渲染及自动重导入；此模式后应单独运行 `verify_cargo_pallet.py` 并更新说明，不能沿用旧图片作为新模型的验证。

只替换带有本任务所有权标记的对象。手动加入任务场景的无关对象会保留到独立场景；同名输出文件必须由 `.cargo_generator.json` 标记为本任务所有，避免覆盖其他已有资产。脚本不会主动格式化项目代码。
'''
    (HERE/'asset_notes.md').write_text(text,encoding='utf-8')


if '--textures' in sys.argv:
    texture_assets()
    sys.exit(0)
if '--compose' in sys.argv:
    compose()
    sys.exit(0)
if '--notes' in sys.argv:
    write_notes()
    sys.exit(0)
try:
    import bpy
except ImportError:
    texture_assets()
    subprocess.run([P['blender'],'--background','--python',str(Path(__file__).resolve()),'--',*sys.argv[1:]],check=True)
    sys.exit(0)

import bmesh
from mathutils import Vector


def srgb(hexcode):
    """
    将用户指定的 sRGB 色值转换到 Blender 节点使用的线性空间。
    导出 glTF 时保留线性因子，避免重复伽马转换导致发灰。
    """
    channels=[int(hexcode[i:i+2],16)/255 for i in (1,3,5)]
    return tuple(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in channels)+(1,)


def owned(data):
    """
    记录任务所有权，以便再次运行时有范围地替换生成的数据。
    未标记的既有场景及资产不参与清理。
    """
    data['generator']=OWNER
    return data


# 先建立新场景再清理旧任务场景，兼容源文件只有一个场景的情况。
# 世界和图像同样按所有权处理；任务之外的数据保持原状。
scene=owned(bpy.data.scenes.new('Cargo_Pallet_Rebuild'))
bpy.context.window.scene=scene
for old_scene in list(bpy.data.scenes):
    if old_scene==scene or old_scene.get('generator')!=OWNER: continue
    extra_objects=[ob for ob in old_scene.objects if ob.get('generator')!=OWNER]
    if extra_objects:
        # 用户可能在任务场景中手工添加对象，重建时先把它们保留到独立场景。
        # 父对象将被重建时解除父级，但保持世界变换和原有几何数据。
        preserved=bpy.data.scenes.get('Cargo_User_Assets') or bpy.data.scenes.new('Cargo_User_Assets')
        for ob in extra_objects:
            if ob.parent and ob.parent.get('generator')==OWNER:
                matrix=ob.matrix_world.copy(); ob.parent=None; ob.matrix_world=matrix
            if ob.name not in preserved.objects: preserved.collection.objects.link(ob)
for sc in list(bpy.data.scenes):
    if sc!=scene and sc.get('generator') == OWNER:
        bpy.data.scenes.remove(sc)
for group in (bpy.data.objects,bpy.data.collections,bpy.data.meshes,bpy.data.materials,bpy.data.cameras,bpy.data.lights,bpy.data.worlds,bpy.data.images):
    for data in list(group):
        if data.get('generator') == OWNER:
            if group not in (bpy.data.objects,bpy.data.collections) and data.users>0: continue
            group.remove(data,do_unlink=True)
if not (HERE/'textures'/'markings_atlas.png').exists():
    subprocess.run([P['python'],str(Path(__file__).resolve()),'--textures'],check=True)
scene.name='Cargo_Pallet_Source'
scene.unit_settings.system='METRIC'
scene.unit_settings.scale_length=1
collection=owned(bpy.data.collections.new('Cargo_Pallet_Asset'))
scene.collection.children.link(collection)
root=owned(bpy.data.objects.new('Cargo_Pallet',None))
collection.objects.link(root)
root['layout']='2 x 2 x 2 / 8 separate boxes'
root['base_color_srgb']=P['blue']


def material(name,color,rough=.45):
    """
    仅使用标准 Principled BSDF，所有资产材质不使用自发光。
    基础色、粗糙度与可选图像输入均可由标准 glTF 导出器识别。
    """
    mat=owned(bpy.data.materials.new(name))
    mat.use_nodes=True
    bs=mat.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value=srgb(color)
    bs.inputs['Roughness'].default_value=rough
    bs.inputs['Metallic'].default_value=0
    mat.diffuse_color=srgb(color)
    mat.use_backface_culling=True
    return mat


body=material('Cargo_Body_9AB5F6',P['blue'],P['roughness'])
accent=material('Cargo_Blue_Hardware','#326CCB',.42)
base=material('Cargo_Dark_Base','#303941',.68)
wood=material('Cargo_Light_Wood','#FFFFFF',.73)
strap=material('Cargo_Black_Webbing','#171C22',.88)
printmat=material('Cargo_Shared_Print_Atlas','#FFFFFF',.49)


def texture(mat,filename,socket,normal=False):
    """
    图像打包进源文件，并使用相对路径供源文件迁移和重新运行。
    织纹为已生成的切线法线贴图，无依赖 Blender 专用程序节点。
    """
    nt=mat.node_tree
    image=owned(bpy.data.images.load(str(HERE/'textures'/filename),check_existing=True))
    image.pack()
    node=nt.nodes.new('ShaderNodeTexImage')
    node.image=image
    bs=nt.nodes.get('Principled BSDF')
    if normal:
        image.colorspace_settings.name='Non-Color'
        nm=nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value=.30
        nt.links.new(node.outputs['Color'],nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    else:
        nt.links.new(node.outputs['Color'],bs.inputs[socket])
    return node


texture(wood,'wood_basecolor.png','Base Color')
texture(strap,'webbing_normal.png','Normal',True)
pn=texture(printmat,'markings_atlas.png','Base Color')
# 使用阈值透明材质，导出为 MASK 以消除批量摆放时的透明排序开销。
# 图集的透明底不写入深度，标识本身仍以普通 PBR 油墨响应灯光。
cut=printmat.node_tree.nodes.new('ShaderNodeMath'); cut.operation='GREATER_THAN'; cut.inputs[1].default_value=.5
printmat.node_tree.links.new(pn.outputs['Alpha'],cut.inputs[0])
printmat.node_tree.links.new(cut.outputs[0],printmat.node_tree.nodes.get('Principled BSDF').inputs['Alpha'])
printmat.surface_render_method='DITHERED'
printmat.use_backface_culling=True


def mesh_obj(name,verts,faces,mat,uv=None,parent=root):
    """
    构建带确定法线、UV 和所有权标记的网格对象。
    几何保持正缩放，真实尺寸直接写入顶点坐标。
    """
    me=owned(bpy.data.meshes.new(name+'_Mesh'))
    me.from_pydata(verts,[],faces)
    me.update()
    bm=bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(me); bm.free()
    ob=owned(bpy.data.objects.new(name,me))
    collection.objects.link(ob)
    ob.parent=parent
    me.materials.append(mat)
    layer=me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi=me.loops[li].vertex_index
            layer.data[li].uv=uv[vi] if uv else (me.vertices[vi].co.x,me.vertices[vi].co.y)
    return ob


def box(name,loc,size,mat,bevel=.002,parent=root):
    """
    小倒角保留为源文件中的可编辑修改器，避免工业箱体过度圆润。
    导出时只评估到独立网格副本，不应用到此处的源对象。
    """
    x,y,z=(v/2 for v in size)
    vs=[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
    ob=mesh_obj(name,vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],mat,parent=parent)
    ob.location=loc
    if bevel:
        mod=ob.modifiers.new('小倒角_可编辑','BEVEL'); mod.width=bevel; mod.segments=2
        mod=ob.modifiers.new('加权法线','WEIGHTED_NORMAL'); mod.keep_sharp=True; mod.weight=40
    return ob


def octagon(w,h,c,cx=0,cy=0):
    """
    用八点倒角矩形构建面板轮廓，控制真实转角且避免高细分。
    同一拓扑也用于凹陷提手槽的边框和槽底。
    """
    return [(cx-w/2+c,cy-h/2),(cx+w/2-c,cy-h/2),(cx+w/2,cy-h/2+c),(cx+w/2,cy+h/2-c),
            (cx+w/2-c,cy+h/2),(cx-w/2+c,cy+h/2),(cx-w/2,cy+h/2-c),(cx-w/2,cy-h/2+c)]


def panel(name,w,loc,rot,parent,handle):
    """
    外框到面板有三毫米真实落差，提手有九毫米深度并封闭槽底。
    所有层由连续四边面连接，既不是贴图假凹槽，也没有内部复杂零件。
    """
    rings=[(octagon(w,.450,.008),0),(octagon(w-.027,.421,.005),-.003)]
    if handle:
        rings += [(octagon(.119,.047,.004,0,.154),-.003),(octagon(.103,.032,.002,0,.154),-.008),
                  (octagon(.103,.032,.002,0,.154),-.012)]
    verts=[(x,y,z) for pts,z in rings for x,y in pts]
    faces=[]
    for r in range(len(rings)-1):
        for i in range(8):
            faces.append((8*r+i,8*r+(i+1)%8,8*(r+1)+(i+1)%8,8*(r+1)+i))
    faces.append(tuple(range((len(rings)-1)*8,len(rings)*8)))
    back=len(verts)
    verts += [(x,y,-.015) for x,y in rings[0][0]]
    for i in range(8):
        faces.append((i,back+i,back+(i+1)%8,(i+1)%8))
    faces.append(tuple(range(back,back+8)))
    ob=mesh_obj(name,verts,faces,body,parent=parent)
    ob.location=loc; ob.rotation_euler=rot
    if handle:
        ob.data.materials.append(accent)
        for poly in ob.data.polygons:
            if 16<=poly.index<=32:
                poly.material_index=1
    return ob


def decal(name,w,h,loc,rot,tile,parent):
    """
    每个大面只用一个四边形承载全部文字、条码及符号。
    与凹面保持零点三五毫米偏移，透明区域不改变箱体基础色。
    """
    u0=(tile%2)*.5; v0=1-(tile//2+1)*.5
    uv=[(u0+.006,v0+.006),(u0+.494,v0+.006),(u0+.494,v0+.494),(u0+.006,v0+.494)]
    ob=mesh_obj(name,[(-w/2,-h/2,0),(w/2,-h/2,0),(w/2,h/2,0),(-w/2,h/2,0)],[(0,1,2,3)],printmat,uv,parent)
    ob.location=loc; ob.rotation_euler=rot
    return ob


prototype=[]
for iz in range(2):
    for iy in range(2):
        for ix in range(2):
            idx=iz*4+iy*2+ix+1
            node=owned(bpy.data.objects.new(f'Box_{idx:02d}',None))
            collection.objects.link(node); node.parent=root
            node.location=((ix-.5)*(P['box'][0]+P['gap']),(iy-.5)*(P['box'][1]+P['gap']),P['pallet'][2]+P['box'][2]/2+iz*(P['box'][2]+P['gap']))
            node['is_cargo_box']=True
            if idx==1:
                # 核心外壁与提手槽底保持三毫米间隔，避免两个外表面共面。
                # 箱盖使用单一完整顶面，杜绝叠加面引起的黑块和闪烁。
                prototype.append(box('Box_Core',(0,0,-.007),(.520,.420,.468),body,.006,node))
                prototype.append(box('Box_Lid',(0,0,.239),(.55,.45,.022),body,.006,node))
                prototype.append(box('Box_Foot_Rim',(0,0,-.243),(.55,.45,.014),body,.004,node))
                for label,w,loc,rot in [('Front',.546,(0,-.225,-.01),(math.pi/2,0,0)),('Back',.546,(0,.225,-.01),(math.pi/2,0,math.pi)),
                                          ('Left',.446,(-.275,0,-.01),(math.pi/2,0,-math.pi/2)),('Right',.446,(.275,0,-.01),(math.pi/2,0,math.pi/2))]:
                    prototype.append(panel('Box_Panel_'+label,w,loc,rot,node,label!='Front'))
                for cx in [-.256,.256]:
                    for cy in [-.206,.206]:
                        prototype.append(box('Box_Corner_Guard',(cx,cy,-.008),(.028,.028,.456),body,.003,node))
            else:
                for src in prototype:
                    ob=owned(src.copy()); ob.data=src.data; collection.objects.link(ob); ob.parent=node
                    ob.name=f'Box_{idx:02d}_'+src.name.removeprefix('Box_')
            tile=0 if iz else 1
            decal(f'Box_{idx:02d}_Print_Front',.495,.403,(0,-.22235,-.01),(math.pi/2,0,0),tile,node)
            decal(f'Box_{idx:02d}_Print_Back',.495,.403,(0,.22235,-.01),(math.pi/2,0,math.pi),2 if iz else 1,node)
            decal(f'Box_{idx:02d}_Print_Left',.395,.403,(-.27235,0,-.01),(math.pi/2,0,-math.pi/2),2,node)
            decal(f'Box_{idx:02d}_Print_Right',.395,.403,(.27235,0,-.01),(math.pi/2,0,math.pi/2),2,node)
            decal(f'Box_{idx:02d}_Print_Top',.488,.388,(0,0,.25035),(0,0,0),3,node)


"""
细部模板以标准单箱尺寸设计，集中参数变化时统一缩放局部几何及附件位置。
共享网格只处理一次，对象缩放保持一；排列位置由实际箱体尺寸及间隙计算。
"""
ratios=Vector([P['box'][i]/(.55,.45,.50)[i] for i in range(3)])
seen_meshes=set()
for ob in collection.objects:
    if ob.type!='MESH' or not ob.parent or not ob.parent.get('is_cargo_box'): continue
    # 面板局部坐标轴经过旋转，需要把尺寸变换换算回网格自身坐标。
    # 这样宽、深独立调整时仍能保持凹槽、印刷和箱盖相互贴合。
    rotation=ob.rotation_euler.to_matrix()
    from mathutils import Matrix
    transform=rotation.inverted()@Matrix.Diagonal(ratios)@rotation
    if ob.data not in seen_meshes:
        for vertex in ob.data.vertices: vertex.co=transform@vertex.co
        seen_meshes.add(ob.data)
    ob.location=Vector([ob.location[i]*ratios[i] for i in range(3)])


"""
托盘由贯通通道两侧的实体支撑块构成，叉孔宽二十七厘米、高九厘米。
底部留出绑带的实际通路，落地脚仍保持零高度，不以黑贴图伪造开口。
"""
for ix,x in enumerate([-.49,0,.49]):
    width=.22
    box(f'Pallet_Runner_{ix}',(x,0,.0155),(width,.98,.015),base,.003)
    for iy,y in enumerate([-.395,0,.395]):
        box(f'Pallet_Block_{ix}_{iy}',(x,y,.071),(width,.21,.112),base,.006)
for x in [-.572,0,.572]:
    for y in [-.43,.43]:
        box('Pallet_Ground_Foot',(x,y,.005),(.05,.11,.010),base,.002)
for y in [-.430,.430]:
    box('Pallet_Fork_Lower_Rail',(0,y,.018),(1.20,.12,.016),base,.003)
box('Pallet_Upper_Frame',(0,0,.134),(1.2,1,.018),base,.006)
for i in range(9):
    box(f'Pallet_Wood_Deck_{i:02d}',(-.533+i*.13325,0,.1515),(.127,.984,.017),wood,.0025)
for x in [-.582,.582]:
    for y in [-.441,.441]:
        box('Pallet_Blue_Corner_X',(x,y,.077),(.039,.103,.076),accent,.003)
for x in [-.547,.547]:
    for y in [-.498,.498]:
        box('Pallet_Blue_Corner_Y',(x,y,.077),(.089,.009,.076),accent,.002)
ratios=Vector([P['pallet'][i]/(1.2,1,.16)[i] for i in range(3)])
for ob in collection.objects:
    if ob.type=='MESH' and ob.name.startswith('Pallet_'):
        ob.location=Vector([ob.location[i]*ratios[i] for i in range(3)])
        for vertex in ob.data.vertices: vertex.co=Vector([vertex.co[i]*ratios[i] for i in range(3)])


def belt(x,index):
    """
    单条闭合实体织带沿前面、顶部、背面及底部连续扫掠。
    每个折点用短圆滑过渡，织带有真实厚度并避开叉孔的有效通道。
    """
    cargo_y=P['box'][1]+P['gap']/2+P['belt_thickness']/2+.0005
    pallet_y=P['pallet'][1]/2+P['belt_thickness']/2+.0005
    top=P['pallet'][2]+P['box'][2]*2+P['gap']+P['belt_thickness']/2+.0005
    deck=P['pallet'][2]
    corners=[(-cargo_y,deck+.006),(-cargo_y,top),(cargo_y,top),(cargo_y,deck+.006),
             (pallet_y,deck-.017),(pallet_y,.004),(-pallet_y,.004),(-pallet_y,deck-.017)]
    path=[]
    for i,co in enumerate(corners):
        cur=Vector(co); prev=Vector(corners[i-1]); nxt=Vector(corners[(i+1)%len(corners)])
        r=min(.011,(cur-prev).length*.18,(nxt-cur).length*.18)
        a=cur+(prev-cur).normalized()*r; b=cur+(nxt-cur).normalized()*r
        for j in range(5):
            t=j/4; q=(1-t)**2*a+2*(1-t)*t*cur+t*t*b
            path.append(q)
    verts=[]; uv=[]; distance=0
    for i,q in enumerate(path):
        if i: distance+=(q-path[i-1]).length
        tangent=(path[(i+1)%len(path)]-path[i-1]).normalized()
        n=Vector((-tangent.y,tangent.x))
        for sx,st in [(-1,-1),(1,-1),(1,1),(-1,1)]:
            yz=q+n*(st*P['belt_thickness']/2)
            verts.append((x+sx*P['belt_width']/2,yz.x,yz.y))
            uv.append(((sx+1)*1.5,distance*45))
    faces=[]
    for i in range(len(path)):
        for j in range(4):
            faces.append((i*4+j,i*4+(j+1)%4,((i+1)%len(path))*4+(j+1)%4,((i+1)%len(path))*4+j))
    ob=mesh_obj(f'Strap_{index}_Continuous',verts,faces,strap,uv)
    for poly in ob.data.polygons: poly.use_smooth=True
    for side in [-1,1]:
        buckle_z=deck+P['box'][2]+P['gap']/2+.020
        box(f'Buckle_{index}_{side}_Housing',(x,side*(cargo_y+.010),buckle_z),(.073,.019,.093),base,.004)
        box(f'Buckle_{index}_{side}_Blue',(x,side*(cargo_y+.022),buckle_z),(.051,.009,.069),accent,.002)
        box(f'Buckle_{index}_{side}_Grip',(x,side*(cargo_y+.028),buckle_z-.001),(.044,.004,.008),accent,.001)
    box(f'Buckle_{index}_Top',(x,0,top+.006),(.068,.084,.011),base,.002)
    box(f'Buckle_{index}_Top_Insert',(x,0,top+.013),(.049,.052,.005),accent,.001)
    return ob


belt(-P['belt_x'],1); belt(P['belt_x'],2)
bpy.context.view_layer.update()


"""
单独评估导出副本并按箱体及功能分组合并，源对象和倒角修改器保持可编辑。
相同层的箱体通过几何签名共享导出网格，减少 GLB 中重复资源。
"""
export_scene=owned(bpy.data.scenes.new('Cargo_Export_Temporary'))
export_collection=owned(bpy.data.collections.new('Cargo_Export_Only'))
export_scene.collection.children.link(export_collection)
export_root=owned(bpy.data.objects.new('Cargo_Pallet_Export',None))
export_collection.objects.link(export_root)
deps=bpy.context.evaluated_depsgraph_get()
groups={}
for ob in collection.objects:
    if ob.type!='MESH': continue
    if ob.parent and ob.parent.get('is_cargo_box'):
        key=ob.parent.name
    elif ob.name.startswith('Pallet_'):
        key='Pallet'
    elif ob.name.startswith('Strap_'):
        key=ob.name
    else:
        key='Buckles'
    groups.setdefault(key,[]).append(ob)
for key,objects in groups.items():
    copies=[]
    origin=objects[0].parent.matrix_world.translation.copy() if key.startswith('Box_') else Vector((0,0,0))
    for src in objects:
        me=owned(bpy.data.meshes.new_from_object(src.evaluated_get(deps),depsgraph=deps))
        ob=owned(bpy.data.objects.new('Export_'+src.name,me)); export_collection.objects.link(ob)
        ob.matrix_world=src.matrix_world.copy(); copies.append(ob)
    bpy.context.window.scene=export_scene
    bpy.ops.object.select_all(action='DESELECT')
    for ob in copies: ob.select_set(True)
    bpy.context.view_layer.objects.active=copies[0]
    bpy.ops.object.join()
    ob=copies[0]; ob.name='Export_'+key
    bpy.context.scene.cursor.location=origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    ob.parent=export_root
    if key.startswith('Box_'): ob['is_cargo_box']=True
    bpy.context.window.scene=scene
cache={}
for ob in export_collection.objects:
    if ob.type!='MESH' or not ob.name.startswith('Export_Box_'): continue
    signature=tuple(round(v,5) for vertex in ob.data.vertices for v in vertex.co)+tuple(round(c,5) for loop in ob.data.uv_layers.active.data for c in loop.uv)
    if signature in cache: ob.data=cache[signature]
    else: cache[signature]=ob.data
bpy.context.window.scene=export_scene
export_root.name='Cargo_Pallet'
root.name='Cargo_Pallet_Source_Root'
export_root.name='Cargo_Pallet'
bpy.ops.object.select_all(action='DESELECT')
for ob in export_collection.objects: ob.select_set(True)
triangles=sum(len(ob.data.loop_triangles) if ob.data.loop_triangles else (ob.data.calc_loop_triangles() or len(ob.data.loop_triangles)) for ob in export_collection.objects if ob.type=='MESH')
bpy.ops.export_scene.gltf(filepath=str(HERE/'cargo_pallet.glb'),export_format='GLB',use_selection=True,use_active_scene=True,
                         export_yup=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_extras=True)
print('CARGO_EXPORTED_TRIANGLES',triangles,flush=True)
bpy.context.window.scene=scene
for ob in list(export_collection.objects): bpy.data.objects.remove(ob,do_unlink=True)
bpy.data.scenes.remove(export_scene)
bpy.data.collections.remove(export_collection)
root.name='Cargo_Pallet'


def aim(ob,target):
    """
    所有相机与中性面光源使用同一货物中心作为观察目标。
    四个立面共享正交尺度，不通过单独缩放掩盖尺寸差异。
    """
    ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()


studio=owned(bpy.data.collections.new('Cargo_Render_Studio_Not_Exported'))
scene.collection.children.link(studio)


def to_studio(ob):
    """
    摄影棚与货物集合分开，且在导出完成之后才建立。
    保存源文件时保留摄影棚，便于用户复现交付渲染。
    """
    ob.parent=None
    for col in list(ob.users_collection): col.objects.unlink(ob)
    studio.objects.link(ob)


floor_mat=material('Studio_Only_Gray','#D9DBDF',.82)
floor=mesh_obj('Studio_Floor',[(-200,-200,-.001),(200,-200,-.001),(200,200,-.001),(-200,200,-.001)],[(0,1,2,3)],floor_mat); to_studio(floor)
world=owned(bpy.data.worlds.new('Cargo_Neutral_World')); scene.world=world; world.use_nodes=True
world.node_tree.nodes.get('Background').inputs[0].default_value=(1,1,1,1)
world.node_tree.nodes.get('Background').inputs[1].default_value=.65
for name,loc,power,size in [('Key',(-3,-4,6),140,5),('Fill',(4,-1,3),60,4),('Back',(1,4,5),100,3)]:
    data=owned(bpy.data.lights.new('Studio_'+name,'AREA')); data.energy=power; data.shape='DISK'; data.size=size
    ob=owned(bpy.data.objects.new('Studio_'+name,data)); studio.objects.link(ob); ob.location=loc; aim(ob,(0,0,.55))
scene.render.engine='CYCLES'; scene.cycles.samples=P['samples']; scene.cycles.use_denoising=True
scene.render.resolution_x=P['resolution']; scene.render.resolution_y=P['resolution']; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='Standard'
scene.view_settings.look='None'
scene.view_settings.exposure=-.20
scene.render.film_transparent=False
views={'Front':(0,-5,.585),'Back':(0,5,.585),'Left':(-5,0,.585),'Right':(5,0,.585),'Top':(0,0,6),'Perspective':(2.5,-3.5,2.55)}
for name,loc in views.items():
    data=owned(bpy.data.cameras.new('Camera_'+name)); ob=owned(bpy.data.objects.new('Camera_'+name,data)); studio.objects.link(ob)
    ob.location=loc; aim(ob,(0,0,.585))
    data.type='PERSP' if name=='Perspective' else 'ORTHO'; data.ortho_scale=1.52; data.lens=65
    if name=='Perspective': data.lens=62
    if name=='Top': ob.rotation_euler=(0,0,0)
    scene.camera=ob
    scene.render.filepath=str(HERE/'renders'/f'{name}.png')
    if '--skip-renders' not in sys.argv:
        bpy.ops.render.render(write_still=True)
        print('CARGO_RENDER_COMPLETE',name,flush=True)
scene.camera=bpy.data.objects['Camera_Perspective']
scene['asset_parameters']=json.dumps(P,ensure_ascii=False)
bpy.context.view_layer.objects.active=root
bpy.ops.object.select_all(action='DESELECT'); root.select_set(True)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_distance=3
            area.spaces.active.region_3d.view_location=(0,0,.58)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'cargo_pallet.blend'))
if '--skip-renders' not in sys.argv:
    subprocess.run([P['python'],str(Path(__file__).resolve()),'--compose'],check=True)
    # 在另一 Blender 进程中重导入验证，绝不清空运行脚本的用户会话。
    # 当前源文件先保存，验证进程仅读取 GLB 和摄影棚配置。
    subprocess.run([P['blender'],'--background','--python',str(HERE/'verify_cargo_pallet.py')],check=True)
    write_notes()
print('CARGO_BUILD_COMPLETE',flush=True)
