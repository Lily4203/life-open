# -*- coding: utf-8 -*-
"""
找出封面页上那块黑色残留是哪个 drawable。

背景：模型在鼻梁位置渲染了一个黑色圆角方块（原版 deepseek 也有，不是压缩造成的）。
715 个 drawable，人眼试错太慢，用二分：
  关掉 [lo,hi) 区间 → 截图 → 数黑块区域的暗像素
  明显下降 → 黑块在被关的区间里

用法：python tools/find_black_drawable.py
输出：把范围缩到单个 index 后打印，并另存一张"关掉它"的截图供人判断。
"""
import os, sys, subprocess
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

URL = 'http://127.0.0.1:8765/%E9%A2%84%E8%A7%88-67.html'
SHOT = 'tools/shot_cdp.py'
OUT  = '_bisect.png'
# 黑块在 1440x900 下的区域（连通域实测：(978,319)-(991,336)，外扩几像素）
RX0, RY0, RX1, RY1 = 965, 305, 1005, 350
BASE = 196          # 未处理时该区域的暗像素数


def dark_count(path):
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    reg = a[RY0:RY1, RX0:RX1]
    return int(((reg[:, :, 0] < 50) & (reg[:, :, 1] < 50) & (reg[:, :, 2] < 50)).sum())


def shot(hide_from, hide_to):
    ev = ("(()=>{const d=window.__m.internalModel.coreModel._model.drawables;"
          "window.__app.renderer.on('prerender',()=>{"
          f"for(let i={hide_from};i<{hide_to};i++){{"
          "d.opacities[i]=0;d.dynamicFlags[i]=d.dynamicFlags[i]|4;}});return 1})()")
    env = dict(os.environ, EVAL=ev, EVAL_WAIT='1.0')
    subprocess.run([sys.executable, SHOT, URL, OUT, '10', '1440', '900'],
                   env=env, capture_output=True, cwd=ROOT)
    return dark_count(os.path.join(ROOT, OUT))


def main():
    lo, hi = 0, 715
    n0 = shot(lo, hi)
    print(f'全部关掉时黑块区暗像素 = {n0}（基准 {BASE}）')
    if n0 >= BASE * 0.7:
        print('全关都没变化 —— 黑块不在 drawable 层，二分无意义，停止。')
        return

    while hi - lo > 1:
        mid = (lo + hi) // 2
        n = shot(lo, mid)
        inside = n < BASE * 0.5
        print(f'  关 [{lo},{mid}) → {n:4d}  ' + ('黑块在此区间' if inside else '不在此区间'))
        if inside:
            hi = mid
        else:
            lo = mid

    print(f'\n黑块 = drawable #{lo}')
    n = shot(lo, lo + 1)
    print(f'单独关掉 #{lo} 后暗像素 = {n}（基准 {BASE}）')
    # 留一张图给人看：关掉它以后脸还正常吗
    Image.open(os.path.join(ROOT, OUT)).save(os.path.join(ROOT, '_only_off.png'))
    print('已存 life/_only_off.png')


if __name__ == '__main__':
    main()
