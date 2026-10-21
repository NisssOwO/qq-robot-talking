# L3 · 长期记忆（facts）· 任务清单

> **状态：已撤销（2026-10-20 13:02）**
>
> 原因：验收发现「模型不会主动记」——@ 唤醒后它正常回复，但没有调用 `qq_remember_fact`；
> 即使在唤醒 prompt 里加了「顺手记事实」的提示，实测仍未触发。判断投入产出不划算，按用户要求整体撤回。
>
> 撤销方式：`bridge.js` / `mcp-snowluma-safe.js` / `console.html` / `config.json` 从
> `*.bak-20261020-121032` 回滚；删除 `src/long-memory.mjs`、`scripts/test-long-memory.mjs`、
> `scripts/test-facts-api.mjs`、`state/facts.json`；preset 第 18 条删除并重新生成 patch。
>
> 本文件保留作为设计记录。

---

> 原始状态：**待开工**（本文档只记录设计，代码未动）
> 目标：让七草日花记住「关于某个人的稳定事实」，跨天、跨会话可用，新事实能取代旧事实。
> 灵感来自 eidolon-sc 的 `memory.py`（`superseded_by`），但**不跑后台模型、不做向量检索**。

## 与现有「轻量记忆」的区别

| | 现有 `qq_memory_*` | 本任务（facts） |
|---|---|---|
| 内容 | 进行中的话题 / 想说未说 / 对某人的印象标签 | 关于某人或某件事的**稳定事实** |
| 生命周期 | 2~24 小时自动过期 | 长期，直到被取代或删除 |
| 作用域 | 单个会话 | 全局（跨群/私聊共享） |
| 存储 | `state/social-v2.json` 里按会话 | 独立 `state/facts.json` |
| 抽取 | 模型随手记 | 模型在回复前主动调 `remember_fact` |

两者并存，工具名分开，互不覆盖。

## 数据结构

`state/facts.json`：

```json
{
  "version": 1,
  "facts": [
    {
      "id": "f_1792456000000_ab12",
      "text": "他最近在换工作，面了两家，倾向做后端",
      "subjects": ["1000000000"],
      "tags": ["工作", "计划"],
      "scope": "group:123456789",
      "createdAt": 1792456000000,
      "updatedAt": 1792456000000,
      "supersededBy": null,
      "source": "message_id:-311615908"
    }
  ]
}
```

- `subjects`：这条事实关于谁（QQ 号优先，其次是名字）；空数组表示"关于群/事"。
- `supersededBy`：被哪条取代；非空即失效——**召回时跳过**，但保留在文件里（对齐 eidolon 的语义：删掉取代者，旧的会回来）。
- 上限：全局 2000 条、单 subject 200 条，超了按最久未更新淘汰。

## 端点（桥接）

| 端点 | 作用 |
|---|---|
| `POST /api/socialV2/facts/remember` | `{ key, token, text, subjects?, tags?, replaces? }` → 写入一条；`replaces` 指向的旧条被标记失效 |
| `POST /api/socialV2/facts/recall` | `{ key, token, query, subjects?, limit? }` → 评分后返回 top-N（默认 5） |
| `POST /api/socialV2/facts/forget` | `{ key, token, id }` → 删除一条（可选，先做） |
| `GET /api/facts` | 控制台列表/搜索（操作者通道） |
| `POST /api/facts/delete` | 控制台删除 |

鉴权与现有 `memory-append` 一致：带 `x-agent-token` 走 AI 通道（会话白名单 + 工具开关），不带则走控制台令牌。

## MCP 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `qq_remember_fact` | `key, token, text, subjects?, replaces?` | 记一条；文本要短（≤120 字），一条只记一件事 |
| `qq_recall_fact` | `key, token, query, limit?` | 查；返回 `id / 时间 / 文本`，不带绝对路径 |

工具描述里必须写明：**不确定背景时先查；不要编造；每轮最多记一条。**

## 召回怎么算分（不用向量）

1. `subject` 命中（当前说话人 QQ 在 `subjects` 里）：**+3**
2. 关键词重叠：中文按 2-gram、英文按空格切词，每命中一个 **+1**（封顶 +4）
3. 时间：30 天内 **+1**；90 天以上 **−1**
4. `supersededBy` 非空的直接跳过

取 top-N，先按分数、再按时间倒序。几百条以内是毫秒级。

## 注入策略：A 模式（已定）

**不自动注入。** 唤醒 prompt 里只加一句提示（「提到过去的事、或不确定背景时先用 `qq_recall_fact`」），事实本身不进 prompt。

代价与收益：

- 每轮**零额外 token**（只有那句提示，约 30 字）；
- 但模型可能想不起来查——靠三处缓解：
  1. preset 里明确触发条件（「上次 / 之前 / 我说过 / 还记得」）；
  2. 工具描述写清用途；
  3. `qq_get_prompt` 返回「长期记忆：共 N 条，最近写入 X」的概况，给它一个"有东西可查"的线索。

配置项 `longMemory.injectTop` 默认 **0**（= A 模式）。以后想切 B 模式，把它改成 3 即可，不用改代码。

## 提示词（preset 新增一节）

- **什么时候记**：对方说了关于自己的稳定事实（职业、住处、喜好、习惯、计划、重要经历）、群里的长期约定或梗。
- **不要记**：闲聊、情绪、临时状态、一次性的玩笑、已经记过的事。
- **每轮最多记一条**；如果知道旧的那条，用 `replaces` 取代它。
- **什么时候查**：对方说「上次/之前/我说过」、或你要提到旧事但不确定细节时。
- **绝不编造**：查不到就说忘了，符合人设（「えー、そんなの覚えてないですけどー」）。

## 控制台

「长期记忆」卡（放在「语音」卡下面）：

- 列表：时间 / 关于谁 / 内容（截断）/ 状态（有效 / 已被取代）
- 搜索框 + 删除按钮
- 开关：启用/停用长期记忆（停用后工具不注册、不注入）
- 统计：总条数、有效条数、最近写入时间

## 任务清单

### 阶段 0 · 准备
- [x] 备份 `src/bridge.js`、`src/mcp-snowluma-safe.js`、`public/console.html`、`config.json` → `*.bak-20261020-121032`

### 阶段 1 · 数据层
- [x] 新增 `src/long-memory.mjs`：读写 JSON、原子落盘、上限淘汰、`remember / recall / forget`
- [x] supersede 语义：被取代的保留、召回跳过、删除取代者后旧条恢复
- [x] 去重：同 subject + 文本相似（字符重叠 > 0.6）不重复写，改为更新时间
- [x] 单元测试 `scripts/test-long-memory.mjs` —— **13 项全绿**

### 阶段 2 · 桥接接口
- [x] `config.json` 增加 `longMemory` 段（`enabled` / `maxFacts` / `maxPerSubject` / `injectTop`）
- [x] `loadConfig()` 补默认值
- [x] 五个端点（remember / recall / forget / 控制台列表 / 控制台删除）
- [x] 鉴权：agent token + 会话白名单 + 工具开关 `facts`
- [x] 接口自测 `scripts/test-facts-api.mjs` —— **7 项全绿**

### 阶段 3 · MCP 工具
- [x] `qq_remember_fact`、`qq_recall_fact`（`qq_forget_fact` 暂不做，靠控制台删）
- [x] 工具描述写清「每轮最多一条、不要编造、不确定先查」
- [ ] **重启 DSH 后才会注册**（与阶段 4 一起）

### 阶段 4 · 提示词与工具说明
- [x] preset 新增第 18 条「长期记忆（facts）」：什么时候记、什么时候查、不许编造
- [x] `qq_get_prompt` 增加 `longMemory` 概况（条数 / 最近写入 / 用法提示）
- [x] 重新生成 preset patch
- [ ] **需重启 DSH** 生效

### 阶段 5 · 控制台
- [x] 「长期记忆」卡：列表 / 搜索 / 显示已取代 / 逐条删除 / 统计
- [x] 操作者接口：`GET /api/facts`、`POST /api/facts/delete`

### 阶段 6 · 验收
- [ ] 群里说「我最近在换工作」→ 工具日志里出现 `remember_fact`
- [ ] 隔天再问「你还记得我换工作吗」→ 工具日志里出现 `recall_fact`，且回答对得上
- [ ] 隔天说「工作定了，去了 A 公司」→ 新事实取代旧的，旧条标记为已取代
- [ ] 问「我之前说过什么」→ 能召回；查不到时按人设装傻，不编造
- [ ] 删除取代者 → 旧事实恢复可召回
- [ ] 停用开关 → 工具不注册、`qq_get_prompt` 不再显示概况
- [ ] token 对比：改造前后每轮输入 token（用 `/api/tokens/summary`），A 模式应几乎无变化

### 阶段 7 · 文档
- [ ] `docs/LONG-MEMORY.md`：结构、接口、评分规则、上限、回滚

## 风险

| 风险 | 处理 |
|---|---|
| 模型忘记记 → 记忆稀疏 | 提示词明确触发条件 + 唤醒时注入最近 3 条提醒 |
| 模型记垃圾 / 每轮都记 | 每轮最多一条 + 相似去重 + 控制台可删 |
| 关键词召回不到（指代/同义） | 靠 DSH 会话历史兜底；prompt 写明「查不到就说忘了」 |
| 存储膨胀 | 全局 2000 条 / 单 subject 200 条上限，按最久未更新淘汰 |
| 隐私 | 只存文本；密钥形态走现有 `redactKnownTokensOnly`；控制台可逐条删 |

## 估时

- 数据层 + 测试：2 小时
- 接口 + 工具：3 小时
- 注入 + preset：1.5 小时
- 控制台：1.5 小时
- 验收 + 文档：1.5 小时

约一天（含联调），比 TTS 略轻——没有外部服务依赖。
