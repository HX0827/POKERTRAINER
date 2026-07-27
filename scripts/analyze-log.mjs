#!/usr/bin/env node
/**
 * 牌谱体检：把导出的 .md 牌谱变成一张表，看牌桌有没有退化。
 *
 *   node --experimental-strip-types scripts/analyze-log.mjs 牌局日志.md
 *
 * 为什么需要它：2026-07-27 的 21 手实测显示，DeepSeek 接管后只有 14% 的牌看到翻牌、
 * 95% 的牌里有 3-bet、七个人格里六个的 PFR 等于 VPIP（冷跟消失了）。这些问题从单手牌里
 * 完全看不出来，只有汇总才暴露。每打一轮就跑一次，比人眼读牌谱可靠得多。
 */
import { readFile } from "node:fs/promises";

const POSITIONS = ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
/** 真实现金局的参考区间，用来判断哪一项已经离谱。 */
const HEALTHY = {
  flopRate: [0.45, 0.75],
  threeBetRate: [0.03, 0.2],
  raiseShare: [0.25, 0.6],
};

function parseHand(line) {
  const id = line.match(/H#(\d+)/)?.[1];
  if (!id) return null;
  const seats = new Map();
  const stacks = line.match(/\| Stacks ([^|]+)/)?.[1] ?? "";
  for (const entry of stacks.split(";")) {
    // `BTN(hero):登邓灯 99.5BB` — 人格名是 2026-07-27 之后才有的，旧牌谱没有就退回位置名
    const withName = entry.trim().match(/^([A-Z+0-9]+)(\(hero\))?:(\S+)\s/);
    const positionOnly = entry.trim().match(/^([A-Z+0-9]+)(\(hero\))?\s/);
    const match = withName ?? positionOnly;
    if (!match) continue;
    seats.set(match[1], { name: withName ? match[3] : match[1], hero: Boolean(match[2]) });
  }
  const streets = {
    preflop: line.match(/\| PF ([^|]*)/)?.[1]?.trim() ?? "",
    flop: line.match(/\| F ([^|]*)/)?.[1]?.trim() ?? "",
    turn: line.match(/\| T ([^|]*)/)?.[1]?.trim() ?? "",
    river: line.match(/\| R ([^|]*)/)?.[1]?.trim() ?? "",
  };
  return { id, seats, streets };
}

/** 把 `UTG open to 2.5BB HJ fold ...` 拆成 [{position, action}]。 */
function parseActions(text) {
  const tokens = text.split(/\s+/);
  const actions = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const position = tokens[i].replace("(hero)", "");
    if (!POSITIONS.includes(position)) continue;
    const action = tokens[i + 1] ?? "";
    if (/^(open|3bet|4bet|5bet|6bet|fold|call|check|limp|bet|raise|allin)$/.test(action)) {
      actions.push({ position, action });
    }
  }
  return actions;
}

const pct = (made, total) => (total > 0 ? (100 * made) / total : 0);
const flag = (value, [low, high]) => (value < low ? " ← 偏低" : value > high ? " ← 偏高" : "");

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("用法: node --experimental-strip-types scripts/analyze-log.mjs <牌谱.md>");
    process.exit(1);
  }
  const text = await readFile(path, "utf8");
  const hands = text
    .split("\n")
    .map((line) => line.replace(/^-\s*/, ""))
    .filter((line) => line.startsWith("H#"))
    .map(parseHand)
    .filter(Boolean);

  if (hands.length === 0) {
    console.error("没解析到任何牌局——确认这是导出的 .md 牌谱");
    process.exit(1);
  }

  const seatStats = new Map();
  const levels = { open: 0, "3bet": 0, "4bet": 0, "5bet": 0 };
  let sawFlop = 0;
  let sawTurn = 0;
  let raises = 0;
  let calls = 0;

  for (const hand of hands) {
    if (hand.streets.flop) sawFlop += 1;
    if (hand.streets.turn) sawTurn += 1;
    for (const [, seat] of hand.seats) {
      if (!seatStats.has(seat.name)) {
        seatStats.set(seat.name, { dealt: 0, vpip: 0, pfr: 0, threeBet: 0, calls: 0, hero: seat.hero });
      }
      seatStats.get(seat.name).dealt += 1;
    }

    const voluntary = new Set();
    const raised = new Set();
    for (const { position, action } of parseActions(hand.streets.preflop)) {
      const name = hand.seats.get(position)?.name ?? position;
      const stat = seatStats.get(name);
      if (!stat) continue;
      if (["open", "3bet", "4bet", "5bet", "6bet"].includes(action)) {
        if (levels[action] !== undefined) levels[action] += 1;
        voluntary.add(name);
        raised.add(name);
        raises += 1;
        if (action !== "open") stat.threeBet += 1;
      } else if (action === "call" || action === "limp") {
        voluntary.add(name);
        calls += 1;
        stat.calls += 1;
      }
    }
    voluntary.forEach((name) => (seatStats.get(name).vpip += 1));
    raised.forEach((name) => (seatStats.get(name).pfr += 1));
  }

  const n = hands.length;
  const flopRate = sawFlop / n;
  const threeBetRate = levels["3bet"] / n;
  const raiseShare = raises / Math.max(1, raises + calls);

  console.log(`\n牌谱体检 · ${n} 手 (H#${hands[0].id} – H#${hands.at(-1).id})\n`);
  console.log(`看到翻牌       ${sawFlop}/${n} = ${pct(sawFlop, n).toFixed(0)}%${flag(flopRate, HEALTHY.flopRate)}   参考 45-75%`);
  console.log(`打到转牌       ${sawTurn}/${n} = ${pct(sawTurn, n).toFixed(0)}%`);
  console.log(`出现 3-bet     ${levels["3bet"]}/${n} = ${pct(levels["3bet"], n).toFixed(0)}%${flag(threeBetRate, HEALTHY.threeBetRate)}   参考 3-20%`);
  console.log(`出现 4-bet     ${levels["4bet"]}/${n} = ${pct(levels["4bet"], n).toFixed(0)}%`);
  console.log(`翻前加注占比   ${raises} 加注 : ${calls} 跟注 = ${pct(raises, raises + calls).toFixed(0)}%${flag(raiseShare, HEALTHY.raiseShare)}   参考 25-60%\n`);

  console.log("座位            手数   VPIP    PFR   差值   3bet+  跟注");
  const rows = [...seatStats.entries()].sort((a, b) => b[1].vpip / b[1].dealt - a[1].vpip / a[1].dealt);
  for (const [name, s] of rows) {
    const vpip = pct(s.vpip, s.dealt);
    const pfr = pct(s.pfr, s.dealt);
    const gap = vpip - pfr;
    // 差值为 0 = 一入池就加注，冷跟消失了。真实玩家类型的差值在 4（岩石）到 30（跟注站）之间。
    const note = s.dealt >= 10 && gap < 2 ? "  ← 从不跟注" : "";
    console.log(
      `${(name + (s.hero ? " (你)" : "")).padEnd(14)} ${String(s.dealt).padStart(4)}  ${vpip.toFixed(0).padStart(4)}%  ${pfr.toFixed(0).padStart(4)}%  ${gap.toFixed(0).padStart(4)}  ${String(s.threeBet).padStart(5)}  ${String(s.calls).padStart(4)}${note}`,
    );
  }
  console.log("\n差值 = VPIP - PFR，即「入池但没加注」的比例。真实玩家：跟注站约 30，疯子约 10，");
  console.log("岩石/TAG 约 4-5。差值接近 0 说明这个座位只会弃牌或加注，牌局会打不到翻牌。\n");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
