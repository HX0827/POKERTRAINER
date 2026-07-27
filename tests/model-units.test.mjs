import assert from "node:assert/strict";
import test from "node:test";

import { bigBlind, bigBlindView, toBB } from "../app/lib/modelView.ts";
import { botObservation, startHand } from "../app/lib/poker.ts";

/**
 * Guards the single unit boundary. The original defect was not "BB is the wrong unit" — it was
 * chips and BB coexisting in one payload with no labels, so the model read a 64-chip stack as
 * "64BB". These tests fail if any amount reaches the model still denominated in chips.
 */

/** Every field of the model view, classified. A new field must be added here on purpose. */
const AMOUNT_FIELDS = [
  "stack",
  "startingStack",
  "effectiveStack",
  "pot",
  "streetBet",
  "toCall",
  "currentBet",
  "minRaiseToBB",
  "maxRaiseToBB",
];
const RATIO_FIELDS = ["potOddsToCall", "spr"];
const PASSTHROUGH_FIELDS = [
  "handNo",
  "street",
  "position",
  "holeCards",
  "communityCards",
  "boardTexture",
  "handStrength",
  "legalActions",
  "publicActions",
  "playersRemaining",
  "opponentsAbleToAct",
  "raiseCountThisStreet",
  "opponentProfiles",
  "publicPlayers",
];

function sampleObservation() {
  // Odd chip counts on purpose: a forgotten conversion cannot coincidentally match.
  const state = startHand();
  const observation = botObservation(state, state.players[state.actingIndex]);
  return {
    ...observation,
    stack: 301,
    startingStack: 401,
    effectiveStack: 355,
    pot: 221,
    streetBet: 15,
    toCall: 89,
    currentBet: 103,
    minimumRaiseTo: 177,
    maximumRaiseTo: 301,
    opponentProfiles: [
      {
        position: "BB",
        name: "Atlas",
        allIn: false,
        totalCommitted: 143,
        preflopAggression: 1,
        calledRaisePreflop: false,
        bigAggressionThisStreet: true,
      },
    ],
    publicPlayers: [
      {
        name: "Atlas",
        position: "BB",
        stack: 359,
        startingStack: 401,
        streetBet: 103,
        totalCommitted: 143,
        folded: false,
        allIn: false,
        acted: true,
        lastAction: "bet 51.5BB",
      },
    ],
  };
}

test("the model view exposes exactly the fields we have classified", () => {
  const view = bigBlindView(sampleObservation());
  const expected = [...AMOUNT_FIELDS, ...RATIO_FIELDS, ...PASSTHROUGH_FIELDS].sort();
  assert.deepEqual(
    Object.keys(view).sort(),
    expected,
    "a field was added to the model view without deciding whether it carries an amount",
  );
});

test("every amount reaching the model is converted to big blinds", () => {
  const observation = sampleObservation();
  const bb = bigBlind(observation);
  const view = bigBlindView(observation);

  const sources = {
    stack: observation.stack,
    startingStack: observation.startingStack,
    effectiveStack: observation.effectiveStack,
    pot: observation.pot,
    streetBet: observation.streetBet,
    toCall: observation.toCall,
    currentBet: observation.currentBet,
    minRaiseToBB: observation.minimumRaiseTo,
    maxRaiseToBB: observation.maximumRaiseTo,
  };
  for (const field of AMOUNT_FIELDS) {
    assert.equal(view[field], sources[field] / bb, `${field} was not converted`);
    assert.notEqual(view[field], sources[field], `${field} still looks like a chip count`);
  }
});

test("nested player and opponent amounts are converted too", () => {
  const observation = sampleObservation();
  const bb = bigBlind(observation);
  const view = bigBlindView(observation);

  const player = view.publicPlayers[0];
  const source = observation.publicPlayers[0];
  for (const field of ["stack", "startingStack", "streetBet", "totalCommitted"]) {
    assert.equal(player[field], source[field] / bb, `publicPlayers.${field} was not converted`);
  }
  assert.equal(player.lastAction, source.lastAction, "action text is already BB and must not be touched");

  assert.equal(
    view.opponentProfiles[0].totalCommitted,
    observation.opponentProfiles[0].totalCommitted / bb,
    "opponentProfiles.totalCommitted was not converted",
  );
});

test("ratios are left alone", () => {
  const observation = { ...sampleObservation(), potOddsToCall: 0.287, spr: 1.36 };
  const view = bigBlindView(observation);
  assert.equal(view.potOddsToCall, 0.287);
  assert.equal(view.spr, 1.36);
});

test("the board texture arrives as its pre-computed summary, not raw card codes", () => {
  const observation = sampleObservation();
  observation.boardTexture = {
    cards: 3,
    paired: false,
    tripsOnBoard: false,
    maxSuitCount: 2,
    suit: "h",
    monotone: false,
    twoTone: true,
    rainbow: false,
    flushPossible: false,
    flushDrawLive: true,
    straightCards: 2,
    straightPossible: false,
    lastCardEffect: "",
    summary: "Th 3s 6h | unpaired | two-tone (2 hearts, flush draws live) | 2 to a straight",
  };
  const view = bigBlindView(observation);
  assert.equal(typeof view.boardTexture, "string");
  assert.match(view.boardTexture, /two-tone/);
});

test("a missing blind level falls back to the standard 2-chip big blind", () => {
  const observation = { ...sampleObservation(), blinds: undefined };
  assert.equal(bigBlind(observation), 2);
  assert.equal(bigBlindView(observation).pot, 110.5);
});

test("toBB rounds to one decimal and survives junk input", () => {
  assert.equal(toBB(301, 2), 150.5);
  assert.equal(toBB(0, 2), 0);
  assert.equal(toBB(undefined, 2), 0);
  assert.equal(toBB(Number.NaN, 2), 0);
});
