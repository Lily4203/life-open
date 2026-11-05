# 接入 DSH：让它当脑子，她当身体

> DSH（DeepSeek Harness）是一个通用 agent 宿主：会话、模型、工具、沙箱都是它的。
> 这个项目是**一间屋子和一个人**。
>
> 两者接起来的分工只有一句话：**DSH 决定做什么，她负责做，做完如实回。**

---

## 一、为什么是 MCP，不是"再写一个插件"

DSH 的插件是 cordis 行，写一个要跟着它的版本走：bundle 分层、patch 覆盖、
每个版本插件的依赖树都会变。**跟着它写，就等于把自己焊死在别人的版本上。**

MCP 是它已经支持的入口（`~/.dsh/storages/mcp_servers.json` 里那条 `basic_memory`
就是同一个形态）。选它的三个理由：

1. **适配的代价是"加一个文件"**，不是"改它的核心"。DSH 升级，这边一行不用动。
2. **同一个服务器，别的宿主也能用**（Claude、WorkBuddy、任何说 MCP 的）。
3. **它天然是"工具"边界**：DSH 里的模型看见的是五个工具，不是一个黑盒。
   她能做什么、不能做什么，写在工具描述里，不靠文档。

---

## 二、三步接上

### 1. 让她先在家

DSH 里那个 agent 再聪明，也得有人在屋里接。

```bash
cd <这个仓库>
cp keys.example.json keys.json      # 填 DEEPSEEK_API_KEY
cp -r data.example data             # 一份空白的她
node tools/serve.mjs                # http://127.0.0.1:8765
```

**浏览器要开着那个页面。** 屋子在页面里，页面关了就没有身体可动——
这时候派动作会回 `no_page`，不会排到三分钟后去关一盏早就变了的灯。

### 2. 把 MCP 服务器加进 DSH

DSH 设置里加一个自定义 MCP（stdio），命令：

```
node  <仓库绝对路径>/mcp/server.mjs
```

环境变量（可选）：

| 变量 | 默认 | 什么时候要改 |
|---|---|---|
| `LIFE_URL` | `http://127.0.0.1:8765` | 她换了端口 |

或者直接写进 `~/.dsh/storages/mcp_servers.json` 的 `tables.servers`（和 `basic_memory` 并列）：

```json
{
  "id": "life",
  "name": "life",
  "transport": "stdio",
  "command": "node",
  "args": ["D:\\dafeiyu\\life\\mcp\\server.mjs"],
  "env": { "LIFE_URL": "http://127.0.0.1:8765" }
}
```

> 用 UI 加更稳：那个文件是 DSH 的运行态存储，它在跑的时候可能整个重写。

### 3. 试一句

在 DSH 里说：

> 看看她现在在干什么，然后让她走到床边。

正常情况下会看到三次工具调用：`life_state` → `life_actions` → `life_act(go_to, 床边)`。
最后那个的返回里有 `ok` 和 `ms`，和"她自己想走过去"的返回是同一种东西。

---

## 三、五个工具，各自管什么

| 工具 | 会不会改变世界 | 什么时候用 |
|---|---|---|
| `life_state` | 不会 | 派动作之前先看：她在哪、什么姿势、哪盏灯亮着 |
| `life_actions` | 不会 | 动作名不许写死，现查 |
| `life_act` | **会** | 请她做一个动作，等结果 |
| `life_hear` | 只加一句话 | 想让"她知道有这回事"，但**不保证她回** |
| `life_speak` | **会**（出声） | 替她开口。绕过她的风格和记忆，慎用 |

### 三个刻意的不对称

**① `life_hear` 不保证有回应。**
有人说话 ≠ 她必须说。她可以选择听见了不接（见契约 2.26）。
如果你需要"一定有回应"，那你要的是 `life_speak`，但那已经不是她了。

**② 动作失败不算工具失败。**
`life_act` 返回 `{ok:false, reason:'failed'}` 是**正常结果**，不是异常。
宿主里的模型应该看见它、自己决定下一步（换个动作、还是算了），
而不是把它当报错重试三遍——那会让她在房间里来回撞。

只有"根本问不到她"（服务没开、页面没开）才是 `isError`。

**③ 动作只认名字，不认坐标。**
`go_to('床边')` 可以，`go_to(3.2, 0, -1.8)` 不行。
这条不是洁癖：坐标一旦能进工具参数，DSH 里的模型就会开始"算路径"，
而那本来是这个项目最不该外包出去的一件事。

---

## 四、这条线的两端各是什么

```
DSH（会话 / 模型 / 计划）
   │  MCP：life_state / life_actions / life_act
   ▼
mcp/server.mjs（薄壳：翻译 + 超时 + 原样带回）
   │  HTTP：POST /api/act
   ▼
tools/serve.mjs（行动端口：分发、超时、计数）
   │  SSE：/api/act/stream
   ▼
页面（唯一碰世界的地方）
   │  R.call(name, args)
   ▼
js/brain/actions.mjs（注册表：窗口 / 归属 / 三步上限 / 失败不冒泡）
   ▼
屋子（Three.js 场景）
```

**每一层都只做一件事，且都能单独换掉。** 这就是"思想和行动分开"在工程上的样子：
DSH 可以换成任何别的宿主，页面可以换成桌面壳，屋子可以换成第二间——
接缝只有那两个协议（MCP 和 HTTP）。

---

## 五、排错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `unreachable` | `tools/serve.mjs` 没跑 | 起来，看 health |
| `no_page` | 服务在跑，但浏览器没开那个页面 | 打开页面；桌面壳同理 |
| `timeout` | 页面卡住 / 动作太久 | 看页面控制台；`/api/health` 的 `act.timedOut` |
| `not_in_window` | 这个动作这轮不允许（比如正躺着） | 先 `life_actions` 看她现在能做什么 |
| 她一动就 `failed` | 模型没加载完 / 家具没登记 | `life_state` 里 `anim` 是 null 就说明屋子还没装好 |

health 里这一块是专门为这条线留的：

```bash
curl -s http://127.0.0.1:8765/api/health | python -m json.tool | grep -A 8 '"act"'
```

`got` / `done` / `timedOut` / `noPage` 分开计数，是因为"她没动"有三种原因，
混成一个数字，排错就只能猜。
