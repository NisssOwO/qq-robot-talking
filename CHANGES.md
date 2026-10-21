# 定制说明（相对上游 qq-bridge v0.2.0-r4）

本仓库是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的定制版，基线 `v0.2.0-r4`（MIT）。
第一个 commit 是**上游原样代码**，第二个 commit 是全部定制改动 —— 用 `git diff HEAD~1` 可以精确看到我改了什么、为什么改。

下面按功能列出改动。所有开关都在 `config.json` + 控制台（`http://127.0.0.1:3100`）里，不需要改代码。

## 1. 静默时段（`src/quiet-hours.mjs` + `config.quietHours`）

工作日固定时段机器人完全静默（默认 09:00–12:00、14:00–18:00，UTC+8）：

- 节假日按中国日历整天正常（调休补班日照常静默），数据来自 `timor.tech`，缓存 `state/holidays-cn.json`，拿不到就按周末规则走；
- 静默期**只有 owner（`config.ownerQQ`）@ 或引用**才会回一条，回完立刻停（`markOwnerException` 保证"回完即停"）；
- 控制台可以开「覆盖」模式（15 分钟）：任何人 @ 都回，但仍不主动冒泡；
- 判定里的 `mentioned` **只看 @/引用/私聊**，不看名字，所以加角色别名不会破坏静默。

## 2. Fish Audio 语音（`src/tts-fish.mjs` + `config.tts`）

- 一次性 `POST /v1/tts` 合成 mp3，走 SnowLuma 的 `record` 段发出去；
- **代理只作用于 TTS**：`config.tts.proxy` 留空是直连，填 `http://127.0.0.1:7897` 这类地址时在模块内手写 CONNECT 隧道，不改桥接进程的全局代理（否则会连带影响 SnowLuma 和图片下载）；
- 注音字典 `config.tts.dictionary`：`写法 → Fish 音素`，按字面子串、区分大小写匹配，用来纠正日文名字读音；
- 长度预判 `maxSeconds × 8` 字，超了直接返回 `400 too-long`，不会先合成再超时；
- 失败一律降级成纯文字（错误码 `no-key / auth / rate / timeout / network` 等）；
- 控制台「语音」卡：启用、Base URL、模型、API Key、音色 ID、代理、试听（只合成不发送）、测试连通性；
- MCP 工具 `qq_tts_say(key, token, ja, zh)`：AI 自己判断要不要发语音（被要求说句话、道晚安、很短的回应），发完再补一条「日语原文 + 中文字幕」的文字版。

## 3. 角色包（`roles/*.pack.json`）

把「角色卡 + 音色 + 注音字典 + 唤醒别名 + 世界观名字」绑成一个文件：

```json
{
  "role": "角色显示名",
  "roleFile": "roles/角色显示名.md",
  "voiceId": "<Fish 音色 ID>",
  "aliases": ["名字", "别名"],
  "dictionary": { "写法": "音素" },
  "worldName": "world.json 里的角色名"
}
```

切角色（控制台下拉 / `POST /api/role`）时，音色、字典、别名、世界观**一起换**；桥接按文件 mtime 热读，不用重启。
别名存在时不再用 QQ 昵称做名字唤醒（避免切了角色还被旧名字叫醒）。
角色卡本身不进仓库（见文末），`roles/README.md` 写了卡片格式。

## 4. 世界观注入（`src/world-prompt.mjs` + `world.json`）

从 eidolon-sc 的 `world.json` 生成一段**固定前缀**（事务所 staff、8 个组合、每位偶像的歌曲名、演出年份）：

- 用绝对日期、不拼「今天」，让前缀稳定、吃满 DeepSeek 的上下文缓存；
- 歌曲/演出按人物过滤（不是偶像的事务员会走 `staffSection`，明确写"你不是偶像"）；
- 切角色时重置引导唤醒，下一条消息自动带上新角色的卡 + 世界观；
- `world.json` 是第三方数据，**不进仓库**，自己放一份到项目根目录即可（没有就不注入）。

## 5. 主动搭话增强（`config.socialV2.proactive`）

在上游「空闲 + 概率」的基础上补了 eidolon 式的约束：

- `group` / `private` 分别开关（私聊默认关）；
- 夜间禁止 `nightFrom`/`nightTo`（默认 23:30–07:00），命中就排到窗口结束后的随机时间；
- 每天上限 `maxPerDay`、活跃窗口 `windowDays`（超过 N 天没互动就不主动搭话）；
- 「每次接触只搭一次」：上次搭话晚于最后一次对方消息就跳过；
- **只有真的发出消息才计数**（先记 `proactiveWakePendingAt`，`recordSentMessagesV2` 里才落 `proactiveSentAt`），AI 沉默不会白耗额度；
- 提示词按私聊/群分别写：先接最近聊过的事，其次搜热点，再其次自己日常；不要空问候（早安/在吗/想你了）、别重复开头、不发照片不提打电话、没话就收尾。

## 6. DSH 模型跟随（`src/bridge.js` 的 `readDshDefaultModel`）

上游把 `provider/model` 写死在 `config.json` 里，而 DSH 侧的 `sessions.selectModel` 名义成功、实际推理仍走 DSH 全局默认（`state/token-usage.jsonl` 里能看到真实归属）。

现在默认 `dsh.manageModel: false`：桥接直接读 DSH profile 的 `cordis.patch.yml` 里 `agent-default-model` 的 `provider/model/reasoningEffort` 去对齐会话，DSH 改了什么就跟随什么；控制台只读显示「设置 = 实际」。
想单独给 QQ 助手指定模型，才把 `dsh.manageModel` 设成 `true`（这时用 `dsh.provider/model/reasoningEffort` 覆盖）。

## 7. 其它

- `src/bridge.js` 的 `sanitizeRoleName` 支持平假名/片假名（上游会把「七草はづき」削成「七草」）；
- 黑话匹配：词条按 `/`、`、`、`（）` 切关键词，长度 ≥4 差一个字也算命中；匹配窗口 15 条消息；命中结果除了拼进唤醒 prompt，也会附在 `unread`/`recent`/`wait` 的返回里（AI 随手查消息时也能看到）；
- 启动：`scripts/dsh-endpoint.mjs` 在每次拉起桥接前发现 DSH 当前端口并改写 `dsh.baseUrl`（DSH 桌面端每次启动换端口）；`watch-dsh.bat` + `--watch` 可以在端口变化时自动重启桥接；
- 控制台新增几张卡：静默、语音、主动搭话（运行总览页）、角色与世界观。

## 怎么用

1. `cp config.example.json config.json`，填 `ownerQQ`、`allow.private` / `allow.groups`（至少一个，否则默认不响应任何人）；
2. 装好 SnowLuma（OneBot v11 网关）和 DeepSeek Harness，确认 `snowluma.wsUrl` / `dsh.baseUrl`；
3. `node src/bridge.js`（或 `start.bat`），控制台 `http://127.0.0.1:3100`；
4. 语音要在控制台「语音」卡里填 Fish Audio 的 API Key（或 `config.tts.apiKeyEnv` 指向的环境变量），音色 ID 用 Fish 的音色页地址里那段；
5. 角色包按 `roles/*.pack.json` 的格式自己加，角色卡按 `roles/README.md` 写。

## 不包含什么

`config.json`、`state/`、`audio/`、`world.json`、`roles/*.pack.json`、角色卡内容、`SnowLuma-v2.0.3-win-x64/`、`启动全部.bat` 都在 `.gitignore` 里，仓库里没有任何本机 QQ 号、群号、API Key 或第三方素材。
