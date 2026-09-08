"""读取八张原始参考图并记录非白色有效区域。
像素测量仅用于比例推断，不把整张图片留白或立体图异常面计入真实尺寸。
"""
from pathlib import Path
import json
from PIL import Image, ImageChops

OUT = Path(__file__).resolve().parent
REF = Path('C:/Users/12899/Desktop/睿芯行3D场景/高清单图')
VIEWS = ['正视图', '后视图', '左视图', '右视图', '俯视图', '仰视图', '立体图1', '立体图2']
report = {}
for view in VIEWS:
    path = REF / f'设计1{view}.PNG'
    with Image.open(path) as source:
        rgba = source.convert('RGBA')
        base = Image.new('RGBA', rgba.size, 'white')
        base.alpha_composite(rgba)
        image = base.convert('RGB')
        difference = ImageChops.difference(image, Image.new('RGB', image.size, 'white'))
        mask = difference.convert('L').point(lambda v: 255 if v > 22 else 0)
        bbox = mask.getbbox()
        report[view] = {'path': str(path), 'image_size': image.size, 'content_bbox': bbox, 'readable': True}

# 以下为人工在正交原图上识别的结构边界，避免把投影中屏幕伸出部分算作车身。
# 多个视图先各自用车身像素尺寸归一化，再交叉核对主要结构比例。
report['calibration'] = {
    'right_body_x': [656, 1340], 'right_ground_y': 1193,
    'right_mast_top_y': 74, 'right_shell_top_y': 1048,
    'right_platform_y': [997, 1011], 'right_mast_x': [696, 763],
    'front_body_x': [788, 1208], 'front_mast_x': [939, 1057],
    'top_body_bbox': [718, 239, 1327, 1221],
    'ratios': {'height_over_length': 1119 / 684, 'width_over_length_top': 609 / 982,
               'mast_width_over_body_width': 118 / 420, 'platform_height_over_length': 196 / 684},
    'assumption': '车身长 1 米；宽 0.61 米；高 1.64 米。正交图之间存在约 1% 到 2% 的轮廓差异。',
    'excluded': '立体图中的拉伸大面、裁切边缘及轮胎向下异常延伸均不建为实体。'
}
(OUT / 'reference_measurements.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
