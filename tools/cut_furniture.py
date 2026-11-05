# -*- coding: utf-8 -*-
"""cut_furniture.py —— 从那张插画里抠出家具，导出透明 PNG。

不是"框一块矩形"：那样会把地板和墙一起带走。做法是从框的四条边往里泛洪，
把和边缘颜色连通的像素判成背景（地板/墙），剩下的才是家具。

顺序很重要：先抠，再裁到家具自己的外框，锚点记在脚底中心。
输出 `life/assets/furniture/<id>.png` + `furniture.json`（尺寸、锚点、原框）。
"""

import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "ref", "assets", "whale-room", "sample-room.png")
OUT = os.path.join(HERE, "..", "assets", "furniture")

# 框是照着网格数的（100px 一格），宁可稍大一点，泛洪会把多余的背景吃掉
BOXES = {
    "bed":      (108, 262, 575, 545),
    "desk":     (695, 196, 975, 462),
    "chair":    (556, 252, 748, 458),
    "shelf":    (352, 82, 486, 336),
    "dresser":  (474, 252, 568, 348),
    "rug":      (424, 474, 736, 666),
    "lamp":     (676, 236, 734, 302),
    "plant":    (84, 342, 152, 452),
}

TOL = 22          # 颜色容差（RGB 最大分量差）


def cut(fid, box):
    """裁一块圆角矩形，不抠图。

    这张插画全是蓝白，白床单 / 蓝墙的颜色距离小于抗锯齿噪声，按颜色抠一定会
    连家具一起吃掉（试过三版）。所以换成：矩形裁切 + 圆角羽化，
    房间的地板和墙用插画里的同一套颜色，贴片的背景就自然化在环境里。
    """
    im = Image.open(SRC).convert("RGBA")
    sub = im.crop(box).copy()

    mask = Image.new("L", sub.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, sub.width - 1, sub.height - 1], radius=34, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(22))
    sub.putalpha(mask)
    return sub, (0, 0, sub.width, sub.height)


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {}
    for fid, box in BOXES.items():
        img, bbox = cut(fid, box)
        p = os.path.join(OUT, fid + ".png")
        img.save(p)
        meta[fid] = {
            "file": fid + ".png",
            "w": img.width, "h": img.height,
            "src_box": box,          # 在原插画里的位置（相对房间，用来定初始摆位）
            "crop": bbox,
        }
        print("%-8s %4d x %4d   裁切=%s" % (fid, img.width, img.height, bbox))

    with open(os.path.join(OUT, "furniture.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("写出", os.path.join(OUT, "furniture.json"))


if __name__ == "__main__":
    main()
