import assert from "node:assert/strict";
import test from "node:test";

import { bestScore, handStrengthValue } from "../app/lib/poker.ts";

/**
 * 全下 EV 的可信度全部押在这里。
 *
 * 摊牌走 `bestScore`（枚举 21 个五张组合），EV 穷举走 `handStrengthValue`（七张牌直接压成
 * 一个整数，快 150 倍）。两条路只要在任何一手牌上给出不同的胜负，EV 就会和真实结算对不上，
 * 而且这种偏差在单手牌里完全看不出来——只会表现为「运气差」那一栏莫名其妙。
 *
 * 所以这里不测某几个精心挑选的牌型，而是拿几十万手随机牌逐一对照两者的**排序结果**。
 */

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];
const DECK = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
const parse = (text) => text.match(/../g).map((code) => ({ rank: code[0], suit: code[1] }));

function compareScore(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

/** 固定种子的线性同余，保证失败可复现。 */
function rng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test("每一种牌型都被认成它自己", () => {
  const cases = [
    ["AsKsQsJsTs2h3d", 8, "皇家同花顺"],
    ["5s4s3s2sAs9h8d", 8, "轮子同花顺"],
    ["7h7d7c7sKh2d3c", 7, "四条"],
    ["9h9d9cKsKh2d3c", 6, "葫芦"],
    ["AhKh8h5h2h3d4c", 5, "同花"],
    ["9h8d7c6s5hKdQc", 4, "顺子"],
    ["As5d4c3h2sKdQc", 4, "轮子顺子"],
    ["JhJdJcKs8h4d2c", 3, "三条"],
    ["QhQdJcJs8h4d2c", 2, "两对"],
    ["8h8dKcQs4h3d2c", 1, "一对"],
    ["AhKd9c7s5h3d2c", 0, "高牌"],
  ];
  for (const [text, category, label] of cases) {
    const cards = parse(text);
    assert.equal(bestScore(cards)[0], category, `${label}: bestScore 认错了`);
    // 类别是打包值的最高位：整数除掉 5 个 4 位的决胜位。
    assert.equal(Math.floor(handStrengthValue(cards) / 16 ** 5), category, `${label}: 快速评估认错了`);
  }
});

test("两组三条时，小的那组当葫芦的对子", () => {
  // 999 + 777 + K：正解是 999 带 77，不是 999 带 KK（K 只有一张）。
  const cards = parse("9h9d9c7s7h7dKc");
  assert.equal(bestScore(cards)[0], 6);
  assert.equal(compareScore(bestScore(cards), bestScore(parse("9h9d9c7s7h2d3c"))), 0);
  assert.equal(handStrengthValue(cards), handStrengthValue(parse("9h9d9c7s7h2d3c")));
});

test("同花取最大的五张，不是随便五张", () => {
  const big = parse("AhQhTh8h6h2s3d");
  const small = parse("AhQhTh8h4h2s3d");
  assert.ok(handStrengthValue(big) > handStrengthValue(small), "第五张踢脚要分出胜负");
  assert.equal(Math.sign(compareScore(bestScore(big), bestScore(small))), 1);
});

test("三十万手随机对局里，快速评估和 bestScore 的胜负判定完全一致", () => {
  const random = rng(20260727);
  let compared = 0;
  for (let round = 0; round < 300_000; round += 1) {
    const pool = DECK.slice();
    for (let i = 0; i < 9; i += 1) {
      const j = i + Math.floor(random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const board = pool.slice(0, 5);
    const a = [...pool.slice(5, 7), ...board];
    const b = [...pool.slice(7, 9), ...board];

    const slow = Math.sign(compareScore(bestScore(a), bestScore(b)));
    const fast = Math.sign(handStrengthValue(a) - handStrengthValue(b));
    if (slow !== fast) {
      assert.fail(
        `第 ${round} 手判定不一致\n` +
          `  公共牌 ${board.map((c) => c.rank + c.suit).join(" ")}\n` +
          `  A ${a.slice(0, 2).map((c) => c.rank + c.suit).join("")} -> bestScore ${bestScore(a)} / 快速 ${handStrengthValue(a)}\n` +
          `  B ${b.slice(0, 2).map((c) => c.rank + c.suit).join("")} -> bestScore ${bestScore(b)} / 快速 ${handStrengthValue(b)}`,
      );
    }
    compared += 1;
  }
  assert.equal(compared, 300_000);
});

test("平局也要一致地判成平局", () => {
  const random = rng(991);
  let ties = 0;
  for (let round = 0; round < 60_000; round += 1) {
    const pool = DECK.slice();
    for (let i = 0; i < 9; i += 1) {
      const j = i + Math.floor(random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const board = pool.slice(0, 5);
    const a = [...pool.slice(5, 7), ...board];
    const b = [...pool.slice(7, 9), ...board];
    const slowTie = compareScore(bestScore(a), bestScore(b)) === 0;
    const fastTie = handStrengthValue(a) === handStrengthValue(b);
    assert.equal(fastTie, slowTie, `第 ${round} 手平局判定不一致`);
    if (slowTie) ties += 1;
  }
  // 随机对局里平局并不罕见（打公共牌），样本里必须真的出现过，否则这条测试什么也没验证。
  assert.ok(ties > 200, `样本里只出现 ${ties} 次平局，覆盖不足`);
});
