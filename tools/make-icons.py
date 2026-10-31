# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧
"""
整套图标生成。

两套图标，一次生成：

一、软件主体（用户 2026-10-31 追加要求）
    「秋夕」字样 ＋ 多张文件堆叠 ＋ 画笔
    底色沿用暮色（夜蓝 → 暮紫 → 落日橙），把「秋夕」的时令感留在底上；
    主体内容按用户要求做：三张纸页错位堆叠，正面写「秋夕」，右下斜插一支画笔。

二、文件格式图标
    PDF / PNG / JPG / WEBP / BMP / GIF / TIF / ICO 各一枚，
    统一「纸页 + 折角 + 底部格式色带 + 格式文字」，靠配色与文字区分。

全部矢量绘制 + 8 倍超采样再缩小，任何尺寸都不是放大位图。
小尺寸按图标设计通行做法做减法（见各函数注释）。

产出：
    build/icon.ico                    应用图标（9 个尺寸）
    build/pdf-file.ico                PDF 关联图标（兼容旧路径）
    build/file-icons/<fmt>.ico        各格式关联图标
    build/icon-preview.png            应用图标预览
    build/file-icons-preview.png      格式图标预览

用法：python tools/make-icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
FILE_ICONS = os.path.join(BUILD, "file-icons")

SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
SS = 8  # 超采样倍数

# ── 暮色：夜蓝 → 暮紫 → 落日橙 ────────────────────────
DUSK = [(0x12, 0x20, 0x4F), (0x5B, 0x2E, 0x6E), (0xE9, 0x76, 0x4C)]

# 纸张三色：越靠后越旧一点，堆叠层次才出来
PAGE_BACK2 = (0xDE, 0xD8, 0xCE, 255)
PAGE_BACK1 = (0xEF, 0xEA, 0xE1, 255)
PAGE_FRONT = (255, 255, 255, 255)

INK = (0x1B, 0x1F, 0x33, 255)       # 「秋夕」字色：近墨黑，压在米白纸上
INK_SOFT = (0xB8, 0xAE, 0x9C, 255)  # 纸上的占位横线
AMBER = (0xF2, 0x9E, 0x3B, 255)     # 画笔笔杆 = 秋色
AMBER_DARK = (0xC9, 0x6C, 0x1E, 255)
NIB = (0x2B, 0x2F, 0x3A, 255)       # 笔尖

# ── 各格式专属配色（沿用行业习惯，一眼能分）──────────────
FORMATS = {
    "pdf": ((0xD9, 0x30, 0x25), "PDF"),
    "png": ((0x2E, 0x7D, 0x32), "PNG"),
    "jpg": ((0xC2, 0x18, 0x5B), "JPG"),
    "webp": ((0x00, 0x83, 0x8F), "WEBP"),
    "bmp": ((0x6D, 0x4C, 0x41), "BMP"),
    "gif": ((0x7B, 0x1F, 0xA2), "GIF"),
    "tif": ((0x45, 0x5A, 0x64), "TIF"),
    "ico": ((0xF9, 0xA8, 0x25), "ICO"),
}


# ──────────────────────────────────────────────────────
# 公共工具
# ──────────────────────────────────────────────────────

def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def three_stop(top, mid, bottom, t: float):
    if t < 0.5:
        k = t / 0.5
        return tuple(lerp(top[i], mid[i], k) for i in range(3))
    k = (t - 0.5) / 0.5
    return tuple(lerp(mid[i], bottom[i], k) for i in range(3))


def gradient(size: int, stops) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        r, g, b = three_stop(stops[0], stops[1], stops[2], t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))
    return img


def plate_mask(size: int, inset: float, radius: float) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [inset, inset, size - 1 - inset, size - 1 - inset], radius=radius, fill=255
    )
    return m


def font(size_px: int, cjk: bool = False):
    """
    取字体。

    cjk=True 走中文字体（微软雅黑 / 黑体）；找不到就直接抛错 ——
    静默降级成位图字体会把「秋夕」画成两个方块，比报错更糟。
    """
    names = (
        ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "SourceHanSansSC-Bold.otf"]
        if cjk
        else ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size_px)
        except OSError:
            continue
    if cjk:
        raise RuntimeError("找不到中文字体，无法绘制「秋夕」字样")
    return ImageFont.load_default()


def save_ico(path: str, render, sizes=SIZES) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    frames = [render(s) for s in sizes]
    frames[-1].save(
        path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1]
    )
    print(f"  {os.path.relpath(path, ROOT):<40} {os.path.getsize(path) / 1024:6.1f} KB  ({len(sizes)} 尺寸)")


# ──────────────────────────────────────────────────────
# 一、软件主体：「秋夕」+ 文件堆叠 + 画笔
# ──────────────────────────────────────────────────────

def draw_app(size: int) -> Image.Image:
    S = size * SS
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    def P(x: float, y: float) -> tuple[int, int]:
        return (round(x * S), round(y * S))

    # 暮色底牌
    plate = gradient(S, DUSK)
    plate.putalpha(plate_mask(S, round(S * 0.02), round(S * 0.225)))
    canvas.alpha_composite(plate)

    d = ImageDraw.Draw(canvas, "RGBA")

    # 落日余晖：左下角一团暖光
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gx, gy, gr = S * 0.22, S * 1.00, S * 0.60
    gd.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=(0xFF, 0xB4, 0x6A, 44))
    canvas.alpha_composite(glow)

    # ---------- 三张纸页，错位堆叠 ----------
    # 后两张往右上错开，形成「一叠文件」；正面那张在左下，用来写字。
    # 小尺寸收敛错位量，否则 16px 下糊成一块砖。
    off = 0.040 if size >= 40 else 0.026
    page_w, page_h = 0.50, 0.56
    base_x, base_y = 0.145, 0.235
    radius = round(S * 0.022)

    for k, col in ((2, PAGE_BACK2), (1, PAGE_BACK1)):
        px, py = base_x + off * k, base_y - off * k
        d.rounded_rectangle(
            [P(px, py), P(px + page_w, py + page_h)], radius=radius, fill=col
        )

    # 正面页 + 顶部秋色压条
    fx, fy = base_x, base_y
    d.rounded_rectangle(
        [P(fx, fy), P(fx + page_w, fy + page_h)], radius=radius, fill=PAGE_FRONT
    )
    d.rounded_rectangle(
        [P(fx + 0.045, fy + 0.050), P(fx + page_w - 0.045, fy + 0.078)],
        radius=round(S * 0.014),
        fill=AMBER,
    )

    # ---------- 「秋夕」字样 ----------
    # ≤24px 不写字：两个汉字的笔画在那个尺度只剩两团墨点，反而脏。
    # 这一档保留「纸叠 + 画笔」，语义仍然成立。
    if size >= 32:
        label = "秋夕"
        fsize = round(min(S * 0.180, page_w * S * 0.40))
        f = font(fsize, cjk=True)
        tw = d.textlength(label, font=f)
        ty = fy + 0.085 + (page_h - 0.085) * 0.34
        d.text(
            (S * (fx + page_w / 2) - tw / 2, S * ty),
            label,
            font=f,
            fill=INK,
            anchor="lm",
        )
        # 字下两条占位横线：暗示这是一页"文件"，不是一张卡片
        for i, w in enumerate((0.30, 0.20)):
            y = ty + 0.135 + i * 0.072
            d.rounded_rectangle(
                [P(fx + 0.075, y), P(fx + 0.075 + w, y + 0.028)],
                radius=round(S * 0.014),
                fill=INK_SOFT,
            )

    # ---------- 画笔：斜插在纸叠右下 ----------
    pen_from = (0.900, 0.935)   # 笔尾
    pen_to = (0.672, 0.512)     # 笔尖
    stroke = max(2, round(S * (0.062 if size >= 40 else 0.082)))

    d.line([P(*pen_from), P(*pen_to)], fill=AMBER, width=stroke, joint="curve")

    # 笔杆高光：靠一侧的浅色细线，做出圆柱感
    dx, dy = pen_to[0] - pen_from[0], pen_to[1] - pen_from[1]
    ln = (dx * dx + dy * dy) ** 0.5 or 1
    nx, ny = -dy / ln, dx / ln
    hx, hy = nx * 0.012, ny * 0.012
    d.line(
        [P(pen_from[0] + hx, pen_from[1] + hy), P(pen_to[0] + hx, pen_to[1] + hy)],
        fill=(255, 236, 200, 190),
        width=max(1, round(stroke * 0.22)),
    )

    # 笔尖：三角 + 深色，指出"写字的那一头"
    nib_len = 0.100
    base_pt = (pen_to[0] + dx / ln * nib_len, pen_to[1] + dy / ln * nib_len)
    half = 0.040
    d.polygon(
        [
            P(*pen_to),
            P(base_pt[0] + nx * half, base_pt[1] + ny * half),
            P(base_pt[0] - nx * half, base_pt[1] - ny * half),
        ],
        fill=NIB,
    )

    # 笔尾封口
    cap = (pen_from[0] - dx / ln * 0.032, pen_from[1] - dy / ln * 0.032)
    d.line([P(*pen_from), P(*cap)], fill=AMBER_DARK, width=stroke)

    return canvas.resize((size, size), Image.LANCZOS)


# ──────────────────────────────────────────────────────
# 二、文件格式：纸页 + 折角 + 色带 + 格式文字
# ──────────────────────────────────────────────────────

def draw_format(size: int, fmt: str) -> Image.Image:
    accent, label = FORMATS[fmt]
    S = size * SS
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    def P(x: float, y: float) -> tuple[int, int]:
        return (round(x * S), round(y * S))

    # 纸页：带右上折角
    l, r, t, b = 0.15, 0.85, 0.075, 0.925
    cut = 0.155
    page = [P(l, t), P(r - cut, t), P(r, t + cut), P(r, b), P(l, b)]
    d = ImageDraw.Draw(canvas, "RGBA")
    d.polygon(page, fill=(255, 255, 255, 255))
    d.polygon([P(r - cut, t), P(r, t + cut), P(r - cut, t + cut)], fill=(0xDF, 0xE4, 0xEE, 255))
    d.line(page + [page[0]], fill=(0xC3, 0xCB, 0xD8, 255), width=max(1, round(S * 0.008)))

    # 底部格式色带（先画一遍再按纸页形状裁切，圆角不会溢出到纸外）
    band_top = b - 0.20
    clip = Image.new("L", (S, S), 0)
    ImageDraw.Draw(clip).polygon(page, fill=255)
    band_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(band_layer).rounded_rectangle(
        [P(l, band_top), P(r, b)], radius=round(S * 0.012), fill=(*accent, 255)
    )
    band_layer.putalpha(
        Image.composite(band_layer.getchannel("A"), Image.new("L", (S, S), 0), clip)
    )
    canvas.alpha_composite(band_layer)

    # ★ 下面是像素坐标，不是归一化值
    #   （踩过：直接拿 0~1 的比例当像素，文字被画到图外，表现为"只有色带没有字"）
    cy = (band_top * S + b * S) / 2

    if size >= 28:
        fsize = round(S * (0.135 if len(label) <= 3 else 0.098))
        f = font(fsize)
        tw = d.textlength(label, font=f)
        d.text((S / 2 - tw / 2, cy), label, font=f, fill=(255, 255, 255, 255), anchor="lm")
    else:
        # 小尺寸：色带中间一颗白点，暗示"这里有标识"
        rad = S * 0.035
        d.ellipse([S / 2 - rad, cy - rad, S / 2 + rad, cy + rad], fill=(255, 255, 255, 230))

    # 上半部分三条浅灰横线，强化"文档"语义（小尺寸省略）
    if size >= 40:
        for i, w in enumerate((0.46, 0.46, 0.30)):
            y = 0.23 + i * 0.115
            d.rounded_rectangle(
                [P(0.28, y), P(0.28 + w, y + 0.055)],
                radius=round(S * 0.028),
                fill=(0xC9, 0xD1, 0xDE, 255),
            )

    return canvas.resize((size, size), Image.LANCZOS)


# ──────────────────────────────────────────────────────
# 预览图
# ──────────────────────────────────────────────────────

def preview(path: str, items) -> None:
    gap = 10
    cell = 256 + gap * 2
    sheet = Image.new("RGBA", (cell * len(items), cell + 34), (246, 246, 248, 255))
    d = ImageDraw.Draw(sheet)
    f = font(18)
    for i, (label, img) in enumerate(items):
        x = i * cell + (cell - img.width) // 2
        y = 12 + (256 - img.height) // 2
        sheet.alpha_composite(img, (x, y))
        tw = d.textlength(label, font=f)
        d.text((i * cell + cell / 2 - tw / 2, cell + 2), label, font=f, fill=(70, 70, 82, 255))
    sheet.save(path)
    print(f"  {os.path.relpath(path, ROOT):<40} 预览")


if __name__ == "__main__":
    print("① 软件主体图标（秋夕 + 文件堆叠 + 画笔）")
    save_ico(os.path.join(BUILD, "icon.ico"), draw_app)

    print("② 文件格式图标")
    for fmt in FORMATS:
        save_ico(os.path.join(FILE_ICONS, f"{fmt}.ico"), lambda s, f=fmt: draw_format(s, f))
    save_ico(os.path.join(BUILD, "pdf-file.ico"), lambda s: draw_format(s, "pdf"))

    print("③ 预览")
    preview(os.path.join(BUILD, "icon-preview.png"), [(f"{s}", draw_app(s)) for s in SIZES])
    preview(
        os.path.join(BUILD, "file-icons-preview.png"),
        [(FORMATS[k][1], draw_format(128, k)) for k in FORMATS],
    )
