/* 3D 那一整套：场景、房间、她、互动、表现、每帧。
 * ============================================================
 * 为什么从页面里搬出来：
 *   ① 66 这个文件原本 3100 多行，改一行 3D 和改一行大脑接线混在一起，
 *      diff 看不出动了哪一层；拆文件之后"改画风"只开这一个文件。
 *   ② 搬出来才能被 node 直接 import 着验（姿势、手势、几何都是纯函数）。
 *   ③ 页面剩下的是"接线和界面"，那才是真的需要人眼看的 900 行。
 *
 * 为什么整段包成一个函数，而不是切成七八个小模块：
 *   这 2000 行是**顺序执行**的顶层代码，`const scene` 建好之后下面几十处都用它。
 *   切成小模块要么把每一样都显式传一遍（改动面 2000 行），要么满世界 getter。
 *   包成函数就不动一个引用：函数体里原来的 `const` 照旧互相可见，
 *   对外只留 `window.__XXX`（本来就有）。**先搬家，再拆房间**——
 *   一次只动一件事，冒烟测试才追得动。
 *
 * 边界（拆完必须还是这样）：
 *   · 这里不碰大脑：不 import loop/executor/memory，只说形状（pose/position）
 *   · 这里不做决定：手的角度、什么时候眨眼，都是"怎么演"，不是"做什么"
 */
import * as THREE from '../../vendor/three/three.module.js';
import { GLTFLoader } from '../../vendor/three/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '../../vendor/vrm/three-vrm.module.js';
/* 手势的词表和演法在 js/brain/gestures.mjs：那是数据，页面只是播放器。
 * 放页面里就只能靠眼睛验；放那边，node 能验它有没有碰到不该碰的骨头。 */
import { GESTURES as GEST, NEAREST, sample as gestSample } from '../brain/gestures.mjs';
/* 装没装完由页面自己报（js/brain/ready.mjs）。外面只认这一份，不猜全局。 */
import { READY } from '../brain/ready.mjs';

/* 尺寸和家具规格在 js/room/spec.mjs：建模、走位、门的宽度用的是同一份数。 */
import { B, SEAT, DESK_TOP, SIT_DROP, ROOM, BED, DESK, CHAIR, DOOR } from './spec.mjs';

/* 表现层在 js/room/perf.mjs：她"怎么动"。这里只把骨头和状态递给它。 */
import { createPerf } from './perf.mjs';
/* 动作插槽在 js/room/anim/：走路/呼吸/待机那套"每帧叠在姿势上的偏移"。
 * 以前是散在这个文件里的一堆赋值，走路只有平移、腿一动不动。
 * 现在换一套动作 = 换一个注册进去的 animator，屋子这侧一行都不改。 */
import { createAnimatorSet } from './anim/index.mjs';
import { procedural } from './anim/procedural.mjs';
import { clip as clipAnimator } from './anim/clip.mjs';
/* 导入一个模型之前先弄清它能不能用（js/room/model-import.mjs）。
 * 判定逻辑是纯函数，所以"什么算能用"这件事在 node 里可测——
 * 这里只负责把真 VRM 摘成摘要，再照结论办。 */
import { slugify, inspect, summarize } from './model-import.mjs';

export function buildWorld() {
const hud = document.getElementById('hud');
const tip = document.getElementById('tip');
const hoverEl = document.getElementById('hover');


/* ============================================================
   二、场景
   美术方向：参照"疯狂米塔"（MiSide）那种日式小公寓的手作感：
   圆角家具、暖光斜阳、木地板、旧墙纸、器物都落影。
   全部程序化（canvas 贴图 + 圆角挤出），零外部模型 ——
   所以不涉及任何素材授权，也不占用她那 33MB 的贴图预算。
   ============================================================ */
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 有它画面才"像游戏"而不是"像预览"
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8d9c6);
scene.fog = new THREE.Fog(0xe8d9c6, 8, 18);

const cam = new THREE.PerspectiveCamera(38, innerWidth/innerHeight, 0.05, 60);
cam.position.set(0, 1.34, 3.35);
cam.lookAt(0.05, 0.62, -0.35);

/* 宣传机位。
   参考片里"好看"的从来不是全景，是 3/4 特写：相机退到 1.2 米、镜头收到 30°，
   背景被压到焦外，只剩她一张脸和一束光。房间玩法视角不动，这里只是换机位。
   出图用：D:\\dafeiyu\\life\\v66_hero.png */
const CAM_HOME = { p:[0, 1.34, 3.35], t:[0.05, 0.62, -0.35], fov:38 };

/* 窄屏（手机竖屏）要退多远。
 * 原因不是构图，是**她会被裁掉**：fov 是垂直的，画面一窄，先裁两侧再顶上下边。
 * 只退距离、不动 fov——动 fov 会把透视拉长，脸会变。
 * 上限 1.34 是量过的：再往后相机退到墙外，会看见墙背面的单面材质。 */
let FIT = 1;
function fitFactor(){
  const a = innerWidth / innerHeight;
  return a < 0.9 ? Math.min(1.34, 0.9 / Math.max(a, 0.5)) : 1;
}
const CAM_HERO = { p:[0.62, 1.06, 1.22], t:[0.03, 0.78, 0.02], fov:29 };
let heroOn = false;
function setHero(on){
  heroOn = on;
  const c = on ? CAM_HERO : CAM_HOME;
  cam.position.set(c.p[0], c.p[1], c.p[2]);
  cam.fov = c.fov;
  cam.updateProjectionMatrix();
  cam.lookAt(c.t[0], c.t[1], c.t[2]);
  document.body.classList.toggle('hero', on);
}

/* ---------------- 程序化贴图 ---------------- */
function cvsTex(w, h, draw, rx, ry){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx || 1, ry || 1);
  t.anisotropy = ANISO;
  return t;
}

const TEX = {};

/* 地板：横向木板 + 板缝 + 木纹。7 米外也看得出"这是木地板" */
TEX.floor = cvsTex(512, 512, (g, w, h) => {
  const rows = 8, ph = h / rows;
  for(let r = 0; r < rows; r++){
    const y = r * ph;
    const base = 178 + ((r * 53) % 30) - 15;
    g.fillStyle = `rgb(${base + 26},${base - 12},${base - 52})`;
    g.fillRect(0, y, w, ph);
    g.save(); g.beginPath(); g.rect(0, y, w, ph); g.clip();
    for(let i = 0; i < 30; i++){                       // 木纹
      g.strokeStyle = `rgba(112,74,46,${0.03 + Math.random() * 0.05})`;
      g.lineWidth = 0.5 + Math.random() * 1.2;
      const yy = y + Math.random() * ph;
      g.beginPath(); g.moveTo(0, yy);
      g.bezierCurveTo(w * .33, yy + (Math.random() - .5) * 7,
                      w * .66, yy + (Math.random() - .5) * 7,
                      w, yy + (Math.random() - .5) * 5);
      g.stroke();
    }
    g.restore();
    g.fillStyle = 'rgba(92,60,38,.42)'; g.fillRect(0, y + ph - 1.6, w, 1.6);  // 横缝
    g.fillRect((r * 181) % w, y, 1.6, ph);                                    // 竖缝
  }
}, 3.2, 3.2);

/* 墙：米色壁纸，竖条暗纹 + 细颗粒 */
TEX.wall = cvsTex(256, 256, (g, w, h) => {
  g.fillStyle = '#f1e8dc'; g.fillRect(0, 0, w, h);
  for(let x = 0; x < w; x += 18){
    g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(x, 0, 7, h);
    g.fillStyle = 'rgba(198,168,138,.10)'; g.fillRect(x + 11, 0, 1.5, h);
  }
  for(let i = 0; i < 2200; i++){
    g.fillStyle = `rgba(176,146,116,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
}, 2.6, 1.8);

/* 圆形编织毯：同心环 + 放射织纹。方毯太"办公"，米塔房间是圆毯 */
TEX.rug = cvsTex(512, 512, (g, w, h) => {
  const cx = w/2, cy = h/2;
  g.fillStyle = '#eadfce'; g.fillRect(0, 0, w, h);
  // 编织毯：几十圈细环，颜色在米白/灰粉/浅橄榄之间轻微起伏。
  // 之前用三道粗色带，出来是个靶心，完全不像布。
  const tone = ['#efe4d2', '#e6d8c6', '#dcb9bc', '#d3c7b5', '#c9d0be', '#e8d3d0'];
  for(let i = 40; i >= 1; i--){
    const r = (i / 40) * cx * 0.99;
    g.strokeStyle = tone[i % tone.length];
    g.lineWidth = cx * 0.028;
    g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
  }
  // 两道真正的包边
  g.strokeStyle = '#b99a80'; g.lineWidth = cx * 0.045;
  g.beginPath(); g.arc(cx, cy, cx * 0.965, 0, 7); g.stroke();
  g.strokeStyle = '#cf9fa6'; g.lineWidth = cx * 0.030;
  g.beginPath(); g.arc(cx, cy, cx * 0.80, 0, 7); g.stroke();
  for(let i = 0; i < 2600; i++){                 // 织纹颗粒
    const a = Math.random() * 7, rr = Math.sqrt(Math.random()) * cx;
    g.fillStyle = `rgba(150,120,96,${Math.random() * .06})`;
    g.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1.6, 1.6);
  }
});

/* 接触阴影：柔和的径向暗块，用来把家具"按"在地板上 */
TEX.shadow = cvsTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2);
  gr.addColorStop(0,   'rgba(58,38,22,.55)');
  gr.addColorStop(.55, 'rgba(58,38,22,.22)');
  gr.addColorStop(1,   'rgba(58,38,22,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
TEX.shadow.wrapS = TEX.shadow.wrapT = THREE.ClampToEdgeWrapping;
TEX.rug.wrapS = TEX.rug.wrapT = THREE.ClampToEdgeWrapping;

/* ---------------- 材质 ---------------- */
const M = {
  floor:  new THREE.MeshStandardMaterial({ map: TEX.floor, roughness:.86 }),
  wall:   new THREE.MeshStandardMaterial({ map: TEX.wall,  roughness:.96 }),
  wallB:  new THREE.MeshStandardMaterial({ map: TEX.wall,  roughness:.96, color:0xf3e9dc }),
  trim:   new THREE.MeshStandardMaterial({ color:0xfbf3e8, roughness:.5 }),
  wood:   new THREE.MeshStandardMaterial({ color:0x9c6f49, roughness:.62 }),
  woodD:  new THREE.MeshStandardMaterial({ color:0x6d4a30, roughness:.72 }),
  sheet:  new THREE.MeshStandardMaterial({ color:0xfbf5ec, roughness:.95 }),
  quilt:  new THREE.MeshStandardMaterial({ color:0xdfb0a3, roughness:.95 }),
  pillow: new THREE.MeshStandardMaterial({ color:0xfffcf5, roughness:.98 }),
  seat:   new THREE.MeshStandardMaterial({ color:0xd8b8a2, roughness:.9 }),
  fabric: new THREE.MeshStandardMaterial({ color:0xecd6c8, roughness:1, side:THREE.DoubleSide }),
  metal:  new THREE.MeshStandardMaterial({ color:0xd6bd9c, roughness:.34, metalness:.9 }),
  dark:   new THREE.MeshStandardMaterial({ color:0x6b5544, roughness:.9 }),
  leaf:   new THREE.MeshStandardMaterial({ color:0x7d9a68, roughness:.85 }),
  ceramic:new THREE.MeshStandardMaterial({ color:0xe7d2bf, roughness:.55 }),
  paper:  new THREE.MeshStandardMaterial({ color:0xfaf3e5, roughness:1 }),
  glow:   new THREE.MeshBasicMaterial({ color:0xffd9a2 }),

  /* —— 米塔那套家具的配色：不是"木色家具"，是"刷白漆的旧家具"。
     白漆 + 灰粉布 + 黄铜五金 + 黑铁细腿，这四样凑齐才有那种日式小公寓味 —— */
  paint:  new THREE.MeshStandardMaterial({ color:0xf6efe4, roughness:.52 }),
  paintS: new THREE.MeshStandardMaterial({ color:0xe8dccb, roughness:.6 }),
  rose:   new THREE.MeshStandardMaterial({ color:0xe4b9bb, roughness:.92 }),
  roseD:  new THREE.MeshStandardMaterial({ color:0xc8939a, roughness:.9 }),
  sage:   new THREE.MeshStandardMaterial({ color:0x9fb094, roughness:.9 }),
  brass:  new THREE.MeshStandardMaterial({ color:0xc9a463, roughness:.3, metalness:.86 }),
  iron:   new THREE.MeshStandardMaterial({ color:0x3b3531, roughness:.44, metalness:.55 }),
  plush:  new THREE.MeshStandardMaterial({ color:0xf4e6dc, roughness:1 }),
  screen: new THREE.MeshStandardMaterial({ color:0x2b3138, roughness:.22, metalness:.2 }),
};

/* ---------------- 光 ----------------
   主光是"从窗外斜进来的午后太阳"：左墙真的挖了窗洞，
   所以地上会有一块被窗棂切开的暖光，这是米塔那种照片感的来源。
   墙不投影（只接收），否则整间屋子会被自己挡住。            */
const hemi = new THREE.HemisphereLight(0xfff7ee, 0x6b6158, 0.70);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffc98f, 2.7);
sun.position.set(-4.6, 2.9, 1.05);
sun.target.position.set(0.75, 0.30, -0.65);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = .5;  sun.shadow.camera.far = 14;
sun.shadow.camera.left = -4;  sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4;    sun.shadow.camera.bottom = -4;
sun.shadow.bias = -0.0008;    sun.shadow.normalBias = 0.018;
sun.shadow.radius = 2.5;
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xb9cde4, 0.62);   // 补冷色，不然暖光会糊成一片
fill.position.set(3.0, 2.0, 2.4);
scene.add(fill);

const bounce = new THREE.PointLight(0xffd9a6, 0.55, 5.5);  // 地面反弹
bounce.position.set(0.2, 0.35, 0.6);
scene.add(bounce);

/* 可互动物件的引用集中放这里（后面互动内核要用） */
const REF = {
  lampOn: true, lampGroup: null, lampLight: null, lampBulb: null,
  pendantOn: true, pendant: null, pendantLight: null, pendantBulb: null,
  curtainOpen: true, curtains: [], curtainGroup: null,
};

/* ---------------- 几何小工具 ---------------- */
function rrect(w, h, r){
  const s = new THREE.Shape();
  const x = -w/2, y = -h/2;
  r = Math.min(r, w/2 - 0.0004, h/2 - 0.0004);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/* 圆角盒：所有家具都用它 —— 米塔那种"手捏出来"的边，
   靠的就是不用硬边 BoxGeometry，倒角一有，高光就活了 */
function rbox(w, h, d, r, mat, x, y, z, parent){
  const bev = Math.max(0.0015, Math.min(r, Math.min(w, d)/2 - 0.0006, h/2 - 0.0006));
  const g = new THREE.ExtrudeGeometry(rrect(w, d, r), {
    depth: Math.max(0.002, h - bev*2),
    bevelEnabled: true, bevelSize: bev, bevelThickness: bev,
    bevelSegments: 3, curveSegments: 7,
  });
  g.rotateX(-Math.PI/2);
  g.center();
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  (parent || scene).add(m);
  return m;
}

function cyl(rt, rb, h, mat, x, y, z, parent, seg){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  (parent || scene).add(m);
  return m;
}

function softShadow(w, d, x, z, op, parent){
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map:TEX.shadow, transparent:true, opacity:op ?? .8, depthWrite:false }));
  m.rotation.x = -Math.PI/2;
  m.position.set(x, 0.007, z);
  m.renderOrder = 1;
  (parent || scene).add(m);
  return m;
}

/* ---------------- 房间：地板 / 三面墙 / 窗洞 / 门 ---------------- */
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.d), M.floor);
floor.rotation.x = -Math.PI/2;
floor.receiveShadow = true;
scene.add(floor);

const dz = -ROOM.d/2;      // 后墙内表面 z
const lx = -ROOM.w/2;      // 左墙内表面 x

/* 窗洞尺寸（先定义，墙要绕着它拼） */
const winY = 1.26, winZ = -0.52, winW = 0.60, winH = 0.70;
const wy0 = winY - winH/2, wy1 = winY + winH/2;      // 0.91 ~ 1.61
const wz0 = winZ - winW/2, wz1 = winZ + winW/2;      // -0.82 ~ -0.22

/* 后墙：门洞里塞一扇门板，门缝透光 */
function wallBox(w, h, d, x, y, z, mat){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.receiveShadow = true;          // 墙不投影，只吃影
  scene.add(m);
  return m;
}
wallBox(ROOM.w, ROOM.h, 0.1, 0, ROOM.h/2, dz - 0.05, M.wall);

// 门：门套 + 门板 + 黄铜把手 + 门底那条暖光
{
  const dw = DOOR.w, dh = DOOR.h, dx = DOOR.x;
  rbox(dw + 0.09, 0.05, 0.09, 0.012, M.trim, dx, dh + 0.025, dz + 0.03);
  rbox(0.045, dh + 0.05, 0.09, 0.012, M.trim, dx - dw/2 - 0.024, (dh + 0.05)/2, dz + 0.03);
  rbox(0.045, dh + 0.05, 0.09, 0.012, M.trim, dx + dw/2 + 0.024, (dh + 0.05)/2, dz + 0.03);
  const leaf = rbox(dw, dh, 0.035, 0.01, M.woodD, dx, dh/2, dz + 0.016);
  leaf.castShadow = false;
  rbox(dw - 0.14, dh * 0.34, 0.008, 0.01, M.wood, dx, dh * 0.70, dz + 0.036);  // 门芯板
  rbox(dw - 0.14, dh * 0.30, 0.008, 0.01, M.wood, dx, dh * 0.27, dz + 0.036);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.017, 16, 12), M.metal);
  knob.position.set(dx + dw/2 - 0.075, 0.94, dz + 0.05); scene.add(knob);
  const slit = new THREE.Mesh(new THREE.PlaneGeometry(dw - 0.03, 0.012), M.glow);
  slit.position.set(dx, 0.006, dz + 0.04); scene.add(slit);   // 门外走廊的灯
}

/* 左墙：绕窗洞拼四块（这样阳光是真从洞里进来的） */
{
  const t = 0.1;
  wallBox(t, wy0, ROOM.d, lx - t/2, wy0/2, 0, M.wallB);                                  // 窗下
  wallBox(t, ROOM.h - wy1, ROOM.d, lx - t/2, (ROOM.h + wy1)/2, 0, M.wallB);               // 窗上
  wallBox(t, wy1 - wy0, wz0 + ROOM.d/2, lx - t/2, winY, (wz0 - ROOM.d/2)/2, M.wallB);     // 窗左
  wallBox(t, wy1 - wy0, ROOM.d/2 - wz1, lx - t/2, winY, (wz1 + ROOM.d/2)/2, M.wallB);     // 窗右
}

/* 窗：玻璃（自己发光，不参与光照）+ 窗框 + 窗台 + 两边窗帘 */
{
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH),
    new THREE.MeshBasicMaterial({ color:0xfff6e2, transparent:true, opacity:.82 }));
  glass.rotation.y = Math.PI/2;
  glass.position.set(lx - 0.03, winY, winZ);
  scene.add(glass);

  // 窗外那块"过曝的天"，给画面一个亮部让它透气
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.3), new THREE.MeshBasicMaterial({ color:0xfffaf0 }));
  sky.rotation.y = Math.PI/2; sky.position.set(lx - 0.16, winY + 0.05, winZ);
  scene.add(sky);

  rbox(0.05, winH + 0.08, winW + 0.08, 0.012, M.trim, lx + 0.012, winY, winZ);   // 窗套
  rbox(0.03, 0.026, winW, 0.006, M.trim, lx + 0.008, winY, winZ);               // 横棂
  rbox(0.03, winH, 0.026, 0.006, M.trim, lx + 0.008, winY, winZ);               // 竖棂
  rbox(0.09, 0.03, winW + 0.16, 0.01, M.trim, lx + 0.048, wy0 - 0.015, winZ);   // 窗台

  // 窗帘：正弦褶皱的布片，比平板值钱得多
  function curtain(zc, w){
    const g = new THREE.PlaneGeometry(w, 0.92, 22, 4);
    const p = g.attributes.position;
    for(let i = 0; i < p.count; i++){
      const u = p.getX(i) / w + 0.5;
      p.setZ(i, Math.sin(u * Math.PI * 5.5) * 0.024);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, M.fabric);
    m.rotation.y = Math.PI/2;
    m.position.set(lx + 0.07, 1.36, zc);
    m.castShadow = true; m.receiveShadow = true;
    // 关=盖住窗，开=往两边推 0.30（xz 都在左墙上，所以只动 z）
    REF.curtains.push({ m, z0: zc, z1: zc + Math.sign(zc - winZ) * 0.30 });
    scene.add(m);
  }
  curtain(wz0 - 0.14, 0.34);
  curtain(wz1 + 0.14, 0.34);
  // 两片布收进一个组，方便整体高亮
  REF.curtainGroup = new THREE.Group();
  scene.add(REF.curtainGroup);
  REF.curtains.forEach(p => REF.curtainGroup.add(p.m));
  const rod = cyl(0.012, 0.012, (wz1 - wz0) + 0.95, M.metal, lx + 0.07, 1.83, winZ);
  rod.rotation.x = Math.PI/2;
}

/* 右墙（镜头这侧，只露一条，负责"关起门来"的边界） */
wallBox(0.1, ROOM.h, ROOM.d, ROOM.w/2 + 0.05, ROOM.h/2, 0, M.wallB);

/* 踢脚线 + 顶角线 */
{
  const sk = (w, d, x, z) => rbox(w, 0.07, d, 0.012, M.trim, x, 0.035, z);
  sk(ROOM.w, 0.03, 0, dz + 0.015);
  sk(0.03, ROOM.d, lx + 0.015, 0);
  const cr = (w, d, x, z) => rbox(w, 0.05, d, 0.014, M.trim, x, ROOM.h - 0.025, z);
  cr(ROOM.w, 0.06, 0, dz + 0.03);
  cr(0.06, ROOM.d, lx + 0.03, 0);
}

/* ---------------- 家具（尺寸没动，一个数都没改） ---------------- */
const FURN = [];
function reg(g, name, hint, spot, face, action){
  g.userData = { name, hint, spot, face, action };
  FURN.push(g);
  return g;
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* ---- 小工具：布偶 ----
   米塔房间里最"活"的东西不是家具，是散落的布偶。
   一个球体 + 两只耳朵 + 两点眼睛，成本极低，气质全靠它 */
function plush(mat, earMat, sc, x, y, z, parent, faceZ){
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.055 * sc, 20, 14), mat);
  body.scale.set(1, .88, .9); body.position.y = 0.05 * sc;
  body.castShadow = true; g.add(body);
  [-1, 1].forEach(sg => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.024 * sc, 12, 10), earMat);
    ear.scale.set(.8, 1.25, .55);
    ear.position.set(sg * 0.038 * sc, 0.098 * sc, 0);
    ear.rotation.z = sg * 0.34; ear.castShadow = true; g.add(ear);
  });
  [-1, 1].forEach(sg => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.007 * sc, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a2f2a, roughness: .5 }));
    eye.position.set(sg * 0.021 * sc, 0.058 * sc, (faceZ ?? 0.048) * sc);
    g.add(eye);
  });
  g.position.set(x, y, z);
  (parent || scene).add(g);
  return g;
}

/* ---- 床：白漆床架 + 灰粉软包床头 + 米白床品 ---- */
{
  const g = new THREE.Group();
  const fh = 0.13;
  // 床架：白漆，四角小圆脚（不是一整块木头，脚一有，影子就分层）
  rbox(BED.w, fh, BED.l, 0.028, M.paint, 0, fh/2 + 0.02, 0, g);
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sz]) =>
    cyl(0.026, 0.020, 0.05, M.paintS, sx * (BED.w/2 - 0.07), 0.025, sz * (BED.l/2 - 0.09), g, 12));
  rbox(BED.w - 0.04, 0.15, BED.l - 0.04, 0.05, M.sheet, 0, 0.235, 0, g);   // 床垫 → 顶面 0.31

  // 床头：灰粉软包 + 白漆外框 + 四颗黄铜扣（软包感全靠这几颗扣子）
  const hb = new THREE.Group();
  rbox(BED.w + 0.02, 0.46, 0.05, 0.03, M.paint, 0, 0.23, 0, hb);
  rbox(BED.w - 0.06, 0.38, 0.028, 0.05, M.rose, 0, 0.235, 0.028, hb);
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sy]) => {
    const bt = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), M.brass);
    bt.position.set(sx * (BED.w/2 - 0.11), 0.235 + sy * 0.11, 0.05);
    hb.add(bt);
  });
  hb.position.set(0, 0.10, -BED.l/2 + 0.045);
  g.add(hb);

  // 床尾横档：细一点，别做成第二块床头板
  rbox(BED.w - 0.02, 0.12, 0.04, 0.016, M.paint, 0, 0.20, BED.l/2 - 0.02, g);

  // 被子叠在床尾（铺满会穿模，布不会自动绕开身体）
  rbox(BED.w - 0.05, 0.075, 0.36, 0.035, M.rose, 0, 0.345, BED.l/2 - 0.23, g);
  rbox(BED.w - 0.09, 0.022, 0.11, 0.01, M.paint, 0, 0.392, BED.l/2 - 0.41, g);   // 白翻边

  // 两个枕头 + 一只布偶
  rbox(0.48, 0.10, 0.19, 0.05, M.paint, -0.06, 0.355, -BED.l/2 + 0.27, g);
  const p2 = rbox(0.36, 0.088, 0.16, 0.042, M.rose, 0.16, 0.385, -BED.l/2 + 0.40, g);
  p2.rotation.y = 0.2;
  plush(M.plush, M.rose, 1.05, -0.19, 0.30, -BED.l/2 + 0.33, g, 0.05);

  g.position.set(BED.x, 0, BED.z);
  scene.add(g);
  softShadow(BED.w + 0.5, BED.l + 0.5, BED.x, BED.z, .82);
  reg(g, '床', '点一下躺上去', V3(BED.x, 0, BED.z + BED.l/2 + 0.34), 0, 'lie');
}

/* ---- 椅子：白漆椅圈 + 灰粉坐垫 ---- */
{
  const g = new THREE.Group();
  const sh = CHAIR.seat;
  rbox(CHAIR.w, 0.07, CHAIR.d, 0.032, M.rose, 0, sh - 0.035, 0, g);                  // 坐垫
  rbox(CHAIR.w - 0.03, 0.03, CHAIR.d - 0.03, 0.008, M.paint, 0, sh - 0.082, 0, g);   // 座框
  // 靠背：两根立柱 + 一根上横档 + 一块软包。整块实心板会像把床头搬过来
  const back = new THREE.Group();
  rbox(CHAIR.w - 0.02, 0.052, 0.034, 0.016, M.paint, 0, 0.275, 0, back);             // 上档
  [-1, 1].forEach(sg => rbox(0.032, 0.30, 0.032, 0.014, M.paint, sg * (CHAIR.w/2 - 0.05), 0.14, 0, back));
  rbox(CHAIR.w - 0.15, 0.13, 0.026, 0.014, M.rose, 0, 0.175, 0.004, back);           // 软包
  back.position.set(0, sh - 0.005, CHAIR.d/2 - 0.03);
  back.rotation.x = -0.05;
  g.add(back);
  // 黑铁细腿：白漆家具配细腿，才轻
  const lx2 = CHAIR.w/2 - 0.045, lz2 = CHAIR.d/2 - 0.042;
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sz]) => {
    cyl(0.010, 0.014, sh - 0.095, M.iron, sx * lx2, (sh - 0.095)/2, sz * lz2, g, 10);
    cyl(0.016, 0.016, 0.008, M.brass, sx * lx2, 0.004, sz * lz2, g, 10);             // 铜脚垫
  });
  g.position.set(CHAIR.x, 0, CHAIR.z);
  g.rotation.y = CHAIR.rot;
  scene.add(g);
  softShadow(CHAIR.w + 0.34, CHAIR.d + 0.34, CHAIR.x, CHAIR.z, .66);
  reg(g, '椅子', '点一下坐下', V3(CHAIR.x + 0.34, 0, CHAIR.z), Math.PI/2, 'sit');
}

/* ---- 桌子：白漆台面 + 黑铁腿 + 一台显示器 ---- */
{
  const g = new THREE.Group();
  rbox(DESK.w, 0.042, DESK.d, 0.018, M.paint, 0, DESK.top - 0.021, 0, g);           // 台面
  rbox(DESK.w - 0.06, 0.05, DESK.d - 0.07, 0.01, M.paintS, 0, DESK.top - 0.068, 0.01, g); // 台面下的裙板
  const lx3 = DESK.w/2 - 0.05, lz3 = DESK.d/2 - 0.055;
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sz]) =>
    cyl(0.012, 0.016, DESK.top - 0.09, M.iron, sx * lx3, (DESK.top - 0.09)/2, sz * lz3, g, 10));
  // 侧边横撑：铁架桌的标志，也让腿不显得悬
  [-1, 1].forEach(sg => {
    const bar = cyl(0.008, 0.008, DESK.d - 0.11, M.iron, sg * lx3, 0.085, 0, g, 8);
    bar.rotation.x = Math.PI/2;
  });

  // 抽屉
  rbox(0.30, 0.095, 0.016, 0.008, M.paint, -0.20, DESK.top - 0.10, -DESK.d/2 + 0.055, g);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 10), M.brass);
  knob.position.set(-0.20, DESK.top - 0.10, -DESK.d/2 + 0.068); g.add(knob);

  /* 显示器：米塔房间里"有人住"的强信号。
     屏幕给一点点自发光的冷色，和暖房间形成冷暖对比，画面立刻有层次 */
  const mon = new THREE.Group();
  rbox(0.30, 0.018, 0.13, 0.008, M.iron, 0, 0.009, 0, mon);                     // 底座
  rbox(0.026, 0.13, 0.026, 0.008, M.iron, 0, 0.075, 0.01, mon);                 // 立柱
  rbox(0.40, 0.25, 0.026, 0.014, M.iron, 0, 0.235, 0, mon);                     // 外框
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.372, 0.222),
    new THREE.MeshBasicMaterial({ color: 0x4a5a68 }));
  scr.position.set(0, 0.236, 0.015); mon.add(scr);
  const glow2 = new THREE.PointLight(0x8fb4d8, 0.30, 0.9, 2);
  glow2.position.set(0, 0.24, 0.10); mon.add(glow2);
  mon.position.set(-0.06, DESK.top, -0.10);
  mon.rotation.y = 0.10;
  g.add(mon);

  // 键盘 / 笔记 / 杯子 / 笔筒
  rbox(0.26, 0.014, 0.085, 0.005, M.paintS, -0.06, DESK.top + 0.007, 0.075, g);
  rbox(0.20, 0.010, 0.15, 0.004, M.paper, 0.28, DESK.top + 0.006, 0.02, g).rotation.y = -0.12;
  const cup = cyl(0.024, 0.020, 0.058, M.paint, 0.33, DESK.top + 0.029, 0.14, g, 18);
  const ch = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.0035, 8, 14), M.paint);
  ch.position.set(0.352, DESK.top + 0.031, 0.14); g.add(ch);
  const pen = cyl(0.008, 0.008, 0.052, M.roseD, -0.36, DESK.top + 0.026, -0.02, g, 12);
  pen.rotation.z = 0.08;

  // 台灯：白罩 + 黄铜杆
  const lampG = new THREE.Group();
  cyl(0.050, 0.056, 0.012, M.brass, 0, 0.006, 0, lampG, 20);
  cyl(0.007, 0.007, 0.15, M.brass, 0, 0.078, 0, lampG, 10);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.060, 0.072, 22, 1, true), M.paint.clone());
  shade.position.y = 0.172; shade.castShadow = true; shade.material.side = THREE.DoubleSide;
  lampG.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 10), M.glow.clone());
  bulb.position.y = 0.152; lampG.add(bulb);
  const lp = new THREE.PointLight(0xffb877, 1.1, 1.9, 2);
  lp.position.set(0, 0.16, 0); lampG.add(lp);
  REF.lampGroup = lampG; REF.lampBulb = bulb; REF.lampLight = lp;
  lampG.position.set(0.34, DESK.top, -0.13);
  g.add(lampG);

  g.position.set(DESK.x, 0, DESK.z);
  g.rotation.y = DESK.rot;
  scene.add(g);
  softShadow(DESK.w + 0.28, DESK.d + 0.28, DESK.x, DESK.z, .66);
  reg(g, '桌子', '点一下坐在桌前', V3(CHAIR.x, 0, CHAIR.z), Math.PI/2, 'desk');
}

/* ---- 衣柜：白漆 + 双门 + 黄铜小把手（后墙右侧） ---- */
{
  const g = new THREE.Group();
  const W = 0.66, D = 0.33, H = 1.30;
  const y0 = 0.055;                                                   // 柜体离地，四条小脚
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sz]) =>
    cyl(0.021, 0.016, y0, M.paintS, sx * (W/2 - 0.055), y0/2, sz * (D/2 - 0.055), g, 10));
  rbox(W, H, D, 0.020, M.paint, 0, y0 + H/2, 0, g);                    // 柜体
  rbox(W + 0.045, 0.038, D + 0.032, 0.012, M.paintS, 0, y0 + H + 0.019, 0, g);  // 顶冠
  rbox(W - 0.02, 0.055, D - 0.02, 0.008, M.paintS, 0, y0 + 0.028, 0, g);        // 底部踢脚
  // 两扇门：门板比柜体前凸 8mm，才有"门"的厚度感
  [-1, 1].forEach(sx => {
    const dw = W/2 - 0.012;
    rbox(dw, H - 0.13, 0.016, 0.010, M.paintS, sx * (W/4), y0 + H/2 + 0.01, D/2 + 0.007, g);
    rbox(dw - 0.07, H - 0.26, 0.008, 0.008, M.paint, sx * (W/4), y0 + H/2 + 0.01, D/2 + 0.016, g); // 门芯凹板
    const kn = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.020, 12), M.brass);
    kn.rotation.x = Math.PI/2;
    kn.position.set(sx * 0.030, y0 + H * 0.55, D/2 + 0.026); g.add(kn);
  });
  // 门缝：一条暗线，不然两扇门看着像一整块
  rbox(0.005, H - 0.13, 0.024, 0.001, M.woodD, 0, y0 + H/2 + 0.01, D/2 + 0.006, g);
  g.position.set(0.95, 0, dz + D/2 + 0.03);
  scene.add(g);
  softShadow(W + 0.4, D + 0.4, 0.95, dz + D/2 + 0.03, .6);
  reg(g, '衣柜', '点一下看看里面', V3(0.95, 0, dz + D/2 + 0.42), 0, 'stand');
}

/* ---- 地毯：圆形编织毯 ---- */
{
  const rug = new THREE.Mesh(new THREE.CircleGeometry(0.80, 64),
    new THREE.MeshStandardMaterial({ map: TEX.rug, roughness:1 }));
  rug.rotation.x = -Math.PI/2;
  rug.position.set(0.02, 0.005, 0.55);
  rug.receiveShadow = true;
  scene.add(rug);
}

/* ---- 顶灯 ---- */
{
  const pg = new THREE.Group();
  cyl(0.004, 0.004, 0.30, M.iron, 0.05, ROOM.h - 0.15, 0.35, pg, 6);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.20, 0.14, 26, 1, true), M.paint.clone());
  shade.position.set(0.05, ROOM.h - 0.36, 0.35);
  shade.material.side = THREE.DoubleSide;
  shade.castShadow = true; pg.add(shade);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 12), M.glow.clone());
  b.position.set(0.05, ROOM.h - 0.40, 0.35); pg.add(b);
  const pl = new THREE.PointLight(0xffd0a0, 1.5, 4.2, 2);
  pl.position.set(0.05, ROOM.h - 0.44, 0.35); pg.add(pl);
  scene.add(pg);
  REF.pendant = pg; REF.pendantLight = pl; REF.pendantBulb = b;
}

/* ---- 落地灯：细铁杆 + 灰粉布罩（可开关） ---- */
{
  const g = new THREE.Group();
  cyl(0.065, 0.075, 0.014, M.iron, 0, 0.007, 0, g, 20);
  cyl(0.008, 0.008, 1.10, M.iron, 0, 0.56, 0, g, 10);
  const sh2 = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.115, 0.20, 24, 1, true), M.rose.clone());
  sh2.position.y = 1.19; sh2.material.side = THREE.DoubleSide; sh2.castShadow = true; g.add(sh2);
  const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), M.glow.clone());
  b2.position.y = 1.17; g.add(b2);
  const lp2 = new THREE.PointLight(0xffc89a, 1.25, 2.4, 2);
  lp2.position.set(0, 1.15, 0); g.add(lp2);
  g.position.set(-1.62, 0, 0.86);
  scene.add(g);
  softShadow(0.34, 0.34, -1.62, 0.86, .6);
  REF.floorOn = true; REF.floorGroup = g; REF.floorLight = lp2; REF.floorBulb = b2;
  // 注意：这里不能直接 interactable()——那是后面才声明的，INTS 还在 TDZ 里。
  // 引用先存进 REF，等互动内核跑起来再登记。
}

/* ---- 墙饰 / 搁板 / 杂物 ---- */
{
  function artTex(kind){
    return cvsTex(192, 240, (g, w, h) => {
      if(kind === 0){                       // 潮汐：分层色带 + 一个太阳
        g.fillStyle = '#dfe9ef'; g.fillRect(0, 0, w, h);
        for(let i = 0; i < 7; i++){
          g.fillStyle = `rgba(${120 + i*10},${150 + i*9},${168 + i*8},.65)`;
          g.fillRect(0, h*0.45 + i*h*0.07, w, h*0.075);
        }
        g.fillStyle = '#f4e3cf';
        g.beginPath(); g.arc(w*0.68, h*0.26, w*0.13, 0, 7); g.fill();
      } else if(kind === 1){                // 抽象色块
        g.fillStyle = '#f6efe5'; g.fillRect(0, 0, w, h);
        ['#e8d3c3', '#cbb9a8', '#a9bcc6', '#f3e9dd'].forEach((c, i) => {
          g.fillStyle = c; g.fillRect(w*0.14, h*(0.12 + i*0.20), w*0.72, h*0.16);
        });
      } else {                              // 简笔小屋
        g.fillStyle = '#eae1d3'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#c9d6c3'; g.fillRect(0, h*0.62, w, h*0.38);
        g.fillStyle = '#d8b7a3';
        g.beginPath(); g.moveTo(w*0.26, h*0.62); g.lineTo(w*0.5, h*0.34);
        g.lineTo(w*0.74, h*0.62); g.closePath(); g.fill();
        g.fillStyle = '#b9c7d2'; g.fillRect(w*0.40, h*0.50, w*0.20, h*0.16);
      }
    });
  }
  const ARTS = [artTex(0), artTex(2), artTex(1)];

  function frame(x, y, w, h, tex, mat){
    const grp = new THREE.Group();
    rbox(w + 0.030, h + 0.030, 0.014, 0.004, mat || M.paint, 0, 0, 0, grp);
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: tex, roughness:.92 }));
    pic.position.z = 0.016;   // 要在框的倒角外侧，否则整张画被埋进框里
    grp.add(pic);
    grp.position.set(x, y, dz + 0.017);
    scene.add(grp);
  }
  frame(-1.02, 1.44, 0.24, 0.30, ARTS[0]);
  frame(-0.70, 1.40, 0.19, 0.24, ARTS[1]);

  /* 贴上去的海报（没有框、一点点歪）—— "住着的人"的痕迹 */
  {
    const po = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.40),
      new THREE.MeshStandardMaterial({ map: ARTS[2], roughness:.95 }));
    po.position.set(1.55, 1.22, dz + 0.012);
    po.rotation.z = 0.035; scene.add(po);
    [[-0.12, 0.185], [0.12, 0.185]].forEach(([ox, oy]) => {
      const tp = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.014),
        new THREE.MeshStandardMaterial({ color: 0xf2e6cf, roughness: 1, transparent: true, opacity: .85 }));
      tp.position.set(1.55 + ox, 1.22 + oy, dz + 0.014);
      tp.rotation.z = 0.28 * Math.sign(ox); scene.add(tp);
    });
  }

  /* 挂钟：黄铜圈 + 白盘 + 两根针 */
  {
    const cl = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.010, 10, 34), M.brass);
    cl.add(rim);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.080, 34),
      new THREE.MeshStandardMaterial({ color: 0xfbf4e6, roughness: .9 }));
    face.position.z = -0.004; cl.add(face);
    const h1 = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.048, 0.004), M.iron);
    h1.position.set(0.017, 0.022, 0.004); h1.rotation.z = -0.5; cl.add(h1);
    const h2 = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.062, 0.004), M.iron);
    h2.position.set(-0.016, 0.026, 0.006); h2.rotation.z = 0.6; cl.add(h2);
    cl.position.set(0.26, 1.50, dz + 0.03);
    scene.add(cl);
  }

  /* 搁板：最后放到床头上方，摆书 + 两只布偶 —— 米塔房间最起作用就是这种"随手放" */
  const shelfY = 1.30, shelfX = -1.50;
  rbox(0.56, 0.028, 0.14, 0.008, M.paint, shelfX, shelfY, dz + 0.09);
  [-1, 1].forEach(sg => rbox(0.016, 0.10, 0.09, 0.004, M.brass, shelfX + sg*0.21, shelfY - 0.062, dz + 0.09));
  const bookCols = [0xb9675a, 0x7d92a8, 0xd8b98a, 0x8d9a78];
  let bx = shelfX - 0.24;
  bookCols.forEach((c, i) => {
    const bh = 0.115 + (i % 3) * 0.026, bw = 0.030 + (i % 2) * 0.010;
    const bk = rbox(bw, bh, 0.10, 0.004,
      new THREE.MeshStandardMaterial({ color: c, roughness:.86 }),
      bx + bw/2, shelfY + 0.014 + bh/2, dz + 0.09);
    bx += bw + 0.007;
  });
  plush(M.sage, M.paint, 0.85, shelfX + 0.06, shelfY + 0.014, dz + 0.10);
  plush(M.rose, M.plush, 0.7, shelfX + 0.17, shelfY + 0.014, dz + 0.09);

  /* 地垫 + 一摞书 + 拖鞋 */
  const cushion = rbox(0.34, 0.10, 0.34, 0.05, M.rose, -0.98, 0.052, 0.72);
  cushion.rotation.y = 0.3;
  softShadow(0.52, 0.52, -0.98, 0.72, .52);

  let sy = 0.017;
  [[0.24, 0.032, 0xb9675a], [0.225, 0.028, 0xd8b98a], [0.20, 0.026, 0x7d92a8]].forEach(([w2, h2, c]) => {
    rbox(w2, h2, w2 * 0.72, 0.003,
      new THREE.MeshStandardMaterial({ color: c, roughness:.88 }), 1.32, sy, 0.30).rotation.y = 0.4;
    sy += h2 + 0.004;
  });

  [[-0.10, 0.02], [0.10, 0.05]].forEach(([ox, oz]) => {
    rbox(0.13, 0.032, 0.22, 0.014, M.plush, BED.x + ox, 0.017, BED.z + BED.l/2 + 0.17 + oz);
  });

  /* 墙角绿植：白盆 + 几片叶子 */
  const plant = new THREE.Group();
  cyl(0.078, 0.062, 0.15, M.paint, 0, 0.075, 0, plant, 18);
  cyl(0.064, 0.064, 0.012, M.dark, 0, 0.152, 0, plant, 18);
  for(let i = 0; i < 8; i++){
    const a = i / 8 * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.058, 12, 10), M.sage);
    leaf.scale.set(0.42, 1, 0.15);
    leaf.position.set(Math.cos(a) * 0.05, 0.21 + (i % 3) * 0.035, Math.sin(a) * 0.05);
    leaf.rotation.set(Math.cos(a) * 0.55, -a, Math.sin(a) * 0.55);
    leaf.castShadow = true;
    plant.add(leaf);
  }
  plant.position.set(lx + 0.30, 0, ROOM.d/2 - 0.34);
  scene.add(plant);
  softShadow(0.42, 0.42, lx + 0.30, ROOM.d/2 - 0.34, .52);
}

/* ============================================================
   四、她
   ============================================================ */
const holder = new THREE.Group();
holder.rotation.order = 'YXZ';
scene.add(holder);

/* 跟着她走的接触阴影。斜光下的真实投影会甩到几米外，
   游戏里普遍再补一块脚下软影，否则人看上去是浮的 */
const herShadow = new THREE.Mesh(new THREE.PlaneGeometry(0.70, 0.70),
  new THREE.MeshBasicMaterial({ map: TEX.shadow, transparent:true, opacity:.55, depthWrite:false }));
herShadow.rotation.x = -Math.PI/2;
herShadow.position.y = 0.010;
herShadow.renderOrder = 2;
scene.add(herShadow);

let vrm = null;
const loader = new GLTFLoader();
loader.register(p => new VRMLoaderPlugin(p));

const state = {
  pos: new THREE.Vector3(0, 0, 0.5),
  want: new THREE.Vector3(0, 0, 0.5),
  facing: 0, faceWant: 0,
  lift: 0, tiltX: 0,
  poseName: 'stand',
  blink: 0, nextBlink: 2, expr: null,
  mouth: 0, mouthWant: 0,
  props: [], propsOff: false,
  t: 0, walking: false,
  pending: null,
  ik: null, ikDirty: false,
  /* 她"主动看向某处"（lookAt 端口写的）。null 时头跟鼠标。
   * until 到点自动失效——注意力是有时效的，不能一直盯着一个地方。 */
  look: null,
};

/* ---------------- 动作：注册表 + 现在用的是哪一版 ----------------
 * 换一套动作 = 换一个注册进来的 animator，屋子这侧一行不用改。
 * ?anim=procedural|clip；要的那个不在就退回第一个，并且**说出来**——
 * 悄悄换掉的话，用户会以为自己那一版生效了。 */
const ANIM_SET = createAnimatorSet();
ANIM_SET.register(procedural());
ANIM_SET.register(clipAnimator());
let ANIM = null;

function mountAnim(){
  if(!vrm?.humanoid){ ANIM = null; return; }
  const q = new URLSearchParams(location.search);
  try {
    if(ANIM) ANIM.unmount();
    ANIM = ANIM_SET.create(q.get('anim'), {
      bone: nbone, state, three: THREE,
      root: vrm.scene,
      loader,
      clipUrl: q.get('clips'),
    });
    console.log('[anim] ' + ANIM.label
      + (ANIM.fallback ? '（?anim= 那个没有，用这个）' : '')
      + '；会：' + ANIM.clips.join('/'));
  } catch (e) {
    ANIM = null;
    console.warn('[anim] 起不来（她就只站着，别的照常）：' + e.message);
  }
}

function bindPick(){
  const el = document.getElementById('pick');
  if(!el) return;
  el.onchange = e => { const f = e.target.files?.[0]; if(f) loadVRM(URL.createObjectURL(f), f.name); };
}
function showPick(html){
  tip.style.display = '';
  tip.innerHTML = `<div class="box">${html}
    <div class="sub"><label class="pick">选文件…<input id="pick" type="file" accept=".vrm,.glb" hidden></label></div></div>`;
  bindPick();
}

/* ============================================================
   六、角色适配层 —— 建模与互动之间的那道接缝
   ------------------------------------------------------------
   房间、互动、相机、动画只认一条契约：
     「一个被缩放到 CANON.h、脚踩在 y=0、面朝 +z 的 VRM humanoid」
   只要满足这条，模型是自己捏的、是 AI 三视图生成的、还是
   VRoid 捏的，对它来说没有区别。于是：
     · 换模型 = 换一个 desc 对象，不改任何互动代码
     · 加一个新零件（尾巴/翅膀/围巾） = 在 desc 里写 bone 名，不写 if
   ============================================================ */
const CANON = { h: 1.357 };   // 世界尺度基准，房间和家具都按它做

const CHAR = {
  id: null, name: '', author: '', license: '', file: '',
  /* 角色 vs 身体：characterId 是"她是谁"，avatarId 是"现在穿哪具"。
     记忆、人设以后挂 characterId；骨骼、表情、描边挂 avatarId。 */
  characterId: null, avatarId: '', kind: 'vrm', label: '',
  body: null,        // 实测比例（缩放后）。拿不到就退回 B，功能降级不崩
  ready: false,
};

/* 实测：把模型自己的比例量出来，互动层只读这个，不读死数字。
   注意要用归一化骨（normalizedBoneNode）的世界位置——直接读 Bone 会拿到
   未更新的矩阵（glTF 的 matrixAutoUpdate 是 false，这个坑前面踩过）。 */
function measure(v){
  const h = v?.humanoid; if(!h) return null;
  v.scene.updateMatrixWorld(true);
  const P = b => {
    const n = h.getNormalizedBoneNode(b);
    if(!n) return null;
    const p = new THREE.Vector3(); n.getWorldPosition(p); return p;
  };
  const L = (x, y) => { const A = P(x), C = P(y); return (A && C) ? A.distanceTo(C) : null; };
  const hips = P('hips'), knee = P('leftLowerLeg'), ankle = P('leftFoot'), sh = P('leftShoulder');
  const m = {
    hipsY:     hips ? hips.y : null,
    kneeY:     knee ? knee.y : null,
    ankleY:    ankle ? ankle.y : null,
    shoulderY: sh ? sh.y : null,
    thigh:     L('leftUpperLeg', 'leftLowerLeg'),
    shin:      L('leftLowerLeg', 'leftFoot'),
    upperArm:  L('leftUpperArm', 'leftLowerArm'),
    foreArm:   L('leftLowerArm', 'leftHand'),
  };
  // 缺骨头时逐项回退，别整体报错
  for(const k in m) if(m[k] == null) m[k] = B[k];
  m.ok = !!(hips && knee && ankle);
  return m;
}

/* ============================================================
   米塔化 —— 不是改模型，是改"她在这个房间里的成像"
   ------------------------------------------------------------
   米塔的角色之所以不显得"贴"进场景，就三件事：
     ① 只用一个暖主光（来自窗），其余全是弱补光；
     ② 阴影里带一点冷紫，纯黑会立刻变成塑料手办；
     ③ 加一道很弱的轮廓光，把她的边界从背景里"抠"出来。
   这三件事与模型无关，任何 VRM 进来都成立，所以写在这一层。
   ============================================================ */
/* 风格预设：米塔化不是一次性的调参，是一份可以换的"成像配方"。
   换画风 = 换一个 key，模型的几何、骨骼、互动一个字节都不动。
  
   cine（2026-11-05 新增）：对着四个参考视频（小矮子阿星的米塔系列、
   可可立希亚的夜景、茉莉绿茶的哄睡）反推出来的共性配方——
   ① 强轮廓光把她的边缘从暗背景里"抠"出来（四个视频全部都有）；
   ② 阴影是连续渐变、不是色块（toony 压到 0.5 左右）；
   ③ 整体降饱和，高光偏暖、阴影偏冷紫；
   ④ 暗角重，画面往里收。
   这就是"第一眼好看"的来源：不是模型精，是光把她托起来了。 */
const STYLES = {
  cine: { label:'电影感', color:0xfff4ea, shift:0.20,  toony:0.52, shade:0x6a5f78, gi:0.44,
          rim:0xffd9b0, rimPow:2.3, rimLift:0.02, rimMix:0.82, outW:0.0006, outC:0x3d3340,
          keyC:0xffcf9e, keyI:19, expo:1.18,
          rimI:3.4, rimC:0xffe4c8,
          hemi:0.16, sunI:4.4, fillI:0.16, bncI:0.18, shRad:4.2,
          sat:0.88, con:1.07, bri:1.01,
          vig:'0.60', vigc:'rgba(74,58,52,0.62)',
          warmG:'rgba(255,222,186,0.34)', coldG:'rgba(46,44,74,0.42)' },
  mita: { label:'米塔',   color:0xfff6ec, shift:0.16,  toony:0.86, shade:0xc9b6bd, gi:0.35,
          rim:0xffe0c0, rimPow:3.0, rimLift:0.04, rimMix:0.62, outW:0.0011, outC:0x4b3a34,
          keyC:0xffd7b0, keyI:17, expo:1.02,
          rimI:0.62, rimC:0xffe6cc,
          hemi:0.70, sunI:2.7, fillI:0.62, bncI:0.55, shRad:2.5,
          sat:0.98, con:1.03, bri:1.00,
          vig:'0.44', vigc:'rgba(186,152,126,0.44)',
          warmG:'rgba(255,226,186,0.30)', coldG:'rgba(108,92,86,0.28)' },
  cel:  { label:'赛璐璐', color:0xffffff, shift:-0.04, toony:0.96, shade:0x93a3bd, gi:0.18,
          rim:0xffffff, rimPow:5.0, rimLift:0.00, rimMix:0.28, outW:0.0024, outC:0x26262e,
          keyC:0xfff4e2, keyI:14, expo:1.06,
          rimI:0.40, rimC:0xeaf0ff,
          hemi:0.58, sunI:3.2, fillI:0.45, bncI:0.40, shRad:1.2,
          sat:1.06, con:1.10, bri:1.02,
          vig:'0.34', vigc:'rgba(150,150,164,0.40)',
          warmG:'rgba(255,240,220,0.22)', coldG:'rgba(96,104,128,0.30)' },
  soft: { label:'柔光',   color:0xfff2e6, shift:0.30,  toony:0.58, shade:0xd9c9cd, gi:0.55,
          rim:0xfff0e0, rimPow:2.2, rimLift:0.09, rimMix:0.42, outW:0.0006, outC:0x6b5a52,
          keyC:0xffe6c8, keyI:13, expo:1.00,
          rimI:0.50, rimC:0xfff0e0,
          hemi:0.86, sunI:2.2, fillI:0.74, bncI:0.62, shRad:5.0,
          sat:1.00, con:1.00, bri:1.04,
          vig:'0.26', vigc:'rgba(200,178,158,0.34)',
          warmG:'rgba(255,236,214,0.34)', coldG:'rgba(140,124,132,0.22)' },
};
let STYLE = new URLSearchParams(location.search).get('style') || 'cine';
if(!STYLES[STYLE]) STYLE = 'cine';

function styleChar(v){
  const S = STYLES[STYLE];
  renderer.toneMappingExposure = S.expo;
  charKey.color.setHex(S.keyC); charKey.intensity = S.keyI;
  // 轮廓光也归画风管：参考视频里"她被抠出来"靠的就是背后这盏
  if(typeof charRim !== 'undefined'){
    charRim.intensity = S.rimI;
    charRim.color.setHex(S.rimC);
  }
  // 环境光：这是"电影感"的总开关。
  // 参考视频背景都是暗的、只有一条主光——半球光越弱，主光才越"像光"。
  // 只调半球光会把屋子调成一片死黑，所以主光要同时加，做的是对比度不是亮度。
  if(typeof hemi !== 'undefined'){
    hemi.intensity = S.hemi ?? 0.70;
    if(typeof sun !== 'undefined'){
      sun.intensity = S.sunI ?? 2.7;
      sun.shadow.radius = S.shRad ?? 2.5;
    }
    if(typeof fill !== 'undefined') fill.intensity = S.fillI ?? 0.62;
    if(typeof bounce !== 'undefined') bounce.intensity = S.bncI ?? 0.55;
  }
  // 调色：canvas 的 CSS filter + #grade 的暗角/冷暖，全部由预设写进来
  if(renderer.domElement){
    renderer.domElement.style.filter = `saturate(${S.sat || 1}) contrast(${S.con || 1}) brightness(${S.bri || 1})`;
  }
  const g = document.getElementById('grade');
  if(g){
    g.style.setProperty('--g-vigc', S.vigc || 'rgba(186,152,126,0.44)');
    g.style.setProperty('--g-warm', S.warmG || 'rgba(255,226,186,0.30)');
    g.style.setProperty('--g-cold', S.coldG || 'rgba(108,92,86,0.28)');
  }
  if(!v?.scene) return;
  let n = 0;
  v.scene.traverse(o => {
    if(!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if(!m) return;
      n++;
      // MToon 才能调卡通光照；普通 glb 材质只做暖色偏移，不硬套
      if(typeof m.shadingShiftFactor === 'number'){
        m.color?.setHex(S.color);                                  // 暖白偏移
        m.shadingShiftFactor = S.shift;                               // 明暗交界往后拉：脸不再一半进阴影
        m.shadingToonyFactor = S.toony;                               // 高一点=更软，低=更硬
        if(m.shadeColorFactor) m.shadeColorFactor.setHex(S.shade); // 阴影带一点冷灰紫，不是纯黑
        if(m.giEqualizationFactor !== undefined) m.giEqualizationFactor = S.gi;
        // 轮廓光：米塔没有描边，靠的是边缘受光
        if(m.parametricRimColorFactor){
          m.parametricRimColorFactor.setHex(S.rim);
          m.parametricRimFresnelPowerFactor = S.rimPow;
          m.parametricRimLiftFactor = S.rimLift;
          m.rimLightingMixFactor = S.rimMix;
        }
        // 描边压细、改成暖棕；纯黑描边会让她变成漫画贴纸
        if(m.outlineWidthMode !== undefined){
          m.outlineWidthMode = 'worldCoordinates';
          m.outlineWidthFactor = S.outW;
          m.outlineColorFactor?.setHex(S.outC);
        }
      } else if(m.color){
        m.color.multiply(new THREE.Color(0xfff0e2));
      }
      m.needsUpdate = true;
    });
  });
  console.log('styled materials', n);
}

/* 角色灯。
   先记一个坑：three.js 里灯的 layers 是按**相机**剔除的，不是按物体，
   所以"给灯设 layer 1 只照角色"根本不生效（灯会整个被跳过）。想只照亮她，
   只能靠距离衰减：给她配一盏贴身的聚光灯 + 一盏背后的点光，
   影响半径压到 1~2 米，屋里其余部分照不到。 */
const charKey = new THREE.SpotLight(0xffd7b0, 17, 6.5, 0.74, 0.74, 1.35);
charKey.castShadow = false;
const charRim = new THREE.PointLight(0xffe6cc, 0.55, 1.9, 2);
scene.add(charKey, charKey.target, charRim);

function updateCharLights(){
  const p = state.pos;
  const f = new THREE.Vector3(Math.sin(state.facing), 0, Math.cos(state.facing));
  // 主光从她的左前方高一点打下来（对应窗的方向），太正会没立体感
  charKey.position.set(p.x - 1.05, 1.95, p.z + 1.25);
  charKey.target.position.set(p.x, 0.55, p.z);
  charKey.target.updateMatrixWorld();
  // 轮廓光放她背后，距离压到 0.9，只擦亮发梢
  charRim.position.set(p.x - f.x * 0.55, 1.02, p.z - f.z * 0.55);
}

/* 座面/躺高/桌面伸手距离都从这里推，换人就自动跟着变 */
function body(){ return CHAR.body || B; }

function registry(){
  return fetch('assets/characters.json', { cache:'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
}

/* ---------- 角色 ≠ 身体 --------------------------------------------
   一个角色可以有多具身体（Live2D / VRM / 以后 MMD、Spine），
   人设、声音、记忆属于**角色**；模型和授权属于**身体**。
   所以"换人"其实是两件事：换角色（换人设）、换身体（换皮）。

   房间只认 VRM。Live2D 是画好的平面图，没有骨骼、没有坐躺、
   手也碰不到桌子——这不是缺陷，是它本来就不该进房间。
   这个函数只做一件事：从角色里挑出一具能进指定场景的身体。 */

function avatarsOf(c){
  if(!c) return [];
  if(Array.isArray(c.avatarModels) && c.avatarModels.length) return c.avatarModels;
  // 兼容 schema 1：一个角色只有 file 一个字段
  if(c.file) return [{ id:(c.id||'local')+'-vrm', kind:'vrm', label:'3D',
                       src:c.file, use:['room'], hide:c.hide, tail:c.tail }];
  return [];
}

function pickAvatar(c, wantUse){
  const list = avatarsOf(c);
  if(!list.length) return null;
  const fits = m => !wantUse || !m.use || m.use.includes(wantUse);
  if(c.defaultAvatarModelId){
    const d = list.find(m => m.id === c.defaultAvatarModelId);
    if(d && fits(d)) return d;
  }
  if(wantUse === 'room')                     return list.find(m => m.kind === 'vrm') || null;
  if(wantUse === 'cover' || wantUse === 'chat')
    return list.find(m => m.kind === 'live2d' && fits(m))
        || list.find(m => m.kind === 'vrm' && fits(m)) || null;
  return list.filter(fits)[0] || null;
}

/* 把「角色 + 身体」压成一个 desc，交给 loadChar。
   loadChar 只认 desc，不认角色——它不该知道"人设"这种东西。 */
function asAvatar(c, m){
  if(!m) return null;
  const cr = m.credit || {};
  return {
    id:        c.id || 'local',
    characterId: c.id || 'local',
    avatarId:  m.id || '',
    kind:      m.kind || 'vrm',
    label:     m.label || '',
    name:      c.name || m.label || m.kind || 'VRM',
    file:      m.src,
    use:       m.use || [],
    hide:      m.hide,
    tail:      m.tail,
    author:    cr.author || cr.art || c.author || '',
    license:   cr.license || c.license || '',
  };
}

function loadVRM(url, name, desc){
  // 兼容旧调用（拖文件进来没有 desc）
  return loadChar(Object.assign({ file: url, name: name || 'VRM', id: 'local' }, desc || {}));
}

function loadChar(desc){
  /* 身体是有"能干什么"的差异的，不是所有身体都能进房间。
     Live2D 没有骨骼：不能坐、不能躺、手伸不到桌上。
     与其让它进来穿模，不如说清楚为什么不行 —— 这是设计，不是缺陷。 */
  if(desc.kind === 'live2d'){
    showPick(`<b>${desc.name || '这个角色'} 的这具身体是 Live2D</b>
      <div class="sub">它是画好的平面图：没有骨骼，不能坐、不能躺，手也碰不到桌子。</div>
      <div class="sub">房间需要 VRM。她还有 3D 版就用 3D 版；没有就换一个角色，或者选一个 .vrm 进来。</div>`);
    return;
  }
  const url = desc.file;
  tip.style.display = '';
  tip.innerHTML = `<div class="box">加载 ${desc.name || '模型'}…<div class="sub" id="ld">0%</div></div>`;

  loader.load(url, gltf => {
    const v = gltf.userData.vrm;
    if(vrm?.scene) holder.remove(vrm.scene);
    state.tail = null;
    state.props = [];

    if(!v){
      // 不是 VRM（普通 glb）也要能站进来：退化成一个"布景"，不做骨骼动画
      gltf.scene.traverse(o => { o.frustumCulled = false; });
      holder.add(gltf.scene);
      vrm = { scene: gltf.scene, expressionManager: null, humanoid: null, meta: {}, update(){} };
      CHAR.body = null;
    } else {
      vrm = v;
      VRMUtils.removeUnnecessaryTriangles?.(v.scene);
      VRMUtils.combineSkeletons(v.scene);
      v.scene.traverse(o => { o.frustumCulled = false; });
      if(v.meta?.metaVersion === '0') v.scene.rotation.y = Math.PI;
      holder.add(v.scene);
    }
    tip.style.display = 'none';

    // 校准：任何单位/任何体型的模型都缩到 CANON.h，世界尺度才成立
    const raw = new THREE.Box3().setFromObject(vrm.scene).getSize(new THREE.Vector3()).y;
    let k = 1;
    if(raw > 0.01){
      k = (desc.fit || CANON.h) / raw;
      vrm.scene.scale.multiplyScalar(k);
      vrm.scene.position.multiplyScalar(k);
    }
    if(v){ dressUp(v, desc); styleChar(v); CHAR.body = measure(v); }
    else CHAR.body = null;

    CHAR.id = desc.id || 'local';
    CHAR.characterId = desc.characterId || desc.id || 'local';
    CHAR.avatarId = desc.avatarId || '';
    CHAR.kind = desc.kind || 'vrm';
    CHAR.label = desc.label || '';
    CHAR.name = desc.name || 'VRM';
    CHAR.author = desc.author || (v?.meta?.author || (v?.meta?.authors||[]).map(a=>a.name).filter(Boolean).join(', ') || '');
    CHAR.license = desc.license || '';
    CHAR.file = url;
    CHAR.ready = true;

    const b0 = body();
    hud.textContent =
      `${CHAR.name}${CHAR.label ? ' · ' + CHAR.label : ''}  ${CANON.h.toFixed(2)} m\n`
      + (v ? `表情 ${Object.keys(v.expressionManager?.expressionMap || {}).length} 个 · 缩放 ×${k.toFixed(2)}\n` : '（不是 VRM，只能当布景）\n')
      + (CHAR.body?.ok ? `髋 ${b0.hipsY.toFixed(2)} 膝 ${b0.kneeY.toFixed(2)} 臂 ${(b0.upperArm+b0.foreArm).toFixed(2)}\n` : '')
      + (CHAR.author ? `模型：${CHAR.author}\n` : '')
      + (CHAR.license ? `${CHAR.license}\n` : '');
    buildFaceButtons();
    applyPose('stand');
    /* 骨头这时候才真有了，动作层只能在这之后接。 */
    mountAnim();
    window.__vrm = v; window.__CHAR = CHAR;
    READY.mark('char', { name: CHAR.name, ok: !!CHAR.body?.ok });
  }, xhr => {
    const el = document.getElementById('ld');
    if(el && xhr.total) el.textContent = `${(xhr.loaded/xhr.total*100)|0}%`;
  }, err => {
    showPick(`<b style="color:#ff9a9a">加载失败：${desc.name || ''}</b>
      <div class="sub">${err.message || err}</div>
      <div class="sub">常见原因：贴图没跟着搬；这不是 VRM；路径不对。</div>`);
  });
}

function dressUp(v, desc){
  const p = new URLSearchParams(location.search);
  const arg = p.get('hide');
  // 该藏哪些零件写在这个角色的 desc 里，不写死在代码里 —— 换人不用改代码
  const list = arg === 'none' ? [] : (arg ? arg.split(',').filter(Boolean) : (desc?.hide || []));
  const props = [];
  v.scene.traverse(o=>{
    if(!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if(list.some(k => o.name.startsWith(k))){ props.push(o); o.visible = false; }
  });
  state.props = props; state.propsOff = props.length > 0;

  // 尾巴是 J_Opt_C_FoxTail1~5 一串，根骨在 hips 下。
  // glTF 导出的骨骼 matrixAutoUpdate=false，不打开它 rotation 是空的（踩过）
  state.tail = null;
  const tailKey = desc?.tail || '';
  if(tailKey) v.scene.traverse(o=>{
    if(o.isBone && o.name.indexOf(tailKey) >= 0){
      o.matrixAutoUpdate = true;
      state.tail = o;
    }
  });
}

/* ---------- 姿势：骨头只设一次，每帧 update() 会搬回真骨骼 ---------- */

/* ---------- 两骨 IK ----------
   为什么要有这个：A-pose 里大臂是朝外（±X）的，绕 X 轴转会变成"自转"，
   角度怎么拧都够不到桌面上那个点。要"手落在桌面"，只能解一次几何：
   已知肩 S、肘 E、腕 H，臂长 L1(上臂)、L2(前臂)，目标点 T，
   先求肘该落在哪儿（两圆交点），再分别把大臂、小臂拧过去。 */
function wpos(b){ const p = new THREE.Vector3(); b.getWorldPosition(p); return p; }

function spinTo(bone, fromV, toV){
  if(!bone || fromV.lengthSq() < 1e-8 || toV.lengthSq() < 1e-8) return;
  const q = new THREE.Quaternion().setFromUnitVectors(fromV.clone().normalize(), toV.clone().normalize());
  const pq = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(pq);
  bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
  bone.updateMatrixWorld(true);
}

function solveArm(side, target, pole){
  const h = vrm?.humanoid; if(!h) return;
  const up = h.getNormalizedBoneNode(side + 'UpperArm');
  const lo = h.getNormalizedBoneNode(side + 'LowerArm');
  const hd = h.getNormalizedBoneNode(side + 'Hand');
  if(!up || !lo || !hd) return;
  holder.updateMatrixWorld(true);

  const S = wpos(up), E = wpos(lo), H = wpos(hd);
  const L1 = S.distanceTo(E), L2 = E.distanceTo(H);
  const toT = target.clone().sub(S);
  const d = THREE.MathUtils.clamp(toT.length(), 0.03, L1 + L2 - 0.004);
  const dir = toT.clone().normalize();

  // 肘的位置：沿 S→T 走 a，再沿极向量方向偏出去 hh
  const a = (L1*L1 - L2*L2 + d*d) / (2*d);
  const hh = Math.sqrt(Math.max(0, L1*L1 - a*a));
  let pv = pole.clone().normalize();
  pv.sub(dir.clone().multiplyScalar(pv.dot(dir)));
  if(pv.lengthSq() < 1e-6) pv.set(0, -1, 0);
  pv.normalize();
  const E2 = S.clone().add(dir.clone().multiplyScalar(a)).add(pv.multiplyScalar(hh));
  const T2 = S.clone().add(dir.clone().multiplyScalar(d));

  spinTo(up, E.clone().sub(S), E2.clone().sub(S));
  const E3 = wpos(lo), H3 = wpos(hd);
  spinTo(lo, H3.clone().sub(E3), T2.clone().sub(E3));
}

function runIK(){
  if(!vrm?.humanoid || !state.ik) return;
  // 目标点按"她的朝向"算：forward 是脸朝的方向，right 是她的右手边
  const f = new THREE.Vector3(Math.sin(state.facing), 0, Math.cos(state.facing));
  const r = new THREE.Vector3(f.z, 0, -f.x);
  const P = state.pos;
  const down = new THREE.Vector3(0, -1, 0.35);      // 肘朝下偏后，别往外翻
  const put = (side, fwd, side_off, y) => solveArm(side,
    new THREE.Vector3(P.x + f.x*fwd + r.x*side_off, y, P.z + f.z*fwd + r.z*side_off), down);

  // 手臂比例：新模型臂长和参考模型不一样，前伸量要跟着缩放，否则手够不到桌沿
  const armK = THREE.MathUtils.clamp(
    (body().upperArm + body().foreArm) / (B.upperArm + B.foreArm), 0.72, 1.28);

  if(state.ik === 'desk'){
    // 腕落在桌面上：前伸 0.13（她手臂总共 0.284，前伸 0.235 是够不到的），左右各 0.08
    put('left',  0.13 * armK, -0.08 * armK, DESK.top + 0.020);
    put('right', 0.13 * armK,  0.08 * armK, DESK.top + 0.020);
  } else if(state.ik === 'lap'){
    put('left',  0.13 * armK, -0.10 * armK, SEAT + 0.05);
    put('right', 0.13 * armK,  0.10 * armK, SEAT + 0.05);
  }
}

function nbone(b){ return vrm?.humanoid?.getNormalizedBoneNode(b) || null; }

function applyPose(name){
  const h = vrm?.humanoid;
  if(!h) return;
  const prev = state.poseName;
  // 站起来时先挪出家具，不然她会站在床垫上/椅子上下不来
  if(name === 'stand' && prev === 'lie') state.pos.set(BED.x, 0, BED.z + BED.l/2 + 0.34);
  if(name === 'stand' && (prev === 'sit' || prev === 'desk')) state.pos.set(CHAIR.x + 0.30, 0, CHAIR.z);
  state.poseName = name;
  // 先复位所有会动的骨头
  ['spine','chest','upperChest','neck','head',
   'leftShoulder','rightShoulder','leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm',
   'leftHand','rightHand','leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg',
   'leftFoot','rightFoot'].forEach(b=>{ const n = nbone(b); if(n) n.rotation.set(0,0,0); });

  // 站姿的底子：手臂从 A 字放下来
  const armsDown = ()=>{
    if(nbone('leftUpperArm'))  nbone('leftUpperArm').rotation.z  =  0.95;
    if(nbone('rightUpperArm')) nbone('rightUpperArm').rotation.z = -0.95;
    if(nbone('leftLowerArm'))  nbone('leftLowerArm').rotation.z  =  0.18;
    if(nbone('rightLowerArm')) nbone('rightLowerArm').rotation.z = -0.18;
  };
  armsDown();

  state.lift = 0; state.tiltX = 0;
  state.walking = false;
  state.ik = null;
  if(name === 'sit') state.ik = 'lap';

  if(name === 'sit' || name === 'desk'){
    state.pos.set(CHAIR.x, 0, CHAIR.z);
    // 大腿抬平、小腿垂下、脚踩地
    const THIGH = -1.75, KNEE = 1.70;   // 搜出来的：膝落在髋高、踝落在 0.263
    if(nbone('leftUpperLeg'))  nbone('leftUpperLeg').rotation.x  = THIGH;
    if(nbone('rightUpperLeg')) nbone('rightUpperLeg').rotation.x = THIGH;
    if(nbone('leftLowerLeg'))  nbone('leftLowerLeg').rotation.x  = KNEE;
    if(nbone('rightLowerLeg')) nbone('rightLowerLeg').rotation.x = KNEE;
    if(nbone('leftFoot'))  nbone('leftFoot').rotation.x  = -0.1;
    if(nbone('rightFoot')) nbone('rightFoot').rotation.x = -0.1;
    // 下沉量 = 座面 - 她的髋高。换人以后髋高变了，这里跟着变，
    // 否则新模型会坐在空气里或者陷进椅子
    state.lift = SEAT - body().hipsY;

    if(name === 'desk'){
      // 手放到桌面上这件事拧角度拧不出来（A-pose 是大臂朝外，
      // 绕 X 转只是自转），所以走两骨 IK，见 runIK()
      state.ik = 'desk';
      if(nbone('spine')) nbone('spine').rotation.x = 0.08;
      state.ikDirty = true;
    }
  }

  // 坐下时尾巴会横着扫过椅子/桌面，往身后压一点
  if(state.tail){
    if(name === 'sit' || name === 'desk') state.tail.rotation.set(-0.8, 0, 1.2);
    else if(name === 'lie') state.tail.rotation.set(-0.3, 0, 0.5);
    else state.tail.rotation.set(0, 0, 0);
  }

  if(name === 'lie'){
    // 躺下时脚底在 pos.z、头顶在 pos.z-B.h，所以把她整个人沿 z 居中到床心
    state.pos.set(BED.x, 0, BED.z + CANON.h/2);
    // 躺下：整体绕 X 转 -90°，头朝 -z（床头那头）
    state.tiltX = -Math.PI/2;
    // 髋骨离床面 0.115（参考模型实测）。按髋高比例缩放，换人也贴得住
    state.lift = BED.surf + 0.115 * (body().hipsY / B.hipsY);
    if(nbone('leftUpperLeg'))  nbone('leftUpperLeg').rotation.z  =  0.10;
    if(nbone('rightUpperLeg')) nbone('rightUpperLeg').rotation.z = -0.10;
  }

  /* 动作层记着"这一帧给每根骨头加了多少"。姿势刚被整体重写，账本必须清空：
   * 不清的话下一帧会按旧账减一遍，把刚摆好的姿势减坏（腿僵在半空，还查不出来）。
   * 只清账、不动骨头——这一刻骨头就是它该有的样子。 */
  ANIM?.forget();
}

/* ---------- 互动 ---------- */
const ray = new THREE.Raycaster();
const planeY0 = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
const ptr = new THREE.Vector2(-2,-2);
const hitPt = new THREE.Vector3();
let hovered = null;

function pickFurniture(){
  if(!FURN.length) return null;
  ray.setFromCamera(ptr, cam);
  const hits = ray.intersectObjects(FURN, true);
  if(!hits.length) return null;
  let o = hits[0].object;
  while(o && !FURN.includes(o)) o = o.parent;
  return o || null;
}

function pickInt(){
  if(!INTS.length) return null;
  ray.setFromCamera(ptr, cam);
  const hits = ray.intersectObjects(INTS.map(i => i.obj), true);
  if(!hits.length) return null;
  let o = hits[0].object;
  while(o && !o.userData.int) o = o.parent;
  return o ? o.userData.int : null;
}

function walkTo(x, z){
  state.pending = null;
  applyPose('stand');
  state.want.set(
    THREE.MathUtils.clamp(x, -ROOM.w/2 + 0.35, ROOM.w/2 - 0.35), 0,
    THREE.MathUtils.clamp(z, -ROOM.d/2 + 0.30, ROOM.d/2 - 0.15));
  state.walking = true;
  poke();
}

function flashHint(text){
  hoverEl.textContent = text;
  hoverEl.classList.add('on');
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(() => { if(!hoveredInt) hoverEl.classList.remove('on'); }, 1100);
}

addEventListener('pointermove', e => {
  ptr.x = (e.clientX/innerWidth)*2 - 1;
  ptr.y = -(e.clientY/innerHeight)*2 + 1;
  poke();

  // 可互动物件优先：指到就亮，太远只提示，不隔空操作
  const it = pickInt();
  if(it){
    hoveredInt = it;
    const near = intDist(it) <= it.reach;
    hoverEl.textContent = near ? `${it.label} · E / 点击` : `${it.label} · 走近一点`;
    hoverEl.classList.add('on');
    document.body.style.cursor = near ? 'pointer' : 'default';
    if(glowOn !== it){
      if(glowOn) glow(glowOn.obj, false);
      glow(it.obj, true);
      glowOn = it;
    }
    return;
  }
  if(glowOn){ glow(glowOn.obj, false); glowOn = null; }
  hoveredInt = null;

  const f = pickFurniture();
  hovered = f;
  if(f){
    hoverEl.textContent = `${f.userData.name} · ${f.userData.hint}`;
    hoverEl.classList.add('on');
    document.body.style.cursor = 'pointer';
  } else {
    hoverEl.classList.remove('on');
    document.body.style.cursor = '';
  }
});

addEventListener('pointerdown', e => {
  if(!vrm) return;
  // 触摸屏上第一下不会有 pointermove，这里必须自己更新指针，否则点哪都点不准
  ptr.x = (e.clientX/innerWidth)*2 - 1;
  ptr.y = -(e.clientY/innerHeight)*2 + 1;

  // ① 可互动物件：够近就动手，不够近就走过去（米塔也是这个规矩）
  const it = pickInt();
  if(it){
    if(intDist(it) <= it.reach){
      useInt(it);
    } else {
      const wp = new THREE.Vector3();
      it.obj.getWorldPosition(wp);
      const dx = state.pos.x - wp.x, dz = state.pos.z - wp.z;
      const len = Math.hypot(dx, dz) || 1;
      walkTo(wp.x + dx / len * 0.55, wp.z + dz / len * 0.55);
      flashHint(`${it.label} · 走近一点`);
    }
    return;
  }

  // ② 家具
  const f = pickFurniture();
  if(f){
    const u = f.userData;
    state.pending = { at: u.spot.clone(), face: u.face, action: u.action };
    state.want.copy(u.spot);
    state.faceWant = u.face;
    state.poseName = 'walking';
    state.lift = 0; state.tiltX = 0;
    applyPose('stand');
    state.walking = true;
    poke();
    return;
  }
  // ③ 地面
  ray.setFromCamera(ptr, cam);
  if(ray.ray.intersectPlane(planeY0, hitPt)){
    walkTo(hitPt.x, hitPt.z);
  }
});

/* ---------- 导入一个模型：先看清它，再收下 ----------------------------
 * 为什么不能像以前那样"拖进来就 load"：
 *   一个缺 hips 的模型照样渲染得出来，然后所有动作都从错误的地方起算——
 *   看起来像我们动作写错了，实际是模型不合格。所以**在收下之前**就说清楚。
 *
 * 三步：解析 → 判定 → 落盘。
 *   判定不过：把缺什么、会怎样列出来，不加载。
 *   没起服务（file:// 打开）：仍然能临时用，但明说"这次关掉就没了"。
 */
const escHtml = (t) => String(t == null ? '' : t)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inspectFile(f){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读不了这个文件'));
    fr.onload = () => {
      const ab = fr.result;
      loader.parse(ab, '', (gltf) => {
        const v = gltf.userData.vrm;
        let h = 0;
        try {
          const box = new THREE.Box3().setFromObject((v && v.scene) || gltf.scene);
          h = box.getSize(new THREE.Vector3()).y;
        } catch (e) { /* 量不出来交给 inspect 判 */ }
        resolve({ ab, sum: summarize(v, { height: h }) });
      }, () => reject(new Error('解析失败：可能不是完整的 VRM，或者文件损坏了')));
    };
    fr.readAsArrayBuffer(f);
  });
}

async function importModel(f){
  if(!/\.(vrm|glb)$/i.test(f.name)){ showPick('<b>只认 .vrm / .glb</b>'); return; }
  const baseName = f.name.replace(/\.(vrm|glb)$/i, '');

  tip.style.display = '';
  tip.innerHTML = `<div class="box">正在看 ${escHtml(baseName)}…<div class="sub">读骨骼、量身高</div></div>`;

  let got;
  try { got = await inspectFile(f); }
  catch (e) {
    showPick(`<b>${escHtml(baseName)}</b><div class="sub">${escHtml(e.message)}</div>`);
    return;
  }

  const verdict = inspect(got.sum);
  const facts = verdict.facts;
  if(!verdict.ok){
    /* 每条 fatal 都是一整句话（见 model-import.mjs 里的注释：
     * 只说"导入失败"等于什么都没说）。 */
    showPick(`<b>这个模型进不了房间</b>
      <div class="sub">${verdict.fatal.map(x => '· ' + escHtml(x)).join('<br>')}</div>
      <div class="sub">量到：高 ${facts.height.toFixed(2)} m · 骨 ${facts.bones} 根 · 材质 ${facts.materials}</div>`);
    return;
  }

  /* 落盘。名字冲突就自动加后缀——同一个模型拖两次是常事，
   * 直接报错会让人以为坏了。 */
  const base = slugify(baseName, 'model');
  const q = (slug) => new URLSearchParams({ name: slug, label: '3D', author: facts.author || '', license: '' });
  let saved = null, err = null;
  for(let i = 0; i < 5 && !saved; i++){
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    try{
      const r = await fetch('/api/model?' + q(slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: got.ab,
      });
      const j = await r.json().catch(() => ({}));
      if(r.ok && j.ok){ saved = j; break; }
      if(r.status === 409) continue;             // 重名，换一个再来
      err = j.error || ('HTTP ' + r.status);
      break;
    }catch(e){ err = '连不上本地服务'; break; }
  }

  if(saved){
    const warn = verdict.warn.length
      ? `<div class="sub" style="color:#ffd9a8">提醒：${verdict.warn.map(escHtml).join('；')}</div>` : '';
    tip.style.display = '';
    tip.innerHTML = `<div class="box">收下了：${escHtml(baseName)}<div class="sub">存在 ${escHtml(saved.src)}，下次打开还在</div>${warn}</div>`;
    setTimeout(() => { tip.style.display = 'none'; }, 2600);
    /* 用服务端的路径加载，不是 objectURL——这样刷新之后还是它。 */
    loadChar({ id: saved.id, characterId: saved.id, kind: 'vrm', label: '3D',
               name: baseName, file: saved.src });
    return;
  }

  /* 没存下来，但还能用。**必须明说**：否则他下次打开发现模型没了，
   * 会以为是"导入功能坏了"，实际是"没有服务端可写"。 */
  showPick(`<b>能看，但没存下来</b>
    <div class="sub">${escHtml(err || '本地服务没接上')}。要先 <code>node tools/serve.mjs</code> 打开这个页面，
    导入的模型才会留在 assets/vrm/ 里；现在这一次关掉页面就没了。</div>`);
  loadChar({ id: 'local', characterId: 'local', kind: 'vrm', label: '临时',
             name: baseName, file: URL.createObjectURL(f) });
}

// 拖文件
addEventListener('dragover', e=>{ e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', e=>{ if(e.clientX<=0 || e.clientY<=0) document.body.classList.remove('drag'); });
addEventListener('drop', e=>{
  e.preventDefault(); document.body.classList.remove('drag');
  const f = e.dataTransfer.files?.[0];
  if(!f) return;
  if(!/\.(vrm|glb)$/i.test(f.name)){ showPick('<b>只认 .vrm / .glb</b>'); return; }
  importModel(f);
});
bindPick();

const FACE_MAP = [['happy','开心'],['angry','生气'],['sad','难过'],['relaxed','放松'],['surprised','惊讶']];
function buildFaceButtons(){
  const bar = document.getElementById('bar');
  bar.innerHTML = '';
  const has = vrm?.expressionManager?.expressionMap;
  if(has) FACE_MAP.forEach(([k,label])=>{
    if(!has[k]) return;
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.f = k;
    b.onclick = ()=>{
      state.expr = (state.expr === k) ? null : k;
      [...bar.querySelectorAll('[data-f]')].forEach(c=>c.classList.toggle('on', c.dataset.f === state.expr));
      poke();
    };
    bar.appendChild(b);
  });
  const sep = document.createElement('span'); sep.className = 'sep'; bar.appendChild(sep);
  if(state.props?.length){
    const pb = document.createElement('button');
    pb.textContent = '道具';
    pb.classList.toggle('on', !state.propsOff);
    pb.onclick = ()=>{
      state.propsOff = !state.propsOff;
      state.props.forEach(o=> o.visible = !state.propsOff);
      pb.classList.toggle('on', !state.propsOff);
      poke();
    };
    bar.appendChild(pb);
  }
  const sty = document.createElement('button');
  sty.title = '米塔 / 赛璐璐 / 柔光 —— 只换成像，不换模型';
  sty.textContent = STYLES[STYLE].label;
  sty.onclick = () => {
    const keys = Object.keys(STYLES);
    STYLE = keys[(keys.indexOf(STYLE) + 1) % keys.length];
    styleChar(vrm);
    sty.textContent = STYLES[STYLE].label;
    poke();
  };
  bar.appendChild(sty);
  const cineBtn = document.createElement('button');
  cineBtn.textContent = '宣传机位';
  cineBtn.title = '拉近到 3/4 特写、收镜头、加电影黑边 —— 用来出图，不是玩法视角';
  cineBtn.onclick = () => {
    setHero(!heroOn);
    cineBtn.textContent = heroOn ? '退出宣传' : '宣传机位';
  };
  bar.appendChild(cineBtn);
  const who = document.createElement('button');
  who.textContent = '换人';
  who.title = '换一个 VRM，房间和互动不用改';
  who.onclick = openWho;
  bar.appendChild(who);
  const st = document.createElement('button');
  st.textContent = '站起来';
  st.onclick = ()=>{ state.pending = null; applyPose('stand'); state.lift = 0; poke(); };
  bar.appendChild(st);
  poke();
}

/* ---------- 角色面板：注册表里的任何一个都能进来 ---------- */
let REG = null;

function openWho(){
  const box = document.getElementById('who');
  box.classList.add('on');
  const list = document.getElementById('whoList');
  list.innerHTML = '';
  const arr = REG?.characters || [];
  if(!arr.length){
    list.innerHTML = '<div class="whoRow"><b style="color:#a8947f">注册表是空的</b></div>';
  }
  arr.forEach(c => {
    const bodies = avatarsOf(c);
    const canRoom = bodies.some(m => !m.use || m.use.includes('room'));
    const row = document.createElement('div');
    row.className = 'whoRow' + (CHAR.characterId === c.id ? ' on' : '');

    // 每具身体一个小标签：能进房间的实心，进不了的划掉，当前在用的高亮
    const chips = bodies.map(m => {
      const ok  = !m.use || m.use.includes('room');
      const cur = CHAR.avatarId === m.id;
      const tipTxt = ok ? (m.use||[]).join(' / ') : '进不了房间';
      return `<span class="k${ok ? '' : ' no'}${cur ? ' cur' : ''}" title="${tipTxt}">${m.label || m.kind}</span>`;
    }).join('');

    /* 署名要跟"现在这具身体"走，不跟第一具走。
       同一角色的两套皮作者常常不同（原画 / 建模 / 3D 转制），写错就是侵权。 */
    const curBody = bodies.find(m => m.id === CHAR.avatarId);
    const roomBody = bodies.find(m => m.kind === 'vrm');
    const shown = curBody || roomBody || bodies[0] || {};
    const cr = shown.credit || {};
    row.innerHTML = '<span class="dot"></span><div>'
      + `<b>${c.name}</b><i>${cr.author || cr.art || c.author || '未知作者'}</i>`
      + (chips ? `<span class="chips">${chips}</span>` : '')
      + (!canRoom ? `<em>没有 3D 身体，进不了房间</em>` : '')
      + '</div>';

    row.onclick = () => {
      const m = pickAvatar(c, 'room');
      if(!m){
        showPick(`<b>${c.name} 没有能进房间的身体</b>
          <div class="sub">房间需要 VRM（3D 骨骼）。这个角色只有 Live2D 或立绘。</div>
          <div class="sub">给它在 <code>assets/characters.json</code> 里加一个 <code>kind: "vrm"</code> 的身体，就能进来了。</div>`);
        return;
      }
      box.classList.remove('on');
      loadChar(asAvatar(c, m));
    };
    list.appendChild(row);
  });
  document.getElementById('whoFile').onchange = e => {
    const f = e.target.files?.[0];
    if(!f) return;
    box.classList.remove('on');
    importModel(f);
  };
  clearTimeout(dimT); document.getElementById('bar').classList.remove('dim');
}

document.getElementById('whoX').onclick = () => document.getElementById('who').classList.remove('on');

let dimT;
function poke(){
  const bar = document.getElementById('bar');
  if(!bar) return;
  bar.classList.remove('dim');
  clearTimeout(dimT);
  dimT = setTimeout(()=>bar.classList.add('dim'), 3200);
}

/* ============================================================
   五、每帧
   ============================================================ */
const clock = new THREE.Clock();


/* ============================================================
   五、互动内核
   ------------------------------------------------------------
   先把话说清楚：米塔是 Unity + IL2CPP 的商业游戏，没有开源、没有
   可调用的 SDK，也没有 Mod 接口能拿到它的移动/交互组件，所以
   "直接套用它游戏里的那套"这条路不存在（就算把资源抽出来用，
   也是侵权）。能搬过来的是它的**结构**，而它的结构非常朴素：
     ① 射线选取：指到才亮，指不到没有任何反馈
     ② 距离门槛：太远只提示"走近一点"，绝不隔空互动
     ③ 物件状态机：每个东西有自己的开/关和过渡动画
   它的"完善感"其实来自后面三样：动画、音效、内容量，不是系统复杂。
   下面这段就是这三层；以后加一件家具，写一行 interactable() 就行。
   ============================================================ */
const INTS = [];
let hoveredInt = null, glowOn = null;

function interactable(obj, label, opt = {}){
  const it = {
    obj, label,
    reach: opt.reach ?? 0.95,
    use: opt.use || (() => {}),
    on: opt.on ?? false,
  };
  obj.userData.int = it;
  INTS.push(it);
  return it;
}

/* 高亮只在"指到的那一刻"克隆材质，离开立刻还原。
   直接改共享材质的话，整间屋子会跟着一起发光 —— 这里最容易踩。 */
function glow(obj, on){
  obj.traverse(o => {
    if(!o.isMesh || !o.material || o.material.isArray) return;
    if(on){
      if(!o.userData._m){ o.userData._m = o.material; o.material = o.material.clone(); }
      if(o.material.emissive){
        o.material.emissive.setHex(0x5c3a1c);
        o.material.emissiveIntensity = 1;
      }
    } else if(o.userData._m){
      o.material.dispose?.();
      o.material = o.userData._m;
      delete o.userData._m;
    }
  });
}

/* 距离用包围盒中心算，不用 group 原点 —— 顶灯和窗帘的组原点都在 (0,0,0)，
   直接取原点会让"距离"变成到房间中心，看起来能互动其实隔着两米 */
const _box = new THREE.Box3(), _cen = new THREE.Vector3();
function intDist(it){
  _box.setFromObject(it.obj);
  _box.getCenter(_cen);
  return Math.hypot(_cen.x - state.pos.x, _cen.z - state.pos.z);
}

function nearestInt(){
  let best = null, bd = Infinity;
  for(const it of INTS){
    const d = intDist(it);
    if(d < bd){ bd = d; best = it; }
  }
  return { it: best, d: bd };
}

function useInt(it, by = 'him'){
  if(!it) return;
  it.on = !it.on;
  it.use(it.on);
  poke();
  // 世界变了，报一声。by 只区分"他按的"和"她自己按的"——
  // 她自己按的不该再报回给她，否则她会跟自己较劲（灭了又开、开了又灭）
  window.__worldChanged?.(by);
}

/* ---------- WASD：相机相对移动，她自己转身 ---------- */
const keys = new Set();
addEventListener('keydown', e => {
  // 在输入框里打字不该让她走起来
  if(e.target && e.target.closest && e.target.closest('input,textarea')) return;
  const k = e.key.toLowerCase();
  if(k === 'e'){
    const n = nearestInt();
    if(n.it && n.d <= n.it.reach) useInt(n.it);
    return;
  }
  if(['w','a','s','d','shift','arrowup','arrowdown','arrowleft','arrowright'].includes(k)) keys.add(k);
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const _dir = new THREE.Vector3(), _right = new THREE.Vector3();
/* 上一帧的位置：动作层要拿它算"这一帧真走了多远"（按键和 walkTo 两条路都算）。 */
const _prevPos = new THREE.Vector3();

function moveByKeys(dt){
  const f = ((keys.has('w') || keys.has('arrowup')) ? 1 : 0) - ((keys.has('s') || keys.has('arrowdown')) ? 1 : 0);
  const side = ((keys.has('d') || keys.has('arrowright')) ? 1 : 0) - ((keys.has('a') || keys.has('arrowleft')) ? 1 : 0);
  if(!f && !side) return false;
  if(state.poseName !== 'stand') applyPose('stand');     // 坐着躺着先站起来
  state.walking = false;
  state.pending = null;
  cam.getWorldDirection(_dir); _dir.y = 0; _dir.normalize();
  _right.set(-_dir.z, 0, _dir.x);                        // 屏幕右 = 视线右
  _dir.multiplyScalar(f).addScaledVector(_right, side);
  if(_dir.lengthSq() < 1e-6) return false;
  _dir.normalize();
  const spd = keys.has('shift') ? 1.25 : 0.80;           // 她 1.36 m，0.8 m/s 已经是小跑
  state.pos.addScaledVector(_dir, spd * dt);
  state.pos.x = THREE.MathUtils.clamp(state.pos.x, -ROOM.w/2 + 0.34, ROOM.w/2 - 0.34);
  state.pos.z = THREE.MathUtils.clamp(state.pos.z, -ROOM.d/2 + 0.30, ROOM.d/2 - 0.18);
  state.faceWant = Math.atan2(_dir.x, _dir.z);
  return true;
}

/* ---------- 灯光/窗帘的过渡（不做 tween 库，一条插值就够） ---------- */
const C_ON = new THREE.Color(0xffd9a2), C_OFF = new THREE.Color(0x3a322c);
function animateInts(dt){
  const k = Math.min(1, dt * 6.5);
  if(REF.lampLight){
    REF.lampLight.intensity += ((REF.lampOn ? 1.15 : 0) - REF.lampLight.intensity) * k;
    if(REF.lampBulb) REF.lampBulb.material.color.lerp(REF.lampOn ? C_ON : C_OFF, k);
  }
  if(REF.pendantLight){
    REF.pendantLight.intensity += ((REF.pendantOn ? 1.5 : 0.05) - REF.pendantLight.intensity) * k;
    if(REF.pendantBulb) REF.pendantBulb.material.color.lerp(REF.pendantOn ? C_ON : C_OFF, k);
  }
  if(REF.floorLight){
    REF.floorLight.intensity += ((REF.floorOn ? 1.25 : 0) - REF.floorLight.intensity) * k;
    if(REF.floorBulb) REF.floorBulb.material.color.lerp(REF.floorOn ? C_ON : C_OFF, k);
  }
  if(REF.curtains.length) REF.curtains.forEach(p => {
    const t = REF.curtainOpen ? p.z1 : p.z0;
    p.m.position.z += (t - p.m.position.z) * k;
  });
}

/* ---------- 登记：现在只有三件，够验证机制了 ---------- */
interactable(REF.pendant,     '顶灯', { reach: 1.7, on: true, use: on => REF.pendantOn = on });
interactable(REF.lampGroup,   '台灯', { reach: 1.05, on: true, use: on => REF.lampOn = on });
interactable(REF.curtainGroup,'窗帘', { reach: 1.5, on: true, use: on => REF.curtainOpen = on });
interactable(REF.floorGroup,  '落地灯', { reach: 1.15, on: true, use: on => REF.floorOn = on });

/* 表现层接手：骨头从 nbone 取，姿势从 state 读。 */
const PERF_API = createPerf({ nbone, state });
const PERF = PERF_API.PERF;
const perfGesture = PERF_API.gesture;
const perfOnSay = PERF_API.onSay;
const perfOnEmotion = PERF_API.onEmotion;
const perfTick = PERF_API.tick;
window.__PERF = PERF_API.debug;

function tick(){
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), .05);
  state.t += dt;

  /* 这一帧她实际挪了多远——不是按键的速度，是**真的位移**。
   * 走路有两条路（WASD 和 walkTo 走去看某个东西），只有量位移能把两条都算上。
   * 动作层拿它推进步态相位：走多快，腿摆多快。 */
  _prevPos.copy(state.pos);

  moveByKeys(dt);
  animateInts(dt);

  if(vrm){
    // 走位
    if(state.walking && state.poseName !== 'sit' && state.poseName !== 'desk' && state.poseName !== 'lie'){
      const d = state.want.clone().sub(state.pos);
      d.y = 0;
      const dist = d.length();
      if(dist > 0.015){
        const sp = Math.min(dist, dt * 0.95);
        state.pos.add(d.normalize().multiplyScalar(sp));
        state.faceWant = Math.atan2(d.x, d.z);
      } else if(state.pending){
        const p = state.pending; state.pending = null;
        state.pos.copy(p.at);
        applyPose(p.action);
        state.walking = false;
      } else {
        state.walking = false;
      }
    }

    let df = state.faceWant - state.facing;
    while(df >  Math.PI) df -= Math.PI*2;
    while(df < -Math.PI) df += Math.PI*2;
    state.facing += df * Math.min(1, dt*6);

    holder.position.set(state.pos.x, state.lift, state.pos.z);
    updateCharLights();
    herShadow.position.set(state.pos.x, 0.010, state.pos.z);
    herShadow.visible = state.poseName !== 'lie';
    holder.rotation.set(state.tiltX, state.facing, 0);

    /* 呼吸和待机搬去 anim/procedural.mjs 了：它和走路是同一套"每帧叠在姿势上"
     * 的偏移，分在两个文件里写同一根 chest，改一次要改两处，还容易一边把另一边覆盖掉。
     * 这里只剩"头往哪看"——那是感知，不是动作。 */
    if(vrm.humanoid){
      // 躺下时不追鼠标（仰面朝天还转头很怪）
      if(state.poseName !== 'lie'){
        const head = nbone('head');
        if(head){
          /* 她"看向某处"时优先用它（lookAt 端口设的，2.5 秒有效），
           * 否则跟鼠标。覆盖而不是叠加：她自己看的方向和鼠标恰好在那儿是两件事。 */
          const lk = state.look;
          const useLook = lk && performance.now() < lk.until;
          const src = useLook ? new THREE.Vector2(lk.x, lk.y) : ptr;
          const p = new THREE.Vector3(src.x, src.y, 0.5).unproject(cam);
          const dir = p.sub(cam.position).normalize();
          const yaw = Math.atan2(dir.x, dir.z) - state.facing;
          const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
          head.rotation.y += (THREE.MathUtils.clamp(-yaw, -.55, .55) - head.rotation.y) * Math.min(1, dt*6);
          head.rotation.x += (THREE.MathUtils.clamp(pitch, -.30, .30) - head.rotation.x) * Math.min(1, dt*6);
        }
      }
    }

    /* 表现层：手势 / 待机 / 镜头。
     * 放在"呼吸和视线"之后：它只加偏移，先让身体各自归位再加，才对得上。 */
    perfTick(dt);

    /* 动作层：只写骨头，外加一个"整个人往下沉多少"。
     * 放在 perf 之后——两层都用"记差额、先减再加"，顺序固定才不互相拆台。
     * 速度用**这一帧真的挪了多远**算，不是按键状态：walkTo 那一路没有按键。 */
    const animSpeed = (state.poseName === 'stand' || state.poseName === 'walking')
      ? Math.min(2.6, dt > 0 ? _prevPos.distanceTo(state.pos) / dt : 0)
      : 0;
    const animOut = ANIM ? ANIM.update(dt, { speed: animSpeed, pose: state.poseName, t: state.t }) : null;
    /* 落脚那一下的下沉加在这里。不加的话，腿在动、人还是像被一根线吊着滑过去。 */
    holder.position.y = state.lift + (animOut?.bob || 0);

    const em = vrm.expressionManager;
    if(em){
      state.nextBlink -= dt;
      if(state.nextBlink <= 0){ state.blink = 1; state.nextBlink = 2 + Math.random()*3.5; }
      if(state.blink > 0){
        state.blink -= dt * 4.2;
        em.setValue('blink', Math.max(0, state.blink));
      }
      FACE_MAP.forEach(([k])=> em.setValue(k, state.expr === k ? 1 : 0));
      state.mouth += (state.mouthWant - state.mouth) * Math.min(1, dt*14);
      em.setValue('aa', state.mouth);
    }

    vrm.update?.(dt);

    if(state.ikDirty){
      runIK();
      holder.updateMatrixWorld(true);
      state.ikDirty = false;
    }

    // 相机：只轻微跟，别把房间晃晕
    if(!window.__camLock){
      /* FIT 是窄屏的退远倍数。这里必须带进来——原来只在 resize 里设 cam.position，
       * 会被这一行每帧覆盖掉，等于白设。 */
      /* camK 是表现层的推镜系数（说话时 0.97）：她说的时候镜头近一点，
       * 说完自己退回来。这是"演出"，不是"瞄准"——所以只动 3%，再多就像有人在拉变焦。 */
      const camWant = new THREE.Vector3(state.pos.x * 0.26, 1.34 + (FIT - 1) * 0.32,
                                        (CAM_HOME.p[2] * FIT + state.pos.z * 0.10) * PERF.camK);
      cam.position.lerp(camWant, Math.min(1, dt*1.6));
      cam.lookAt(state.pos.x * 0.20 + 0.05, 0.62 + (FIT - 1) * 0.26, -0.35);
    }
  }

  renderer.render(scene, cam);
}
tick();

function fitCamera(){
  FIT = fitFactor();
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
fitCamera();
addEventListener('resize', fitCamera);

/* 启动 */
const q = new URLSearchParams(location.search);
if(q.has('vrm')){
  loadVRM(q.get('vrm'), q.get('vrm').split('/').pop());
} else {
  registry().then(reg => {
    REG = reg;
    window.__REG = REG;          // 调试/自动化用：能直接看注册表结构
    const arr = reg?.characters || [];
    const want = q.get('char') || arr[0]?.id;
    const c = arr.find(x => x.id === want) || arr[0];
    if(!c){
      showPick(`<b>注册表里还没有角色</b>
        <div class="sub">在 <code>assets/characters.json</code> 里加一条，或者直接拖 .vrm 进来</div>`);
      return;
    }
    /* ?avatar= 可以指定用哪具身体（vrm / live2d / 具体 id）；
       不给就按场景挑：房间要 VRM。 */
    const askKind = q.get('avatar');
    const m = askKind
      ? (avatarsOf(c).find(x => x.id === askKind || x.kind === askKind) || pickAvatar(c, 'room'))
      : pickAvatar(c, 'room');
    if(!m){
      showPick(`<b>${c.name} 没有能进房间的身体</b>
        <div class="sub">房间需要 VRM（3D 骨骼）。这个角色只有 Live2D 或立绘。</div>
        <div class="sub">给它在 <code>assets/characters.json</code> 里加一个 <code>kind: "vrm"</code> 的身体，就能进来了。</div>`);
      return;
    }
    loadChar(asAvatar(c, m));
  });
}

window.__state = state;
window.__apply = applyPose;
window.__THREE = THREE;
window.__holder = holder;
window.__camera = cam;
window.__ik = runIK;
window.__INTS = INTS;
window.__REF = REF;
window.__use = useInt;
window.__move = moveByKeys;
window.__anim = animateInts;
window.__near = nearestInt;
window.__keys = keys;
window.__STYLE = () => STYLE;
window.__setStyle = k => { STYLE = k; styleChar(vrm); };
window.__FURN = FURN;          // 动作桥要用：家具表里有 spot/face/action，几何只在这一侧
window.__walk = walkTo;
/* 动作层：调试和探针用。返回现在用的是哪一版、相位到哪儿了——
 * "腿有没有动"这件事不该只靠眼睛看截图。 */
window.__ANIM = () => (ANIM ? { id: ANIM.id, label: ANIM.label, clips: ANIM.clips, ...(ANIM.state() || {}) } : null);
window.__ANIMS = () => ANIM_SET.ids();
window.__poke = poke;

/* 这一段（3D 那套）装完了。打勾时顺手带上"装成了什么样"的数字——
 * 冒烟测试除了看勾，还能核对数字；只打一个 true，等于只说"跑到了这儿"。 */
READY.mark('scene', { objects: scene.children.length, fov: cam.fov });
READY.mark('room', { furn: Object.keys(FURN).length, ref: Object.keys(REF).length });
READY.mark('interact', { items: INTS.length });
READY.mark('perf', { gestures: Object.keys(GEST).length });
}
