#!/usr/bin/env python3
"""
生成 Aria 的应用图标：build/icon.png（1024×1024，带透明圆角）。

用法：python scripts/make-icon.py
（开发期一次性工具。应用本身只依赖 Node —— 这个脚本不参与构建，
 产物 build/icon.png 已提交进仓库，electron-builder 会把它转成 icns / ico。）

设计：iOS/macOS 风格 —— 圆角方块 + 蓝紫渐变 + 白色均衡器条。
"""

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4                      # 超采样倍数，最后缩回去，边缘才干净
W = SIZE * SS
RADIUS = int(W * 0.2237)    # Apple 的圆角比例（约 22.37%）

TOP = (124, 92, 255)        # 紫
BOTTOM = (10, 132, 255)     # iOS 蓝（就是应用里的 --accent）


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    # 1) 竖向渐变
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, W))
    for y in range(W):
        grad.putpixel((0, y), lerp(TOP, BOTTOM, y / (W - 1)) + (255,))
    grad = grad.resize((W, W))

    # 2) 圆角遮罩
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=RADIUS, fill=255)
    canvas.paste(grad, (0, 0), mask)

    # 3) 白色均衡器条（圆头）：高度错落，像正在播放的波形
    draw = ImageDraw.Draw(canvas)
    bar_w = int(W * 0.115)
    gap = int(W * 0.062)
    heights = [0.30, 0.52, 0.72, 0.44]                 # 相对画布高
    total = bar_w * len(heights) + gap * (len(heights) - 1)
    x = (W - total) / 2
    for h in heights:
        bar_h = W * h
        y0 = (W - bar_h) / 2
        draw.rounded_rectangle([x, y0, x + bar_w, y0 + bar_h], radius=bar_w / 2, fill=(255, 255, 255, 255))
        x += bar_w + gap

    # 4) 缩回目标尺寸
    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    icon.save("build/icon.png")
    print(f"已写出 build/icon.png（{SIZE}×{SIZE}，圆角 {RADIUS // SS}px，{len(heights)} 条白色均衡器）")


if __name__ == "__main__":
    main()
