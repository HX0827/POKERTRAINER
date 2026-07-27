import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SEAT_DYNAMICS,
  EMPTY_TABLE_DYNAMICS,
  FREQUENCY_TARGETS,
  dynamicsForHand,
  mergeTableDynamics,
  selfCalibration,
  tableRead,
} from "../app/lib/tableDynamics.ts";

/**
 * Fixtures are hand-built GameStates rather than engine output: the whole value of this
 * module is the counting definitions, and a fixture states the definition in one place
 * ("here is a BB checking its free option") in a way a simulated hand never does.
 */

const BB = 2;

function seatOf(id, position) {
  return {
    id,
    name: id,
    isHero: false,
    position,
    persona: { id: "gto" },
    stack: 200,
    hole: [],
    folded: false,
    allIn: false,
    streetBet: 0,
    totalCommitted: 0,
    acted: false,
    raiseLocked: false,
    lastAction: "",
    result: 0,
  };
}

function record(playerId, kind, { street = "preflop", facedBet = BB, toAmount = 0 } = {}) {
  return {
    street,
    playerId,
    position: playerId,
    name: playerId,
    kind,
    amount: 0,
    toAmount,
    facedBet,
    allInAfterAction: false,
    potBefore: 0,
    label: `${playerId} ${kind}`,
  };
}

const fold = (id, opts) => record(id, "fold", opts);
const check = (id, opts) => record(id, "check", opts);
/** A call always matches the faced bet exactly. */
const call = (id, facedBet = BB, opts = {}) =>
  record(id, "call", { facedBet, toAmount: facedBet, ...opts });
const raise = (id, to, facedBet = BB, opts = {}) =>
  record(id, "raise", { facedBet, toAmount: to, ...opts });
const allin = (id, to, facedBet = BB, opts = {}) =>
  record(id, "allin", { facedBet, toAmount: to, ...opts });

function handOf(ids, actions, extra = {}) {
  return {
    players: ids.map((id) => seatOf(id, id)),
    actions,
    community: [],
    revealed: [],
    winners: [],
    ...extra,
  };
}

/** Every counter that is a numerator over another counter. */
const RATIOS = [
  ["voluntary", "handsDealt"],
  ["raisedPreflop", "voluntary"],
  ["coldCalls", "voluntary"],
  ["threeBetOpp", "handsDealt"],
  ["threeBets", "threeBetOpp"],
  ["foldedPreflop", "handsDealt"],
  ["sawFlop", "handsDealt"],
  ["wonWithoutShowdown", "handsDealt"],
];

function assertCoherent(dynamics) {
  for (const [id, seat] of Object.entries(dynamics)) {
    for (const [made, opportunity] of RATIOS) {
      assert.ok(
        seat[made] <= seat[opportunity],
        `${id}: ${made}=${seat[made]} exceeds ${opportunity}=${seat[opportunity]}`,
      );
    }
  }
}

test("empty and garbage states are counted, not thrown on", () => {
  assert.deepEqual(dynamicsForHand({}), {});
  assert.deepEqual(dynamicsForHand({ players: [] }), {});
  assert.deepEqual(dynamicsForHand(undefined), {});
  assert.equal(Object.isFrozen(EMPTY_SEAT_DYNAMICS), true);
  assert.equal(Object.isFrozen(EMPTY_TABLE_DYNAMICS), true);
  assert.deepEqual(EMPTY_TABLE_DYNAMICS, {});
});

test("every dealt seat records a hand, even one that never acts", () => {
  // BTN is all-in from a previous street in real play; here he simply has no action record.
  const state = handOf(["UTG", "SB", "BB"], [fold("UTG"), call("SB"), check("BB")]);
  const dynamics = dynamicsForHand(state);
  assert.deepEqual(Object.keys(dynamics).sort(), ["BB", "SB", "UTG"]);
  for (const seat of Object.values(dynamics)) assert.equal(seat.handsDealt, 1);
});

test("the BB checking its free option is not voluntary; the SB completing is", () => {
  const state = handOf(
    ["CO", "BTN", "SB", "BB"],
    [fold("CO"), fold("BTN"), call("SB"), check("BB")],
  );
  const dynamics = dynamicsForHand(state);

  assert.equal(dynamics.BB.voluntary, 0, "a free check is not money in by choice");
  assert.equal(dynamics.BB.foldedPreflop, 0);
  assert.equal(dynamics.SB.voluntary, 1, "completing the small blind is a decision");
  assert.equal(dynamics.SB.raisedPreflop, 0);
  assert.equal(dynamics.SB.coldCalls, 0, "a completion faces no raise");
  assert.equal(dynamics.CO.foldedPreflop, 1);
  assert.equal(dynamics.CO.voluntary, 0);
  assertCoherent(dynamics);
});

test("a limp is voluntary but is not a cold call", () => {
  const state = handOf(["UTG", "SB", "BB"], [call("UTG"), fold("SB"), check("BB")]);
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.UTG.voluntary, 1);
  assert.equal(dynamics.UTG.coldCalls, 0);
  assert.equal(dynamics.UTG.threeBetOpp, 0, "nobody raised, so there is no 3-bet spot");
});

test("a cold call is the first voluntary money and answers a raise", () => {
  const state = handOf(
    ["UTG", "CO", "SB", "BB"],
    [raise("UTG", 6), call("CO", 6), fold("SB"), fold("BB")],
  );
  const dynamics = dynamicsForHand(state);

  assert.equal(dynamics.CO.coldCalls, 1);
  assert.equal(dynamics.CO.voluntary, 1);
  assert.equal(dynamics.CO.raisedPreflop, 0);
  assert.equal(dynamics.UTG.raisedPreflop, 1);
  assert.equal(dynamics.UTG.coldCalls, 0);
  assertCoherent(dynamics);
});

test("the big blind defending a raise is a cold call (the blind was forced, not chosen)", () => {
  const state = handOf(["UTG", "SB", "BB"], [raise("UTG", 6), fold("SB"), call("BB", 6)]);
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.BB.coldCalls, 1);
  assert.equal(dynamics.BB.voluntary, 1);
});

test("limping and then calling a raise is not a cold call, and enters the pot once", () => {
  const state = handOf(
    ["UTG", "CO", "SB", "BB"],
    [call("UTG"), raise("CO", 8), fold("SB"), fold("BB"), call("UTG", 8)],
  );
  const dynamics = dynamicsForHand(state);

  assert.equal(dynamics.UTG.voluntary, 1, "VPIP is per hand, not per call");
  assert.equal(dynamics.UTG.coldCalls, 0, "he was already in for the limp");
  assert.equal(dynamics.UTG.threeBetOpp, 1, "he still faced the first raise having not raised");
  assert.equal(dynamics.UTG.threeBets, 0);
  assertCoherent(dynamics);
});

test("a 3-bet spot is exactly one prior raise with no raise of your own", () => {
  const made = dynamicsForHand(
    handOf(["UTG", "CO", "SB", "BB"], [raise("UTG", 6), raise("CO", 18), fold("SB"), fold("BB")]),
  );
  assert.equal(made.CO.threeBetOpp, 1);
  assert.equal(made.CO.threeBets, 1);
  assert.equal(made.CO.raisedPreflop, 1);
  assert.equal(made.UTG.threeBetOpp, 0, "the opener is not facing a raise when he opens");

  const declined = dynamicsForHand(handOf(["UTG", "CO"], [raise("UTG", 6), fold("CO")]));
  assert.equal(declined.CO.threeBetOpp, 1, "folding is still an opportunity");
  assert.equal(declined.CO.threeBets, 0);
  assert.equal(declined.CO.foldedPreflop, 1);
});

test("facing two raises is a cold call, not a 3-bet opportunity", () => {
  const state = handOf(
    ["UTG", "CO", "BTN"],
    [raise("UTG", 6), raise("CO", 18), call("BTN", 18)],
  );
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.BTN.threeBetOpp, 0, "two raises out there is a 4-bet spot");
  assert.equal(dynamics.BTN.coldCalls, 1);
  assert.equal(dynamics.CO.threeBetOpp, 1);
});

test("a player who has already raised never gets a 3-bet opportunity", () => {
  const state = handOf(
    ["UTG", "CO"],
    [raise("UTG", 6), raise("CO", 18), raise("UTG", 44), call("CO", 44)],
  );
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.UTG.threeBetOpp, 0, "facing a 3-bet is a 4-bet spot, not a 3-bet spot");
  assert.equal(dynamics.UTG.raisedPreflop, 1, "PFR is per hand, not per raise");
  assert.equal(dynamics.CO.threeBetOpp, 1);
  assert.equal(dynamics.CO.threeBets, 1);
  assertCoherent(dynamics);
});

test("an all-in below the current bet is a call, not a raise", () => {
  const state = handOf(
    ["UTG", "CO"],
    [raise("UTG", 6), allin("CO", 5, 6)],
  );
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.CO.raisedPreflop, 0);
  assert.equal(dynamics.CO.threeBets, 0);
  assert.equal(dynamics.CO.threeBetOpp, 1);
  assert.equal(dynamics.CO.coldCalls, 1);
  assert.equal(dynamics.CO.voluntary, 1);
});

test("an all-in above the current bet is a raise", () => {
  const state = handOf(
    ["UTG", "CO", "BTN"],
    [raise("UTG", 6), allin("CO", 60, 6), fold("BTN", { facedBet: 60 })],
  );
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.CO.raisedPreflop, 1);
  assert.equal(dynamics.CO.threeBets, 1);
  assert.equal(dynamics.BTN.threeBetOpp, 0, "two raises are out there by the time BTN acts");
});

test("postflop aggression never touches the preflop counters", () => {
  const state = handOf(
    ["UTG", "BB"],
    [
      raise("UTG", 6),
      call("BB", 6),
      raise("BB", 4, 0, { street: "flop" }),
      raise("UTG", 12, 4, { street: "flop" }),
      call("BB", 12, { street: "flop" }),
      raise("BB", 20, 0, { street: "turn" }),
      fold("UTG", { street: "turn", facedBet: 20 }),
    ],
    { community: [1, 2, 3, 4] },
  );
  const dynamics = dynamicsForHand(state);

  assert.equal(dynamics.BB.raisedPreflop, 0, "a flop raise is not a preflop raise");
  assert.equal(dynamics.BB.threeBetOpp, 1, "only the preflop spot counts");
  assert.equal(dynamics.BB.threeBets, 0);
  assert.equal(dynamics.BB.voluntary, 1);
  assert.equal(dynamics.UTG.raisedPreflop, 1);
  assert.equal(dynamics.UTG.threeBetOpp, 0);
  assert.equal(dynamics.UTG.foldedPreflop, 0, "he folded on the turn");
  assertCoherent(dynamics);
});

test("sawFlop follows the board and the preflop fold, not the postflop line", () => {
  const state = handOf(
    ["UTG", "CO", "BB"],
    [raise("UTG", 6), fold("CO"), call("BB", 6), fold("BB", { street: "flop", facedBet: 4 })],
    { community: [1, 2, 3] },
  );
  const dynamics = dynamicsForHand(state);
  assert.equal(dynamics.UTG.sawFlop, 1);
  assert.equal(dynamics.BB.sawFlop, 1, "folding ON the flop still means he saw it");
  assert.equal(dynamics.CO.sawFlop, 0);

  const noFlop = dynamicsForHand(handOf(["UTG", "BB"], [raise("UTG", 6), fold("BB")]));
  assert.equal(noFlop.UTG.sawFlop, 0, "the hand ended preflop");
});

test("wonWithoutShowdown needs a win and an empty reveal list", () => {
  const stolen = dynamicsForHand(
    handOf(["UTG", "BB"], [raise("UTG", 6), fold("BB")], { winners: ["UTG"] }),
  );
  assert.equal(stolen.UTG.wonWithoutShowdown, 1);
  assert.equal(stolen.BB.wonWithoutShowdown, 0);

  const shown = dynamicsForHand(
    handOf(["UTG", "BB"], [raise("UTG", 6), call("BB", 6)], {
      community: [1, 2, 3, 4, 5],
      revealed: ["UTG", "BB"],
      winners: ["UTG"],
    }),
  );
  assert.equal(shown.UTG.wonWithoutShowdown, 0, "he had to show it down");
});

test("mergeTableDynamics sums, unions seats, and refuses junk", () => {
  const a = dynamicsForHand(handOf(["UTG", "BB"], [raise("UTG", 6), fold("BB")]));
  const b = dynamicsForHand(handOf(["UTG", "CO"], [raise("UTG", 6), call("CO", 6)]));
  const merged = mergeTableDynamics(a, b);

  assert.deepEqual(Object.keys(merged).sort(), ["BB", "CO", "UTG"]);
  assert.equal(merged.UTG.handsDealt, 2);
  assert.equal(merged.UTG.raisedPreflop, 2);
  assert.equal(merged.BB.handsDealt, 1);
  assert.equal(merged.CO.coldCalls, 1);
  assert.equal(a.UTG.handsDealt, 1, "inputs are not mutated");

  const dirty = mergeTableDynamics(
    { X: { handsDealt: -4, voluntary: 2.7, threeBets: Number.NaN } },
    undefined,
  );
  assert.deepEqual(dirty.X, { ...EMPTY_SEAT_DYNAMICS, voluntary: 2 });
  assert.deepEqual(mergeTableDynamics(undefined, undefined), {});
});

test("FREQUENCY_TARGETS carries the researched HUD lines", () => {
  assert.deepEqual(Object.keys(FREQUENCY_TARGETS).sort(), [
    "boss",
    "gto",
    "maniac",
    "rock",
    "short",
    "station",
    "tag",
  ]);
  assert.deepEqual(FREQUENCY_TARGETS.station, { vpip: 0.4, pfr: 0.1, threeBet: 0.02 });
  assert.deepEqual(FREQUENCY_TARGETS.maniac, { vpip: 0.45, pfr: 0.35, threeBet: 0.16 });
  assert.deepEqual(FREQUENCY_TARGETS.rock, { vpip: 0.15, pfr: 0.11, threeBet: 0.04 });

  for (const [id, target] of Object.entries(FREQUENCY_TARGETS)) {
    assert.ok(target.pfr <= target.vpip, `${id}: PFR cannot exceed VPIP`);
    assert.ok(target.vpip > 0 && target.vpip < 1, `${id}: VPIP out of range`);
    // Nobody is allowed to be the 18.3% 3-better that published analysis called broken.
    assert.ok(target.threeBet <= 0.16, `${id}: 3-bet target is cartoonish`);
  }
  // The derived call share; a real station raises about one entry in ten, so 0.75 not 0.9.
  const station = FREQUENCY_TARGETS.station;
  const callShare = (station.vpip - station.pfr) / station.vpip;
  assert.ok(Math.abs(callShare - 0.75) < 1e-9, `station call share is ${callShare}`);
});

function seatStats(overrides) {
  return { ...EMPTY_SEAT_DYNAMICS, ...overrides };
}

test("selfCalibration says nothing below eight hands", () => {
  const stats = seatStats({ handsDealt: 7, voluntary: 7, raisedPreflop: 7, threeBetOpp: 5, threeBets: 5 });
  assert.equal(selfCalibration(stats, "gto"), "");
  assert.equal(selfCalibration({ ...stats, handsDealt: 8 }, "gto").length > 0, true);
  assert.equal(selfCalibration(EMPTY_SEAT_DYNAMICS, "gto"), "");
  assert.equal(selfCalibration(undefined, "gto"), "");
});

test("selfCalibration names the 3-bet problem the table actually had", () => {
  // Volcano's real 21-hand line: enters everything, raises everything, 3-bets nearly every spot.
  const text = selfCalibration(
    seatStats({
      handsDealt: 20,
      voluntary: 12,
      raisedPreflop: 12,
      threeBetOpp: 9,
      threeBets: 8,
    }),
    "boss",
  );

  assert.match(text, /Your last 20 hands: entered 12 \(60%, target 35%\)/);
  assert.match(text, /you raised 12 and called 0 \(call share 0%, target 23%\)/);
  assert.match(text, /3-bet 8 of 9 spots \(89%, target 11%\)/);
  assert.match(text, /3-betting far too often/);
  assert.match(text, /calling is the normal action/);
  assert.ok(text.length <= 300, `too long for the prompt: ${text.length}`);
});

test("selfCalibration names the missing call when the 3-bet rate is fine", () => {
  // Six of seven personas had PFR === VPIP: they never call, and that is the whole defect.
  const text = selfCalibration(
    seatStats({ handsDealt: 20, voluntary: 8, raisedPreflop: 8, threeBetOpp: 3, threeBets: 0 }),
    "gto",
  );
  assert.match(text, /almost never call preflop/);
  assert.match(text, /should be calls, not raises/);
  assert.ok(text.length <= 300);
});

test("selfCalibration names too many pots, too few pots, and no problem at all", () => {
  const loose = selfCalibration(
    seatStats({ handsDealt: 20, voluntary: 19, raisedPreflop: 10, threeBetOpp: 2, threeBets: 0 }),
    "maniac",
  );
  assert.match(loose, /entering far too many pots/);

  const nit = selfCalibration(seatStats({ handsDealt: 20, voluntary: 0 }), "rock");
  assert.match(nit, /folding too much/);
  assert.doesNotMatch(nit, /call share/, "with no entries there is no call share to report");
  assert.doesNotMatch(nit, /3-bet/, "with no spots there is no 3-bet rate to report");

  const healthy = selfCalibration(
    seatStats({ handsDealt: 20, voluntary: 5, raisedPreflop: 4, threeBetOpp: 3, threeBets: 0 }),
    "gto",
  );
  assert.match(healthy, /close to target/);
});

test("selfCalibration resolves seat-suffixed persona ids and unknown ones", () => {
  const stats = seatStats({ handsDealt: 20, voluntary: 8, raisedPreflop: 2 });
  assert.equal(selfCalibration(stats, "station#3"), selfCalibration(stats, "station"));
  assert.match(selfCalibration(stats, "station"), /target 40%/);
  // Unknown ids fall back to a solid TAG line instead of throwing.
  assert.match(selfCalibration(stats, "nobody"), /target 24%/);
  assert.match(selfCalibration(stats, ""), /target 24%/);
});

function seatList(ids) {
  return ids.map((id) => ({ playerId: id, position: id, personaId: "gto" }));
}

test("tableRead reports only well-sampled seats, and never the acting one", () => {
  const wild = seatStats({ handsDealt: 20, voluntary: 18, raisedPreflop: 17 });
  const dynamics = { HERO: wild, CO: { ...wild, handsDealt: 7, voluntary: 7, raisedPreflop: 7 } };

  assert.equal(tableRead(dynamics, seatList(["HERO", "CO"]), "HERO"), "", "CO has 7 hands");
  assert.match(tableRead(dynamics, seatList(["HERO", "CO"]), "CO"), /^HERO /);
  assert.equal(tableRead({}, seatList(["HERO"]), "X"), "");
  assert.equal(tableRead(undefined, undefined, "X"), "");
});

test("tableRead stays quiet about seats that play normally", () => {
  const normal = seatStats({
    handsDealt: 24,
    voluntary: 6,
    raisedPreflop: 5,
    threeBetOpp: 8,
    threeBets: 1,
    foldedPreflop: 18,
  });
  assert.equal(tableRead({ A: normal, B: normal }, seatList(["A", "B"]), "ME"), "");
});

test("tableRead ranks by exploitability, caps at three seats and fits the prompt", () => {
  const dynamics = {
    STATION: seatStats({ handsDealt: 20, voluntary: 16, raisedPreflop: 2, foldedPreflop: 4 }),
    MANIAC: seatStats({
      handsDealt: 20,
      voluntary: 14,
      raisedPreflop: 13,
      threeBetOpp: 8,
      threeBets: 6,
      foldedPreflop: 6,
    }),
    NIT: seatStats({ handsDealt: 20, voluntary: 1, raisedPreflop: 1, foldedPreflop: 19 }),
    WIDE3B: seatStats({
      handsDealt: 20,
      voluntary: 6,
      raisedPreflop: 5,
      threeBetOpp: 8,
      threeBets: 5,
      foldedPreflop: 14,
    }),
    ME: seatStats({ handsDealt: 20, voluntary: 20, raisedPreflop: 20 }),
  };
  const text = tableRead(
    dynamics,
    seatList(["STATION", "MANIAC", "NIT", "WIDE3B", "ME"]),
    "ME",
  );

  assert.ok(text.length <= 300, `too long for the prompt: ${text.length}`);
  assert.doesNotMatch(text, /ME /, "the acting seat is never in its own read");
  // Widest range first, then the station, then the wide 3-better: entering range is worth
  // money every hand, a 3-bet range only in the spots where he faces an open.
  assert.match(text, /^MANIAC entered 14 of 20 hands, raising 13 — his range is far wider/);
  assert.match(text, /STATION entered 16 of 20 hands and called 14 of them — value bet him/);
  // Three seats maximum, and the nit is the least valuable read of the four.
  assert.equal((text.match(/—/g) ?? []).length, 3);
  assert.doesNotMatch(text, /NIT/);

  const nitOnly = tableRead(dynamics, seatList(["NIT"]), "ME");
  assert.match(nitOnly, /^NIT folded 19 of 20 hands preflop — respect his raises\.$/);

  const threeBetOnly = tableRead(dynamics, seatList(["WIDE3B"]), "ME");
  assert.match(threeBetOnly, /^WIDE3B has 3-bet 5 of 8 spots — his 3-bets are not premium\.$/);
});
