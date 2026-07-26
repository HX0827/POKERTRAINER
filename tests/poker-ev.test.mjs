import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  calculateHeroAllInEv,
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
