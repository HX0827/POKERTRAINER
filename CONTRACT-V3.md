# CONTRACT V3 — 让牌打到翻牌，并把难度做出来

## 背景（21 手实测，必读）

DeepSeek 接管后的真实分布第一次被量出来，结果是退化的：

```
看到翻牌 3/21 = 14%（真实 55-70%）   翻前结束 17/21 = 81%
出现 3-bet 的牌 20/21 = 95%（真实 5-8%）   4-bet 12/21 = 57%
翻前主动投钱：加注 57 次 : 跟注 11 次 = 84% 是加注

人格        VPIP  PFR  3bet+  跟注     应该是
Volcano      95%  95%    17    0      松凶但要有跟注
钱老板        38%  38%     8    0      ~45%
Atlas        19%  19%     3    0      ~25%
老陈          14%   0%     0    4      ~75%（跟注站！）
Stone         5%   5%     1    0      12-18%
```

**七个人格里六个 PFR = VPIP**：一旦入池必定加注，冷跟这个动作消失了。这是没有翻牌的机械原因。

**根因在底线第 1 条**："potOddsToCall is the equity you need to call"。这在翻后正确，
在**翻前冷跟时是错的**——翻前跟 3BB 靠的是后三条街的隐含赔率、位置与可玩性。模型逐字应用，
于是几乎每条弃牌理由都写着 "pot odds require 40%"，连 CO 的 A6s 面对开池都弃。
跟注被判死刑，模型就只剩弃或加。

用户已确认的方向：**提示词 + 频率预算**修跟注问题；难度做三件——对手剔削 Hero 的漏洞、
难度档位（换人格组合）、AI 记住牌桌动态。

金额单位规矩不变：引擎内部整数筹码，模型侧一律 BB，换算只在 `app/lib/modelView.ts`。

## 文件归属（严格）

| Agent | 文件 |
|---|---|
| A（动态追踪） | `app/lib/tableDynamics.ts`（新）+ `tests/table-dynamics.test.mjs`（新） |
| B（提示词与注入） | `app/api/ai/decision/route.ts` + `app/lib/heroProfile.ts` |
| C（人格与难度档） | `app/lib/poker.ts` + `app/components/PokerTrainer.tsx` + `app/globals.css` |

`app/lib/strategy.ts`、`app/lib/modelView.ts`、既有 tests 本轮不要动（C 可按需更新
`tests/rebuy.test.mjs` 里因人格文案变化而失败的正则守卫，但不要削弱它）。

---

## 一、Agent A：`app/lib/tableDynamics.ts`

一个模块同时服务两个需求：AI 的**自我频率校准**，和 AI 对**其他座位**的读牌。
纯函数、无 IO、`import type` only（必须能被 `node --experimental-strip-types` 直接加载）。

```ts
import type { GameState } from "./poker";

/** 单个座位在滚动窗口内的行为计数。 */
export interface SeatDynamics {
  handsDealt: number;
  voluntary: number;        // 翻前主动投钱（BB 免费过牌不算，SB 补齐算）
  raisedPreflop: number;    // 翻前有过 raise/allin
  coldCalls: number;        // 翻前面对加注选择跟注（非 3-bet）
  threeBetOpp: number;      // 面对本街第 1 个加注、且自己尚未加注过的次数
  threeBets: number;
  foldedPreflop: number;
  sawFlop: number;
  wonWithoutShowdown: number;
}
export const EMPTY_SEAT_DYNAMICS: SeatDynamics;

/** playerId -> SeatDynamics。 */
export type TableDynamics = Record<string, SeatDynamics>;
export const EMPTY_TABLE_DYNAMICS: TableDynamics;

/** 从一手已结束的牌局提取每个座位的增量。只用公开动作。 */
export function dynamicsForHand(state: GameState): TableDynamics;
export function mergeTableDynamics(a: TableDynamics, b: TableDynamics): TableDynamics;

/** 人格的目标频率，供自我校准比对。 */
export interface FrequencyTarget {
  vpip: number;      // 目标入池率 0..1
  threeBet: number;  // 面对开池时的目标 3-bet 率 0..1
  callShare: number; // 入池动作里"跟注"应占的比例 0..1
}
export const FREQUENCY_TARGETS: Record<string, FrequencyTarget>;

/**
 * 给正在行动的 AI 看它自己的最近频率与目标的偏差。样本不足返回 ""。
 * 例：`Your last 20 hands: entered 12 (60%, target 75%); of those you raised 12 and called 0
 * (call share 0%, target 90%); 3-bet 8 of 9 spots (89%, target 1%). You are 3-betting far too
 * often — calling is the normal action here unless the hand is clearly a raise.`
 */
export function selfCalibration(seat: SeatDynamics, personaId: string): string;

/**
 * 给正在行动的 AI 看**其他**座位的倾向。只列样本足够且明显偏离常态的座位，最多 3 个。
 * 例：`BTN raises 9 of 10 entries and has 3-bet 6 of 8 spots — his range is far wider than it
 * looks. LJ folded 17 of 20 hands.`
 */
export function tableRead(
  dynamics: TableDynamics,
  seats: Array<{ playerId: string; position: string; personaId: string }>,
  excludePlayerId: string,
): string;
```

口径细节：`threeBetOpp` 只在"面对本街已有恰好 1 个加注、且自己本手尚未加注"时 +1；
`coldCalls` 是面对加注的 call（非 limp）。窗口由调用方控制（C 只保留最近 25 手）。
`selfCalibration` 在 `handsDealt < 8` 时返回 ""，`tableRead` 对每个座位要求 `handsDealt >= 8`。

**频率目标以真实 HUD 数据为准**（来源：mypokercoaching 的玩家类型表 + poker.org 对 LLM 对战的
分析）。用 VPIP/PFR 两个数表达，而不是自造指标——这是模型训练语料里的原生词汇，"40/10" 它认得：

| persona | VPIP | PFR | 差值 | 锚点 |
|---|---|---|---|---|
| gto 均衡派 | 0.24 | 0.20 | 4 | TAG 25/20 |
| boss 老板 | 0.35 | 0.27 | 8 | LAG，介于 TAG 与疯子之间 |
| tag 猎手 | 0.25 | 0.20 | 5 | TAG 25/20 |
| station 老陈 | 0.40 | 0.10 | **30** | Calling Station 40/10 |
| short 短码哥 | 0.22 | 0.19 | 3 | 短码 raise-or-fold |
| rock 岩石 | 0.15 | 0.11 | 4 | Nit 15/11 |
| maniac 火山 | 0.45 | 0.35 | 10 | Maniac 45/35 |

3-bet 目标一律用"面对开池时的比例"：gto 0.08、boss 0.11、tag 0.09、station 0.02、
short 0.12、rock 0.04、maniac 0.16（对照：GTO 基准 6-8%，被判定为失控的 LLM 是 18.3%）。

`FrequencyTarget` 因此改为 `{ vpip: number; pfr: number; threeBet: number }`，
`callShare` 由 `(vpip - pfr) / vpip` 导出，不再单独配置。注意跟注站的 callShare 是 0.75
而非 0.9——真实跟注站也会加注一成。

**这些数字同时是"别太夸张"的依据**：火山原本实测 95/95，现在的目标 45/35 仍是全桌最松，
但不再是漫画人物。

**验收**：tsc 0 错误；自写 `tests/table-dynamics.test.mjs` 覆盖各计数口径（含 BB 免费过牌不算
voluntary、SB 补齐算、3-bet 机会的定义、限位样本不足返回空串）；再写一个一次性脚本用
`startHand`/`localBotDecision` 跑 200 手，确认所有计数满足 `made <= opportunity` 且
`selfCalibration` 在真实数据上产出合理文本，把输出贴进报告。

---

## 二、Agent B：提示词与注入（`route.ts` + `heroProfile.ts`）

### 1. 修掉造成"只弃或只加"的底线第 1 条

现文案：`1. Compare equity with price. potOddsToCall is the equity you need to call. ...`
改成明确区分翻前/翻后（措辞自拟，必须包含这三层意思）：

- potOddsToCall 是**翻后**跟注的门槛；
- **翻前冷跟不由即时底池赔率决定**——3BB 的跟注买的是后面三条街的隐含赔率、位置和可玩性，
  用即时赔率去否决它是错的；
- 对全下永远没有隐含赔率（这条保留）。

### 2. 新增一条"跟注是正常动作"

加入底线（编号自排）：跟注是一等动作；一张健康的桌上，选择继续的牌里**大多数是跟注而不是加注**；
如果你发现自己只有"弃或加"两个选项，说明你打错了。

### 3. 注入自我校准与牌桌读牌

`RequestBody` 增加 `selfCalibration?: string` 与 `tableRead?: string`（由客户端算好传入，
route 只做长度上限 300 字符 + 压平换行）。位置：放在 HERO READ 之后、PERSONA 之前，各自成段：

```
FREQUENCY CHECK: <selfCalibration>
TABLE READ: <tableRead>
```

两者为空时整段不出现（提示词与现在逐字节一致）。

### 4. 把 Hero 画像从数据变成指令

`heroProfile.ts` 新增：

```ts
/** 把统计转成可执行的剥削指令；无足够样本时返回 []。 */
export function exploitDirectives(counters: HeroCounters, minSample?: number): string[];
```

规则举例（阈值自定，必须给注释说明依据）：面对翻牌下注弃牌率 > 65% → "he folds to flop bets
X% — c-bet almost every flop against him and barrel again on the turn"；WTSD < 25% →
"he gives up before showdown — thin value bets and extra barrels print"；3-bet 率 < 5% →
"his 3-bets are premium-only; fold your marginal opens to him"；VPIP > 40% 且 PFR 低 →
"he calls too wide preflop — value bet relentlessly, bluff less"。
`summarizeHeroProfile` 的既有签名与行为不变，新增函数独立。

**样本量纪律（必须实现）**：对 LLM 扑克对战的分析发现，模型拿到对手统计后会用极小样本做
"狂野的剥削调整"。因此每条指令必须携带分母，且分母 < 12 的统计不得生成指令；
指令文案里要写清样本（`he folds to flop bets 85% (17/20)`），并在 HERO READ 段末尾附一句
`Sample sizes are small; treat these as tendencies, not certainties.`

route 里 HERO READ 段改为：原有一行频率文本 + 指令列表（最多 3 条，每条一行 `- `）。
`heroProfile` 请求字段增加可选 `directives?: string[]`（客户端传，route 只做数量/长度限制）。

**验收**：tsc 0 错误；既有 61 个测试全过；自查 payload——画像为空、动态为空时提示词回到
现状。用户已知提示词效果本地无法验证，报告里如实说明。

---

## 三、Agent C：人格频率语言 + 难度档位 + 接线

### 1. 七个人格提示词补上明确频率

每个 persona 的 prompt 末尾追加一句**具体数字**的频率描述，与 §一 的 FREQUENCY_TARGETS 一致。
**用 HUD 记号写**，这是模型训练语料里的原生词汇：
老陈 `"Your HUD line should read 40/10 over a large sample: you enter about 40% of hands and
raise only 10% - three of every four pots you play, you got there by CALLING. You almost never
3-bet (about 1 in 50 spots)."`；
火山 `"Your HUD line should read 45/35: the loosest and most aggressive player at the table, but
still a human one. About one in five of your entries is a call, not a raise, and you 3-bet
roughly one spot in six. A player who raises literally every hand is not a maniac, he is a
malfunction."`
其余人格照 §一 的表格照此写，务必同时给出 VPIP 和 PFR 两个数。
不要删除现有文案里已有的牌面结构条款。

### 2. 难度档位

`app/lib/poker.ts` 增加：

```ts
export type TableTier = "casual" | "regular" | "tough";
export interface TierDefinition { id: TableTier; title: string; blurb: string; lineup: string[]; heroReadStrength: "light" | "normal" | "hard"; }
export const TABLE_TIERS: Record<TableTier, TierDefinition>;
export const DEFAULT_TIER: TableTier = "regular";
```

`lineup` 是 7 个非 hero 的 persona id（座位 1..7 依次取用），`regular` 必须等于现状
（gto, boss, tag, station, short, rock, maniac）。`casual` 多放娱乐型（station/boss/maniac 重复
出现，少放 gto/tag）；`tough` 多放 gto/tag/short，去掉 station。同一 persona 允许在
lineup 里重复出现——重复时玩家名要能区分（例如 `老陈 2`），`freshPlayers` 需相应处理
（现在是按 PERSONAS 数组一一对应，需要改成按 lineup 构建，`id` 要唯一，可用 `${personaId}#${seat}`）。
**注意**：`planRebuy`、`heroCountersForHand`、strategy 的 persona traits 都按 `persona.id` 取，
座位 id 变化不能破坏它们——保留 `player.persona.id` 为原始 persona id，只让 `player.id` 唯一。

`startHand(previous?, options?: { tier?: TableTier })`；不传时沿用 `previous` 的档位，
`GameState` 增加 `tier: TableTier`。切换档位时重开牌桌（筹码按各自买入重置）。

### 3. 自己手牌的强度也要预计算

对 LLM 扑克的公开分析发现模型会"搞混自己的底牌、位置和牌力"（已在我们的牌谱里见到同类错误）。
`app/lib/poker.ts` 增加：

```ts
/** 翻后：用一句话说清这手牌现在是什么。翻前返回 undefined。 */
export function describeHoleStrength(hole: Card[], community: Card[]): string | undefined;
```

内容包含：成手类别（用现成的 `bestScore`/`SCORE_NAMES` 思路，但输出英文），以及**相对牌面的位置**
——overpair / top pair / second pair / bottom pair / no pair 等，例如
`"top pair (J) with a K kicker"`、`"second pair"`、`"ace high, no pair"`、`"two pair, Qs and Js"`。
接进 `botObservation` 作为可选字段 `handStrength?: string`（与 `boardTexture` 并列），
并由 B 已有的 `bigBlindView` 透传（B 已把 `boardTexture` 透传，`handStrength` 需要 C 通知 B 加上——
**为避免冲突，C 只负责 poker.ts 侧产出该字段并写测试；modelView 的透传由我（集成方）补**）。

### 4. 客户端接线

- 难度档位选择器（可放在 AI 阵容弹窗顶部），切换时确认"会重置牌桌"，存 localStorage。
- 每手结束后 `dynamicsForHand` 累加进 ref，只保留最近 25 手；
  每次请求决策时算好 `selfCalibration(...)` 与 `tableRead(...)` 一起发给 route。
- Hero 画像请求体增加 `directives: exploitDirectives(counters)`；`heroReadStrength` 为 `light`
  时只发 1 条指令、`normal` 3 条、`hard` 全部（最多 5 条）。
- 阵容弹窗里显示当前档位说明。

**验收**：tsc 0 错误；`tests/poker-ev.test.mjs`、`tests/rebuy.test.mjs`、
`tests/strategy-guardrail.test.mjs`、`tests/model-units.test.mjs` 全过（人格文案守卫若因新增
频率句失败，更新正则但**不得**削弱"禁止与牌面无关的机械阈值"这条）；自写脚本验证三个档位各
跑 50 手不崩、座位 id 唯一、`planRebuy` 仍按原 persona 生效。

---

## 全员通用验收

```
cd /home/claude/work
tsc -p tsconfig.check.json
node --experimental-strip-types --test tests/*.test.mjs
```
不要装包。不要改 `typestubs/`、`tsconfig.check.json`。
提示词类改动本地无法验证效果，报告里如实标注哪些是"未验证"。
