"""把实际渲染与原图裁去留白后并列排版，供视觉检验。
仅用于生成对照文档，不修改参考原文件，也不把图像用于车辆材质。
"""
from pathlib import Path
import json
import sys
from PIL import Image, ImageDraw, ImageFont, ImageChops

OUT = Path(__file__).resolve().parent
REF = Path('C:/Users/12899/Desktop/睿芯行3D场景/高清单图')
STAGE = sys.argv[1] if len(sys.argv) > 1 else 'final'
SOURCE = OUT / ('white_preview' if STAGE == 'white' else 'previews')
NAMES = {'front': '正视图', 'rear': '后视图', 'left': '左视图', 'right': '右视图',
         'top': '俯视图', 'bottom': '仰视图', 'front_right': '立体图1', 'rear_left': '立体图2'}
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 24)
SMALL = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 19)


def crop_content(path):
    """依据实际有效轮廓裁去各图不同的空白区域。
    透明渲染先铺白底，再用相同方法定位轮廓。
    """
    image = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', image.size, 'white')
    bg.alpha_composite(image)
    image = bg.convert('RGB')
    mask = ImageChops.difference(image, Image.new('RGB', image.size, 'white')).convert('L').point(lambda v: 255 if v > 20 else 0)
    return image.crop(mask.getbbox())


def put(canvas, source, rect):
    """等比缩放排入对照格子，不拉伸任何方向。
    正交图全车按有效轮廓高度对齐，俯仰视图按有效车身长度对齐。
    """
    source.thumbnail((rect[2] - rect[0], rect[3] - rect[1]), Image.Resampling.LANCZOS)
    x = rect[0] + (rect[2] - rect[0] - source.width) // 2
    y = rect[1] + (rect[3] - rect[1] - source.height) // 2
    canvas.paste(source, (x, y))


views = [v for v in NAMES if (SOURCE / (v + '.png')).exists()]
sheet = Image.new('RGB', (1500, 920 * ((len(views) + 1) // 2)), 'white')
draw = ImageDraw.Draw(sheet)
for i, view in enumerate(views):
    x, y = (i % 2) * 750, (i // 2) * 920
    draw.text((x + 22, y + 12), NAMES[view] + (' · 白模核对' if STAGE == 'white' else ' · 材质核对'), fill='#20242a', font=FONT)
    draw.text((x + 125, y + 56), '参考原图', fill='#666666', font=SMALL)
    draw.text((x + 496, y + 56), 'Blender 实际渲染', fill='#666666', font=SMALL)
    put(sheet, crop_content(REF / ('设计1' + NAMES[view] + '.PNG')), (x + 20, y + 100, x + 364, y + 885))
    put(sheet, crop_content(SOURCE / (view + '.png')), (x + 385, y + 100, x + 729, y + 885))
    draw.line((x + 373, y + 100, x + 373, y + 890), fill='#dddddd', width=1)
    draw.line((x + 15, y + 912, x + 735, y + 912), fill='#dddddd', width=1)
sheet.save(OUT / (STAGE + '_reference_comparison.jpg'), quality=94)
contact = Image.new('RGB', (2000, 1800), 'white')
draw = ImageDraw.Draw(contact)
for i, view in enumerate(views):
    x, y = (i % 4) * 500, (i // 4) * 900
    draw.text((x + 20, y + 15), NAMES[view], fill='#343a42', font=FONT)
    put(contact, crop_content(SOURCE / (view + '.png')), (x + 15, y + 70, x + 485, y + 868))
contact.save(OUT / (STAGE + '_contact_sheet.jpg'), quality=94)
print('COMPOSE_DONE', STAGE)
