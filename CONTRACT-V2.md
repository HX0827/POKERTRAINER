# CONTRACT V2 — 护栏松绑 + Hero 画像记忆

背景：V1 护栏把全桌 VPIP 从 39.4% 压到 19.2%（跟注站 77%→29%，火山 61%→30%），七个人格被压成同一个紧手。
实测数据见本文件末尾。V2 的两个决定（用户已确认）：

1. **护栏只留致命线**：删光全部翻前范围规则，翻后只拦"大注点上的绝望跟注/纯空气巨额全下"。
2. **记忆系统只做 Hero 画像**：统计人类玩家的公开倾向注入提示词，让 AI 越打越会剥削 Tom。
   明确不做筹码输赢奖惩（扑克结果方差 ~95BB/100 手，十几万手才能分辨胜率差，短样本只会学出迷信）。

金额单位一律是筹码（SB=1, BB=2）。设计文档 §5 的翻前矩阵在 V2 中作废，postflop 部分按下面重写。

## 文件归属（严格，不要碰别人的文件）

| Agent | 文件 |
|---|---|
| A（护栏） | `app/lib/strategy.ts` + `tests/strategy-guardrail.test.mjs` |
| B（存储） | `app/lib/heroProfile.ts`（新）+ `app/api/hero-profile/route.ts`（新）+ `db/schema.ts` + `app/api/hands/route.ts` |
| C（接线） | `app/components/PokerTrainer.tsx` + `app/api/ai/decision/route.ts` |

`app/lib/poker.ts`、`app/globals.css`、`CONTRACT*.md`、`docs/` 本轮任何人都不要改。

## 一、护栏新规则（Agent A）

`checkDecision` / `suggestSafeAction` / `describeHandClass` 的签名与类型**保持不变**（route 和客户端已依赖）。
`RuleId` 保留原联合类型不变（少用几个成员没关系，删成员会破坏 route 的类型）。

### 翻前：不再有任何范围否决

`street === "preflop"` 时永远 `ok: true`。只保留静默尺寸钳制（`clampedRaiseTo`）：
open 目标带 4.4–8 筹码（每个 limper +2）、3bet 为 open 的 2.5–4.5 倍、4bet 为 3bet 的 2.2–2.8 倍，
最后一律钳进 `[minimumRaiseTo, maximumRaiseTo]`。钳制永远不算否决。

### 翻后：只保留两条致命线

其余全部放行（`POST-CALL-EQUITY`、`POST-RAISE-VALUE`、`POST-RAISE-SEMIBLUFF`、`POST-RAISE-BLUFF` 不再否决任何东西）。

**1. `POST-CALL-ALLIN` — 绝望的大额跟注**。同时满足才否决：

- `effCall >= 0.25 * heroEffectiveStack`（`heroEffectiveStack = observation.stack`，即身后筹码）
- `engineEquity < requiredEquity - 0.12`（12 个百分点的硬边距，不再用人格容差）
- 无隐含赔率补偿：若**存在**未全下的对手 **且** `outs >= 8`，额外再给 0.08 的松弛
  （即此时门槛变成 `requiredEquity - 0.20`）

`requiredEquity` 用 V1 的有效额公式（`effCall / (effectivePot + effCall)`，扣掉对手无法被跟到的超额部分）。

**2. `POST-JAM-EQUITY` — 纯空气的巨额全下**。同时满足才否决：

- 有效下注量 `> 1.5 * pot`（有效量 = min(意图增量, 最大在场对手剩余筹码)）
- `engineEquity < 0.25`
- `outs < 4`
- **且没有任何对手能弃牌**（所有未弃牌对手都已 all-in）——有人能弃牌时诈唬是合法策略，火山有权这么打

翻后尺寸仍做静默钳制：`[minimumRaiseTo, min(maximumRaiseTo, currentBet + 2.5 * pot)]`（比 V1 的 1.5 倍池放宽）。

**`suggestSafeAction`**：面对下注时，若 `POST-CALL-ALLIN` 不否决则 `call`，否则 `fold`；无人下注时一律 `check`（不再主动开池）。翻前一律 `check`（无注）或 `fold`（有注）——它只在"两次都被否决"的兜底路径上用，本身不该有风格。

### Agent A 的验收

1. `tsc -p tsconfig.check.json` → 0 错误。
2. 重写 `tests/strategy-guardrail.test.mjs`。原 9 个用例的**新期望**：
   - case1（BB A8o 冷跟 3bet）→ `ok: true`（人格保留，这是本次松绑的核心取舍）
   - case2（BB A8o 跟 4bet）→ `ok: true`
   - case3（LJ A5s 4bet）→ `ok: true`
   - case4（LJ A5s 翻牌全下 903，BB 能弃牌）→ `ok: true`（有人能弃牌 → 诈唬合法）
   - case5（BB 用 288 身后跟 903 全下）→ **仍 `ok: false`, rule `POST-CALL-ALLIN`**
   - case6（AA 面对 4bet 全下）→ `ok: true`
   - case7（BTN 76s 开池）→ `ok: true`
   - case8（BB A8o 防守单次 open）→ `ok: true`
   - case9（A 高跟转牌超池全下）→ **仍 `ok: false`, rule `POST-CALL-ALLIN`**
   另加至少 5 个新用例守住松绑后的边界：全下对手前用 3% 权益跟掉全部筹码 → 否决；
   跟掉 30% 筹码但权益只差 8 个点 → 放行；面对未全下对手用 9 个 outs 的听牌跟大注 → 放行（隐含赔率）；
   跟注站用弱对子跟半池 → 放行（人格保留）；火山拿同花听牌超池全下 → 放行。
   保留 `describeHandClass` 与 `suggestSafeAction` 的既有断言。
3. `node --experimental-strip-types --test tests/poker-ev.test.mjs` → 仍 13/13。
4. **跑 `/tmp/vpip.mjs`（已存在，直接 `cd /tmp && node --experimental-strip-types vpip.mjs`）**，
   在报告里贴出松绑后的表格。目标：全桌 VPIP ≥ 36%，跟注站 ≥ 70%，火山 ≥ 55%，岩石 ≤ 20%，
   且否决/手在所有人格上 < 0.05。达不到就继续放松，把最终数字写进报告。

## 二、Hero 画像（Agent B）

### `app/lib/heroProfile.ts`（签名冻结，C 依赖）

```ts
import type { GameState } from "./poker";

export interface HeroCounters {
  handsDealt: number;
  vpip: number; pfr: number;
  threeBetOpp: number; threeBet: number;
  foldToThreeBetOpp: number; foldToThreeBet: number;
  cbetFlopOpp: number; cbetFlop: number;
  foldToBetFlopOpp: number; foldToBetFlop: number;
  foldToBetTurnOpp: number; foldToBetTurn: number;
  foldToBetRiverOpp: number; foldToBetRiver: number;
  foldToAllInOpp: number; foldToAllIn: number;
  postflopAggro: number; postflopPassive: number;
  sawFlop: number; wentToShowdown: number;
}
export const EMPTY_HERO_COUNTERS: HeroCounters;
/** 从一手已结束的牌局提取 Hero 的公开行为增量。只允许用公开信息。 */
export function heroCountersForHand(state: GameState): HeroCounters;
export function mergeHeroCounters(a: HeroCounters, b: HeroCounters): HeroCounters;
export interface HeroProfileSummary {
  handsDealt: number;
  /** 供提示词使用的一行英文，样本不足的项自动省略；无可用项时返回 "" */
  text: string;
  lines: Array<{ key: string; label: string; made: number; opp: number; pct: number }>;
}
export function summarizeHeroProfile(counters: HeroCounters, minSample?: number): HeroProfileSummary;
```

口径（全部只用公开信息，底牌只有在 `state.revealed` 含 hero 时才算已知）：

- `vpip`：翻前主动投钱（面对 `toCall > 0` 的 call，或任何 raise/allin）；BB 免费过牌不算；SB 补齐算。
- `pfr`：翻前有过 raise/allin。
- `threeBetOpp` / `threeBet`：面对本街第 1 个加注时的再加注机会与执行。
- `foldToThreeBetOpp` / `foldToThreeBet`：自己开池后面对 3bet 的弃牌。
- `cbetFlopOpp` / `cbetFlop`：作为翻前最后加注者、看到翻牌且有下注权时的持续下注。
- `foldToBet{Flop,Turn,River}`：该街面对下注/加注时的弃牌（分母是面对下注的次数）。
- `foldToAllIn`：面对全下（`facedBet` 对应对手 all-in）时的弃牌。
- `postflopAggro` / `postflopPassive`：翻后 (bet+raise) 与 (call) 的动作计数。
- `sawFlop` / `wentToShowdown`：看到翻牌的手数、走到摊牌的手数。

`summarizeHeroProfile` 默认 `minSample = 8`：分母 < 8 的项不进 `text`。
`text` 形如 `VPIP 34% (24/70) | PFR 18% (13/70) | folds to flop bet 71% (12/17) | fold vs all-in 80% (8/10) | WTSD 26% (9/35)`。
`handsDealt < 15` 时 `text` 返回 `""`（样本太小，不注入）。

### 存储

`db/schema.ts` 增加 `heroHandStats` 表；`app/api/hero-profile/route.ts` 用与 `app/api/hands/route.ts`
完全相同的 `ensureSchema()` 风格（`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 补列），因为线上库已存在。

表：`hero_hand_stats(id INTEGER PK AUTOINCREMENT, hand_id TEXT NOT NULL UNIQUE, counters TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`，
`counters` 存 `HeroCounters` 的 JSON。索引 `created_at DESC`。

- `POST /api/hero-profile` body `{ handId: string, counters: HeroCounters }` → upsert，返回 `{ ok: true }`。
  校验：handId ≤ 32 字符；counters 每个字段必须是有限非负数且 ≤ 1000，否则 400。
- `GET /api/hero-profile` → 取最近 500 行聚合 → `{ handsDealt, text, lines, counters }`（即 `summarizeHeroProfile` 的结果 + 原始 counters）。
  D1 不可用时返回 `{ handsDealt: 0, text: "", lines: [], counters: EMPTY_HERO_COUNTERS, storage: "unavailable" }`，**不要 5xx**。
- `DELETE /api/hero-profile` → 清空该表，返回 `{ ok: true, deleted: n }`。
- `app/api/hands/route.ts` 的 `DELETE` 同时清空 `hero_hand_stats`（一键清空要连画像一起清），其余逻辑不动。

## 三、接线（Agent C）

### 客户端 `PokerTrainer.tsx`

1. 启动时 `GET /api/hero-profile`，存进 state（失败静默用空画像）。
2. `logFinishedHand` 里额外 `POST /api/hero-profile`（`heroCountersForHand(finished)`），成功后用返回值或本地
   `mergeHeroCounters` 更新画像 state；失败静默（画像是增益，不能影响牌局）。
3. 决策请求 body 增加：`heroProfile: { text: string; handsDealt: number } | undefined`（`text` 为空时不要发）
   和 `heroPosition: string`（当前 Hero 的座位，如 `"BB"`——AI 需要知道桌上哪个位置是人类）。
4. 「一键清空记录」保持只调 `DELETE /api/hands`（B 已让它连带清画像），清空后把本地画像 state 归零。
5. AI 设置弹窗里加一行只读展示：`已建模 N 手` + 画像 text（没有则显示"样本不足，继续打"）。
   **不要**在牌局进行中把画像显示在牌桌上——它是给 AI 的，不是给 Hero 的提示。

### `app/api/ai/decision/route.ts`

`RequestBody` 增加 `heroProfile?: { text?: string; handsDealt?: number }` 与 `heroPosition?: string`。
两者齐全且 `text` 非空时，在 system 提示词的 PERSONA 之前插入一段：

```
HERO READ (the human player is in seat <heroPosition>; these are observed public frequencies over <N> hands):
<text>
Exploit these leaks when the spot allows it. They describe only that one seat — every other seat is an AI.
```

`text` 做长度上限 400 字符、剥掉换行后再插入。其余流程（护栏审计、重问一次、来源标记）保持不变。

### Agent C 的验收

`tsc -p tsconfig.check.json` → 0 错误；`node --experimental-strip-types --test tests/poker-ev.test.mjs` → 13/13。
自查：画像为空/接口 503 时决策链路完全不受影响；`reason` 仍不在牌局中渲染。

## 附：V1 实测数据（护栏开 vs 关，本地引擎驱动，各 700 手）

```
人格          VPIP开   VPIP关    PFR开   PFR关   否决/手  主因
Atlas        14.9%    27.3%     6.7%   15.4%   0.17   PF-RANGE-VS-OPEN
钱老板        21.4%    47.9%    15.4%   37.6%   0.38   PF-OPEN-RANGE
Mika         13.6%    20.4%     7.4%   15.6%   0.13   PF-RANGE-VS-OPEN
老陈         29.4%    77.4%     2.0%    3.4%   0.63   PF-RANGE-VS-OPEN
K.O.         16.4%    30.0%    12.1%   26.4%   0.21   PF-OPEN-RANGE
Stone         9.4%    11.3%     4.0%    6.3%   0.05   PF-RANGE-VS-OPEN
Volcano      29.6%    61.3%    23.4%   52.6%   0.52   PF-OPEN-RANGE
全桌平均      19.2%    39.4%
```
