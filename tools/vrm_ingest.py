# -*- coding: utf-8 -*-
"""
VRM 落位与体检。下载完不用手动搬文件，跑这个就行。

  python tools/vrm_ingest.py            # 扫下载目录 / QQ 文件 / 桌面，列出找到的 vrm 和压缩包
  python tools/vrm_ingest.py --install  # 把最新的那个装到 assets/vrm/fish.vrm 并体检
  python tools/vrm_ingest.py --install "D:/xxx/你的模型.vrm"
  python tools/vrm_ingest.py --check assets/vrm/fish.vrm   # 只体检

装的时候会：zip/7z 自动解开 → 找 .vrm → 连带同目录贴图一起搬进 assets/vrm/ → 改名 fish.vrm
"""
import os, sys, json, struct, shutil, zipfile, glob, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../life
DEST_DIR = os.path.join(ROOT, 'assets', 'vrm')
DEST = os.path.join(DEST_DIR, 'fish.vrm')

HOME = os.path.expanduser('~')
SCAN = [
    os.path.join(HOME, 'Downloads'),
    os.path.join(HOME, 'Desktop'),
    os.path.join(HOME, 'Documents', 'Tencent Files'),
    os.path.join(HOME, 'Documents', 'WeChat Files'),
]
ARCH = ('.zip', '.7z')


# ---------- 体检 ----------
def read_glb_json(path):
    with open(path, 'rb') as f:
        head = f.read(12)
        if len(head) < 12:
            return None, 'TooShort'
        magic, ver, total = struct.unpack('<III', head)
        if magic != 0x46546C67:
            return None, '不是 GLB（头 4 字节不是 glTF）'
        clen, ctype = struct.unpack('<II', f.read(8))
        if ctype != 0x4E4F534A:
            return None, '首个 chunk 不是 JSON'
        return json.loads(f.read(clen).decode('utf-8')), None


def bbox(j):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for m in j.get('meshes', []):
        for p in m.get('primitives', []):
            ai = p.get('attributes', {}).get('POSITION')
            if ai is None:
                continue
            a = j['accessors'][ai]
            if 'min' in a and 'max' in a:
                for i in range(3):
                    lo[i] = min(lo[i], a['min'][i])
                    hi[i] = max(hi[i], a['max'][i])
    if lo[0] > 1e8:
        return None
    return [round(h - l, 4) for l, h in zip(lo, hi)]


def check(path):
    print(f'\n== 体检 {path}')
    if not os.path.exists(path):
        print('   ！文件不存在')
        return False
    size = os.path.getsize(path)
    print(f'   大小  {size/1048576:.1f} MB')
    j, err = read_glb_json(path)
    if err:
        print(f'   ！{err}')
        return False

    ext = j.get('extensions', {})
    v0 = ext.get('VRM')
    v1 = ext.get('VRMC_vrm')
    if v0:
        meta = v0.get('meta', {})
        title = meta.get('title', '?')
        author = meta.get('author', '?')
        ver = 'VRM 0.x'
        bones = len(v0.get('humanoid', {}).get('humanBones', []))
        groups = v0.get('blendShapeMaster', {}).get('blendShapeGroups', [])
        exprs = [g.get('name', '?') for g in groups]
    elif v1:
        meta = v1.get('meta', {})
        title = meta.get('name', '?')
        author = ', '.join(a.get('name', '?') for a in (
            meta.get('authors') or ([meta['author']] if meta.get('author') else []))) or '?'
        ver = 'VRM 1.0'
        bones = len(v1.get('humanoid', {}).get('humanBones', {}))
        exprs = list((v1.get('expressions', {}).get('preset') or {}).keys())
    else:
        print('   ！不认：没有 VRM / VRMC_vrm 扩展，这大概是普通 glb，不是 VRM')
        return False

    print(f'   规范  {ver}')
    print(f'   名字  {title}')
    print(f'   作者  {author}')
    print(f'   骨骼  {bones} 个人形骨')
    print(f'   表情  {len(exprs)} 个：{", ".join(exprs[:14])}{" …" if len(exprs) > 14 else ""}')
    print(f'   网格  {len(j.get("meshes", []))} 个 / 材质 {len(j.get("materials", []))} 个')

    imgs = j.get('images', [])
    ext_uri = [i['uri'] for i in imgs if i.get('uri')]
    print(f'   贴图  {len(imgs)} 张' + (f'（{len(ext_uri)} 张是外部文件 → 目录结构必须保留）' if ext_uri else '（已内嵌）'))
    if ext_uri:
        miss = [u for u in ext_uri if not os.path.exists(os.path.join(os.path.dirname(path), u))]
        if miss:
            print(f'   ！缺 {len(miss)} 张贴图，按下面这些路径找：')
            for u in miss[:5]:
                print(f'      {u}')

    size3 = bbox(j)
    if size3:
        x, y, z = size3
        think = '米' if y < 3 else ('厘米' if y > 40 else '不明单位')
        print(f'   包围盒  {x} × {y} × {z}  → 原生高度 {y}，像是「{think}」')
    print('   结论  可以用' if bones >= 12 else '   结论 ！骨骼太少，可能动不了')
    return bones >= 12


# ---------- 招领 ----------
def scan():
    found = []
    for d in SCAN:
        if not os.path.isdir(d):
            continue
        for p in glob.glob(os.path.join(d, '**', '*.vrm'), recursive=True):
            found.append(p)
        for ext in ARCH:
            for p in glob.glob(os.path.join(d, '**', '*' + ext), recursive=True):
                nm = os.path.basename(p).lower()
                if 'vrm' in nm or '肥鱼' in nm or '鱼' in nm:
                    found.append(p)
    seen, out = set(), []
    for p in found:
        rp = os.path.realpath(p)
        if rp in seen:
            continue
        seen.add(rp)
        out.append((os.path.getmtime(p), p))
    out.sort(reverse=True)
    return out


def install(src, keep_name=False):
    os.makedirs(DEST_DIR, exist_ok=True)
    if src.lower().endswith(ARCH):
        if src.lower().endswith('.7z'):
            print('！7z 我解不开，请先手动解压，然后 --install 指向解压出来的 .vrm')
            return False
        tmp = os.path.join(DEST_DIR, '_extract')
        if os.path.isdir(tmp):
            shutil.rmtree(tmp)
        with zipfile.ZipFile(src) as z:
            names = z.namelist()
            z.extractall(tmp)
        vms = [os.path.join(tmp, n) for n in names if n.lower().endswith('.vrm')]
        if not vms:
            print('！这个压缩包里没有 .vrm，可能下错了（看看是不是 MMD 的 .pmx 或 Unity 的 .unitypackage）')
            return False
        vms.sort(key=lambda p: -os.path.getsize(p))
        inner = vms[0]
        print(f'   包里有 {len(vms)} 个 vrm，用最大的：{os.path.basename(inner)}')
        base = os.path.dirname(inner)
        # 连贴图一起搬：vrm 同目录及同级 textures 文件夹
        for item in os.listdir(base):
            if item.lower().endswith('.vrm'):
                continue
            s = os.path.join(base, item)
            d = os.path.join(DEST_DIR, item)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)
        shutil.copy2(inner, DEST)
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        shutil.copy2(src, DEST if not keep_name else os.path.join(DEST_DIR, os.path.basename(src)))
        # 同目录的贴图目录也带上
        base = os.path.dirname(src)
        for item in os.listdir(base):
            s = os.path.join(base, item)
            if os.path.isdir(s) and 'texture' in item.lower():
                shutil.copytree(s, os.path.join(DEST_DIR, item), dirs_exist_ok=True)
    print(f'   已装到 {DEST}')
    return check(DEST)


def main():
    args = sys.argv[1:]
    if '--check' in args:
        i = args.index('--check')
        p = args[i + 1] if len(args) > i + 1 else DEST
        check(p)
        return

    if '--install' in args:
        i = args.index('--install')
        rest = [a for a in args[i + 1:] if not a.startswith('--')]
        if rest:
            src = rest[0]
        else:
            c = scan()
            if not c:
                print('没扫到 .vrm 或压缩包。下载页面是百度网盘吗？那得先在浏览器里点下载。')
                return
            src = c[0][1]
            print(f'用最新的：{src}')
        install(src)
        return

    c = scan()
    if not c:
        print('扫过的目录：')
        for d in SCAN:
            print(f'  {"√" if os.path.isdir(d) else "×"} {d}')
        print('\n一个 .vrm / 压缩包都没有。百度网盘要先在浏览器登录、点「下载」才会落盘。')
        return
    print('找到这些（新的在上）：')
    for mt, p in c[:12]:
        print(f'  {time.strftime("%m-%d %H:%M", time.localtime(mt))}  {os.path.getsize(p)/1048576:8.1f} MB  {p}')
    print('\n装最新的那个：python tools/vrm_ingest.py --install')


if __name__ == '__main__':
    main()
