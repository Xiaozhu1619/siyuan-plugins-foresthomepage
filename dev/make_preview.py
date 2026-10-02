# -*- coding: utf-8 -*-
"""用 Pillow 绘制集市预览图 preview.png（1024x768）。

本地无头浏览器不可用时，用程序化绘制的方式产出可复现的预览图：
布局、字号、颜色与 index.css 一一对应，先在 1056x792 的"视口"上绘制，
再整体缩放到 1024x768（等价于 0.97 的屏幕缩放，文字仍然清晰可读）。

用法：python dev/make_preview.py
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VIEW_W, VIEW_H = 1056, 792
OUT_W, OUT_H = 1024, 768

# ---------------------------------------------------------------- 调色板
TEXT = (35, 38, 43)
TEXT2 = (107, 114, 128)
MUTED = (138, 143, 152)
PRIMARY = (53, 117, 240)
BORDER = (232, 232, 236)
SURFACE = (255, 255, 255)
SOFT = (247, 247, 248)
NOTE_BG = (242, 243, 245)
PAGE_BG = (255, 255, 255)
FAINT = (206, 209, 214)

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

_font_cache = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(FONT_BOLD if bold else FONT_REG, int(size))
    return _font_cache[key]


def I(v):
    """Pillow 的多数图元要求整数坐标"""
    return int(round(v))


# ---------------------------------------------------------------- 文本
def text_width(draw, s, f, ls=0.0):
    if not s:
        return 0
    w = sum(draw.textlength(ch, font=f) for ch in s)
    return w + ls * (len(s) - 1)


def draw_text(draw, x, y, s, f, fill, ls=0.0):
    cx = x
    for ch in s:
        draw.text((cx, y), ch, font=f, fill=fill)
        cx += draw.textlength(ch, font=f) + ls
    return cx - x


def draw_text_center(draw, cx, y, s, f, fill, ls=0.0):
    w = text_width(draw, s, f, ls)
    draw_text(draw, cx - w / 2.0, y, s, f, fill, ls)
    return w


NO_START = "。，、；：！？）」』】》…—·"


def wrap_text(draw, s, f, max_w):
    """按字符宽度折行，并做简单的避头点处理（对应 CSS 的 line-break: strict）"""
    lines, cur = [], ""
    for ch in s:
        if draw.textlength(cur + ch, font=f) <= max_w or not cur or ch in NO_START:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def ellipsize(draw, s, f, max_w):
    if draw.textlength(s, font=f) <= max_w:
        return s
    out = ""
    for ch in s:
        if draw.textlength(out + ch + "…", font=f) > max_w:
            break
        out += ch
    return out + "…"


# ---------------------------------------------------------------- 图元
def rounded_shadow(img, box, radius, blur=13, offset=(0, 9), alpha=18):
    x0, y0, x1, y1 = box
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(
        [I(x0 + offset[0]), I(y0 + offset[1]), I(x1 + offset[0]), I(y1 + offset[1])],
        radius=radius, fill=(16, 24, 40, alpha),
    )
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def glyph_doc(draw, cx, cy, size, color):
    w = h = float(size)
    x0, y0 = cx - w / 2.0, cy - h / 2.0
    x1, y1 = x0 + w, y0 + h
    fold = w * 0.34
    draw.rounded_rectangle([I(x0), I(y0), I(x1), I(y1)], radius=2, outline=color, width=1)
    draw.line([I(x1 - fold), I(y0), I(x1 - fold), I(y0 + fold)], fill=color, width=1)
    draw.line([I(x1 - fold), I(y0 + fold), I(x1), I(y0 + fold)], fill=color, width=1)


def glyph_calendar(draw, cx, cy, size, color):
    w, h = float(size), size * 0.88
    x0, y0 = cx - w / 2.0, cy - h / 2.0
    x1, y1 = x0 + w, y0 + h
    draw.rounded_rectangle([I(x0), I(y0), I(x1), I(y1)], radius=2, outline=color, width=1)
    draw.line([I(x0), I(y0 + h * 0.28), I(x1), I(y0 + h * 0.28)], fill=color, width=1)
    draw.line([I(x0 + w * 0.29), I(y0 - 1.5), I(x0 + w * 0.29), I(y0 + h * 0.2)], fill=color, width=1)
    draw.line([I(x1 - w * 0.29), I(y0 - 1.5), I(x1 - w * 0.29), I(y0 + h * 0.2)], fill=color, width=1)


def glyph_clock(draw, cx, cy, size, color):
    r = size / 2.0
    draw.ellipse([I(cx - r), I(cy - r), I(cx + r), I(cy + r)], outline=color, width=1)
    draw.line([I(cx), I(cy - r * 0.5), I(cx), I(cy)], fill=color, width=1)
    draw.line([I(cx), I(cy), I(cx + r * 0.45), I(cy + r * 0.3)], fill=color, width=1)


def glyph_spark(draw, cx, cy, size, color):
    r = size / 2.0
    pts = []
    for i in range(8):
        angle = -math.pi / 2 + i * (math.pi / 4)
        rr = r if i % 2 == 0 else r * 0.4
        pts.append((I(cx + rr * math.cos(angle)), I(cy + rr * math.sin(angle))))
    draw.polygon(pts, outline=color, width=1)


def glyph_chevron(draw, cx, cy, size, color, direction):
    h, w = size * 0.4, size * 0.26
    sgn = -1 if direction == "left" else 1
    draw.line([I(cx - sgn * w / 2), I(cy - h), I(cx + sgn * w / 2), I(cy)], fill=color, width=2)
    draw.line([I(cx + sgn * w / 2), I(cy), I(cx - sgn * w / 2), I(cy + h)], fill=color, width=2)


def glyph_refresh(draw, cx, cy, size, color):
    r = size / 2.0
    draw.arc([I(cx - r), I(cy - r), I(cx + r), I(cy + r)], start=-40, end=250, fill=color, width=2)


def glyph_chart(draw, cx, cy, size, color):
    """柱状图图标"""
    for i, h in enumerate((0.52, 1.0, 0.72)):
        x = cx - size * 0.34 + i * size * 0.34
        draw.line([I(x), I(cy + size * 0.36), I(x), I(cy + size * 0.36 - size * h)],
                  fill=color, width=2)


def glyph_resize(draw, cx, cy, size, color):
    """右下角缩放抓手：两道斜线"""
    draw.line([I(cx - size * 0.18), I(cy + size * 0.34), I(cx + size * 0.34), I(cy - size * 0.18)],
              fill=color, width=2)
    draw.line([I(cx + size * 0.16), I(cy + size * 0.36), I(cx + size * 0.36), I(cy + size * 0.16)],
              fill=color, width=2)


def glyph_pin(draw, cx, cy, size, color, filled=False):
    """图钉：与插件里的 ICONS.pin 同形"""
    k = size / 15.0
    pts = [(cx - 3.2 * k, cy - 0.6 * k), (cx + 3.4 * k, cy - 6.4 * k),
           (cx + 6.6 * k, cy - 3.4 * k), (cx + 4.2 * k, cy + 1.0 * k),
           (cx + 5.4 * k, cy + 4.2 * k), (cx - 2.2 * k, cy + 3.0 * k),
           (cx - 0.6 * k, cy + 6.6 * k), (cx - 3.4 * k, cy - 0.2 * k),
           (cx - 6.4 * k, cy + 2.8 * k)]
    if filled:
        draw.polygon([(I(px), I(py)) for px, py in pts], fill=color)
    else:
        draw.polygon([(I(px), I(py)) for px, py in pts], outline=color, width=1)


def glyph_folder(draw, cx, cy, size, color):
    """文件夹：左上角一小片"标签"，下面是大块本体"""
    w, h = size, size * 0.78
    x0, y0 = cx - w / 2.0, cy - h / 2.0
    x1, y1 = x0 + w, y0 + h
    draw.rounded_rectangle([I(x0), I(y0), I(x0 + w * 0.46), I(y0 + h * 0.34)], radius=1.5, outline=color, width=1)
    draw.rounded_rectangle([I(x0), I(y0 + h * 0.26), I(x1), I(y1)], radius=2, outline=color, width=1)


def glyph_plus(draw, cx, cy, size, color):
    h = size / 2.0
    draw.line([I(cx), I(cy - h), I(cx), I(cy + h)], fill=color, width=2)
    draw.line([I(cx - h), I(cy), I(cx + h), I(cy)], fill=color, width=2)


def glyph_search(draw, cx, cy, size, color):
    """放大镜：圆心略偏左上，手柄朝右下（坐标全部相对 cx/cy）"""
    r = size * 0.30
    ox, oy = cx - size * 0.10, cy - size * 0.10
    draw.ellipse([I(ox - r), I(oy - r), I(ox + r), I(oy + r)], outline=color, width=2)
    draw.line([I(ox + r * 0.72), I(oy + r * 0.72), I(ox + size * 0.52), I(oy + size * 0.52)],
              fill=color, width=2)


# ---------------------------------------------------------------- 内容
# 全部为演示用的虚构数据，不涉及任何真实账号、文档或个人安排
GREETING = "晚上好，小明"
POEM = "今天从哪里开始？"
META = "2026年10月2日 星期五 · 19:53"
SEARCH_PLACEHOLDER = "搜索文档与内容…"

# 头部纵向排布（与 index.css 对齐）
HERO_PAD_TOP = 56
HERO_GAP_HI = 11
HERO_GAP_META = 12
HERO_GAP_SEARCH = 18
HERO_PAD_BOTTOM = 20
SEARCH_H = 44
SEARCH_W = 520

# 12 栅格：三张卡片各占 4 格（1/3 宽），高度统一 4 行
GRID_PAD = 30
GRID_GAP = 18
ROW_H = 84
SPAN_X = 3          # 12 栅格下四张卡片正好各占 1/4
SPAN_Y = 3          # 常规卡片 3 行高（预览版式：五行内塞得下两排卡片）
QUICK_SPAN = 12     # 快速访问默认整行宽
QUICK_SPAN_Y = 3
COL_W = (VIEW_W - GRID_PAD * 2 - GRID_GAP * 11) / 12.0
CARD_W = SPAN_X * COL_W + (SPAN_X - 1) * GRID_GAP
CARD_H = SPAN_Y * ROW_H + (SPAN_Y - 1) * GRID_GAP
COL_STEP = COL_W + GRID_GAP
CARD_COUNT = 4
QUICK_W = QUICK_SPAN * COL_W + (QUICK_SPAN - 1) * GRID_GAP
QUICK_H = QUICK_SPAN_Y * ROW_H + (QUICK_SPAN_Y - 1) * GRID_GAP
QUICK_ITEM_GAP = 8
QUICK_ITEM_MIN = 176
# 卡片边缘到条目网格之间被吃掉的横向内边距合计（与 index.js 的 QUICK_CONTENT_PADDING 一致）
QUICK_CONTENT_PADDING = 44
HI_SIZE = 27
POEM_SIZE = 16
META_SIZE = 12

# 四张卡片一行时单卡偏窄，标题控制在 8 字以内避免被省略号截断
RECENT = [
    ("读书笔记 · 第三章", "4 分钟前"),
    ("周报 · 第 39 周", "42 分钟前"),
    ("菜谱 · 番茄牛腩", "3 小时前"),
    ("会议纪要 · 周五", "10-01"),
    ("学习笔记 · 线代", "09-29"),
    ("影单 · 待看", "09-28"),
    ("收纳清单 · 书房", "09-27"),
    ("旅行计划 · 冬天", "09-26"),
]

NOTES = [
    ("「先写完，再写好。」初稿阶段别急着自我审查。", "10-02 19:27"),
    ("把常用的三样东西放在手边，其余收进抽屉。", "10-02 14:53"),
    ("好的工具应该消失在动作里。", "10-01 13:53"),
]

# 快速访问的示例分组（虚构数据）
# 最后一组故意留一条超长标题，用来看「只留前面几个字符 + 省略号」的效果
QUICK_GROUPS = [
    ("本周常用", ["周报 · 第 39 周", "会议纪要 · 周五", "读书笔记 · 第三章", "学习笔记 · 线代", "菜谱 · 番茄牛腩"]),
    ("写作用", ["灵感池", "选题清单", "素材 · 引用", "长文 · 草稿", "关于如何写好一份技术方案的第一版草稿"]),
    ("未分类", ["影单 · 待看", "收纳清单 · 书房", "旅行计划 · 冬天"]),
]

MONTH_LABEL = "2026 年 10 月"
WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]
LEAD = 3            # 2026-10-01 是周四，周一起始 => 前导 3 天（9/28-9/30）
DAYS_IN_MONTH = 31
TODAY = 2
DOTS = {2: 3, 5: 1, 9: 5, 14: 2, 17: 4, 21: 1, 26: 6, 28: 2}

# 行高常量（与 index.css 对齐）
ROW_H = 35          # .fh-doc
LINE_H = 21         # 13px * 1.62
NOTE_PAD_V = 8 + 6
NOTE_FOOT = 4 + 15


def main():
    img = Image.new("RGBA", (VIEW_W, VIEW_H), PAGE_BG + (255,))
    draw = ImageDraw.Draw(img)

    pad, gap = GRID_PAD, GRID_GAP
    card_w = CARD_W
    xs = [pad + i * SPAN_X * COL_STEP for i in range(CARD_COUNT)]
    top = (HERO_PAD_TOP + HI_SIZE * 1.32 + HERO_GAP_HI + POEM_SIZE * 1.55 +
           HERO_GAP_META + META_SIZE * 1.4 + HERO_GAP_SEARCH + SEARCH_H + HERO_PAD_BOTTOM + 6)

    body_w = card_w - 16
    note_text_w = body_w - 8 - 20          # compose 内边距 + note 内边距
    doc_title_w_base = body_w - 10 - 18 - 10 - 10

    # 预排版
    recent_rows = []
    for title, time in RECENT:
        avail = doc_title_w_base - text_width(draw, time, font(11), 0.4)
        recent_rows.append((ellipsize(draw, title, font(13), avail), time))

    note_rows = []
    for txt, stamp in NOTES:
        lines = wrap_text(draw, txt, font(13), note_text_w)
        h = NOTE_PAD_V + len(lines) * LINE_H + NOTE_FOOT
        note_rows.append((lines, stamp, h))

    cal_rows = (LEAD + DAYS_IN_MONTH + 6) // 7
    # 所有卡片同高（缩放档位决定），内容超出时卡片内部滚动
    heights = [CARD_H] * CARD_COUNT
    body_limit = top + CARD_H - 14

    # ---------------- 问候语（三行 + 搜索框） ----------------
    cy = HERO_PAD_TOP
    draw_text_center(draw, VIEW_W / 2.0, cy, GREETING, font(HI_SIZE, bold=True), TEXT, 0.75)
    cy += HI_SIZE * 1.32 + HERO_GAP_HI
    draw_text_center(draw, VIEW_W / 2.0, cy, POEM, font(POEM_SIZE), (122, 129, 140), 1.5)
    cy += POEM_SIZE * 1.55 + HERO_GAP_META
    draw_text_center(draw, VIEW_W / 2.0, cy, META, font(META_SIZE), (150, 156, 165), 1.15)
    cy += META_SIZE * 1.4 + HERO_GAP_SEARCH

    sx = (VIEW_W - SEARCH_W) / 2.0
    draw.rounded_rectangle([I(sx), I(cy), I(sx + SEARCH_W), I(cy + SEARCH_H)],
                           radius=12, fill=SOFT, outline=BORDER, width=1)
    glyph_search(draw, sx + 22, cy + SEARCH_H / 2.0, 17, MUTED)
    draw_text(draw, sx + 42, cy + (SEARCH_H - 17) / 2.0, SEARCH_PLACEHOLDER, font(13), MUTED, 0.25)

    # ---------------- 三张卡片 ----------------
    for i, x in enumerate(xs):
        box = [x, top, x + card_w, top + heights[i]]
        rounded_shadow(img, box, 18)
        draw.rounded_rectangle([I(v) for v in box], radius=18, fill=SURFACE, outline=BORDER, width=1)

        head_cy = top + 25
        if i == 0:
            glyph_clock(draw, x + 21, head_cy, 15, PRIMARY)
            title = "最近打开"
            glyph_refresh(draw, x + card_w - 22, head_cy, 15, TEXT2)
        elif i == 1:
            glyph_spark(draw, x + 21, head_cy, 15, PRIMARY)
            title = "灵感随记"
        elif i == 2:
            glyph_calendar(draw, x + 21, head_cy, 15, PRIMARY)
            title = "日历"
            glyph_chevron(draw, x + card_w - 76, head_cy, 15, TEXT2, "left")
            draw_text_center(draw, x + card_w - 46, head_cy - 7, "今天", font(12), TEXT2)
            glyph_chevron(draw, x + card_w - 20, head_cy, 15, TEXT2, "right")
        else:
            glyph_chart(draw, x + 21, head_cy, 15, PRIMARY)
            title = "统计"
            glyph_refresh(draw, x + card_w - 22, head_cy, 15, TEXT2)

        draw_text(draw, x + 34, head_cy - 9, title, font(14, bold=True), TEXT, 0.4)

        # 右下角的缩放抓手（悬停才明显，这里画淡一点示意）
        glyph_resize(draw, x + card_w - 13, top + CARD_H - 13, 13, (206, 209, 214))

        bx, by = x + 8, top + 47
        if i == 0:
            draw_recent(draw, bx, by, body_w, recent_rows, body_limit)
        elif i == 1:
            draw_notes(draw, bx, by, body_w, note_rows, body_limit)
        elif i == 2:
            draw_calendar(draw, bx, by, body_w, cal_rows)
        else:
            draw_stats(draw, bx, by, body_w, body_limit)

    # ---------------- 第二排：快速访问（默认整行宽） ----------------
    quick_top = top + CARD_H + GRID_GAP
    quick_x = pad
    qbox = [quick_x, quick_top, quick_x + QUICK_W, quick_top + QUICK_H]
    rounded_shadow(img, qbox, 18)
    draw.rounded_rectangle([I(v) for v in qbox], radius=18, fill=SURFACE, outline=BORDER, width=1)
    glyph_resize(draw, quick_x + QUICK_W - 13, quick_top + QUICK_H - 13, 13, (206, 209, 214))
    draw_quick(draw, quick_x, quick_top, QUICK_W)

    img = img.convert("RGB").resize((OUT_W, OUT_H), Image.LANCZOS)
    out = os.path.join(ROOT, "preview.png")
    img.save(out, "PNG", optimize=True)
    print("preview.png ->", os.path.getsize(out), "bytes")


def quick_cols(card_w, min_w=QUICK_ITEM_MIN, gap=QUICK_ITEM_GAP):
    """与插件里的 quickColumns 同一套换算规则。
    净宽 = 卡片宽 - QUICK_CONTENT_PADDING(44)，不是 16 —— 卡片内三级内边距都要扣掉。"""
    inner = max(0, card_w - QUICK_CONTENT_PADDING)
    if not inner:
        return 1
    return max(1, min(8, int((inner + gap) // (min_w + gap))))


def draw_quick(draw, x, top, card_w):
    """快速访问卡片：分组 + 条目流式网格（横向越宽，列数越多）"""
    head_cy = top + 25
    glyph_pin(draw, x + 21, head_cy, 16, PRIMARY)
    draw_text(draw, x + 34, head_cy - 9, "快速访问", font(14, bold=True), TEXT, 0.4)

    # 右上角：新建分组 + 添加
    glyph_plus(draw, x + card_w - 22, head_cy - 2, 15, TEXT2)
    add_text = "添加"
    aw = text_width(draw, add_text, font(13), 0.02)
    draw_text(draw, x + card_w - 34 - aw, head_cy - 8, add_text, font(13), TEXT2, 0.02)
    glyph_plus(draw, x + card_w - 44 - aw, head_cy - 2, 13, TEXT2)
    glyph_folder(draw, x + card_w - 68 - aw, head_cy - 2, 14, TEXT2)

    cols = quick_cols(card_w)
    content_w = max(0, card_w - QUICK_CONTENT_PADDING)
    item_w = (content_w - QUICK_ITEM_GAP * (cols - 1)) / float(cols)
    y = top + 47

    for name, items in QUICK_GROUPS:
        # 组头左侧的拖动抓手（六点），常驻低透明度
        grip_x = x + 16
        for gi in range(6):
            gx = grip_x + (gi % 2) * 5
            gy = y + 5 + (gi // 2) * 5
            draw.ellipse([I(gx - 1), I(gy - 1), I(gx + 1), I(gy + 1)], fill=MUTED + (110,))
        glyph_folder(draw, x + 29, y + 8, 14, MUTED)
        draw_text(draw, x + 40, y + 1, name, font(12.5, bold=True), TEXT2, 0.5)
        name_w = text_width(draw, name, font(12.5, bold=True), 0.5)
        cnt = str(len(items))
        bx0 = x + 46 + name_w
        draw.rounded_rectangle([I(bx0), I(y + 2), I(bx0 + 16 + len(cnt) * 5), I(y + 18)], radius=8, fill=SOFT)
        draw_text(draw, bx0 + 7, y + 4, cnt, font(11), MUTED, 0.2)
        y += 22

        for i, title in enumerate(items):
            r, c = divmod(i, cols)
            ix = x + 16 + c * (item_w + QUICK_ITEM_GAP)
            iy = y + r * 33
            draw.rounded_rectangle([I(ix), I(iy), I(ix + item_w), I(iy + 29)], radius=9, fill=SOFT)

            glyph_doc(draw, ix + 15, iy + 14, 13, MUTED)
            avail = item_w - 38
            draw_text(draw, ix + 26, iy + 8, ellipsize(draw, title, font(13), avail), font(13), TEXT, 0.01)

        rows = (len(items) + cols - 1) // cols
        y += rows * 33 + 14


def draw_recent(draw, bx, by, bw, rows, max_y):
    for idx, (title, time) in enumerate(rows):
        y = by + idx * ROW_H
        if y + ROW_H > max_y:
            break
        if idx == 0:
            draw.rounded_rectangle([I(bx), I(y), I(bx + bw), I(y + ROW_H - 3)], radius=10, fill=SOFT)
        glyph_doc(draw, bx + 19, y + ROW_H / 2.0 - 1.5, 13, MUTED)
        draw_text(draw, bx + 38, y + 9, title, font(13), TEXT, 0.15)
        tw = text_width(draw, time, font(11), 0.4)
        # 悬停的那一行会因图钉出现而把时间整体左移——和真实 flex 布局一致
        pin_w = 18 if idx == 0 else 0
        draw_text(draw, bx + bw - 10 - pin_w - tw, y + 10, time, font(11), MUTED, 0.4)
        if idx == 0:
            # 交代 Pin 的入口：悬停第一行时露出的实心图钉
            glyph_pin(draw, bx + bw - 19, y + ROW_H / 2.0 + 1, 14, PRIMARY, filled=True)


def draw_notes(draw, bx, by, bw, rows, max_y):
    inner_x, inner_w = bx + 4, bw - 8
    ta_h = 64
    draw.rounded_rectangle([I(inner_x), I(by), I(inner_x + inner_w), I(by + ta_h)],
                           radius=12, fill=SOFT, outline=BORDER, width=1)
    draw_text(draw, inner_x + 12, by + 11, "记下此刻的想法…", font(13), MUTED, 0.15)

    foot_y = by + ta_h + 8
    draw_text(draw, inner_x + 2, foot_y + 9, "⌘ / Ctrl + Enter", font(11), MUTED, 0.6)
    btn_w, btn_h = 62, 30
    btn_x = inner_x + inner_w - btn_w
    draw.rounded_rectangle([I(btn_x), I(foot_y), I(btn_x + btn_w), I(foot_y + btn_h)], radius=9, fill=PRIMARY)
    draw_text_center(draw, btn_x + btn_w / 2.0, foot_y + 8, "记录", font(13), SURFACE, 0.4)

    y = foot_y + btn_h + 12
    for lines, stamp, h in rows:
        if y + h > max_y:
            break
        draw.rounded_rectangle([I(inner_x), I(y), I(inner_x + inner_w), I(y + h)], radius=11, fill=NOTE_BG)
        ty = y + 8
        for line in lines:
            draw_text(draw, inner_x + 10, ty, line, font(13), TEXT, 0.15)
            ty += LINE_H
        draw_text(draw, inner_x + 10, ty + 3, stamp, font(11), MUTED, 0.7)
        y += h + 4


STATS = [("1,284", "笔记总数", "今日 +3"), ("2 小时 15 分", "今日使用时长", ""), ("1,860", "今日写作字数", "")]
STATS_NOTE = "使用时长自 2026-09-18 起本地累计"


def draw_stats(draw, bx, by, bw, max_y):
    x = bx + 6
    w = bw - 12
    y = by + 6
    for value, label, extra in STATS:
        h = 72
        if y + h > max_y:
            break
        draw.rounded_rectangle([I(x), I(y), I(x + w), I(y + h)], radius=12, fill=SOFT)
        draw_text(draw, x + 14, y + 12, value, font(21, bold=True), TEXT, 0.25)
        draw_text(draw, x + 14, y + 44, label, font(12), (92, 99, 110), 0.5)
        if extra:
            draw_text(draw, x + 14, y + 44 + 17, extra, font(11), PRIMARY, 0.4)
        y += h + 12
    if STATS_NOTE and y + 34 <= max_y:
        draw_text(draw, x + 2, y + 6, STATS_NOTE, font(11), (150, 156, 165), 0.25)


def draw_calendar(draw, bx, by, bw, rows):
    draw_text(draw, bx + 12, by + 1, MONTH_LABEL, font(15, bold=True), TEXT, 0.4)

    grid_x, grid_w = bx + 8, bw - 16
    col_w = grid_w / 7.0
    week_y = by + 26
    for i, wd in enumerate(WEEKDAYS):
        draw_text_center(draw, grid_x + col_w * (i + 0.5), week_y, wd, font(11), MUTED, 0.5)

    grid_y = week_y + 21
    day_h = 36
    for i in range(rows * 7):
        offset = i - LEAD
        row, col = divmod(i, 7)
        cx = grid_x + col_w * (col + 0.5)
        cy = grid_y + row * (day_h + 2) + day_h / 2.0
        other = offset < 0 or offset >= DAYS_IN_MONTH
        if other:
            label = str(30 + offset + 1) if offset < 0 else str(offset - DAYS_IN_MONTH + 1)
        else:
            label = str(offset + 1)

        if not other and offset + 1 == TODAY:
            draw.rounded_rectangle([I(cx - 15), I(cy - 15), I(cx + 15), I(cy + 15)], radius=10, fill=PRIMARY)
            draw_text_center(draw, cx, cy - 8, label, font(12.5), SURFACE, 0.2)
            if TODAY in DOTS:
                draw.ellipse([I(cx - 2), I(cy + 9), I(cx + 2), I(cy + 13)], fill=SURFACE)
            continue

        color = FAINT if other else TEXT
        draw_text_center(draw, cx, cy - 8, label, font(12.5), color, 0.2)
        if not other and (offset + 1) in DOTS:
            draw.ellipse([I(cx - 2), I(cy + 9), I(cx + 2), I(cy + 13)], fill=PRIMARY)


if __name__ == "__main__":
    main()
