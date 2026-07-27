# Mist Table · AI 决策质量改造设计文档

- 版本：v1.0（评审稿）
- 日期：2026-07-26
- 基于代码：`app/lib/poker.ts`、`app/api/ai/decision/route.ts`、`app/api/ai/status/route.ts`、`app/components/PokerTrainer.tsx`（2026-07-26 快照，文中行号以此为准）
- 已确认的三个方向：**先出文档评审**；护栏对离谱动作**带原因重问一次**；人格**疯但有底线**
- 文中所有权益数字均由蒙特卡洛模拟实算（1.2万–4万次/项，标注 ≈），非估计

---

## 0. 一句话结论

当前问题不是 DeepSeek 太蠢，而是：提示词教它演疯子、程序只查合法性不查合理性、失败时静默换人还不留痕。改造方案是把决策管线改成 **"模型提案 → 引擎审计 → 不合格带原因重问一次 → 仍不合格才替换，全程记录来源"**，人格从"行为指令"降级为"合理动作集合内的频率偏好"。

## 1. 问题与根因（简要回顾）

以 H#0004 为例的四类故障，对应四个改造点：

| 故障现象 | 根因位置 | 改造点 |
|---|---|---|
| BB 的 A8o 冷跟 3-bet、再跟 4-bet、翻牌跟 144BB 全下（需 38.7% 权益，实测 ≈22.3%） | 提示词无数学底线；`route.ts:64` 只要求"选一个合法动作" | §5 策略护栏 + §6 提示词重写 |
| 火山 A5s 翻牌超池全下 451.5BB（有效 144，1.7 倍池，被跟时 ≈28.7% 权益） | `poker.ts:271` 人格提示词"overbet frequently, manufacture action" | §6 人格重写 + §5.2 全下规则 |
| 合法但愚蠢的动作全部放行 | `route.ts:22` `sanitizeDecision` 只查合法性 | §5.5 裁决流程 |
| API 失败静默回退本地引擎，无从考证每个动作谁做的 | `PokerTrainer.tsx:358` 静默 catch；状态栏恒显"已连接" | §7 来源记录与状态诚实 |

## 2. 设计原则

1. **数学是硬底线，人格是软偏好。** 护栏只做单向裁剪：砍掉"明显烧钱"的激进与跟注，从不强迫弃牌或禁止 check/fold。所以它防蠢不防怂——火山依然狂，只是不再自杀。
2. **不信任模型的自报数字。** DeepSeek 返回的 `estimatedEquity` 只做观察记录，裁决一律用引擎自己的蒙特卡洛结果。
3. **翻前用范围表，翻后用权益地板。** 这不是随意分工——实测发现 A8o 对 4-bet 范围的原始权益（≈31.4%）竟然高于跟注价格（28.4%），但这手牌被支配严重、位置差、实现率极低，纯权益地板拦不住它。翻前必须查范围表；翻后权益对比才够准。
4. **一切可追溯。** 每个 AI 动作记录来源（DeepSeek 一次过 / 重问后过 / 被护栏替换 / 本地回退），写进牌谱行，UI 如实显示。
5. **确定性可复现。** 护栏的蒙特卡洛用现成的 `seededRandom(stateSeed(state))`（`poker.ts:730`），同一局面重算结果一致，便于排查。

## 3. 决策管线总体架构

```
                      ┌─ 客户端 PokerTrainer.tsx ─────────────────────────┐
  轮到 AI 行动 ──────► botObservation(state, player)                       │
                      │        │                                          │
                      │        ▼                                          │
                      │  POST /api/ai/decision ──── 失败/超时 ──► 本地引擎  │
                      │        │                    localBotDecision      │
                      │        │                          │               │
                      │        │                    checkDecision 钳制    │
                      │        │                    source=local-fallback │
                      └────────┼──────────────────────────┼───────────────┘
                               ▼                          │
              ┌─ 服务端 route.ts ─────────────────────┐    │
              │ 1. 组装系统提示词（质量底线+人格）      │    │
              │ 2. DeepSeek 调用（结构化 JSON 输出）   │    │
              │ 3. 合法性校验 sanitizeDecision        │    │
              │ 4. 策略审计 checkDecision(obs, 决策)  │    │
              │      │通过                 │否决      │    │
              │      ▼                    ▼          │    │
              │  source=ds        带违规原因重问一次   │    │
              │                        │通过 │仍否决  │    │
              │                        ▼     ▼       │    │
              │             source=ds-retry  用引擎   │    │
              │                          建议动作替换  │    │
              │                       source=override │    │
              └───────────────────────────────────────┘    │
                               │                          │
                               ▼                          ▼
                    applyAction + 记录 {source, rule, 数字} 进牌谱与 UI
```

核心新增模块是 **`app/lib/strategy.ts`**（纯函数，无 IO），同一套 `checkDecision` / `suggestSafeAction` 同时供服务端（审计 DeepSeek）和客户端（钳制本地引擎）使用——本地引擎在 H#0003 里让老陈的 A7 连跟超池，说明它同样需要这层底线。

## 4. 新决策协议

### 4.1 DeepSeek 请求变更（route.ts）

- `max_tokens`: 160 → **420**（要装下结构化推理字段）
- `temperature`: 0.35 → **0.45**（风格方差交给温度，错误交给护栏兜底；重问那一次降回 0.2 求服从）
- `thinking` 保持关闭（延迟优先）；留一个 `AI_THINKING=1` 环境变量作对照实验开关
- user 消息在现有 observation 基础上追加 `handClassHint`（如 `"A8o"`，省得模型自己拼错）；`potOddsToCall` 字段已有（`poker.ts:1255`），提示词里明确它就是"所需权益"

### 4.2 模型必须返回的 JSON

```json
{
  "handClass": "A8o",
  "planType": "value | semi-bluff | bluff | bluff-catch | pot-control | give-up",
  "estimatedEquity": 0.31,
  "action": "call",
  "raiseTo": 24,
  "reason": "不超过140字符的一句话理由"
}
```

校验规则：`action` 必须 ∈ `legalActions`（沿用现有逻辑）；`raiseTo` 仅 raise 时必需并做边界钳制；其余字段缺失**不否决**（记 `schema-partial`，动作合法即可用），避免格式问题引发不必要的回退。

### 4.3 /api/ai/decision 新响应

```json
{
  "action": "fold",
  "raiseTo": null,
  "source": "ds | ds-retry | override",
  "model": { "handClass": "A8o", "planType": "bluff-catch", "estimatedEquity": 0.4, "reason": "..." },
  "guardrail": {
    "requiredEquity": 0.387,
    "engineEquity": 0.223,
    "assumedRange": "4bet+jam: QQ+, AK, A5s-A4s",
    "verdict": "pass | pass-after-retry | overridden",
    "vetoRule": "POST-CALL-ALLIN",
    "detail": "跟注 144 进 228.5 需 38.7% 权益；A 高无听牌约 22%；对手已全下，无隐含赔率"
  }
}
```

失败时（网络/超时/两次都非法）仍返回 502，但 body 带 `failReason`，客户端回退本地引擎时把原因记进来源。

### 4.4 重问消息（第二次调用追加的对话轮）

保留原 system + 原 user，追加模型上一轮的 assistant 回复，再追加：

```json
{
  "verdict": "rejected",
  "violation": {
    "rule": "POST-CALL-ALLIN",
    "requiredEquity": 0.387,
    "engineEstimatedEquity": 0.223,
    "assumedVillainRange": "QQ+, AK, A5s-A4s (4bet then jam)",
    "note": "Calling 144 into pot 228.5 needs 38.7% equity. Ace-high with no draw has ~22% vs this range. Opponent is all-in: no implied odds."
  },
  "instruction": "Choose again from legalActions. Pick a different action, or a smaller legal size that satisfies the floor. Folding is always acceptable."
}
```

设计取舍：**不**在重问里直接给出"参考动作"，避免模型无脑照抄、失去人格间差异；只给违规的数学事实。重问仍不合格才用 `suggestSafeAction` 替换并记 `override`。

## 5. 策略护栏规则（strategy.ts 核心）

规则分两类处理：**范围/权益问题 → 否决并重问**；**纯尺寸问题 → 静默钳制到边界**（不浪费一次重问）。fold 和 check 永远不被否决。

### 5.1 翻前：手牌分层 + 对抗矩阵

169 种起手牌分为七层（完整列表写在 strategy.ts 里，这里给定义）：

| 层 | 内容 |
|---|---|
| T0 | AA KK |
| T1 | QQ AKs AKo |
| T2 | JJ TT AQs AQo AJs KQs |
| T3 | 99 88 77 ATs A5s A4s KJs QJs JTs T9s AJo KQo |
| T4 | 66-22、A9s-A6s A3s A2s、KTs K9s QTs Q9s J9s、98s 87s 76s 65s 54s、ATo KJo QJo JTo |
| T5 | J8s T8s 97s 86s 75s 64s K8s Q8s、A9o-A5o、KTo QTo T9o 98o |
| T6 | 其余（垃圾） |

面对加注时允许继续的层级（`raiseCountThisStreet` 已有现成计算，`poker.ts:1144`）：

| 面对 | 已自愿入池 / BB 防守 | 冷跟 | 再加注（价值） | 再加注（诈唬，需 persona.bluff ≥ 0.6） |
|---|---|---|---|---|
| open（第 1 加注） | ≤T4；looseness≥0.75 放宽到 ≤T5；价格>0.30 收紧一层 | ≤T3 | ≤T2 | T3 中的同花牌 + KQo |
| 3-bet（第 2 加注） | ≤T2；价格≤0.30 时加 T3 的对子和同花牌 | T0+T1+{JJ TT AQs} | ≤T1 | {A5s A4s KQs}，需 bluff≥0.7 |
| 4-bet（第 3 加注） | T0+T1 可跟；T0+{AK} 可全下 | T0+{AKs} | T0+{AK}（通常直接全下） | {A5s A4s} 全下，需 bluff≥0.8 且有效筹码 ≤120BB |
| 5-bet+（≥第 4 加注） | T0+{AKs} | T0 | T0 | 无 |

规则 ID：`PF-RANGE-VS-OPEN` / `PF-RANGE-VS-3BET` / `PF-COLD-VS-3BET` / `PF-RANGE-VS-4BET` / `PF-RANGE-VS-5BET`。

两个实测校验：BB 拿 A8o（T5）防守单次 open——老陈 looseness 0.82 → 允许，粘性人格保留；同一张 A8o 冷防 3-bet（需 ≤T1+{JJ TT AQs}）→ 否决。**H#0004 的第一错在这一行就被拦下。** 另外矩阵对 4-bet 诈唬全下留了 {A5s A4s} 的口子，所以火山那手 A5s 4-bet 本身会被放行——它错的不是翻前，是翻牌的 5.3 倍池全下（见 5.2）。

尺寸钳制 `PF-RAISE-SIZE`（钳不否决）：open 2.2–4BB（每个 limper +1BB）；3-bet 为 open 的 2.5–4.5 倍（OOP 取高）；4-bet 为 3-bet 的 2.2–2.8 倍；5-bet 基本即全下。

短码调整：有效筹码 ≤60BB 时，冷跟列整体收紧一层，优先 jam-or-fold（短码哥的人格提示词同步强调）。

### 5.2 翻后：权益地板 + 激进合理性

所需权益直接用现成的 `observation.potOddsToCall`；注意一切按**有效额**计算：有效跟注 = min(toCall, 自己筹码)，有效下注压力 = 对手实际能被跟的部分（H#0004 火山名义 451.5BB、有效 144BB 的教训）。

**跟注（POST-CALL-EQUITY / POST-CALL-ALLIN）**，允许当：

```
engineEquity ≥ requiredEquity − tol(persona) − drawAllowance
drawAllowance = 0.05  当 outs≥8 且 对手未全下 且 SPR≥2.5（隐含赔率）
              = 0     当对手已全下 ← H#0003 老陈 A7 连跟超池全下的直接修正
```

**下注/加注**，满足其一即放行：

- 价值（`POST-RAISE-VALUE`）：engineEquity ≥ 0.55（尺寸 ≤1 倍池）或 ≥ 0.60（超池 ≤1.5 倍池）
- 半诈唬（`POST-RAISE-SEMIBLUFF`）：outs ≥ 8 → 尺寸上限 1.25 倍池；outs 4–7 → 上限 0.9 倍池
- 纯诈唬（`POST-RAISE-BLUFF`）：outs < 4 时需持关键阻断牌（坚果同花 A 阻断、顺子阻断等）且尺寸 ≤0.66 倍池、persona.bluff ≥ 0.7、能弃牌的对手 ≤ 2 人
- 全下/巨注（`POST-JAM-EQUITY`，有效尺寸 > 1.25 倍池）：engineEquity ≥ 0.60，或 SPR ≤ 1.2 且 ≥ 0.45，或 outs ≥ 12

用 H#0004 验证：火山 A5s 在 3sTd2s 上 outs ≈ 7（4 张顺子 + 3 张 A，且 A 出牌对 AK 无效，算保守值），SPR≈5.3，被跟范围下权益 ≈28.7% → 全下三条件全不满足 → 否决重问；重问后它仍可选 0.75 倍池半诈唬下注（outs 4–7 允许 ≤0.9 倍池）——**火山的凶保留了，自杀被剪掉**。

### 5.3 权益估算器

对每个未弃牌对手，按其本手最强的自愿动作给范围收紧系数（按 `preflopStrength()` 对 1326 组合排序取前 N%，函数现成，`poker.ts:1094`）：

| 对手最强动作 | 取前 |
|---|---|
| 发起 4-bet+ | 6% |
| 发起 3-bet | 12% |
| open | 30%（晚位 40%） |
| 跟注加注 | 45% |
| limp / 盲注被动 | 70% / 100% |
| 本街再有大注（≥0.75 池）或加注/全下 | 在上值基础上 ×0.55 |

蒙特卡洛 1500–2500 次（多人时用逐人取样近似），种子用 `seededRandom(stateSeed(state))` 保证可复现。纯 JS 实测同类计算 <15ms，相对 1–3s 的 API 延迟可忽略。outs 估算器给保守值（同花听 9、两头顺 8、卡顺 4、高张每张 3，板面成对/三同花时打折）。

### 5.4 人格容差表（"疯但有底线"的量化）

| 人格 | 跟注容差 tol | 诈唬门槛 | 超池许可 | 备注 |
|---|---|---|---|---|
| 均衡派 / 猎手 / 岩石 | 0.01 | 标准 | ≤1 倍池 | 几乎无风格折扣 |
| 短码哥 | 0.02 | 标准 | jam 规则主导 | SPR 低时天然易过 jam 条件 |
| 老板 | 0.03 | bluff 0.76 → 全部诈唬类可用 | ≤1.5 倍池（需满足 5.2） |
| 火山 | 0.04 | bluff 0.90 → 全部可用 | ≤1.5 倍池（需满足 5.2） | 频率最高，底线相同 |
| 老陈 | **0.06** | raise 仅价值 | — | 粘性最大化但拒绝明显烧钱 |

容差的含义：老陈可以跟一个差 6% 权益以内的"小亏但符合人设"的注，但 H#0004 翻牌那种差 16% 的跟注（22.3% vs 38.7%）任何容差都救不了。

### 5.5 裁决流程与替换动作

```
checkDecision(obs, persona, decision) →
  { ok: true }
  | { ok: false, rule, detail, numbers }   // 范围/权益类 → 重问
  | { ok: true, clampedRaiseTo }           // 尺寸类 → 静默钳制
```

`suggestSafeAction(obs, persona)`（重问仍失败时的替换）：无人下注 → 满足价值条件则 0.66 倍池下注，否则 check；面对下注 → 过权益地板则 call，否则 fold。刻意保守：override 是最后兜底，出现率本身就是需要调参的告警信号（见 §11）。

## 6. 提示词重写

### 6.1 新系统提示词（route.ts，全人格共享）

```text
You are one seat in an 8-max no-limit Texas Hold'em cash game. Blinds 1/2 chips, BB = 2.
You receive ONLY your own hole cards and public information. Never assume hidden cards.

DECISION QUALITY FLOOR — applies to every persona, non-negotiable:
1. Compare equity with price. potOddsToCall is the equity you need to call. Estimate your
   equity vs the ranges implied by opponents' actions. There are NO implied odds vs an all-in.
2. Facing preflop 3-bets/4-bets/5-bets, continue only with holdings a competent player could
   defend at that depth. Dominated offsuit hands (A8o, KTo, ...) never cold-call a 3-bet+.
3. Aggression needs a purpose: value bets expect worse hands to call; bluffs need credible
   fold equity plus draws or key blockers. Never jam more than 1.25x pot with neither.
4. Sizing: preflop opens 2.2-4BB (+1BB per limper); 3-bets 2.5-4.5x the open; 4-bets
   2.2-2.8x the 3-bet. Postflop bets 0.33-1.5x pot unless low SPR justifies a jam.
5. Your PERSONA controls only which defensible action you pick and how often - looseness,
   sizing taste, bluff frequency. It never overrides math.
A strategy engine audits your decision. If rejected you get the reason and choose again.

OUTPUT: one JSON object only, no prose:
{"handClass":"A8o","planType":"value|semi-bluff|bluff|bluff-catch|pot-control|give-up",
 "estimatedEquity":0.31,"action":"<one of legalActions>","raiseTo":<number if raise>,
 "reason":"<=140 chars"}

PERSONA: <persona.prompt>
```

### 6.2 七个人格新旧对照（poker.ts:162-274）

**均衡派 gto**（原：balanced strategy...，基本保留）
```text
Balanced, disciplined cash-game regular. Mix sizes, protect checking ranges, avoid
result-oriented decisions. Zero style tolerance: always the highest-EV defensible action.
```

**老板 boss**（原文问题："punish weakness, apply oversized pressure" → 无条件施压）
```text
Loose-aggressive table captain. Play many pots (top ~45% preflop, wider in position),
isolate weak limpers, and take the aggressive option when EV is close. Prefer big sizings
(0.75-1.25x pot, occasional 1.5x overbet) WHEN you hold equity, blockers, or a range
advantage. Your pressure targets capped ranges and likely folds - never a wall of made
hands. The quality floor always wins over machismo.
```

**猎手 tag**（原文基本健康，微调）
```text
Tight-aggressive positional player. Strong entries in position, value-heavy isolation,
credible pressure. Without initiative or equity, give up quickly and fold with discipline.
```

**老陈 station**（原文问题："dislike folding pairs and draws" → 无条件粘）
```text
Sticky loose-passive recreational caller. Preflop: play lots of suited, connected and
paired hands when the price is fair, but never cold-call 3-bets+ with dominated hands.
Postflop: you hate folding any pair or draw when the price is within a few percent of
break-even, and you raise only obvious value (two pair or better). You are sticky, not
suicidal: when a huge bet or all-in prices out your hand with no draw, you fold.
```

**短码哥 short**（原文健康，补充承诺阈值）
```text
Compact 50BB strategy: raise-or-fold preflop, no marginal cold calls, well-timed jams
vs 3-bets with strong pairs and AK. Postflop, commit with top pair or better when SPR <= 2;
avoid bloating pots with marginal hands out of position.
```

**岩石 rock**（原文健康，保留）
```text
Very tight, value-heavy nit. Fold marginal holdings, choose low-variance lines, bluff
rarely and only with excellent blockers. Patience is your edge.
```

**火山 maniac**（原文问题："overbet frequently, manufacture action" → 教唆乱打）
```text
Hyper-aggressive maniac WITH a calculator. Highest bluff frequency at the table: attack
capped ranges, squeeze light, barrel scare cards, prefer big sizings (0.75-1.5x pot;
overbet when the board favors your range or you hold key blockers). What keeps you
dangerous instead of dead money: bluffs always carry blockers, draws, or clear fold
equity; jams beyond 1.25x pot need a real hand, a 12+ out draw, or SPR <= 1.2; and you
never call off with hopeless equity. Your chaos lives in aggression, never in calls.
```

## 7. 决策来源记录与状态诚实

### 7.1 来源类型

```ts
type ActionSource =
  | "ds"             // DeepSeek 一次通过
  | "ds-retry"       // 重问后通过
  | "override"       // 两次都不合格，护栏替换（带 rule）
  | "local-fallback" // API 失败/超时回退本地引擎（带 failReason）
  | "local-engine";  // 未配置 API，本地引擎（护栏钳制后）
```

客户端在每次 AI 动作落地时记录 `{handNo, actionIndex, playerId, source, rule?, failReason?}`（`useRef` 存 map，跟着 `applyAction` 走）。

### 7.2 牌谱行追加来源段

`compactHandLog` 增加可选参数，牌局结束时在行尾追加，例如：

```
... | Hero +0BB | Src DS:9 RT:1 OV:1(F LJ allin→bet 56, POST-JAM-EQUITY) LF:0
```

复盘时一眼看出：哪些怪动作是模型真实决策（该调提示词/护栏），哪些是回退或替换（该查网络/规则）。这直接回答了"BB 每个动作究竟来自谁无法证明"的问题。

### 7.3 UI 状态如实显示

- 状态芯片三态：绿"DeepSeek 已连接" / 琥珀"DeepSeek 波动 · 本手回退 N 次"（任一动作 fallback 即转琥珀，下次成功恢复绿）/ 灰"本地人格引擎"。替换现在恒绿的假象（`PokerTrainer.tsx:476-485`）。
- AI 设置弹窗 footer 加最近 100 个动作的来源统计：`DS 92 · 重问 5 · 替换 2 · 回退 1`。
- 模型的 `reason` 字段**不在牌局进行中显示**（会泄露对手意图，破坏训练），只随牌谱在结束后可见。

## 8. 本地引擎同套护栏

`localBotDecision`（`poker.ts:1153`）出口统一走 `checkDecision`，否决则直接用 `suggestSafeAction`（本地引擎不存在"重问"）。它翻前已有 raiseDepth≥3 的门（`poker.ts:1172`），主要补翻后：老陈式"任意对子跟超池全下"（H#0003）会被 `POST-CALL-ALLIN` 的无隐含赔率规则拦下。本地引擎的人格数值（looseness 等）不动。

## 9. 改动文件清单

| 文件 | 改动 | 预估规模 |
|---|---|---|
| `app/lib/strategy.ts`（新） | 分层表与对抗矩阵、outs 估算、对手范围建模、MC 权益、`checkDecision`、`suggestSafeAction`、规则 ID 常量 | ~420 行 |
| `app/api/ai/decision/route.ts` | 新系统提示词、结构化输出解析、护栏审计、带原因重问一次、新响应结构 | ~130 行改 |
| `app/lib/poker.ts` | 7 个人格 prompt 替换；`localBotDecision` 出口接护栏；`compactHandLog` 来源后缀参数 | ~90 行改 |
| `app/components/PokerTrainer.tsx` | 来源追踪 ref、apiHealth 三态、芯片/弹窗统计、日志后缀传入、失败原因记录 | ~110 行改 |
| `app/api/ai/status/route.ts` | 不变 | 0 |
| `scripts/strategy-check.ts`（新，可选） | §10 回归用例跑批（tsx 直跑，不引入测试框架） | ~150 行 |

无新依赖、无 schema 变更；`/api/hands` 存的 markdown 自然带上来源段，无需迁移。

## 10. 回归用例（全部取自实录，数字已实测）

| # | 场景 | 触发规则 | 期望结果 |
|---|---|---|---|
| 1 | H#0004 翻前：BB 老陈 A8o（T5）冷防 BTN 3-bet。需 38.6%，对 3-bet 范围实测 ≈30.7% | PF-COLD-VS-3BET | 否决 → 重问 → fold |
| 2 | H#0004 翻前：BB A8o 跟 4-bet。原始权益 ≈31.4% **高于**价格 28.4%，但范围表禁止 | PF-RANGE-VS-4BET | 否决（证明翻前不能只看权益地板） |
| 3 | H#0004 翻前：LJ 火山 A5s 4-bet（bluff 0.90 ≥ 0.8，有效 99.5BB ≤ 120） | 4-bet 诈唬白名单 | **放行**（风格保留） |
| 4 | H#0004 翻牌：LJ A5s 全下，有效 1.7 倍池，outs≈7，SPR≈5.3，被跟权益 ≈28.7% | POST-JAM-EQUITY | 否决 → 重问 → 允许 ≤0.9 倍池半诈唬下注 |
| 5 | H#0004 翻牌：BB Ac8s 跟 144 全下。需 38.7%，对全下范围实测 ≈22.3%，无隐含赔率，容差 0.06 不够 | POST-CALL-ALLIN | 否决 → fold |
| 6 | 任意深度 AA 5-bet 全下 | — | 永远放行（价值不设上限） |
| 7 | 火山 BTN 76s open 2.5BB（T4，vs 无人加注） | — | 放行（风格保留） |
| 8 | 老陈 BB A8o 防守单次 open（looseness 0.82 → ≤T5） | — | 放行（粘性保留） |
| 9 | H#0003 型：老陈中对面对超池全下，权益差 >6% | POST-CALL-ALLIN | 否决 → fold |

补一个复盘教育点：Ac8s 对 Ad5d 在 3sTd2s 上实际有 **64%** 权益、这手也确实赢了摊牌前的对抗——但对 4-bet 全下**范围**只有 22.3%。牌谱来源段 + guardrail 数字留档，能把"结果好"与"决策好"分开看，这正是训练器的目的。

## 11. 风险与调参

- **范围近似误差**：percentile 建模只是近似，靠容差边距吸收；`guardrail.detail` 记录全部数字，偏差可回溯调整。
- **override 率是健康指标**：目标 <8%/人格。>15% 说明提示词与护栏打架（提示词该再收敛，或矩阵过紧），而不是继续提高拦截强度。
- **延迟**：MC <15ms 可忽略；最坏路径多一次 API 调用。route 设 9s 总预算，超时回退本地并如实标记。
- **模型自报数字不可信**：`estimatedEquity` 仅记录，用来观察模型推理质量（长期可统计"模型自估 vs 引擎实测"的偏差曲线）。
- **flash vs pro**：flash 便宜快但更依赖护栏，pro 相反；来源统计天然是两个模型的对比工具。
- **护栏不防怂**：设计上单向裁剪，AI 只会变紧不会变松。若日后发现全桌过紧，调的是提示词频率，不是开护栏口子。

## 12. 分期实施建议

- **P1（核心质量闭环）**：`strategy.ts` + 系统/人格提示词 + route 审计与重问。做完这步，H#0003/H#0004 型怪牌即消失。
- **P2（可追溯）**：本地引擎钳制、来源记录、牌谱后缀、UI 三态与统计。
- **P3（回归与调参）**：`strategy-check.ts` 跑 §10 用例，实战观察 override 率一周再微调矩阵。

三期可以一次做完（合计约一个工作日的改动量），也可以 P1 先行验证效果。文档确认后我按此实施。



---

## 13. V2 变更记录（2026-07-27）：护栏松绑 + Hero 画像

V1 上线后实测发现严重回归：全桌 VPIP 从 39.4% 被压到 19.2%，跟注站 77%→29%，火山 61%→30%。
§5.1 的翻前范围矩阵把七个人格压成了同一个紧手，而这个训练桌的价值恰恰在于对手风格各异。

**根因**：H#0003/H#0004 的灾难全部发生在大注点（22% 权益跟 144BB、无隐含赔率对全下），
而 §5 把范围纪律施加到了每一个翻前决策上。犯错代价完全不对等——开池 76s 错了亏 2BB，
跟错一次 all-in 亏 100BB+。护栏应当随**犯错代价**分级，而不是逐个动作查户口。

**V2 决定**：§5.1 全部作废（翻前不再有任何范围否决，只保留静默尺寸钳制）；
§5.2 只保留两条致命线——`POST-CALL-ALLIN`（跟注额 ≥25% 有效筹码 且 权益差 ≥12 个点 且
无隐含赔率补偿）与 `POST-JAM-EQUITY`（>1.5 倍池 且 权益<25% 且 outs<4 且 无人能弃牌）。
§5.4 的人格容差表随之作废（12 个点的统一硬边距取代了 1–6 个点的人格微调）。

松绑后实测：全桌 VPIP 38.8%（护栏关 39.5%，成本 0.7 个点），跟注站 77.1%、火山 59.6%、
岩石 12.1%，否决率 0.23%；H#0004 翻牌那手 A8o 跟 903 全下仍被拦（需 38.7%，实有 14.3%）。
**明确的取舍**：A8o 冷跟 3-bet 这类翻前松散动作现在会放行——它每次只亏几个 BB，
而拦掉它的代价是整桌人格消失。

**记忆系统**：只做 Hero 公开倾向画像（VPIP/PFR/3bet/各街弃牌率/面对全下弃牌率/WTSD 等，
全部来自公开动作，底牌只在摊牌亮出时可见），注入每个 AI 的系统提示词。
**不做**筹码输赢奖惩：API 模型推理时不更新参数，奖惩只能变成提示词文本；而扑克结果的标准差约
95BB/100 手，要分辨 5BB/100 的胜率差需十几万手量级，短样本喂进去只会让 AI 学出"上次诈唬输了
所以别诈唬"这类结果论迷信——正是本文档 §2 原则 2 要避免的东西。画像指向人类玩家的行为频率，
几百手即收敛，且让 AI 越打越会剥削 Hero，这才是训练器该有的"进步"。

---

## 14. 人格补码偏好与结算亮牌（2026-07-27）

**补码偏好**：`Persona.rebuy` 新增四个参数——`trigger`（低于目标筹码的多少比例就补）、`cover`
（手上不到最大对手的多少比例就补，用来表达"想压住全桌"）、`ceiling`（补完之后最深愿意坐多少，
按买入量的倍数计）、`chance`（补码意愿，用来表达不情愿的玩家）。`planRebuy()` 是纯函数，
`roll` 由外部注入以便测试；补码只在开局结算（真实赌场规则：牌局中途不得加注筹码）。

**筹码一次只按整手买**：`REBUY_RACK = 100BB`，补码额永远是 100BB 的整数倍且至少一手。
买不起最小一手（加 100BB 会超过自己的 `ceiling`）的人格就干脆不补——这条规则正好让短码哥
锁死在 50BB：他的天花板就是 50BB，一手 100BB 太深，于是他中途永不补码，只在输光后按 50BB 重新买入。
破产买入不受整手规则约束，仍按人格自己的买入量（老陈 180BB、短码哥 50BB），否则这些人设会被抹平。

结果写进 `GameState.rebuys`，牌谱里出现 `Rebuys LJ buy-in +180BB; CO top-up +100BB`。
牌桌上不做任何提示——座位名牌只有 7px 的位置标签和筹码量，插一个带底色的徽章会压过筹码本身，
试过之后撤掉了。

七种风格：均衡派低于 85% 补一手；老板 75% 就补、并补到能压住最大对手（最深 1.8 倍买入）；
猎手 80% 补一手；老陈中途从不补、只在输光后重新买入；短码哥永远只打 50BB；
岩石输掉一半才有 60% 概率补一手；火山 80% 就补且总想当最大的那堆。

1200 手实测：老板筹码 10 分位 871BB（几乎不短码），短码哥中途补码 0 次、买入 64 次，
老陈中途补码 0 次、买入 46 次，火山主动补码 31 次最高，Hero 永不被自动补码（由买入面板决定）；
所有补码均为 100BB 整数倍。

补码只托住下限：**赢来的筹码一律直接进入后手，不设任何收码/退码机制**（已确认的产品决定，
也符合真实现金局禁止 rat-hole 的规则）。代价是长局里短码哥可能靠赢牌打得很深，人设被稀释；
这是明知并接受的取舍。

**结算亮牌**：牌局结束后默认把所有座位翻开（含弃牌者），牌谱里同步写出全部底牌并对弃牌者标 `[f]`。
开关在结算面板上，状态存本机。实现上刻意**不**改写 `state.revealed`——那个字段代表真实摊牌，
是 Hero 画像 WTSD 统计的来源，污染它会让画像失真。

---

## 15. 复盘可观测性与牌面感知（2026-07-27，源自 H#0017）

H#0017 暴露了三件事，全部已修。

**牌谱看不出谁是谁**。原来只有底池赢家带人格名（`LJ:老陈`），复盘时 BTN 是哪个人格只能靠筹码量猜。
现在 `Stacks` 段给每个座位都标上人格名：`Stacks SB(hero):登邓灯 100BB; BB:Atlas 100BB; …`。

**AI 的自述理由从不落盘**。`model.reason` 一直在决策链路里收集，但只活在内存 ref 里（当前手 + 前两手），
牌谱和数据库都没有。现在新增 `Why` 段：`Why PF LJ raise 7: KQs, standard late-position open | F LJ call 35: …`，
按动作顺序排列，单条截断 72 字符、每手最多 12 条。它只在牌局结束后写入，牌局进行中依然不渲染（§7.3）。

**与牌面无关的机械阈值**。老陈的提示词写着 "raise only obvious value (two pair or better)"，
于是在 JcJsTs Qs 7c 这种成对 + 三黑桃的面上，DeepSeek 照字面把一手几乎垫底的两对推了出去。
这和当初火山那句 "overbet frequently" 是同一类毛病：**给了模型一条与牌面结构无关的绝对规则**。
修法有两层——老陈和短码哥的提示词改成按牌面判断（成对面/三同花面/四连面上的两对是抓诈唬牌，不是价值牌），
并在共享底线里加了第 6 条通用条款，明确"'两对以上'不构成投钱的理由"。
测试里加了正则守卫，防止这类措辞回流。

顺带修掉一个 V2 遗留的矛盾：共享底线第 2 条原本写着"被支配的同花外牌绝不冷跟 3-bet+"，
而 V2 已经在代码层删除了全部翻前范围否决。提示词继续管着，等于 DeepSeek 驱动时人格照样被压紧，
与 §13 的决定相悖。现已改写为按"投入筹码占比"分级，保留 H#0004 的教训（别在翻前用被支配的牌投入大量筹码），
但不再规定具体范围。

**注意**：提示词类改动无法在本地验证——本地人格引擎不读提示词，只有接上 DeepSeek 实战才看得出效果。
建议接 API 后重点观察两件事：老陈在成对/三同花面上是否还会用两对推注；以及全桌 VPIP 是否比 §13 的
38.8% 更高（底线第 2 条松绑后，DeepSeek 驱动的入池率理应向本地引擎的水平靠拢）。

---

## 16. 单位混发与牌面结构（2026-07-27，源自外部复盘意见）

一份外部复盘指出六处 DeepSeek 推理错误。逐条定性后，**只有一类是我们发错了信息**。

**是我们的错：payload 混用两套单位。** `botObservation` 的数值字段是筹码
（`stack: 301`、`pot: 221`），而同一份 payload 里的 `publicActions` / `lastAction` 是
`amountBB()` 格式化的 BB 字符串（`"bet 44BB"`）。模型把筹码数直接贴上 BB 标签，于是出现
"Hero 还有 64BB"（实际 32BB = 64 筹码）这种整齐的 2 倍误差。这会同时污染跟注门槛、SPR 判断
和下注尺寸——而且此前**模型返回的 `raiseTo` 也一直是单位不明的**，若它按 BB 回答，
`clampRaiseTo` 会静默把它压到最小加注，从外部看只是"AI 尺寸怪"，查不出原因。

修法：内部一律保持筹码（引擎、护栏、applyAction 不变），在 route 层加一道
`bigBlindView()`，把发给模型的整份 observation 换算成 BB；模型改为返回 `raiseToBB`，
服务端乘回筹码再钳制（`raiseTo` 作为遗留别名，同样按 BB 解读）。提示词开头单独用三行声明
"每一个数字都是大盲"。护栏否决理由里的金额（`chips()`）也一并改成 BB 输出——重问消息是模型
唯一会读到的护栏文本，让它成为混用单位的最后一个漏网点毫无意义。

**我们有责任但主因在模型：牌面结构靠模型自己解析。** 它把 T♥3♠6♥ 说成 `T63r`（rainbow），
把完成同花的 A♥ 只当作"吓唬封顶范围的 scare card"。花色本来就在 `communityCards` 里，
是模型没读准；但 §15 刚加的底线第 6 条（成对面/三同花面上两对只是抓诈唬牌）依赖它能正确分类牌面，
分类不准这条规则就是空转。新增 `describeBoard()`：成对/三条、花色计数、是否已成同花、听牌是否还活着、
离顺子几张，以及**最后一张牌改变了什么**，输出一行英文摘要注入 payload，并在提示词里写明
"boardTexture 是预计算的，以它为准，不要自己看牌码"。例：
`Jc Js Ts Qs | PAIRED | 3 spades — a flush is already possible | Qs brought the third spade …`

**修不了的三条，是模型自身的推理质量**：K5o 从 CO open 当作合理诈唬（松人格的入池，§13 就是
这么放开的，不是 bug）；K5o 因阻断 KK/AK/KQ 而 4-bet（阻断牌逻辑本身有缺陷）；
"BTN 平跟 4-bet 后封顶 JJ/AK"（范围推断错误）。这三条给再准确的数据也不会消失，
只能靠换更强的模型，或把范围推断从模型手里拿走交给程序——后者是解算器的活，不在当前范围内。

## 16.1 为什么保留 BB 而不是全改筹码

改完 §16 后有过一个提议：既然单位是祸根，干脆去掉 BB、全用筹码。这里记录为什么没这么做。

Bug 的成因不是"存在 BB"，而是**同一份 payload 里两种单位共存且都没标注**。只要全局单一，
用哪种都不会出这个错；所以真正要选的是"哪一种更适合各自的场景"。

**引擎必须留在整数筹码**：`showdown()` 的边池分配是 `Math.floor(sidePot / winners.length)`
再逐一补余数，改成 BB 就要引入小数，边池分钱是最不能出浮点误差的地方。

**模型必须拿 BB**：德州扑克的全部策略语料都是 BB 计价的（"open 2.5x"、"100BB deep"、SPR、
3-bet 尺寸）。给它筹码，它套用任何一条已知阈值前都得先除以盲注——反而增加算术出错面，
正是我们要消灭的东西。BB 还是跨级别不变量：将来加 2/5 的桌子，人格买入、护栏尺寸带、
所有经验数字原样可用。

**人也要看 BB**：牌谱的 `+18.5BB`、All-in EV、运气差都是标准扑克指标，换成"+37 筹码"更难复盘。

结论：内部整数筹码，对外（模型 + 牌谱 + UI）统一 BB，中间**只留一个换算点**——
`app/lib/modelView.ts`。它不依赖任何框架，因此能被 node 测试直接加载；
`tests/model-units.test.mjs` 用一份"字段分类清单"锁住它：模型视图的键集合必须与
金额/比率/透传三类的并集完全一致，任何人往里加字段而没归类，测试立刻失败
（已实测：注入一个未换算字段后测试变红）。

附带好处是这个决定可逆——若日后仍想改成纯筹码，只需把 `bigBlindView` 退化成恒等函数
并改一句提示词，其余代码一行不动。

---

## 17. 频率账本与难度档（2026-07-27，源自 21 手实测 + 外部资料）

### 实测：牌桌退化了

DeepSeek 接管后第一次量到真实分布：看到翻牌 3/21 = 14%（真实现金局 55-70%），
翻前就结束 17/21 = 81%，出现 3-bet 的牌 20/21 = 95%（真实 5-8%），4-bet 12/21 = 57%。
翻前主动投钱里 84% 是加注。**七个人格里六个的 PFR 等于 VPIP**——一旦入池必定加注，
冷跟这个动作从桌上消失了。这是没有翻牌的机械原因，而没有翻牌意味着训练价值近乎为零。

### 根因在底线第 1 条

原文 "potOddsToCall is the equity you need to call" 在翻后正确，**在翻前冷跟时是错的**：
翻前跟 3BB 买的是后面三条街的隐含赔率、位置和可玩性，不是即时权益。模型逐字应用，
于是几乎每条弃牌理由都以 "pot odds require 40%" 收尾，连 CO 的 A6s 面对单个开池都弃。
跟注被这条规则判了死刑，模型就只剩弃或加两个选项。已重写为区分翻前/翻后，
并新增一条"跟注是一等动作"明确点名该跟的牌类。

### 外部资料校准

查了公开的 LLM 扑克对战分析与玩家类型数据，两个结论直接改变了设计：

**这是 LLM 打扑克的通病**，不是我们独有的。某次多模型对战里 LLAMA 的 VPIP 62.8%
（正常 18-22%）、3-bet 18.3%（最优 6-8%），分析原话是所有模型"都打得太松太凶"，
且"没有任何分析自身范围、追求平衡策略的意愿"。**模型不会自我约束频率，必须外部给它频率账本。**

**真实玩家类型的 HUD 线**：疯子 45/35、跟注站 40/10、岩石 15/11、TAG 25/20。
原来的火山实测 95/95，确实是漫画人物；目标改为 45/35 后它仍是全桌最松，但成了真人。
关键在**差值**：跟注站的标志是 30 的差值，而我们的 AI 差值全是 0——这在真实世界里
对应不到任何一种玩家。人格文案因此改用 HUD 记号书写（"Your HUD line should read 40/10"），
这是模型训练语料里的原生词汇。

**还有一条警告**：模型拿到对手统计后会用极小样本做"狂野的剥削调整"。因此
`exploitDirectives` 的每条指令必须携带分母，分母 < 12 不得生成指令，且 HERO READ 段末尾
固定附上"样本很小，这些是倾向不是定论"。

### 落地的三件东西

**频率账本**（`app/lib/tableDynamics.ts`）：滚动 25 手统计每个座位的 VPIP/PFR/3-bet/冷跟，
一份数据两个用途——`selfCalibration` 把 AI 自己的频率与人格目标的偏差写成一句话回注提示词
（"你 3-bet 了 17 次机会里的 11 次，目标 16%——这手该跟注"），`tableRead` 把**其他**座位的
倾向写给它看（牌桌动态博弈，而不是八个孤立机器人）。

**难度档位**：娱乐场 / 常规桌 / 高手局，换人格组合并调节 AI 使用 Hero 画像的力度
（light 1 条指令 / normal 3 条 / hard 5 条）。lineup 允许重复人格，因此座位 id 改为
`${personaId}#${seat}`，而 `player.persona.id` 保持原样——`planRebuy`、`heroCountersForHand`、
strategy 的人格参数全部按 persona.id 取，不受影响。`regular` 档与改造前逐座位一致。

**自己手牌的强度也预计算**（`describeHoleStrength`）：外部分析发现模型会"搞混自己的底牌、
位置和牌力"。现在明确告诉它 "second pair (9) with an 8 kicker"、"kings paired on the board;
you have no pair of your own"，而不是让它从牌码推。与 `boardTexture` 并列进入 payload。

**注意**：提示词类改动本地一律无法验证——本地引擎不读提示词。要看效果必须接 API 再打一轮，
重点复核翻牌率是否从 14% 回到 50% 以上、以及各人格的 VPIP/PFR 是否出现应有的差值。
