# -*- coding: utf-8 -*-
"""按用户提供的像素画参考重绘应用图标。
角色：浅蓝近白的圆胖身体 + 深紫蓝大三角耳 + 圆眼 + 粉腮红 + 小微笑。
背景：参考图里的绿（上）到褐（下）渐变，做成圆角方形。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

BASE = 512
SS = 8
W = BASE * SS

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'assets')

# ---- 色板（取自参考图采样 + 适度提纯）----
BG_GREEN_HI = (96, 216, 108)
BG_GREEN_LO = (30, 132, 56)
BG_BROWN    = (126, 102, 74)

BODY_HI    = (232, 253, 255)
BODY_MID   = (188, 242, 250)
BODY_LO    = (132, 212, 234)
BODY_LINE  = (54, 128, 170)

EAR_DARK   = (40, 54, 96)
EAR_MID    = (76, 104, 164)
EAR_HI     = (128, 156, 210)
EAR_EDGE   = (18, 24, 46)

EYE        = (24, 34, 50)
BLUSH      = (250, 148, 174)
MOUTH      = (30, 68, 102)


def P(v):
    return int(round(v * W))


def poly(d, pts, fill, outline=None, w=0):
    xy = [(P(x), P(y)) for x, y in pts]
    d.polygon(xy, fill=fill)
    if outline:
        d.line(xy + [xy[0]], fill=outline, width=w, joint='curve')


def rounded_bg():
    """绿→褐竖向渐变，套圆角方形蒙版。"""
    grad = Image.new('RGB', (W, W))
    gd = ImageDraw.Draw(grad)
    y0, y1 = P(0.015), P(0.985)
    split = 0.60
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(1, (y1 - y0))
        if t < split:
            k = t / split
            c = tuple(int(BG_GREEN_HI[i] + (BG_GREEN_LO[i] - BG_GREEN_HI[i]) * (k ** 1.35))
                      for i in range(3))
        else:
            k = (t - split) / (1 - split)
            c = tuple(int(BG_GREEN_LO[i] + (BG_BROWN[i] - BG_GREEN_LO[i]) * (k ** 0.75))
                      for i in range(3))
        gd.line([(0, y), (W, y)], fill=c)

    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [P(0.015), P(0.015), P(0.985), P(0.985)], radius=P(0.225), fill=255)
    out = grad.convert('RGBA')
    out.putalpha(mask)
    return out


def ears(img):
    """大三角耳，向外上方张开，耳根埋进身体。"""
    lay = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)

    # 左耳：尖端朝上偏左，耳根埋进头顶
    L_OUT = [(0.205, 0.085), (0.480, 0.360), (0.150, 0.415)]
    L_MID = [(0.238, 0.145), (0.432, 0.352), (0.196, 0.398)]
    L_HI  = [(0.268, 0.192), (0.302, 0.208), (0.240, 0.372)]
    # 右耳：镜像
    R_OUT = [(0.795, 0.085), (0.520, 0.360), (0.850, 0.415)]
    R_MID = [(0.762, 0.145), (0.568, 0.352), (0.804, 0.398)]
    R_HI  = [(0.732, 0.192), (0.698, 0.208), (0.760, 0.372)]

    for pts in (L_OUT, R_OUT):
        poly(d, pts, EAR_DARK + (255,), outline=EAR_EDGE + (255,), w=max(3, P(0.011)))
    for pts in (L_MID, R_MID):
        poly(d, pts, EAR_MID + (255,))
    for pts in (L_HI, R_HI):
        poly(d, pts, EAR_HI + (255,))

    img.alpha_composite(lay)


def body(img):
    box = [P(0.062), P(0.268), P(0.938), P(0.952)]
    lay = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.ellipse(box, fill=(255, 255, 255, 255))

    grad = Image.new('RGB', (W, W))
    gd = ImageDraw.Draw(grad)
    y0, y1 = box[1], box[3]
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(1, (y1 - y0))
        if t < 0.45:
            k = t / 0.45
            c = tuple(int(BODY_HI[i] + (BODY_MID[i] - BODY_HI[i]) * k) for i in range(3))
        else:
            k = (t - 0.45) / 0.55
            c = tuple(int(BODY_MID[i] + (BODY_LO[i] - BODY_MID[i]) * (k ** 1.25)) for i in range(3))
        gd.line([(0, y), (W, y)], fill=c)

    grad = grad.convert('RGBA')
    lay = Image.composite(grad, Image.new('RGBA', (W, W), (0, 0, 0, 0)), lay.split()[3])

    # 左上高光
    hl = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([P(0.150), P(0.310), P(0.425), P(0.505)], fill=(255, 255, 255, 125))
    hl = hl.filter(ImageFilter.GaussianBlur(P(0.038)))
    lay.alpha_composite(hl)

    # 底部反光
    rl = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rl)
    rd.ellipse([P(0.330), P(0.800), P(0.670), P(0.905)], fill=(255, 255, 255, 60))
    rl = rl.filter(ImageFilter.GaussianBlur(P(0.028)))
    lay.alpha_composite(rl)

    ImageDraw.Draw(lay).ellipse(box, outline=BODY_LINE + (255,), width=max(3, P(0.013)))
    img.alpha_composite(lay)


def face(img):
    # 眼睛
    lay = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for ex in (0.352, 0.648):
        d.ellipse([P(ex - 0.050), P(0.478), P(ex + 0.050), P(0.594)], fill=EYE + (255,))
        d.ellipse([P(ex - 0.034), P(0.495), P(ex - 0.002), P(0.531)], fill=(255, 255, 255, 242))
        d.ellipse([P(ex + 0.010), P(0.552), P(ex + 0.030), P(0.572)], fill=(255, 255, 255, 172))
    img.alpha_composite(lay)

    # 腮红
    bl = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bl)
    for bx in (0.232, 0.768):
        bd.ellipse([P(bx - 0.086), P(0.622), P(bx + 0.086), P(0.698)], fill=BLUSH + (190,))
    bl = bl.filter(ImageFilter.GaussianBlur(P(0.021)))
    img.alpha_composite(bl)

    # 嘴
    mo = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    md = ImageDraw.Draw(mo)
    md.arc([P(0.446), P(0.604), P(0.554), P(0.694)], start=16, end=164,
           fill=MOUTH + (255,), width=max(3, P(0.016)))
    img.alpha_composite(mo)


def build_master():
    img = rounded_bg()
    ears(img)
    body(img)
    face(img)
    return img


def render(master, size):
    return master.resize((size, size), Image.LANCZOS)


def main():
    master = build_master()
    os.makedirs(OUT, exist_ok=True)

    render(master, 512).save(os.path.join(OUT, 'icon-512.png'))
    render(master, 512).save(os.path.join(OUT, 'icon.png'))
    for s in (16, 24, 32, 48, 64, 128, 256):
        render(master, s).save(os.path.join(OUT, f'icon-{s}.png'))
    render(master, 32).save(os.path.join(OUT, 'tray.png'))

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    render(master, 256).save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=ico_sizes)

    # 预览：深色行 + 浅色行，检查小尺寸可读性
    sheet = Image.new('RGBA', (900, 420), (18, 20, 26, 255))
    drow = ImageDraw.Draw(sheet)
    drow.rectangle([0, 210, 900, 420], fill=(245, 246, 248, 255))
    for y in (105, 315):
        x = 24
        for s in (16, 24, 32, 48, 64, 128):
            sheet.alpha_composite(render(master, s), (x, y - s // 2))
            x += s + 26
    sheet.alpha_composite(render(master, 320), (560, 50))
    sheet.save(os.path.join(OUT, '..', '..', 'icon-preview.png'))
    print('done ->', OUT)


if __name__ == '__main__':
    main()
