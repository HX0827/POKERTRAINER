import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  legalActions,
  parseSavedGame,
  serializeGame,
  startHand,
} from "../app/lib/poker.ts";

test("a fresh hand round-trips exactly through serialize + parse", () => {
  const game = startHand();
  const parsed = parseSavedGame(serializeGame(game));
  assert.deepEqual(parsed, game);
});

test("a mid-hand state round-trips exactly — cards, pot, acting seat and all", () => {
  let game = startHand();
  // Play a few AI actions so there is real mid-hand state: bets, folds, a moved actingIndex.
  for (let step = 0; step < 3 && !game.handComplete; step += 1) {
    const actor = game.players[game.actingIndex];
    const legal = legalActions(game, actor);
    const action = legal.includes("call") ? "call" : legal[0];
    game = applyAction(game, action);
  }
  const parsed = parseSavedGame(serializeGame(game));
  assert.deepEqual(parsed, game);
});

test("a finished-hand flag survives the round trip", () => {
  const game = { ...startHand(), handComplete: true };
  const parsed = parseSavedGame(serializeGame(game));
  assert.equal(parsed.handComplete, true);
});

test("static seat facts come from the code, not from storage", () => {
  const game = startHand();
  const envelope = JSON.parse(serializeGame(game));
  // A stale or tampered save claims a different name and a retuned persona.
  envelope.game.players[1].name = "冒名顶替";
  envelope.game.players[1].persona = { ...envelope.game.players[1].persona, buyInBB: 9999 };
  const parsed = parseSavedGame(JSON.stringify(envelope));
  assert.ok(parsed);
  assert.equal(parsed.players[1].name, game.players[1].name);
  assert.equal(parsed.players[1].persona.buyInBB, game.players[1].persona.buyInBB);
});

test("a fresh table honours a requested opening button seat, and rejects junk", () => {
  assert.equal(startHand(undefined, { dealerIndex: 3 }).dealerIndex, 3);
  assert.equal(startHand(undefined, { dealerIndex: 0 }).dealerIndex, 0);
  // Out-of-range or fractional requests fall back to the traditional seat 7.
  assert.equal(startHand(undefined, { dealerIndex: 8 }).dealerIndex, 7);
  assert.equal(startHand(undefined, { dealerIndex: -1 }).dealerIndex, 7);
  assert.equal(startHand(undefined, { dealerIndex: 2.5 }).dealerIndex, 7);
  assert.equal(startHand().dealerIndex, 7);
  // A continuing table ignores the request: the button always moves one seat.
  const previous = startHand();
  assert.equal(startHand(previous, { dealerIndex: 3 }).dealerIndex, (previous.dealerIndex + 1) % 8);
});

test("parseSavedGame rejects everything malformed instead of throwing", () => {
  const good = JSON.parse(serializeGame(startHand()));
  const withGame = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy.game);
    return JSON.stringify(copy);
  };
  const cases = [
    null,
    "",
    "not json",
    "42",
    JSON.stringify({}),
    JSON.stringify({ ...good, v: 999 }),
    JSON.stringify({ v: 1, game: null }),
    withGame((g) => (g.handNo = 0)),
    withGame((g) => (g.handNo = 1.5)),
    withGame((g) => (g.dealerIndex = 8)),
    withGame((g) => (g.actingIndex = -1)),
    withGame((g) => (g.street = "flip")),
    withGame((g) => (g.pot = -1)),
    withGame((g) => (g.handComplete = "yes")),
    withGame((g) => g.players.pop()),
    withGame((g) => (g.players[0].id = "someone-else")),
    withGame((g) => (g.players[2].stack = -5)),
    withGame((g) => (g.players[2].stack = "100")),
    withGame((g) => (g.players[3].hole = [{ rank: "Z", suit: "s" }])),
    withGame((g) => (g.players[3].hole = [1, 2])),
    withGame((g) => (g.deck = "not an array")),
    withGame((g) => (g.community = [{ rank: "A", suit: "moons" }])),
  ];
  for (const raw of cases) {
    assert.equal(parseSavedGame(raw), null, `should reject: ${String(raw).slice(0, 80)}`);
  }
});
