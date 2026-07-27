// CONTRACT-V2 §一 acceptance suite.
//
// V2 loosened the guardrail from "police every decision" to "block the two
// lethal lines". Preflop is never a veto any more (only silent size clamps),
// and postflop only POST-CALL-ALLIN and POST-JAM-EQUITY can fire. Cases 1-9 are
// the original V1 fixtures kept verbatim with their V2 verdicts; case 5 and
// case 9 are the two "乱玩" hands (H#0004 / H#0003) that must still be vetoed.

import assert from "node:assert/strict";
import test from "node:test";

import { checkDecision, describeHandClass, suggestSafeAction } from "../app/lib/strategy.ts";
import { PERSONAS } from "../app/lib/poker.ts";

// All fixtures are in CHIPS (SB = 1, BB = 2); design-doc numbers are in BB.
const SMALL_BLIND = 1;
const BIG_BLIND = 2;

function traits(id) {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  assert.ok(persona, `persona ${id} is missing from PERSONAS`);
  return {
    id: persona.id,
    looseness: persona.looseness,
    aggression: persona.aggression,
    bluff: persona.bluff,
  };
}

function profile(overrides) {
  return {
    position: "LJ",
    name: "对手",
    allIn: false,
    totalCommitted: 0,
    preflopAggression: 0,
    calledRaisePreflop: false,
    bigAggressionThisStreet: false,
    ...overrides,
  };
}

function publicPlayer(overrides) {
  return {
    name: "对手",
    position: "LJ",
    stack: 0,
    startingStack: 0,
    streetBet: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    acted: true,
    lastAction: "",
    ...overrides,
  };
}

function makeObservation(overrides = {}) {
  return {
    handNo: 4,
    street: "preflop",
    position: "BB",
    holeCards: ["Ac", "8s"],
    communityCards: [],
    stack: 358,
    startingStack: 360,
    effectiveStack: 360,
    pot: 3,
    streetBet: BIG_BLIND,
    toCall: 0,
    potOddsToCall: 0,
    spr: 0,
    currentBet: BIG_BLIND,
    minRaise: BIG_BLIND,
    minimumRaiseTo: 4,
    maximumRaiseTo: 360,
    legalActions: ["fold", "call", "raise", "allin"],
    publicActions: [],
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 0,
    opponentProfiles: [],
    blinds: { smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND },
    publicPlayers: [],
    ...overrides,
  };
}

/** A pass must be silent: no rule, no detail. */
function assertClean(verdict) {
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rule, undefined);
  assert.equal(verdict.detail, undefined);
}

// H#0004 preflop: LJ opens to 8, BTN 3-bets to 24, BB holds only the posted blind.
// Pot 35 = SB 1 + BB 2 + LJ 8 + BTN 24. Required equity 22/57 ~= 38.6%.
function bbColdVersusThreeBet() {
  return makeObservation({
    position: "BB",
    holeCards: ["Ac", "8s"],
    stack: 358,
    startingStack: 360,
    effectiveStack: 360,
    pot: 35,
    streetBet: BIG_BLIND,
    toCall: 22,
    potOddsToCall: 22 / (35 + 22),
    spr: 358 / 35,
    currentBet: 24,
    minRaise: 16,
    minimumRaiseTo: 40,
    maximumRaiseTo: 360,
    playersRemaining: 3,
    opponentsAbleToAct: 2,
    raiseCountThisStreet: 2,
    opponentProfiles: [
      profile({ position: "LJ", name: "火山", preflopAggression: 1, totalCommitted: 8 }),
      profile({ position: "BTN", name: "老板", preflopAggression: 2, totalCommitted: 24 }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 358,
        startingStack: 360,
        streetBet: 2,
        totalCommitted: 2,
        acted: false,
        lastAction: "post BB",
      }),
      publicPlayer({
        position: "LJ",
        name: "火山",
        stack: 967,
        startingStack: 975,
        streetBet: 8,
        totalCommitted: 8,
        lastAction: "open to 4BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 376,
        startingStack: 400,
        streetBet: 24,
        totalCommitted: 24,
        lastAction: "3bet to 12BB",
      }),
    ],
  });
}

// H#0004 flop 3s Td 2s, LJ jams 903 into 169 (nominal 5.3x pot, effective 288 = 1.7x pot).
// Pot 1072 = 169 + 903. Effective price 288/745 ~= 38.7% (naive pot odds would say 45.7%).
function bbFacingFlopJam() {
  return makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["Ac", "8s"],
    communityCards: ["3s", "Td", "2s"],
    stack: 288,
    startingStack: 360,
    effectiveStack: 360,
    pot: 1072,
    streetBet: 0,
    toCall: 903,
    potOddsToCall: 903 / (1072 + 903),
    spr: 288 / 1072,
    currentBet: 903,
    minRaise: 903,
    minimumRaiseTo: 288,
    maximumRaiseTo: 288,
    legalActions: ["fold", "call"],
    playersRemaining: 2,
    opponentsAbleToAct: 0,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({
        position: "LJ",
        name: "火山",
        preflopAggression: 3,
        bigAggressionThisStreet: true,
        allIn: true,
        totalCommitted: 975,
      }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 288,
        startingStack: 360,
        streetBet: 0,
        totalCommitted: 72,
        acted: false,
        lastAction: "call 36BB",
      }),
      publicPlayer({
        position: "LJ",
        name: "火山",
        stack: 0,
        startingStack: 975,
        streetBet: 903,
        totalCommitted: 975,
        allIn: true,
        lastAction: "all-in 451.5BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 376,
        startingStack: 400,
        streetBet: 0,
        totalCommitted: 24,
        folded: true,
        lastAction: "fold",
      }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Cases 1-9 — the V1 fixtures with their V2 verdicts                  */
/* ------------------------------------------------------------------ */

test("case 1 — BB A8o cold-calling a 3-bet is allowed (V2 drops every preflop range veto)", () => {
  const verdict = checkDecision(bbColdVersusThreeBet(), traits("station"), { action: "call" });
  assertClean(verdict);
  // The old PF-COLD-VS-3BET path is gone: a station is allowed to be a station.
  assert.equal(verdict.numbers.engineEquity, null);
});

test("case 2 — BB A8o calling a 4-bet is allowed", () => {
  // BB called the 3-bet (streetBet 24) and now faces LJ's 4-bet to 72; BTN folded.
  // Pot 121 = SB 1 + BB 24 + LJ 72 + BTN 24. Price 48/169 ~= 28.4%.
  const observation = makeObservation({
    position: "BB",
    holeCards: ["Ac", "8s"],
    stack: 336,
    startingStack: 360,
    effectiveStack: 360,
    pot: 121,
    streetBet: 24,
    toCall: 48,
    potOddsToCall: 48 / (121 + 48),
    spr: 336 / 121,
    currentBet: 72,
    minRaise: 48,
    minimumRaiseTo: 120,
    maximumRaiseTo: 360,
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 3,
    opponentProfiles: [
      profile({ position: "LJ", name: "火山", preflopAggression: 3, totalCommitted: 72 }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 336,
        startingStack: 360,
        streetBet: 24,
        totalCommitted: 24,
        acted: false,
        lastAction: "call 12BB",
      }),
      publicPlayer({
        position: "LJ",
        name: "火山",
        stack: 903,
        startingStack: 975,
        streetBet: 72,
        totalCommitted: 72,
        lastAction: "4bet to 36BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 376,
        startingStack: 400,
        streetBet: 24,
        totalCommitted: 24,
        folded: true,
        lastAction: "fold",
      }),
    ],
  });

  assertClean(checkDecision(observation, traits("station"), { action: "call" }));
});

test("case 3 — maniac A5s 4-bet over a 3-bet is allowed, size clamped silently", () => {
  // LJ opened to 8, BTN 3-bet to 24, BB called; pot 57 = SB 1 + BB 24 + LJ 8 + BTN 24.
  const observation = makeObservation({
    position: "LJ",
    holeCards: ["Ad", "5d"],
    stack: 191,
    startingStack: 199,
    effectiveStack: 199,
    pot: 57,
    streetBet: 8,
    toCall: 16,
    potOddsToCall: 16 / (57 + 16),
    spr: 191 / 57,
    currentBet: 24,
    minRaise: 16,
    minimumRaiseTo: 40,
    maximumRaiseTo: 199,
    playersRemaining: 3,
    opponentsAbleToAct: 2,
    raiseCountThisStreet: 2,
    opponentProfiles: [
      profile({ position: "BTN", name: "老板", preflopAggression: 2, totalCommitted: 24 }),
      profile({
        position: "BB",
        name: "老陈",
        preflopAggression: 0,
        calledRaisePreflop: true,
        totalCommitted: 24,
      }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "LJ",
        name: "火山",
        stack: 191,
        startingStack: 199,
        streetBet: 8,
        totalCommitted: 8,
        acted: true,
        lastAction: "open to 4BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 175,
        startingStack: 199,
        streetBet: 24,
        totalCommitted: 24,
        lastAction: "3bet to 12BB",
      }),
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 175,
        startingStack: 199,
        streetBet: 24,
        totalCommitted: 24,
        lastAction: "call 12BB",
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("maniac"), { action: "raise", raiseTo: 72 });
  assertClean(verdict);
  // 4-bet band is 2.2x-2.8x the 3-bet: 72 is above 2.8 * 24 = 67.2 -> pulled to 67.
  assert.equal(verdict.clampedRaiseTo, 67);
});

test("case 4 — maniac jamming 903 into a 169 pot is allowed while BB can still fold", () => {
  // Nominal 5.3x pot, effective 288 (BB's stack behind) = 1.7x pot. BB is NOT all-in,
  // so there is fold equity to buy and the bluff is a legal line for this persona.
  const observation = makeObservation({
    street: "flop",
    position: "LJ",
    holeCards: ["Ad", "5d"],
    communityCards: ["3s", "Td", "2s"],
    stack: 903,
    startingStack: 975,
    effectiveStack: 360,
    pot: 169,
    streetBet: 0,
    toCall: 0,
    potOddsToCall: 0,
    spr: 903 / 169,
    currentBet: 0,
    minRaise: BIG_BLIND,
    minimumRaiseTo: BIG_BLIND,
    maximumRaiseTo: 903,
    legalActions: ["check", "raise", "allin"],
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 0,
    opponentProfiles: [
      profile({
        position: "BB",
        name: "老陈",
        preflopAggression: 0,
        calledRaisePreflop: true,
        allIn: false,
        totalCommitted: 72,
      }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "LJ",
        name: "火山",
        stack: 903,
        startingStack: 975,
        streetBet: 0,
        totalCommitted: 72,
        acted: false,
        lastAction: "4bet to 36BB",
      }),
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 288,
        startingStack: 360,
        streetBet: 0,
        totalCommitted: 72,
        acted: false,
        lastAction: "call 36BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 376,
        startingStack: 400,
        streetBet: 0,
        totalCommitted: 24,
        folded: true,
        lastAction: "fold",
      }),
    ],
  });

  assertClean(checkDecision(observation, traits("maniac"), { action: "allin" }));
});

test("case 5 — station calling off 288 versus the flop jam is still vetoed (H#0004)", () => {
  const verdict = checkDecision(bbFacingFlopJam(), traits("station"), { action: "call" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "POST-CALL-ALLIN");
  // The whole remaining stack, no implied odds (villain is all-in), 12+ points short.
  assert.ok(verdict.numbers.engineEquity < verdict.numbers.requiredEquity - 0.12);
  assert.ok(verdict.numbers.outs < 8);
  assert.match(verdict.detail, /fold/);
});

test("case 6 — AA jamming over a 4-bet is always allowed", () => {
  // LJ opened to 8, CO 3-bet to 24, BTN 4-bet to 72, LJ folded. Pot 107 = 1 + 2 + 8 + 24 + 72.
  const observation = makeObservation({
    handNo: 12,
    position: "CO",
    holeCards: ["As", "Ah"],
    stack: 376,
    startingStack: 400,
    effectiveStack: 400,
    pot: 107,
    streetBet: 24,
    toCall: 48,
    potOddsToCall: 48 / (107 + 48),
    spr: 376 / 107,
    currentBet: 72,
    minRaise: 48,
    minimumRaiseTo: 120,
    maximumRaiseTo: 400,
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 3,
    opponentProfiles: [
      profile({ position: "BTN", name: "老板", preflopAggression: 3, totalCommitted: 72 }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "CO",
        name: "岩石",
        stack: 376,
        startingStack: 400,
        streetBet: 24,
        totalCommitted: 24,
        acted: false,
        lastAction: "3bet to 12BB",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 328,
        startingStack: 400,
        streetBet: 72,
        totalCommitted: 72,
        lastAction: "4bet to 36BB",
      }),
      publicPlayer({
        position: "LJ",
        name: "猎手",
        stack: 232,
        startingStack: 240,
        streetBet: 8,
        totalCommitted: 8,
        folded: true,
        lastAction: "fold",
      }),
    ],
  });

  assertClean(checkDecision(observation, traits("rock"), { action: "allin" }));
});

test("case 7 — maniac opening 76s on the BTN in an unopened pot stays allowed", () => {
  const observation = makeObservation({
    handNo: 7,
    position: "BTN",
    holeCards: ["7h", "6h"],
    stack: 600,
    startingStack: 600,
    effectiveStack: 360,
    pot: 3,
    streetBet: 0,
    toCall: BIG_BLIND,
    potOddsToCall: 2 / (3 + 2),
    spr: 600 / 3,
    currentBet: BIG_BLIND,
    minRaise: BIG_BLIND,
    minimumRaiseTo: 4,
    maximumRaiseTo: 600,
    playersRemaining: 3,
    opponentsAbleToAct: 2,
    raiseCountThisStreet: 0,
    opponentProfiles: [
      profile({ position: "SB", name: "岩石", preflopAggression: 0, totalCommitted: 1 }),
      profile({ position: "BB", name: "老陈", preflopAggression: 0, totalCommitted: 2 }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BTN",
        name: "火山",
        stack: 600,
        startingStack: 600,
        streetBet: 0,
        totalCommitted: 0,
        acted: false,
        lastAction: "",
      }),
      publicPlayer({
        position: "SB",
        name: "岩石",
        stack: 159,
        startingStack: 160,
        streetBet: 1,
        totalCommitted: 1,
        acted: false,
        lastAction: "post SB",
      }),
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 358,
        startingStack: 360,
        streetBet: 2,
        totalCommitted: 2,
        acted: false,
        lastAction: "post BB",
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("maniac"), { action: "raise", raiseTo: 5 });
  assertClean(verdict);
  // 5 already sits inside the 4.4-8 open band, so nothing is touched.
  assert.equal(verdict.clampedRaiseTo, undefined);
});

test("case 8 — station BB defending A8o against a single open stays allowed", () => {
  // CO opens to 5, pot 8 = SB 1 + BB 2 + CO 5, price 3/11 ~= 27.3%.
  const observation = makeObservation({
    handNo: 8,
    position: "BB",
    holeCards: ["Ac", "8s"],
    stack: 358,
    startingStack: 360,
    effectiveStack: 240,
    pot: 8,
    streetBet: BIG_BLIND,
    toCall: 3,
    potOddsToCall: 3 / (8 + 3),
    spr: 358 / 8,
    currentBet: 5,
    minRaise: 3,
    minimumRaiseTo: 8,
    maximumRaiseTo: 360,
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({ position: "CO", name: "猎手", preflopAggression: 1, totalCommitted: 5 }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 358,
        startingStack: 360,
        streetBet: 2,
        totalCommitted: 2,
        acted: false,
        lastAction: "post BB",
      }),
      publicPlayer({
        position: "CO",
        name: "猎手",
        stack: 235,
        startingStack: 240,
        streetBet: 5,
        totalCommitted: 5,
        lastAction: "open to 2.5BB",
      }),
    ],
  });

  assertClean(checkDecision(observation, traits("station"), { action: "call" }));
});

test("case 9 — station calling a turn overbet all-in with no equity is still vetoed (H#0003)", () => {
  // H#0003 shape: villain jams 45 into a 15 pot (3x pot). Pot 60 already contains the jam.
  // Hero has 200 behind but the effective stack is only 53, so this call is ~85% of the
  // money still at risk in the hand — the guardrail's "expensive mistake" gate.
  const observation = makeObservation({
    handNo: 3,
    street: "turn",
    position: "BB",
    holeCards: ["Ah", "7c"],
    communityCards: ["Kd", "8c", "2h", "Qs"],
    stack: 200,
    startingStack: 207,
    effectiveStack: 53,
    pot: 60,
    streetBet: 0,
    toCall: 45,
    potOddsToCall: 45 / (60 + 45),
    spr: 200 / 60,
    currentBet: 45,
    minRaise: 45,
    minimumRaiseTo: 90,
    maximumRaiseTo: 200,
    legalActions: ["fold", "call"],
    playersRemaining: 2,
    opponentsAbleToAct: 0,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({
        position: "BTN",
        name: "老板",
        preflopAggression: 1,
        bigAggressionThisStreet: true,
        allIn: true,
        totalCommitted: 53,
      }),
    ],
    publicPlayers: [
      publicPlayer({
        position: "BB",
        name: "老陈",
        stack: 200,
        startingStack: 207,
        streetBet: 0,
        totalCommitted: 7,
        acted: false,
        lastAction: "check",
      }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 0,
        startingStack: 53,
        streetBet: 45,
        totalCommitted: 53,
        allIn: true,
        lastAction: "all-in 22.5BB",
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("station"), { action: "call" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "POST-CALL-ALLIN");
  assert.ok(verdict.numbers.engineEquity < verdict.numbers.requiredEquity - 0.12);
  assert.equal(verdict.numbers.outs, 3); // river: only the A-high overcard outs, no draw
});

/* ------------------------------------------------------------------ */
/* New V2 boundary cases                                               */
/* ------------------------------------------------------------------ */

test("case 10 — calling off the whole stack with ~3% equity in front of an all-in is vetoed", () => {
  // 72o on A K Q rainbow: no draw, no outs, villain 4-bet then jammed.
  const observation = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["7c", "2d"],
    communityCards: ["Ah", "Kd", "Qc"],
    stack: 200,
    startingStack: 300,
    effectiveStack: 300,
    pot: 300,
    streetBet: 0,
    toCall: 200,
    potOddsToCall: 200 / 500,
    spr: 200 / 300,
    currentBet: 200,
    minRaise: 200,
    minimumRaiseTo: 200,
    maximumRaiseTo: 200,
    legalActions: ["fold", "call"],
    playersRemaining: 2,
    opponentsAbleToAct: 0,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({ position: "BTN", name: "老板", preflopAggression: 3, allIn: true, totalCommitted: 300 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "老陈", stack: 200, startingStack: 300, totalCommitted: 100 }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 0,
        startingStack: 300,
        streetBet: 200,
        totalCommitted: 300,
        allIn: true,
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("station"), { action: "call" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "POST-CALL-ALLIN");
  assert.ok(verdict.numbers.engineEquity < 0.1, `equity ${verdict.numbers.engineEquity}`);
  assert.equal(verdict.numbers.outs, 0);
});

test("case 11 — calling 30% of the stack while only ~7 points short of the price is allowed", () => {
  // QJo on K 8 3: 90 into an effective pot of 250 needs 36%, the hand has ~29%.
  // Expensive enough to clear the 25% commitment gate, but inside the 12-point margin.
  const observation = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["Qc", "Jd"],
    communityCards: ["Kh", "8s", "3d"],
    stack: 300,
    startingStack: 370,
    effectiveStack: 300,
    pot: 160,
    streetBet: 0,
    toCall: 90,
    potOddsToCall: 90 / 250,
    spr: 300 / 160,
    currentBet: 90,
    minRaise: 90,
    minimumRaiseTo: 180,
    maximumRaiseTo: 300,
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({ position: "CO", name: "猎手", preflopAggression: 1, totalCommitted: 70 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "老陈", stack: 300, startingStack: 370, totalCommitted: 70 }),
      publicPlayer({
        position: "CO",
        name: "猎手",
        stack: 210,
        startingStack: 370,
        streetBet: 90,
        totalCommitted: 160,
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("station"), { action: "call" });
  assertClean(verdict);
  const { requiredEquity, engineEquity } = verdict.numbers;
  // The call is genuinely -EV on raw pot odds; V2 lets it through anyway.
  assert.ok(engineEquity < requiredEquity, `${engineEquity} should be under ${requiredEquity}`);
  assert.ok(engineEquity >= requiredEquity - 0.12, `${engineEquity} should be within 12 points`);
});

/** 76hh on Ah Kh 2c facing a 600 overbet into 640 — 9 outs, ~31% vs ~48% needed. */
function flushDrawFacingOverbet({ villainAllIn }) {
  return makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["7h", "6h"],
    communityCards: ["Ah", "Kh", "2c"],
    stack: 700,
    startingStack: 730,
    effectiveStack: villainAllIn ? 630 : 700,
    pot: 640,
    streetBet: 0,
    toCall: 600,
    potOddsToCall: 600 / 1240,
    spr: 700 / 640,
    currentBet: 600,
    minRaise: 600,
    minimumRaiseTo: 1200,
    maximumRaiseTo: 700,
    legalActions: villainAllIn ? ["fold", "call"] : ["fold", "call", "raise", "allin"],
    playersRemaining: 2,
    opponentsAbleToAct: villainAllIn ? 0 : 1,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({
        position: "CO",
        name: "老板",
        preflopAggression: 3,
        bigAggressionThisStreet: true,
        allIn: villainAllIn,
        totalCommitted: 630,
      }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "老陈", stack: 700, startingStack: 730, totalCommitted: 30 }),
      publicPlayer({
        position: "CO",
        name: "老板",
        stack: villainAllIn ? 0 : 250,
        startingStack: villainAllIn ? 630 : 880,
        streetBet: 600,
        totalCommitted: 630,
        allIn: villainAllIn,
      }),
    ],
  });
}

test("case 12 — a 9-out draw calling a big bet from an opponent who is NOT all-in is allowed", () => {
  const verdict = checkDecision(flushDrawFacingOverbet({ villainAllIn: false }), traits("boss"), {
    action: "call",
  });
  assertClean(verdict);
  const { requiredEquity, engineEquity, outs } = verdict.numbers;
  assert.ok(outs >= 8, `expected a real draw, got ${outs} outs`);
  // Implied odds are doing the work: the gap is wider than the bare 12-point margin.
  assert.ok(
    engineEquity < requiredEquity - 0.12,
    `${engineEquity} vs ${requiredEquity}: the 12-point margin should not have saved this`,
  );
  assert.ok(engineEquity >= requiredEquity - 0.2, `${engineEquity} vs ${requiredEquity}`);
});

test("case 12b — the same draw against an ALL-IN opponent loses the implied odds and is vetoed", () => {
  const verdict = checkDecision(flushDrawFacingOverbet({ villainAllIn: true }), traits("boss"), {
    action: "call",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "POST-CALL-ALLIN");
  assert.match(verdict.detail, /no implied odds/);
});

test("case 13 — station calling half pot with a weak pair is allowed (cheap, persona preserved)", () => {
  // 50 into a 300 stack is 17% of the money at risk: below the 25% commitment gate.
  const observation = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["8h", "8d"],
    communityCards: ["Ks", "9c", "4d"],
    stack: 300,
    startingStack: 350,
    effectiveStack: 300,
    pot: 150,
    streetBet: 0,
    toCall: 50,
    potOddsToCall: 50 / 200,
    spr: 300 / 150,
    currentBet: 50,
    minRaise: 50,
    minimumRaiseTo: 100,
    maximumRaiseTo: 300,
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({ position: "CO", name: "猎手", preflopAggression: 1, totalCommitted: 100 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "老陈", stack: 300, startingStack: 350, totalCommitted: 50 }),
      publicPlayer({
        position: "CO",
        name: "猎手",
        stack: 250,
        startingStack: 350,
        streetBet: 50,
        totalCommitted: 100,
      }),
    ],
  });

  assertClean(checkDecision(observation, traits("station"), { action: "call" }));
});

test("case 14 — a cheap call in front of an all-in is allowed even with hopeless equity", () => {
  // 40 chips out of 400 behind: the mistake is too small for the guardrail to care.
  const observation = makeObservation({
    street: "turn",
    position: "BB",
    holeCards: ["7c", "2d"],
    communityCards: ["Ah", "Kd", "Qc", "Js"],
    stack: 400,
    startingStack: 440,
    effectiveStack: 400,
    pot: 120,
    streetBet: 0,
    toCall: 40,
    potOddsToCall: 40 / 160,
    spr: 400 / 120,
    currentBet: 40,
    minRaise: 40,
    minimumRaiseTo: 80,
    maximumRaiseTo: 400,
    legalActions: ["fold", "call"],
    playersRemaining: 2,
    opponentsAbleToAct: 0,
    raiseCountThisStreet: 1,
    opponentProfiles: [
      profile({ position: "BTN", name: "老板", preflopAggression: 2, allIn: true, totalCommitted: 80 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "老陈", stack: 400, startingStack: 440, totalCommitted: 40 }),
      publicPlayer({
        position: "BTN",
        name: "老板",
        stack: 0,
        startingStack: 80,
        streetBet: 40,
        totalCommitted: 80,
        allIn: true,
      }),
    ],
  });

  const verdict = checkDecision(observation, traits("station"), { action: "call" });
  assertClean(verdict);
  assert.ok(verdict.numbers.engineEquity < verdict.numbers.requiredEquity - 0.12);
});

test("case 15 — maniac jamming a 4x-pot overbet with a flush draw is allowed", () => {
  const observation = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["Qh", "9h"],
    communityCards: ["Ah", "5h", "2c"],
    stack: 400,
    startingStack: 450,
    effectiveStack: 400,
    pot: 100,
    streetBet: 0,
    toCall: 0,
    potOddsToCall: 0,
    spr: 4,
    currentBet: 0,
    minRaise: BIG_BLIND,
    minimumRaiseTo: BIG_BLIND,
    maximumRaiseTo: 400,
    legalActions: ["check", "raise", "allin"],
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 0,
    opponentProfiles: [
      profile({ position: "CO", name: "猎手", preflopAggression: 1, totalCommitted: 50 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "火山", stack: 400, startingStack: 450, totalCommitted: 50 }),
      publicPlayer({ position: "CO", name: "猎手", stack: 400, startingStack: 450, totalCommitted: 50 }),
    ],
  });

  const verdict = checkDecision(observation, traits("maniac"), { action: "allin" });
  assertClean(verdict);
  assert.equal(verdict.numbers.outs, 9);
  // All-ins are never re-sized.
  assert.equal(verdict.clampedRaiseTo, undefined);
});

test("case 16 — postflop raise sizes are clamped to currentBet + 2.5x pot, never vetoed", () => {
  const observation = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["Ah", "Kh"],
    communityCards: ["Qh", "5h", "2c"],
    stack: 600,
    startingStack: 650,
    effectiveStack: 600,
    pot: 100,
    streetBet: 0,
    toCall: 0,
    potOddsToCall: 0,
    spr: 6,
    currentBet: 0,
    minRaise: BIG_BLIND,
    minimumRaiseTo: BIG_BLIND,
    maximumRaiseTo: 600,
    legalActions: ["check", "raise", "allin"],
    playersRemaining: 2,
    opponentsAbleToAct: 1,
    raiseCountThisStreet: 0,
    opponentProfiles: [
      profile({ position: "CO", name: "猎手", preflopAggression: 1, totalCommitted: 50 }),
    ],
    publicPlayers: [
      publicPlayer({ position: "BB", name: "火山", stack: 600, startingStack: 650, totalCommitted: 50 }),
      publicPlayer({ position: "CO", name: "猎手", stack: 600, startingStack: 650, totalCommitted: 50 }),
    ],
  });

  const wild = checkDecision(observation, traits("maniac"), { action: "raise", raiseTo: 500 });
  assertClean(wild);
  assert.equal(wild.clampedRaiseTo, 250); // 0 + 2.5 * 100

  // A 2x-pot bet is inside the widened band and is left alone (V1 capped at 1.5x).
  const sane = checkDecision(observation, traits("maniac"), { action: "raise", raiseTo: 200 });
  assertClean(sane);
  assert.equal(sane.clampedRaiseTo, undefined);
});

test("case 17 — preflop never vetoes, whatever the hand, position or persona", () => {
  const junk = [
    { position: "UTG", holeCards: ["7c", "2d"], raiseCountThisStreet: 0, toCall: 2, currentBet: 2 },
    { position: "BB", holeCards: ["9s", "4h"], raiseCountThisStreet: 1, toCall: 6, currentBet: 8 },
    { position: "SB", holeCards: ["Jc", "2h"], raiseCountThisStreet: 2, toCall: 22, currentBet: 24 },
    { position: "CO", holeCards: ["Tc", "3d"], raiseCountThisStreet: 3, toCall: 48, currentBet: 72 },
    { position: "BTN", holeCards: ["5c", "3d"], raiseCountThisStreet: 4, toCall: 120, currentBet: 180 },
  ];
  for (const overrides of junk) {
    for (const personaId of ["rock", "gto", "tag", "station", "maniac", "boss", "short"]) {
      for (const decision of [{ action: "call" }, { action: "raise", raiseTo: 40 }, { action: "allin" }]) {
        const verdict = checkDecision(
          makeObservation({
            pot: 3 + overrides.currentBet * 2,
            opponentProfiles: [profile({ position: "LJ", preflopAggression: 2 })],
            ...overrides,
          }),
          traits(personaId),
          decision,
        );
        assert.equal(
          verdict.ok,
          true,
          `${personaId} ${overrides.holeCards.join("")} ${decision.action} was vetoed with ${verdict.rule}`,
        );
        assert.equal(verdict.rule, undefined);
      }
    }
  }
});

test("case 18 — preflop raise sizes are still clamped into the open / 3-bet / 4-bet bands", () => {
  const unopened = makeObservation({
    position: "CO",
    holeCards: ["7c", "2d"],
    raiseCountThisStreet: 0,
    toCall: BIG_BLIND,
    currentBet: BIG_BLIND,
    streetBet: 0,
    minimumRaiseTo: 4,
    maximumRaiseTo: 360,
  });
  const open = checkDecision(unopened, traits("maniac"), { action: "raise", raiseTo: 60 });
  assertClean(open);
  assert.equal(open.clampedRaiseTo, 8); // 4.4-8 band, no limpers

  const facingOpen = makeObservation({
    position: "BTN",
    holeCards: ["Kd", "Qd"],
    raiseCountThisStreet: 1,
    pot: 11,
    toCall: 8,
    currentBet: 8,
    streetBet: 0,
    minimumRaiseTo: 14,
    maximumRaiseTo: 360,
  });
  const threeBet = checkDecision(facingOpen, traits("boss"), { action: "raise", raiseTo: 200 });
  assertClean(threeBet);
  assert.equal(threeBet.clampedRaiseTo, 36); // 2.5x-4.5x of the 8-chip open
});

/* ------------------------------------------------------------------ */
/* Frozen helpers                                                      */
/* ------------------------------------------------------------------ */

test("describeHandClass names offsuit, paired and suited holdings", () => {
  assert.equal(describeHandClass(["Ac", "8s"]), "A8o");
  assert.equal(describeHandClass(["Td", "Ts"]), "TT");
  assert.equal(describeHandClass(["Kh", "Qh"]), "KQs");
});

test("suggestSafeAction folds the hopeless flop jam call", () => {
  const safe = suggestSafeAction(bbFacingFlopJam(), traits("station"));
  assert.equal(safe.action, "fold");
});

test("suggestSafeAction calls when POST-CALL-ALLIN would allow it, and never opens a pot", () => {
  const cheapCall = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["8h", "8d"],
    communityCards: ["Ks", "9c", "4d"],
    stack: 300,
    startingStack: 350,
    effectiveStack: 300,
    pot: 150,
    streetBet: 0,
    toCall: 50,
    currentBet: 50,
    minimumRaiseTo: 100,
    maximumRaiseTo: 300,
    legalActions: ["fold", "call", "raise", "allin"],
    raiseCountThisStreet: 1,
    opponentProfiles: [profile({ position: "CO", preflopAggression: 1, totalCommitted: 100 })],
    publicPlayers: [
      publicPlayer({ position: "BB", stack: 300, startingStack: 350, totalCommitted: 50 }),
      publicPlayer({ position: "CO", stack: 250, startingStack: 350, streetBet: 50, totalCommitted: 100 }),
    ],
  });
  assert.equal(suggestSafeAction(cheapCall, traits("station")).action, "call");

  // Nothing to call: V2's fallback checks instead of value-betting.
  const nutsUnopened = makeObservation({
    street: "flop",
    position: "BB",
    holeCards: ["Ah", "Ad"],
    communityCards: ["As", "9c", "4d"],
    stack: 300,
    startingStack: 350,
    effectiveStack: 300,
    pot: 150,
    streetBet: 0,
    toCall: 0,
    currentBet: 0,
    minimumRaiseTo: BIG_BLIND,
    maximumRaiseTo: 300,
    legalActions: ["check", "raise", "allin"],
    raiseCountThisStreet: 0,
    opponentProfiles: [profile({ position: "CO", preflopAggression: 1, totalCommitted: 50 })],
    publicPlayers: [
      publicPlayer({ position: "BB", stack: 300, startingStack: 350, totalCommitted: 50 }),
      publicPlayer({ position: "CO", stack: 300, startingStack: 350, totalCommitted: 50 }),
    ],
  });
  assert.equal(suggestSafeAction(nutsUnopened, traits("maniac")).action, "check");

  // Preflop is always check (no bet) or fold (facing a bet) — the fallback has no style.
  assert.equal(suggestSafeAction(makeObservation({ toCall: 0 }), traits("maniac")).action, "check");
  assert.equal(
    suggestSafeAction(makeObservation({ toCall: 22, currentBet: 24 }), traits("maniac")).action,
    "fold",
  );
});
