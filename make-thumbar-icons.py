#!/usr/bin/env python3
"""
生成任务栏缩略图工具栏（thumbarButtons）用的 16x16 单色图标。

Electron 的 setThumbarButtons 只接受 PNG/ICO 小图标，且没有"用系统图标"的选项，
所以这里手写最小 PNG 编码器直接画：白色前景 + 透明底（Windows 会按主题着色）。

运行：python make-thumbar-icons.py
输出：src/assets/thumb-prev.png / thumb-play.png / thumb-pause.png / thumb-next.png
"""
import os
import struct
import zlib

W = H = 16
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def write_png(path, pixels):
    raw = b''
    for y in range(H):
        raw += b'\x00'                      # 每行滤波器类型 0
        for x in range(W):
            raw += bytes(pixels[y][x])

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))  # 8bit RGBA
    out += chunk(b'IDAT', zlib.compress(raw, 9))
    out += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)


def inside_tri(x, y, a, b, c):
    def sign(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    p = (x, y)
    d1, d2, d3 = sign(p, a, b), sign(p, b, c), sign(p, c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def inside_rect(x, y, x0, y0, x1, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def render(shape):
    return [[WHITE if shape(x + 0.5, y + 0.5) else CLEAR for x in range(W)] for y in range(H)]


def play(x, y):
    return inside_tri(x, y, (5, 3), (5, 13), (12, 8))


def next_(x, y):
    return play(x, y) or inside_rect(x, y, 12, 3, 13, 13)


def prev(x, y):
    return inside_tri(x, y, (11, 3), (11, 13), (4, 8)) or inside_rect(x, y, 2, 3, 3, 13)


def pause(x, y):
    return inside_rect(x, y, 5, 3, 7, 13) or inside_rect(x, y, 9, 3, 11, 13)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, 'src', 'assets')
    icons = {
        'thumb-play.png': play,
        'thumb-pause.png': pause,
        'thumb-prev.png': prev,
        'thumb-next.png': next_,
    }
    for name, shape in icons.items():
        path = os.path.join(out_dir, name)
        write_png(path, render(shape))
        print('wrote', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
