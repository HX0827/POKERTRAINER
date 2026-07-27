import assert from "node:assert/strict";
import test from "node:test";

import { botObservation, describeHoleStrength, startHand } from "../app/lib/poker.ts";

/**
 * Published analysis of LLM poker agents found they "confuse their own hole cards, position,
 * hand strengths". The model is therefore told what it holds rather than left to work it out,
 * and the description must be honest about strength RELATIVE to the board — "top pair" and
 * "third pair" are the same made category but not remotely the same hand.
 */

const cards = (codes) => codes.match(/../g).map((code) => ({ rank: code[0], suit: code[1] }));
const describe = (hole, board) => describeHoleStrength(cards(hole), cards(board));

test("there is no hand strength before the flop", () => {
  assert.equal(describeHoleStrength(cards("AhKd"), []), undefined);
  assert.equal(describeHoleStrength(cards("AhKd"), cards("Ks9c")), undefined);
});

test("pair strength is reported relative to the board, not as a bare category", () => {
  assert.match(describe("Jh9d", "Js7c2d"), /top pair/i);
  assert.match(describe("9h8d", "Js9c2d"), /second pair/i);
  assert.match(describe("5h4d", "AsKc5d"), /third pair/i);
  // Same made category (one pair) every time, but three very different hands.
  assert.doesNotMatch(describe("5h4d", "AsKc5d"), /top pair/i);
});

test("an overpair and an underpair are distinguished", () => {
  assert.match(describe("QhQd", "Js7c2d"), /overpair/i);
  assert.match(describe("7h7d", "AsKc9h"), /underpair/i);
});

test("made hands above one pair are named", () => {
  assert.match(describe("QhJd", "QsJc4d"), /two pair/i);
  assert.match(describe("8h8d", "8sKc3h"), /set|three of a kind|trips/i);
  assert.match(describe("9h8d", "7s6c5h"), /straight/i);
  assert.match(describe("Ah7h", "Kh9h2h"), /flush/i);
  assert.match(describe("KhKd", "Ks4c4h"), /full house/i);
  assert.match(describe("5h5d", "5s5c9h"), /four of a kind|quads/i);
});

test("a missed hand is called what it is", () => {
  const acehigh = describe("Ah5d", "Kc9s3h");
  assert.match(acehigh, /no pair/i);
  assert.match(acehigh, /ace high/i);
});

test("a board pair is not mistaken for the player's own pair", () => {
  const text = describe("9h5d", "KcKs3h2d");
  assert.match(text, /board/i);
  assert.match(text, /no pair of your own/i);
});

test("playing the board is called out explicitly", () => {
  const text = describe("3h2d", "AsKsQsJsTs");
  assert.match(text, /playing the board/i);
});

test("the observation carries hand strength from the flop onward", () => {
  const state = startHand();
  const preflop = botObservation(state, state.players[state.actingIndex]);
  assert.equal(preflop.handStrength, undefined);

  state.community = cards("3s5sKc");
  const actor = state.players[state.actingIndex];
  actor.hole = cards("Js5c");
  const flop = botObservation(state, actor);
  assert.equal(typeof flop.handStrength, "string");
  assert.match(flop.handStrength, /second pair/i);
});

test("every description is a single short line", () => {
  const samples = [
    ["QhQd", "Js7c2d"],
    ["Ah7h", "Kh9h2h"],
    ["9h5d", "KcKs3h2d"],
    ["3h2d", "AsKsQsJsTs"],
    ["Ah5d", "Kc9s3h"],
  ];
  for (const [hole, board] of samples) {
    const text = describe(hole, board);
    assert.ok(text.length > 0 && text.length <= 140, `${hole}/${board}: ${text.length} chars`);
    assert.doesNotMatch(text, /\n/, "must stay one line for the prompt");
  }
});
