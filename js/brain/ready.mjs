/* 「页面装好了没有」的唯一判据。
 * ------------------------------------------------------------
 * 为什么需要这个东西：外部（CDP 脚本、桌面壳的看门狗、冒烟测试）只能看见
 * "某个全局有没有值"。于是它们拿 __LOOP 当判据——而 __LOOP 在 2775 行就赋值了，
 * 表单监听在 3009 行、VRM 是异步的、规则/衣柜/世界内容要等网络。
 * 在那几百毫秒里发一句话，要么表单真提交把页面导航重载，要么 send() 撞上
 * 还没收尾的一轮静默变成"打断"——表现都是"填了没反应"，而且偶发。
 *
 * 所以判据不能是"猜某个变量在不在"，得由页面自己报一份清单：
 *   装完了哪些块、缺哪些块、什么时候报的。
 * 这份清单还有第二个用处：拆文件之后，哪个模块没被搬进来，清单上立刻少一块，
 * 不用靠打开页面看一眼。
 *
 * 规矩：块名是**稳定的字符串**，改名字等于改协议（外面和测试都认它）。
 */

/* 期望的块。顺序 = 依赖顺序 = 出问题时先看哪个。
 * 和拆出来的文件一一对应，不是随便列的：
 *   场景 → 房间 → 她 → 互动 → 表现 → 大脑 → 内容 → 界面 → 时钟 → 外线 */
export const EXPECT = [
  'scene',    // js/room/scene.mjs    渲染器、相机、光
  'room',     // js/room/room.mjs     房间几何与家具（REF）
  'char',     // js/room/char.mjs     她的模型、适配层、姿势
  'interact', // js/room/interact.mjs 射线、高亮、开关
  'perf',     // js/room/perf.mjs     手势播放器（表现层）
  'brain',    // 动作注册表 / 记忆 / 一轮 / 执行
  'content',  // 规则、衣柜、世界内容（三份都是网络来的）
  'ui',       // 输入框、字幕、HUD、键盘
  'clock',    // 空时刻
  'inbox',    // 外部消息订阅 + 心跳
];

const fresh = () => ({
  ok: false,
  at: 0,
  note: '',
  closed: false,
  blocks: Object.create(null),
  missing: EXPECT.slice(),

  /* 打一个勾。info 不是布尔时（对象/数字）就是这一块的细节，方便坏了能查。
   *
   * 已经收过尾的也要重算：VRM 是异步来的，收尾那一刻它往往还没到。
   * 早先这里只记 blocks 不重算，于是页面在 __CHAR.ready 已经是 true 的时候
   * 还挂着"缺 char"——冒烟测试当场就抓到了（就绪信号比现实晚，等于假的）。 */
  mark(name, info = true) {
    this.blocks[name] = info;
    if (this.closed) this._recalc();
    return this;
  },

  /* 缺哪些块、ok 是什么，永远从 blocks 现算。存下来的结论会过期。 */
  _recalc() {
    this.missing = EXPECT.filter((k) => this.blocks[k] == null);
    this.ok = this.missing.length === 0;
    this.at = Date.now();
    return this;
  },

  /* 收尾：把这一刻的结论定下来。之后再有块到齐，mark 会自己重算。 */
  finish(note = '') {
    this.note = note;
    this.closed = true;
    return this._recalc();
  },

  /* 一行话。给 console 和冒烟测试的失败信息用。 */
  summary() {
    const have = EXPECT.filter((k) => this.blocks[k] != null);
    return (this.ok ? '就绪' : '没装完')
      + `：${have.length}/${EXPECT.length} 块`
      + (this.missing.length ? `，缺 ${this.missing.join('/')}` : '')
      + (this.note ? `（${this.note}）` : '');
  },

  /* 等到就绪，或者超时。给 CDP 用：轮询的是"页面自己的判断"，
   * 不是外面猜的那个全局。 */
  wait(ms = 30000) {
    if (this.ok) return Promise.resolve(this);
    const t0 = Date.now();
    return new Promise((res) => {
      const tick = () => {
        if (this.ok || Date.now() - t0 > ms) return res(this);
        setTimeout(tick, 100);
      };
      tick();
    });
  },
});

/* 两段 <script type="module"> 各 import 一次，必须拿到同一个对象——
 * 所以底下垫在 globalThis 上，而不是每次 new 一个。
 * 这样第一段（3D 那套）打的勾，第二段（大脑接线）收尾时看得见。 */
export const READY = (globalThis.__READY ||= fresh());

/* 桌面壳/自动化最爱问的一句：现在能不能操作？ */
export const isReady = () => READY.ok === true && READY.missing.length === 0;
