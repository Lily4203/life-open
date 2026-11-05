# -*- coding: utf-8 -*-
"""refine_cut.py —— 对已经裁好的单件图做去背。

之前失败是因为"背景参考色"采到了别的家具（书桌框左边正好压在白椅背上）。
现在每件家具已经是单独一张图，四角几乎一定是背景（墙角 / 地板），
从这里取色，再用"从边缘往里长"去掉连通的背景，家具内部的浅色区域碰不到。

跑法：python tools/refine_cut.py
"""

import os
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "assets", "furniture")

TOL = 17          # 颜色容差（最大分量差）。太大就吃家具，太小留边
FEATHER = 0.8     # 边缘羽化（像素）


def corner_colors(a, pad=6):
    h, w, _ = a.shape
    pts = []
    for y in (pad, h - pad - 1):
        for x in (pad, w - pad - 1):
            pts.append(a[y, x])
    # 再补四条边的中点，防止四角被家具占掉
    mx, my = w // 2, h // 2
    pts.append(a[pad, mx]); pts.append(a[h - pad - 1, mx])
    pts.append(a[my, pad]); pts.append(a[my, w - pad - 1])
    return np.array(pts, dtype=np.int16)


def cut_one(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)[:, :, :3]
    h, w, _ = a.shape

    refs = corner_colors(a)
    d = np.min(np.abs(a.astype(np.int16)[:, :, None, :] - refs[None, None, :, :]).max(axis=3), axis=2)
    cand = d <= TOL                       # 可能是背景的像素

    seed = np.zeros((h, w), bool)
    seed[0, :] = seed[-1, :] = True
    seed[:, 0] = seed[:, -1] = True
    m = seed & cand

    for _ in range(4000):
        n = m.copy()
        n[1:, :] |= m[:-1, :]; n[:-1, :] |= m[1:, :]
        n[:, 1:] |= m[:, :-1]; n[:, :-1] |= m[:, 1:]
        n &= cand
        if n.sum() == m.sum():
            break
        m = n

    alpha = (~m).astype(np.uint8) * 255
    # 去掉里面的小洞（家具上的花纹不该变透明）
    filled = alpha.copy()
    # 简单填洞：从边界做一次"外部"标记，没被标记的就是内部
    inv = (alpha == 0)
    ext = np.zeros((h, w), bool)
    ext[0, :] = inv[0, :]; ext[-1, :] = inv[-1, :]
    ext[:, 0] = inv[:, 0]; ext[:, -1] = inv[:, -1]
    for _ in range(4000):
        n = ext.copy()
        n[1:, :] |= ext[:-1, :]; n[:-1, :] |= ext[1:, :]
        n[:, 1:] |= ext[:, :-1]; n[:, :-1] |= ext[:, 1:]
        n &= inv
        if n.sum() == ext.sum():
            break
        ext = n
    holes = inv & ~ext
    filled[holes] = 255

    out = im.copy()
    a_out = Image.fromarray(filled, "L").filter(ImageFilter.GaussianBlur(FEATHER))
    out.putalpha(a_out)

    bb = out.getbbox()
    if bb:
        out = out.crop(bb)
    return out


def main():
    n = 0
    for f in sorted(os.listdir(D)):
        if not f.endswith(".png") or f.startswith("_"):
            continue
        p = os.path.join(D, f)
        out = cut_one(p)
        if out.width < 20 or out.height < 20:
            print("%-14s 失败（几乎全被吃掉）" % f)
            continue
        out.save(os.path.join(D, f.replace(".png", "_c.png")))
        print("%-14s %4d x %4d" % (f, out.width, out.height))
        n += 1
    print("完成", n, "件")


if __name__ == "__main__":
    main()
