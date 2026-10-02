# -*- coding: utf-8 -*-
"""纯 Python 生成插件图标（无需 Pillow）。

产物：
  icon.png           160x160  集市图标（圆角方块 + 白色小屋）
  dev/bg-sample.png  1200x800 仅用于本地预览校验背景图/遮罩层，不随插件发布
"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --------------------------------------------------------------------------- #
# PNG 编码
# --------------------------------------------------------------------------- #

def encode_png(width, height, rows):
    """rows: 每行是 bytes，长度 = width * 4（RGBA）"""
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def write_png(path, width, height, pixel_fn):
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            r, g, b, a = pixel_fn(x, y)
            row += bytes((r & 255, g & 255, b & 255, a & 255))
        rows.append(bytes(row))
    with open(path, "wb") as fp:
        fp.write(encode_png(width, height, rows))


def mix(c1, c2, t):
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(3))


# --------------------------------------------------------------------------- #
# 几何
# --------------------------------------------------------------------------- #

def in_rounded_rect(px, py, x0, y0, x1, y1, r):
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def in_rect(px, py, x0, y0, x1, y1):
    return x0 <= px <= x1 and y0 <= py <= y1


# --------------------------------------------------------------------------- #
# 图标
# --------------------------------------------------------------------------- #

ICON_SIZE = 160
SS = 4  # 每像素 4x4 超采样做抗锯齿
GREEN_TOP = (52, 160, 122)
GREEN_BOTTOM = (26, 118, 86)


def house_mask(u, v):
    """u, v 为 0..1 归一化坐标。返回 True 表示落在白色小屋图形内。"""
    roof = in_triangle(u, v, (0.5, 0.205), (0.135, 0.515), (0.865, 0.515))
    body = in_rect(u, v, 0.268, 0.485, 0.732, 0.795)
    if not (roof or body):
        return False
    # 门洞：挖掉一块圆角矩形
    if in_rounded_rect(u, v, 0.425, 0.615, 0.575, 0.80, 0.045):
        return False
    return True


def icon_pixel(px, py):
    hits = 0
    for sy in range(SS):
        for sx in range(SS):
            u = (px + (sx + 0.5) / SS) / ICON_SIZE
            v = (py + (sy + 0.5) / SS) / ICON_SIZE
            if not in_rounded_rect(u, v, 0.031, 0.031, 0.969, 0.969, 0.235):
                continue
            if house_mask(u, v):
                continue
            hits += 1
    total = SS * SS
    if hits == 0:
        return (0, 0, 0, 0)
    alpha = int(round(255 * hits / total))
    # 底色：竖直渐变 + 极轻微的左上高光
    t = py / (ICON_SIZE - 1)
    base = mix(GREEN_TOP, GREEN_BOTTOM, t)
    gloss = max(0.0, 1.0 - (px / ICON_SIZE * 0.6 + py / ICON_SIZE * 0.4)) * 0.055
    color = mix(base, (255, 255, 255), gloss)
    return (int(round(color[0])), int(round(color[1])), int(round(color[2])), alpha)


# --------------------------------------------------------------------------- #
# 预览用背景图（柔和的林间色带，仅本地校验用）
# --------------------------------------------------------------------------- #

def bg_pixel(px, py):
    w, h = 1200, 800
    u, v = px / w, py / h
    top = mix((92, 122, 112), (54, 78, 74), v ** 1.1)
    bottom = mix((176, 158, 132), (120, 104, 88), v ** 1.3)
    t = min(1.0, max(0.0, (v - 0.42) / 0.58))
    base = mix(top, bottom, t * t * (3 - 2 * t))
    glow = math.exp(-(((u - 0.72) ** 2) / 0.06 + ((v - 0.18) ** 2) / 0.05)) * 0.30
    color = mix(base, (255, 244, 222), glow)
    grain = ((px * 7919 + py * 104729) % 13) / 13.0 - 0.5
    color = tuple(min(255, max(0, c + grain * 4)) for c in color)
    return (int(color[0]), int(color[1]), int(color[2]), 255)


def main():
    icon_path = os.path.join(ROOT, "icon.png")
    write_png(icon_path, ICON_SIZE, ICON_SIZE, icon_pixel)
    print("icon.png ->", os.path.getsize(icon_path), "bytes")

    bg_path = os.path.join(ROOT, "dev", "bg-sample.png")
    write_png(bg_path, 1200, 800, bg_pixel)
    print("dev/bg-sample.png ->", os.path.getsize(bg_path), "bytes")


if __name__ == "__main__":
    main()
