import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  calculateHeroAllInEv,
  compactHandLog,
  heroEvSummary,
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

test("preflop all-in EV is explicitly labeled as a 25,000-run simulation", () => {
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
  assert.equal(ev.method, "monte-carlo");
  assert.equal(ev.trials, 25_000);
  assert.ok(ev.standardError > 0);
});

test("multiway all-in history records starting stacks, commitments, cards, and each pot", () => {
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

  const finished = applyAction(state, "allin");
  assert.equal(finished.handComplete, true);
  assert.equal(finished.pot, 1204);
  assert.deepEqual(
    finished.potResults.map((pot) => [pot.kind, pot.amount, pot.winners]),
    [
      ["main", 600, ["hero"]],
      ["side", 604, ["middle"]],
      ["return", 202, ["deep"]],
    ],
  );

  const log = compactHandLog(finished);
  assert.match(log, /Stacks BTN\(hero\) 100BB; CO 251BB; UTG\+1 352BB/);
  assert.match(log, /Eff\(hero\) CO 100BB; UTG\+1 100BB/);
  assert.match(
    log,
    /Committed BTN\(hero\) 100BB \[all-in\]; CO 251BB \[all-in\]; UTG\+1 352BB \[all-in\]/,
  );
  assert.match(log, /Cards BTN\(hero\)=AsAd; CO=KsKd; UTG\+1=QsQd/);
  assert.match(log, /Main 300BB -> BTN\(hero\):登邓灯 300BB/);
  assert.match(log, /Side 1 302BB -> CO:Volcano 302BB/);
  assert.match(log, /Uncalled return 101BB -> UTG\+1:老陈 101BB/);
  assert.match(log, /UTG\+1 bet all-in 101BB/);
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
