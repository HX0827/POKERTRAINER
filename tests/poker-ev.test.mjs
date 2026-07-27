import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  botObservation,
  calculateHeroAllInEv,
  compactHandLog,
  heroEvSummary,
  legalActions,
  localBotDecision,
  startHand,
} from "../app/lib/poker.ts";

const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const suits = ["s", "h", "d", "c"];

function card(code) {
  return { rank: code[0], suit: code[1] };
}

function remainingDeck(knownCodes) {
  const known = new Set(knownCodes);
  return ranks.flatMap((rank) =>
    suits
      .map((suit) => `${rank}${suit}`)
      .filter((code) => !known.has(code))
      .map(card),
  );
}

test("turn all-in EV exactly enumerates every possible river", () => {
  const heroCards = ["As", "Ad"];
  const villainCards = ["Ks", "Kd"];
  const boardCodes = ["2c", "3d", "4h", "5s"];
  const state = {
    handNo: 1,
    dealerIndex: 0,
    players: [
      {
        id: "hero",
        isHero: true,
        hole: heroCards.map(card),
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 0,
        totalCommitted: 100,
      },
      {
        id: "villain",
        isHero: false,
        hole: villainCards.map(card),
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 0,
        totalCommitted: 100,
      },
    ],
    deck: remainingDeck([...heroCards, ...villainCards, ...boardCodes]),
    community: boardCodes.map(card),
    street: "turn",
    pot: 200,
    currentBet: 0,
    minRaise: 2,
    actingIndex: 0,
    actions: [],
    message: "",
    handComplete: false,
    revealed: [],
    winners: [],
    heroStartStack: 100,
    heroAllInEv: null,
  };

  const ev = calculateHeroAllInEv(state);
  assert.ok(ev);
  assert.equal(ev.method, "exact");
  assert.equal(ev.trials, 44);
  assert.equal(ev.standardError, 0);
  assert.ok(Math.abs(ev.expectedPayout - (200 * 41) / 44) < 1e-9);
  assert.ok(Math.abs(ev.expectedResult - ((200 * 41) / 44 - 100)) < 1e-9);
});

test("positive stacks carry across hands and only busted personas rebuy", () => {
  const previous = startHand();
  previous.dealerIndex = 7;
  previous.players = previous.players.map((player) => {
    if (player.id === "hero") return { ...player, stack: 7 };
    if (player.id === "gto") return { ...player, stack: 0 };
    return player;
  });

  const next = startHand(previous);
  assert.equal(next.players.find((player) => player.id === "hero").stack, 7);
  assert.equal(next.players.find((player) => player.id === "gto").stack, 199);
  assert.equal(next.startingStacks.hero, 7);
  assert.equal(next.startingStacks.gto, 200);
});

test("closing a turn all-in captures EV before the river is dealt", () => {
  const heroCards = ["As", "Ad"];
  const villainCards = ["Ks", "Kd"];
  const boardCodes = ["2c", "3d", "4h", "5s"];
  const state = {
    handNo: 2,
    dealerIndex: 0,
    players: [
      {
        id: "hero",
        name: "登邓灯",
        isHero: true,
        hole: heroCards.map(card),
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 100,
        totalCommitted: 100,
        acted: true,
        lastAction: "all-in 50BB",
        result: 0,
        position: "BTN",
      },
      {
        id: "villain",
        name: "Villain",
        isHero: false,
        hole: villainCards.map(card),
        folded: false,
        allIn: false,
        stack: 100,
        streetBet: 0,
        totalCommitted: 0,
        acted: false,
        lastAction: "",
        result: 0,
        position: "BB",
      },
    ],
    deck: remainingDeck([...heroCards, ...villainCards, ...boardCodes]),
    community: boardCodes.map(card),
    street: "turn",
    pot: 0,
    currentBet: 100,
    minRaise: 100,
    actingIndex: 1,
    actions: [],
    message: "",
    handComplete: false,
    revealed: [],
    winners: [],
    heroStartStack: 100,
    heroAllInEv: null,
  };

  const finished = applyAction(state, "call");
  assert.equal(finished.handComplete, true);
  assert.equal(finished.heroAllInEv?.method, "exact");
  assert.equal(finished.heroAllInEv?.trials, 44);
  const summary = heroEvSummary(finished);
  assert.ok(summary);
  assert.ok(Math.abs(summary.actualResult - summary.expectedResult - summary.luck) < 1e-9);
});

test("preflop all-in EV enumerates every runout instead of sampling", () => {
  const state = startHand();
  state.pot = 200;
  state.currentBet = 0;
  state.players = state.players.map((player) => ({
    ...player,
    folded: !["hero", "gto"].includes(player.id),
    allIn: ["hero", "gto"].includes(player.id),
    streetBet: 0,
    totalCommitted: ["hero", "gto"].includes(player.id) ? 100 : 0,
  }));

  const ev = calculateHeroAllInEv(state);
  assert.ok(ev);
  /*
   * 八个座位都发了牌，牌堆固定剩 36 张，翻前要补 5 张 —— C(36,5) = 376,992。这是这个游戏里
   * 最大的一次穷举，所以每一次全下 EV 都是精确值，不存在抽样误差。原来的阈值是 5 万，翻前
   * 一律走 25,000 次蒙特卡洛，每手带 ±0.6-1.2BB 的噪声，累计几十手就是十几 BB 的假信号。
   */
  assert.equal(ev.method, "exact");
  assert.equal(ev.trials, 376_992);
  assert.equal(ev.standardError, 0);
});

test("a locked-in hero gets an EV snapshot even when opponents still have chips behind", () => {
  // 英雄翻牌全下，另外两家还有筹码、之后一路过牌到河牌：牌局从没进入「只剩一人能行动」。
  const state = startHand();
  state.street = "flop";
  state.community = ["2c", "7d", "Jh"].map(card);
  state.players = state.players.map((player, index) => ({
    ...player,
    folded: index > 2,
    allIn: index === 0,
    stack: index === 0 ? 0 : 400,
    streetBet: 0,
    totalCommitted: index <= 2 ? 100 : 0,
  }));
  state.players[0] = { ...state.players[0], isHero: true };

  const ev = calculateHeroAllInEv(state);
  assert.ok(ev, "英雄已经全下、牌还没发完，就必须能拍到快照");
  assert.equal(ev.street, "flop", "快照要记在钱进池子的那条街");
  assert.equal(ev.method, "exact");
  assert.equal(ev.heroCommitted, 100);
});

test("multiway all-in history records starting stacks, commitments, cards, and each contested pot", () => {
  const heroCards = ["As", "Ad"];
  const middleCards = ["Ks", "Kd"];
  const deepCards = ["Qs", "Qd"];
  const boardCodes = ["2c", "3d", "4h", "9s", "Jc"];
  const state = {
    handNo: 18,
    dealerIndex: 0,
    players: [
      {
        id: "hero",
        name: "登邓灯",
        isHero: true,
        hole: heroCards.map(card),
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 0,
        totalCommitted: 200,
        acted: true,
        lastAction: "all-in to 100BB",
        result: 0,
        position: "BTN",
      },
      {
        id: "middle",
        name: "Volcano",
        isHero: false,
        hole: middleCards.map(card),
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 0,
        totalCommitted: 502,
        acted: true,
        lastAction: "all-in to 251BB",
        result: 0,
        position: "CO",
      },
      {
        id: "deep",
        name: "老陈",
        isHero: false,
        hole: deepCards.map(card),
        folded: false,
        allIn: false,
        stack: 202,
        streetBet: 0,
        totalCommitted: 502,
        acted: false,
        lastAction: "",
        result: 0,
        position: "UTG+1",
      },
    ],
    deck: remainingDeck([
      ...heroCards,
      ...middleCards,
      ...deepCards,
      ...boardCodes,
    ]),
    community: boardCodes.map(card),
    street: "river",
    pot: 1204,
    currentBet: 0,
    minRaise: 2,
    actingIndex: 2,
    actions: [],
    message: "",
    handComplete: false,
    revealed: [],
    winners: [],
    startingStacks: {
      hero: 200,
      middle: 502,
      deep: 704,
    },
    potResults: [],
    heroStartStack: 200,
    heroAllInEv: null,
  };

  const finished = applyAction(state, "check");
  assert.equal(finished.handComplete, true);
  assert.equal(finished.pot, 1204);
  assert.deepEqual(
    finished.potResults.map((pot) => [pot.kind, pot.amount, pot.winners]),
    [
      ["main", 600, ["hero"]],
      ["side", 604, ["middle"]],
    ],
  );

  const log = compactHandLog(finished);
  // Seats carry their persona name so a review never has to guess who sat where.
  assert.match(log, /Stacks BTN\(hero\):\S+ 100BB; CO:\S+ 251BB; UTG\+1:\S+ 352BB/);
  assert.match(log, /Eff\(hero\) CO 100BB; UTG\+1 100BB/);
  assert.match(
    log,
    /Committed BTN\(hero\) 100BB \[all-in\]; CO 251BB \[all-in\]; UTG\+1 251BB/,
  );
  assert.match(log, /Cards BTN\(hero\)=AsAd; CO=KsKd; UTG\+1=QsQd/);
  assert.match(log, /Main 300BB -> BTN\(hero\):登邓灯 300BB/);
  assert.match(log, /Side 1 302BB -> CO:Volcano 302BB/);
  assert.match(log, /UTG\+1 check/);
  assert.doesNotMatch(log, /Uncalled return/);
});

test("a preflop shove records both the raise number and that the player is all-in", () => {
  const priorActions = [5, 19, 49, 157].map((toAmount, index) => ({
    street: "preflop",
    playerId: `p${index}`,
    position: ["CO", "BTN", "UTG+1", "CO"][index],
    name: `P${index}`,
    kind: "raise",
    amount: toAmount,
    toAmount,
    facedBet: index === 0 ? 2 : [5, 19, 49][index - 1],
    allInAfterAction: false,
    potBefore: 0,
    label: ["open to 2.5BB", "3bet to 9.5BB", "4bet to 24.5BB", "5bet to 78.5BB"][index],
  }));
  const state = {
    handNo: 19,
    dealerIndex: 0,
    players: [
      {
        id: "hero",
        name: "登邓灯",
        isHero: true,
        hole: [card("Ad"), card("Kd")],
        folded: false,
        allIn: false,
        stack: 181,
        streetBet: 19,
        totalCommitted: 19,
        acted: false,
        lastAction: "",
        result: 0,
        position: "BTN",
      },
      {
        id: "villain",
        name: "Volcano",
        isHero: false,
        hole: [card("Qs"), card("Qd")],
        folded: false,
        allIn: false,
        stack: 343,
        streetBet: 157,
        totalCommitted: 157,
        acted: true,
        lastAction: "5bet to 78.5BB",
        result: 0,
        position: "CO",
      },
    ],
    deck: remainingDeck(["Ad", "Kd", "Qs", "Qd"]),
    community: [],
    street: "preflop",
    pot: 0,
    currentBet: 157,
    minRaise: 108,
    actingIndex: 0,
    actions: priorActions,
    message: "",
    handComplete: false,
    revealed: [],
    winners: [],
    startingStacks: { hero: 200, villain: 500 },
    potResults: [],
    heroStartStack: 200,
    heroAllInEv: null,
  };

  const next = applyAction(state, "allin");
  assert.equal(next.actions.at(-1).label, "6bet all-in to 100BB");
  assert.equal(next.actions.at(-1).allInAfterAction, true);
});

test("folded contributions do not create fake side pots", () => {
  const boardCodes = ["2c", "3d", "4h", "9s", "Jc"];
  const state = {
    handNo: 20,
    dealerIndex: 0,
    players: [
      {
        id: "hero",
        name: "登邓灯",
        isHero: true,
        hole: [card("7s"), card("6s")],
        folded: true,
        allIn: false,
        stack: 199,
        streetBet: 0,
        totalCommitted: 1,
        acted: true,
        lastAction: "fold",
        result: 0,
        position: "SB",
      },
      {
        id: "blind",
        name: "Atlas",
        isHero: false,
        hole: [card("8s"), card("8d")],
        folded: true,
        allIn: false,
        stack: 198,
        streetBet: 0,
        totalCommitted: 2,
        acted: true,
        lastAction: "fold",
        result: 0,
        position: "BB",
      },
      {
        id: "short",
        name: "Volcano",
        isHero: false,
        hole: [card("As"), card("Ad")],
        folded: false,
        allIn: true,
        stack: 0,
        streetBet: 0,
        totalCommitted: 10,
        acted: true,
        lastAction: "all-in to 5BB",
        result: 0,
        position: "CO",
      },
      {
        id: "caller",
        name: "老陈",
        isHero: false,
        hole: [card("Ks"), card("Kd")],
        folded: false,
        allIn: false,
        stack: 90,
        streetBet: 0,
        totalCommitted: 10,
        acted: false,
        lastAction: "",
        result: 0,
        position: "BTN",
      },
    ],
    deck: remainingDeck([
      "7s",
      "6s",
      "8s",
      "8d",
      "As",
      "Ad",
      "Ks",
      "Kd",
      ...boardCodes,
    ]),
    community: boardCodes.map(card),
    street: "river",
    pot: 23,
    currentBet: 0,
    minRaise: 2,
    actingIndex: 3,
    actions: [],
    message: "",
    handComplete: false,
    revealed: [],
    winners: [],
    startingStacks: { hero: 200, blind: 200, short: 10, caller: 100 },
    potResults: [],
    heroStartStack: 200,
    heroAllInEv: null,
  };

  const finished = applyAction(state, "check");
  assert.deepEqual(
    finished.potResults.map((pot) => [pot.kind, pot.amount, pot.eligible]),
    [["main", 23, ["short", "caller"]]],
  );
});

test("a lone player cannot bet into opponents who are already all-in", () => {
  const state = startHand();
  const hero = state.players.find((player) => player.id === "hero");
  state.players = state.players.map((player) => ({
    ...player,
    folded: !["hero", "gto"].includes(player.id),
    allIn: player.id === "gto",
    streetBet: 0,
  }));
  state.currentBet = 0;
  assert.deepEqual(legalActions(state, state.players.find((player) => player.id === hero.id)), [
    "check",
  ]);
});

test("a short all-in does not reopen raising for a player who already acted", () => {
  const state = startHand();
  state.players = state.players.slice(0, 3).map((player, index) => ({
    ...player,
    folded: false,
    allIn: false,
    stack: index === 1 ? 50 : 300,
    streetBet: 100,
    totalCommitted: 100,
    acted: index === 0,
    raiseLocked: false,
  }));
  state.actingIndex = 1;
  state.currentBet = 100;
  state.minRaise = 100;

  const next = applyAction(state, "allin");
  const priorCaller = next.players[0];
  assert.equal(priorCaller.raiseLocked, true);
  assert.deepEqual(legalActions(next, priorCaller), ["fold", "call"]);
});

test("fold award separates the winner's uncalled excess from the contested pot", () => {
  const state = startHand();
  state.players = state.players.slice(0, 2).map((player, index) => ({
    ...player,
    folded: false,
    allIn: false,
    stack: index === 0 ? 100 : 80,
    streetBet: index === 0 ? 100 : 20,
    totalCommitted: index === 0 ? 100 : 20,
    acted: index === 0,
    raiseLocked: false,
  }));
  state.pot = 40;
  state.currentBet = 100;
  state.minRaise = 80;
  state.actingIndex = 1;

  const finished = applyAction(state, "fold");
  assert.equal(finished.pot, 80);
  assert.deepEqual(
    finished.potResults.map((pot) => [pot.kind, pot.amount]),
    [
      ["main", 80],
      ["return", 80],
    ],
  );
  assert.equal(finished.players[0].result, 60);
});

test("all-in runout streets remain in the compact hand history without actions", () => {
  const state = startHand();
  state.community = ["2c", "3d", "4h", "5s", "6c"].map(card);
  state.actions = [];
  state.players = state.players.map((player) => ({
    ...player,
    folded: player.id !== "hero",
  }));
  state.handComplete = true;
  state.street = "showdown";
  state.winners = ["hero"];
  state.revealed = ["hero"];
  state.potResults = [];

  const log = compactHandLog(state);
  assert.match(log, /F 2c3d4h/);
  assert.match(log, /T 5s/);
  assert.match(log, /R 6c/);
});

test("bot observation includes public stack context without leaking opponent cards", () => {
  const state = startHand();
  state.actions = [
    {
      street: "preflop",
      playerId: "boss",
      position: "CO",
      name: "钱老板",
      kind: "raise",
      amount: 6,
      toAmount: 6,
      facedBet: 2,
      allInAfterAction: false,
      potBefore: 3,
      label: "open to 3BB",
    },
  ];
  const player = state.players.find((candidate) => candidate.id === "gto");
  const observation = botObservation(state, player);
  assert.equal(observation.raiseCountThisStreet, 1);
  assert.equal(observation.blinds.bigBlind, 2);
  assert.equal(observation.publicPlayers.length, 8);
  assert.ok(observation.publicPlayers.every((publicPlayer) => !("hole" in publicPlayer)));
  assert.ok(observation.publicPlayers.every((publicPlayer) => "startingStack" in publicPlayer));
});

test("local personality engine folds KJs when facing a four-bet", () => {
  const state = startHand();
  const playerIndex = state.players.findIndex((player) => player.id === "boss");
  state.players = state.players.map((player, index) => ({
    ...player,
    folded: ![0, playerIndex].includes(index),
  }));
  state.players[playerIndex].hole = [card("Ks"), card("Js")];
  state.players[playerIndex].streetBet = 12;
  state.players[playerIndex].stack = 488;
  state.players[playerIndex].acted = false;
  state.actingIndex = playerIndex;
  state.currentBet = 48;
  state.minRaise = 24;
  state.actions = [6, 18, 48].map((toAmount, index) => ({
    street: "preflop",
    playerId: `raiser-${index}`,
    position: ["CO", "BTN", "SB"][index],
    name: `Raiser ${index}`,
    kind: "raise",
    amount: toAmount,
    toAmount,
    facedBet: index === 0 ? 2 : [6, 18][index - 1],
    allInAfterAction: false,
    potBefore: 3,
    label: ["open to 3BB", "3bet to 9BB", "4bet to 24BB"][index],
  }));

  assert.deepEqual(localBotDecision(state, state.players[playerIndex]), { action: "fold" });
});

test("the hand log names every seat and can carry the AI reasoning trail", async () => {
  const { compactHandLog: log, startHand: deal } = await import("../app/lib/poker.ts");
  const state = deal();
  const plain = log(state);
  // Every seat should be identifiable by persona, not just by position (H#0017 review gap).
  for (const player of state.players) {
    assert.ok(
      plain.includes(`${player.position}${player.isHero ? "(hero)" : ""}:${player.name}`),
      `${player.name} missing from the stacks line`,
    );
  }
  assert.equal(plain.split("\n").length, 1, "没有理由时就该是干干净净的一行");

  /*
   * 理由不再挤进 H# 那一行。以前是 `| Why a | b | c`，为了不让那一行失控，调用方把每条砍到
   * 72 字、每手只留 12 条——两刀砍掉的都是已经从模型那里拿到手的内容。现在每条占一行，
   * 想写多长写多长，而 H# 行本身一个字都没变，`analyze-log.mjs` 照常解析。
   */
  const long = "翻牌 K72 彩虹，我在按钮位有范围优势，1/3 池的持续下注可以让所有小对子和 A 高牌做决定，" +
    "而且这桌的大盲跟得很松，被抓的风险低于我拿到的弃牌率";
  assert.ok(long.length > 72, "样例理由必须超过旧的 72 字上限，否则这条测试什么也没验证");
  const reasons = Array.from({ length: 30 }, (_, i) => `F BTN Volcano bet ${i}BB — ${long}`);
  assert.ok(reasons.length > 12, "条数必须超过旧的 12 条上限");

  const withWhy = log(state, "DS:3 RT:0 OV:0 LF:0", { reasons });
  const lines = withWhy.split("\n");
  assert.match(lines[0], /\| Src DS:3 RT:0 OV:0 LF:0$/, "H# 行结尾不变，理由不再挂在后面");
  assert.equal(lines.length, 1 + reasons.length, "每条理由各占一行，一条都不许丢");
  reasons.forEach((reason, index) => {
    assert.equal(lines[index + 1], `  - ${reason}`, `第 ${index + 1} 条理由被改写或截断了`);
  });
  // 缩进让牌谱分析脚本自动跳过这些行：它只认顶格的 H#。
  assert.equal(lines.slice(1).filter((line) => line.startsWith("H#")).length, 0);
});

test("board texture is classified for the model instead of left to card-code parsing", async () => {
  const { describeBoard } = await import("../app/lib/poker.ts");
  const board = (codes) => codes.match(/../g).map(card);

  // The reviewer's example: T-heart 3-spade 6-heart was reported by the model as "T63r".
  const twoTone = describeBoard(board("Th3s6h"));
  assert.equal(twoTone.rainbow, false, "two hearts is not a rainbow board");
  assert.equal(twoTone.twoTone, true);
  assert.equal(twoTone.maxSuitCount, 2);
  assert.match(twoTone.summary, /two-tone/);

  assert.equal(describeBoard(board("Th3s6c")).rainbow, true);

  // A turn that completes a flush must say so — it is not "just a scare card".
  const completed = describeBoard(board("Ah3d8h4h"));
  assert.equal(completed.flushPossible, true);
  assert.match(completed.lastCardEffect, /third heart/);
  assert.match(completed.lastCardEffect, /flush is now possible/);

  // H#0017's board: paired AND three spades by the turn.
  const h17 = describeBoard(board("JcJsTsQs"));
  assert.equal(h17.paired, true);
  assert.equal(h17.flushPossible, true);
  assert.match(h17.lastCardEffect, /highest card/);

  assert.equal(describeBoard(board("9h8h7h")).monotone, true);
  assert.equal(describeBoard([card("2c"), card("5d")]), undefined, "no texture before the flop");
});

test("the observation carries pre-computed texture from the flop onward", async () => {
  const { startHand: deal, botObservation: observe } = await import("../app/lib/poker.ts");
  const state = deal();
  const preflop = observe(state, state.players[state.actingIndex]);
  assert.equal(preflop.boardTexture, undefined);

  state.community = [card("Th"), card("3s"), card("6h")];
  const flop = observe(state, state.players[state.actingIndex]);
  assert.ok(flop.boardTexture);
  assert.equal(flop.boardTexture.rainbow, false);
});
