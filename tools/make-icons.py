"""生成软件图标与各文件格式图标（纯 PIL，无外部依赖）。
用法：python tools/make-icons.py
产物：build/icon.ico、build/file-icons/<ext>.ico、docs/screenshots/_icon-preview.png
"""
from __future__ import annotations
import io
import os
import struct
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
FI = os.path.join(BUILD, "file-icons")
os.makedirs(FI, exist_ok=True)

SIZES = [16, 24, 32, 48, 64, 128, 256]
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_UI = r"C:\Windows\Fonts\msyh.ttc"

# 每种格式一套主色（深→浅），用于圆角底板渐变
ACCENTS = {
    "pdf":  ((192, 57, 43),  (233, 108, 92)),
    "png":  ((26, 86, 168),  (72, 148, 232)),
    "jpg":  ((166, 106, 6),  (232, 168, 46)),
    "jpeg": ((166, 106, 6),  (232, 168, 46)),
    "webp": ((106, 44, 168), (158, 96, 224)),
    "bmp":  ((12, 104, 112), (46, 168, 176)),
    "gif":  ((168, 42, 110), (226, 96, 162)),
    "svg":  ((28, 122, 74),  (76, 182, 122)),
    "avif": ((42, 62, 150),  (96, 122, 224)),
}
APP = ((26, 34, 56), (74, 42, 46))  # 软件图标：墨蓝 → 暗酒红


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_tile(size: int, top, bottom, radius_ratio=0.22) -> Image.Image:
    """圆角方形底板 + 竖直渐变（逐行画线，避免依赖 numpy）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(2, int(size * radius_ratio)), fill=255
    )
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(top, bottom, y / max(1, size - 1)) + (255,))
    img.paste(grad, (0, 0), mask)
    return img


def paper(size: int, accent) -> Image.Image:
    """一张带折角的纸，占画布约 62%，居中偏上。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = int(size * 0.60)
    h = int(size * 0.56)
    x0 = (size - w) // 2
    y0 = int(size * 0.09)
    fold = max(2, int(w * 0.30))
    body = (x0, y0, x0 + w, y0 + h)
    d.rounded_rectangle(body, radius=max(1, int(size * 0.05)), fill=(255, 255, 255, 255))
    # 折角：把右上角切掉，再画一个三角
    d.polygon(
        [(x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w - fold, y0 + fold)],
        fill=lerp(accent[0], (255, 255, 255), 0.55) + (255,),
    )
    d.polygon(
        [(x0 + w - fold, y0), (x0 + w - fold, y0 + fold), (x0 + w, y0 + fold)],
        fill=accent[0] + (255,),
    )
    return layer


def font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def label(img: Image.Image, text: str, size: int, color=(255, 255, 255)) -> None:
    """底部居中标签：用 anchor='mm' 垂直居中在 0.815h 处，绝不被圆角切掉。"""
    d = ImageDraw.Draw(img)
    f = font(FONT_BOLD, max(7, int(size * 0.26)))
    d.text((size / 2, size * 0.815), text, font=f, fill=color + (255,), anchor="mm")


def make_format(ext: str, size: int) -> Image.Image:
    top, bottom = ACCENTS[ext]
    img = rounded_tile(size, top, bottom)
    img.alpha_composite(paper(size, (top, bottom)))
    if size >= 24:
        label(img, ext.upper(), size)
    return img


def make_app(size: int) -> Image.Image:
    top, bottom = APP
    img = rounded_tile(size, top, bottom, radius_ratio=0.24)
    # 暖色光晕，压在左下角，和界面主色呼应
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = int(size * 0.55)
    gd.ellipse((int(-size * 0.25), int(size * 0.42), int(-size * 0.25) + r, int(size * 0.42) + r),
               fill=(200, 78, 58, 70))
    img.alpha_composite(glow)
    img.alpha_composite(paper(size, ACCENTS['pdf']))
    d = ImageDraw.Draw(img)
    # 纸面上的三条正文线，暗示"可读可批注"
    w = int(size * 0.30)
    x = int(size * 0.50) - w // 2
    for i, alpha in enumerate((70, 120, 170)):
        y = int(size * (0.46 + i * 0.12))
        d.rounded_rectangle((x, y, x + w, y + max(1, size // 40)),
                            radius=max(1, size // 80), fill=(30, 36, 50, alpha))
    if size >= 48:
        label(img, "PDF", size, color=(255, 255, 255))
    return img


def save_ico(path: str, fn) -> None:
    """逐尺寸渲染，拼成 32 位 BMP 帧的 ICO。

    ★ 用 BMP 帧而不是 PNG 帧：PNG 压缩帧虽然 Vista+ 支持，但 NSIS 的安装包图标
    与部分老工具读不了，实测会让编译器报错或图标显示为空。BMP 帧兼容性最好。
    小尺寸单独渲染的好处：24px 以下不写字，32px 的字也不会糊成一团。
    """
    frames = []
    for size in SIZES:
        rgba = fn(size)
        if size >= 256:
            """
            ★ 256 这一档必须用 PNG 帧：Windows 的图标解析器对 256×256 的
            32 位 BMP 帧支持不一致（Windows 10 的 Explorer 与部分安装器会
            直接判定整个 .ico 无效，于是回退到"图片类"通用图标）。实测
            2026-10-23 就是这个问题：.ico 用 GDI+ 能读，但资源管理器不认。
            """
            buf = io.BytesIO()
            rgba.save(buf, format="PNG", optimize=True)
            frames.append((size, buf.getvalue()))
            continue
        px = rgba.load()
        xor = bytearray()
        for y in range(size - 1, -1, -1):          # DIB 是自下而上
            for x in range(size):
                r, g, b, a = px[x, y]
                xor += bytes((b, g, r, a))
        mask_row = ((size + 31) // 32) * 4          # AND 掩码按 4 字节对齐
        and_mask = bytes(mask_row * size)           # 全 0 = 用 alpha 通道
        dib = struct.pack(
            "<IiiHHIIiiII",
            40, size, size * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0,
        )
        frames.append((size, dib + bytes(xor) + and_mask))

    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b""
    payload = b""
    for size, data in frames:
        side = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        payload += data
    with open(path, "wb") as fh:
        fh.write(header + entries + payload)


save_ico(os.path.join(BUILD, "icon.ico"), make_app)
for ext in ACCENTS:
    save_ico(os.path.join(FI, f"{ext}.ico"), lambda s, e=ext: make_format(e, s))
# 保持旧路径可用（安装器、文件关联都引用它）
save_ico(os.path.join(BUILD, "pdf-file.ico"), lambda s: make_format("pdf", s))

# 预览图（640 宽，白底 + 深底各一排）
preview = Image.new("RGB", (640, 460), (246, 247, 250))
order = ["pdf", "png", "jpg", "webp", "bmp", "gif", "svg", "avif"]
prev = Image.new("RGB", (640, 232), (16, 18, 24))
preview.paste(make_app(128), (32, 28), make_app(128))
for i, ext in enumerate(order):
    icon = make_format(ext, 96)
    preview.paste(icon, (200 + (i % 4) * 108, 26 + (i // 4) * 108), icon)
for i, ext in enumerate(order):
    icon = make_format(ext, 96)
    prev.paste(icon, (24 + (i % 8) * 77, 66), icon)
preview.paste(prev, (0, 232))
preview.save(os.path.join(ROOT, "docs", "screenshots", "_icon-preview.png"))
print("done")
