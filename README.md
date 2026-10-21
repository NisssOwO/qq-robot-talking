# qq-robot-talking

把 **DeepSeek Harness** 里的 agent 接到 **QQ**：好友和群里的消息变成 DSH 会话中的用户消息，agent 的回复（包括它自己决定什么时候开口、一次说几条）再发回 QQ。

这是 **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的定制版**，基线 `v0.2.0-r4`。代码主体来自上游；本仓库在上游之上加了「静默时段 / Fish Audio 语音 / 角色包 / 世界观注入 / 主动搭话约束 / DSH 模型跟随」等能力。

> 上游英文 README 原文见 [docs/UPSTREAM-README.en.md](docs/UPSTREAM-README.en.md)（未随定制同步，中文以本文件为准）。

仓库历史刻意分成两段（[CHANGES.md](CHANGES.md) 有逐项说明）：

```
commit 1  upstream: qq-bridge v0.2.0-r4    ← 上游原样，逐字节一致
commit 2+ custom: ...                      ← 全部改动
```

所以 `git diff HEAD~1` 就能看清"定制到底改了什么、为什么改"，而不是一个无法追溯的整包。

---

## 开始之前：你需要先准备好这些

这个项目不是「下载下来双击就能跑」的单文件程序——它挂在两个外部软件上，**下面 4 项缺任何一项都跑不起来**：

| # | 要先准备 | 它负责什么 | 从哪儿弄 |
| --- | --- | --- | --- |
| 1 | **DeepSeek Harness（DSH）** | 机器人的「脑子」。桥接把 QQ 消息转成 DSH 会话里的用户消息，再把 agent 的回复发回 QQ。装好后能打开它的 Web GUI 就行 | 按 DSH 官方说明安装（桌面版或 Web 版都可以） |
| 2 | **SnowLuma**（QQ 网关） | 真正登录 QQ、收发消息，对外提供 OneBot v11 的 **WebSocket + HTTP API** 两个接口。**这个要你自己下载** | [Releases](https://github.com/SnowLuma/SnowLuma/releases/latest) 下 `SnowLuma-v<版本>-win-x64.zip`（完整版自带 Node 运行时；Lite 版需要本机 Node 22.13+），解压后双击 `launcher.bat` |
| 3 | **Node.js ≥ 22.13** | 跑桥接本身 | [nodejs.org](https://nodejs.org/) |
| 4 | **一个 QQ 账号**（建议小号）+ 你自己的 QQ 号 | 小号给机器人登录用；你自己的号填进 `ownerQQ`（静默时段例外、语音试听默认目标、错误通知都发给它） | — |

可选项：

- **Fish Audio API Key** —— 只有要发语音才需要；在控制台「语音」卡里填，不用写进配置文件。不填只影响语音，文字聊天照常。
- **本地 HTTP 代理** —— TTS 要连 `api.fish.audio`，国内直连可能被重置；有代理就填 `tts.proxy`（例如 `http://127.0.0.1:7897`）。
- **Windows 动态端口** —— 如果 SnowLuma 报 `listen EACCES: permission denied 127.0.0.1:3000`，把 OneBot 的 HTTP/WS 改到 `38000/38001`（见「常见问题」）。

> 第一次做，建议先照 **[原项目作者的视频教程](https://www.bilibili.com/video/BV1ss8R6zERG/)** 把「DSH + SnowLuma + 原版桥接」连通，再回来用这个定制版——安装前几步和原版完全一致。

## 这个版本多了什么

| 能力 | 一句话 |
| --- | --- |
| **静默时段** | 工作日 09:00–12:00、14:00–18:00 完全静默，只有 owner @ 才回一条、回完即停；节假日按中国日历自动放行，调休补班照常静默 |
| **Fish Audio 语音** | 一次性 `/v1/tts` 合成 + 注音字典 + **只给 TTS 用的代理隧道**（不污染进程全局代理）；AI 自己判断该不该发语音，发完补一条「日语原文 + 中文字幕」 |
| **角色包** | 角色卡、音色 ID、注音字典、唤醒别名、世界观名字绑进一个 `roles/*.pack.json`，切角色时**一起换**，热读不用重启 |
| **世界观注入** | 从 eidolon 的 `world.json` 生成**稳定前缀**（事务所/组合/歌曲/演出年份），事务员这类非偶像角色走 staff 分支；用绝对日期，不拼"今天"，吃满上下文缓存 |
| **主动搭话** | 群/私聊分别开关、夜间禁止（默认 23:30–07:00）、每天上限、活跃窗口、一次接触只搭一次；提示词按私聊/群分别写（先接旧话题 → 搜热点 → 自己日常），**只有真的发出消息才计数** |
| **DSH 模型跟随** | 不再写死 `provider/model`，直接读 DSH 全局默认（`agent-default-model`）对齐会话，控制台显示"设置 = 实际"；想覆盖才开 `dsh.manageModel` |
| **杂项** | 假名角色名（上游会把「七草はづき」削成「七草」）、黑话模糊匹配（15 条窗口 + 读取通道注入）、DSH 桌面端端口自动发现 |

## 来源与致谢

### 原项目（代码主体）

- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** — MIT。本项目继承的东西：
  - OneBot v11 收发、DSH 会话生命周期（创建 / 退役 / 待处理队列清理）
  - 三种运行模式：单会话转发、`social`（群聊社交）、`socialV2`（`reserved2` 二代仿真：AI 自己决定何时回、发几条）
  - DSH 端 preset（`qq-chat` / `qq-chat-v2`）与 MCP 服（`snowluma` / `snowluma-host` / `web-search-safe`）的安装脚本
  - 控制台、token 用量统计、安全边界（工具隐藏清单、语音库路径限制、白名单）
  - 基线版本 `v0.2.0-r4`，适配 DSH `0.2.0-rc.2`
  - 上游完整文档保留在 **[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md)**（含 SnowLuma 版本要求、"连上了但收不到消息"排查、HTTP/WS token 区别等踩坑记录）
  - 视频教程：<https://www.bilibili.com/video/BV1ss8R6zERG/>（B 站，原作者的完整安装演示，从装 SnowLuma 到跑通第一条消息）

### 参考项目

- **[Sallyn0225/eidolon-sc](https://github.com/Sallyn0225/eidolon-sc)** — 角色扮演与语音能力的参考实现。借鉴点：
  - **角色卡结构**：`你是谁 / 怎么说话 / 怎么称呼别人 / 和他们相处的方式 / 性格 / 说话形式 / 硬性规则`（我们的卡按这个分节写，见 `roles/README.md`）
  - **世界设定** `characters/world.json`：事务所 staff、8 个组合、每首歌的演唱者、每场 live 的日期 → 我们的 `src/world-prompt.mjs`
  - **语音**：`characters.toml` 的 `voice_id`（Fish Audio 音色）与 `readings.toml` 的 `kana → phonemes` 注音表 → 我们的 `src/tts-fish.mjs` 字典
  - **主动搭话** `reach_outs.py`：按亲密度分档的间隔（3–6h / 8–16h / 20–36h）、夜间禁止、每天上限、每次接触只搭一次 → 我们的 `socialV2.proactive`
  - **长期记忆** `facts.py` 的 supersede 语义：试做过一版，实测模型不主动调用 `remember` 工具，已撤销；设计留档在 [docs/LONG-MEMORY-TODO.md](docs/LONG-MEMORY-TODO.md)
  - ⚠️ 仓库**不包含** eidolon 的任何素材（角色卡、facts、图片、`world.json` 都要自备，且受其自身许可约束）

### 运行环境

- **SnowLuma** — QQ 的 OneBot v11 网关。桥接用 WebSocket 收事件、HTTP 调 API。上游 README 里记录了版本要求与"连上了但收不到消息"的排查方法。
- **DeepSeek Harness** — agent 运行环境。桥接通过它的一元 RPC 与会话事件流工作。

## 它怎么工作

```
QQ ──► SnowLuma（OneBot v11）
         │  WS 事件（ws://…:38001）        HTTP API（http://…:38000）
         ▼                                      ▲
   src/bridge.js ───────────────────────────────┘
         │  会话 / 消息 / 工具审批
         ▼
   DeepSeek Harness（agent 在这里跑）
         │
         ▼
   控制台 http://127.0.0.1:3100（模式切换、白名单、静默、语音、主动搭话、角色）
```

三种模式（控制台顶部切换）：

1. **转发**：每条 QQ 消息直接进 agent，回复自动回 QQ。最简单，也最"吵"。
2. **social**：群聊社交模式，桥接自己决定要不要回。
3. **socialV2（`reserved2`，二代仿真）**：AI 自己决定何时回、回几条、要不要潜水。文本输出**不会自动转发**，必须由 AI 调 `qq_send_message` / `qq_send_burst` / `qq_reply` 等工具发出去 —— 这也是"她说了话但 QQ 没收到"的常见原因。

## 视频教程

原项目（qq-bridge）作者录的完整安装演示：

- **B 站**：<https://www.bilibili.com/video/BV1ss8R6zERG/>

视频覆盖的是**原版** qq-bridge 的流程：装 SnowLuma → 扫码登录 → 配 OneBot → 装 DSH 端 preset → 跑通第一条消息。本定制版把这些步骤原样保留，只是多了静默时段 / 语音 / 角色包这些可选能力；按视频走完，再回来看下面「配置要点」即可。

## 上手步骤（按顺序做）

### 1. 确认 DSH 已经装好并正在运行

打开 DSH 的 Web GUI（端口每次启动会变，以实际为准）。**DSH 要先启动，桥接才能找到它**；桥接启动时用 `scripts/dsh-endpoint.mjs` 自动探测端口。

### 2. 下载本仓库并安装依赖

```bash
git clone https://github.com/NisssOwO/qq-robot-talking.git
cd qq-robot-talking
npm install                                # postinstall 会修补 @snowluma/sdk 的 ESM 打包问题
cp config.example.json config.json         # Windows CMD: copy config.example.json config.json
```

### 3. 启动 SnowLuma 并配好 OneBot

- 解压 `SnowLuma-v<版本>-win-x64.zip`，双击 `launcher.bat`
- 打开启动日志里的 **WebUI 地址**（默认 <http://localhost:5099>），用日志里的初始密码登录
- 按引导走：同意条款 → 设置密码 → 接入 QQ 进程（**扫码登录机器人账号**）
- 在 WebUI 里开启 **WebSocket 服务端** 和 **HTTP API**，记下两个端口（默认 WS `3001`、HTTP `3000`）和 accessToken

> **Windows 端口坑**：`3000/3001` 经常落在 Windows 的动态端口保留段里，表现是 `listen EACCES: permission denied 127.0.0.1:3000`。可以先跑 `netsh int ipv4 show excludedportrange protocol=tcp` 确认。绕开办法：SnowLuma 里把 HTTP 改成 `38000`、WS 改成 `38001`，桥接配置同步改。注意有些版本还要先关掉 **WS 默认端口**、单独开一个 WS 服务端，两个别同时占。

### 4. 编辑 `config.json`

至少填这四项：

| 字段 | 填什么 |
| --- | --- |
| `ownerQQ` | 你自己的 QQ 号 |
| `allow.private` / `allow.groups` | 允许机器人回复的 QQ 号 / 群号。**留空时默认谁都不回**（fail-closed，别担心它乱说话） |
| `snowluma.wsUrl` / `httpUrl` | 例如 `ws://127.0.0.1:38001` / `http://127.0.0.1:38000` |
| `snowluma.accessToken` | 与 WebUI 里的一致，没设就留空 |

可选：`consolePort`（默认 3100）、`quietHours`（静默时段）、`socialV2.proactive`（主动搭话）、`tts`（语音）。控制台里也能改。

### 5. 装 DSH 端（最容易漏，漏了 QQ 上毫无反应）

```bash
node scripts/setup-dsh.mjs
```

这一步会往 DSH profile 里装 `qq-chat` / `qq-chat-v2` 两个 preset，并挂载 `snowluma` / `snowluma-host` / `web-search-safe` 三个 MCP。**装完必须重启 DSH**——preset 和 MCP 只在 DSH 启动时加载。

### 6. 启动桥接

```bash
npm start                  # 前台运行
# 或 Windows 双击 start.bat（崩溃自动重启）
```

看到日志里 `SnowLuma 已连接` 即成功。

### 7. 打开控制台

<http://127.0.0.1:3100> —— 令牌在 `state/console-token`。在控制台里：

- **模式**：单会话转发 / `social` / `socialV2`（二代仿真，推荐）。注意 `socialV2` 下 AI 的文本**不会自动转发**，要靠它自己调 `qq_send_message` 等工具发出去
- **角色**：下拉选人格卡（`roles/*.md`），音色、注音字典、世界观会跟着角色包一起换
- **语音**：填 Fish Audio Key → 点「测试连通性」→ 点「试听」
- **静默时段 / 主动搭话**：「运行总览」页里的卡片

### 8. 测试

用你的 QQ 给机器人小号发消息，或在群里 @ 它，应该能收到回复。收不到就看下面「常见问题」。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| QQ 上完全没反应 | ① 白名单没填（`allow.private` / `allow.groups` 是空数组）② 没跑 `node scripts/setup-dsh.mjs` ③ 跑完没重启 DSH ④ SnowLuma 没连上（看桥接日志有没有 `SnowLuma 已连接`） |
| `listen EACCES ... 3000/3001` | Windows 动态端口保留段占用 → 改用 `38000/38001` |
| 控制台 401 / 打不开 | 地址是 `http://127.0.0.1:3100`，令牌在 `state/console-token` |
| MCP 工具报 `HTTP 426` | `httpUrl` 填成了 WS 端口；HTTP API 和 WS 是**两个**端口 |
| DSH 重启后桥接找不到它 | DSH 端口每次启动随机；重跑 `node scripts/dsh-endpoint.mjs`，或重启桥接让它自动探测 |
| AI 明明回复了但 QQ 没收到 | `socialV2` 模式下文本不自动转发，必须由 AI 调发送工具；preset 里已写了规则，检查一下是不是切到了错的模式 |

## 配置要点（本仓库新增的字段）

完整模板见 `config.example.json`，这里只列定制相关的：

```jsonc
{
  "dsh": {
    "manageModel": false        // false = 跟随 DSH 全局默认；true = 用下面的 provider/model 覆盖
  },
  "quietHours": {
    "enabled": true,
    "weekdays": [1, 2, 3, 4, 5],
    "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
    "holidays": "cn"            // 中国节假日（timor.tech），节假日放行、调休补班静默
  },
  "tts": {
    "enabled": true,
    "provider": "fish",
    "baseUrl": "https://api.fish.audio",
    "apiKey": "",               // 建议在控制台「语音」卡里填；也可用 apiKeyEnv 指环境变量
    "model": "s2.1-pro-free",
    "voiceId": "",              // 角色包里有就优先用角色包的
    "timeoutMs": 30000,
    "keepFiles": 20,
    "proxy": "",                // 例如 http://127.0.0.1:7897；留空直连
    "dictionary": {}            // 写法 → Fish 音素，如 { "七草にちか": "na1na0kU0sa1nichi1ka0" }
  },
  "socialV2": {
    "proactive": {
      "enabled": true,
      "group": true,            // 群里允许主动冒泡
      "private": false,         // 私聊默认不主动
      "nightFrom": "23:30",     // 夜间禁止窗口
      "nightTo": "07:00",
      "maxPerDay": 4,
      "windowDays": 7           // 超过 7 天没互动就不主动搭话
    }
  }
}
```

角色包格式（`roles/<角色名>.pack.json`）：

```json
{
  "role": "角色显示名",
  "roleFile": "roles/角色显示名.md",
  "voiceId": "<Fish 音色 ID>",
  "aliases": ["名字", "别名", "假名"],
  "dictionary": { "写法": "音素" },
  "worldName": "world.json 里对应的角色名"
}
```

切换角色（控制台下拉或 `POST /api/role`）时，音色、注音字典、唤醒别名、世界观一起换。
`worldName` 对应的角色必须在 `world.json` 的 `idols` 或 `office.staff` 里，否则不注入世界观。

## 目录结构（只列定制相关）

```
src/bridge.js            # 主进程（大部分功能都在这里）
src/quiet-hours.mjs      # 静默时段状态机 + 节假日
src/tts-fish.mjs         # Fish Audio 合成（含 CONNECT 代理隧道、注音字典、时长预判）
src/world-prompt.mjs     # 世界观前缀生成（偶像分支 / staff 分支）
src/mcp-snowluma-safe.js # MCP 工具（含 qq_tts_say）
public/console.html      # 控制台（单文件）
scripts/dsh-endpoint.mjs # DSH 端口发现（start.bat 每次拉起前跑一遍）
roles/README.md          # 角色卡格式说明（角色卡本身不进仓库）
CHANGES.md               # 相对上游的逐项改动
docs/QUIET-HOURS.md      # 静默时段设计与验证记录
docs/TTS-VOICE-TODO.md   # 语音功能的实施记录
docs/LONG-MEMORY-TODO.md # 长期记忆的设计与撤销原因
docs/UPSTREAM-README.md  # 上游完整 README（原文保留）
```

## 与上游的差异

逐项说明见 **[CHANGES.md](CHANGES.md)**，包括每项改动的动机与已知取舍。

## 这个仓库不包含什么

以下内容在 `.gitignore` 里，**永远不会**出现在本仓库：

- `config.json` 及所有备份 —— 含你的 QQ 号、群号、API Key
- `state/`（会话、日志、令牌）、`audio/`（语音文件）
- `world.json` —— 第三方世界观数据，自己放一份到项目根目录
- `roles/*.pack.json`、`roles/.refs/`、`roles/.backup/` —— 角色包与角色资料
- `SnowLuma-*/` —— 网关二进制
- 本机一键启动器 —— 含本机 QQ / DSH / SnowLuma 安装路径

仓库里没有任何真实 QQ 号、群号、音色 ID 或 API Key。

## 安全提醒

- `allowAllWhenEmpty: true` 等于把账号交给模型：白名单留空 + 该开关为 true 时，**任何人**的消息都会进 agent。建议始终先填白名单。
- 语音发送只允许「语音库目录内」的文件（`socialV2.voice.dir`），AI 传绝对路径也会被限制，防止被注入后拿任意本地文件当语音外发。
- 控制台令牌在 `state/console-token`，不要提交、不要贴给别人。

## 致谢

- [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的作者 —— 没有这个桥接就没有本项目
- [Sallyn0225/eidolon-sc](https://github.com/Sallyn0225/eidolon-sc) 的作者 —— 角色卡、世界观、注音词典、主动搭话的设计都参考自它
- SnowLuma 与 DeepSeek Harness 的维护者

## 许可

MIT，与上游一致。上游版权声明保留在 [LICENSE](LICENSE)。
