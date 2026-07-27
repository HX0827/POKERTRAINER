import assert from "node:assert/strict";
import test from "node:test";

import { BIG_BLIND, PERSONAS, REBUY_RACK, planRebuy, startHand } from "../app/lib/poker.ts";

const persona = (id) => PERSONAS.find((candidate) => candidate.id === id);
const chips = (id, bb) => bb * BIG_BLIND;

function seat(id, stackBb, overrides = {}) {
  const found = persona(id);
  return {
    id,
    name: id,
    isHero: id === "hero",
    persona: found,
    stack: Math.round(stackBb * BIG_BLIND),
    position: "BTN",
    hole: [],
    folded: false,
    allIn: false,
    streetBet: 0,
    totalCommitted: 0,
    acted: false,
    raiseLocked: false,
    lastAction: "",
    result: 0,
    ...overrides,
  };
}

const bb = (chipsValue) => chipsValue / BIG_BLIND;

test("every persona declares a rebuy style", () => {
  for (const p of PERSONAS) {
    assert.ok(p.rebuy, `${p.id} has no rebuy style`);
    assert.ok(p.rebuy.trigger >= 0 && p.rebuy.trigger <= 1, `${p.id} trigger out of range`);
    assert.ok(p.rebuy.cover >= 0 && p.rebuy.cover <= 1, `${p.id} cover out of range`);
    assert.ok(p.rebuy.ceiling >= 1, `${p.id} ceiling below 1 would shrink a stack`);
    assert.ok(p.rebuy.chance > 0 && p.rebuy.chance <= 1, `${p.id} chance out of range`);
    assert.ok(p.rebuy.label.length > 0, `${p.id} has no label`);
  }
});

test("busting always buys back in to the persona's table target", () => {
  for (const p of PERSONAS) {
    const player = seat(p.id, 0);
    assert.equal(planRebuy(player, chips(p.id, 300), 0.99), p.buyInBB * BIG_BLIND, p.id);
  }
});

test("a healthy stack is never topped up", () => {
  for (const p of PERSONAS) {
    const player = seat(p.id, p.buyInBB); // exactly at target
    assert.equal(planRebuy(player, chips(p.id, 100), 0), player.stack, p.id);
  }
});

test("planRebuy never returns less than the current stack", () => {
  for (const p of PERSONAS) {
    for (const ratio of [0.05, 0.3, 0.6, 0.9, 1, 1.5, 3]) {
      for (const roll of [0, 0.5, 1]) {
        const player = seat(p.id, p.buyInBB * ratio);
        const to = planRebuy(player, chips(p.id, 600), roll);
        assert.ok(to >= player.stack, `${p.id} ratio ${ratio} roll ${roll}: ${to} < ${player.stack}`);
      }
    }
  }
});

test("老板 hates being short: buys whole racks and stays under his ceiling", () => {
  const boss = persona("boss");
  const ceiling = Math.round(boss.buyInBB * BIG_BLIND * boss.rebuy.ceiling);

  // 70% of a 250BB target is inside the 0.75 trigger
  const short = seat("boss", boss.buyInBB * 0.7);
  const added = planRebuy(short, chips("boss", 100), 0) - short.stack;
  assert.ok(added > 0, "should top up at 70%");
  assert.equal(added % REBUY_RACK, 0, "tops up in whole 100BB racks");

  // Deep enough by his own standard, but dwarfed by a 500BB stack -> cover rule fires
  const covered = seat("boss", boss.buyInBB * 0.95);
  const to = planRebuy(covered, chips("boss", 500), 0);
  assert.ok(to > covered.stack, "should reload to cover a much bigger stack");
  assert.equal((to - covered.stack) % REBUY_RACK, 0);
  assert.ok(to <= ceiling, "never sits deeper than his ceiling");

  // Deep and nobody towers over him -> stays put
  const settled = seat("boss", boss.buyInBB * 0.95);
  assert.equal(planRebuy(settled, chips("boss", 260), 0), settled.stack);
});

test("短码哥 stays at 50BB: a whole rack is too deep, so he never tops up", () => {
  const short = persona("short");
  for (const ratio of [0.2, 0.5, 0.9]) {
    const player = seat("short", short.buyInBB * ratio);
    assert.equal(
      planRebuy(player, chips("short", 800), 0),
      player.stack,
      `ratio ${ratio}: buying a 100BB rack would break his 50BB game`,
    );
  }
  // Busting is different: he buys back in at his chosen 50BB.
  assert.equal(bb(planRebuy(seat("short", 0), chips("short", 800), 0)), 50);
});

test("老陈 never tops up mid-session, only re-buys after busting", () => {
  const station = persona("station");
  for (const ratio of [0.1, 0.4, 0.9]) {
    const player = seat("station", station.buyInBB * ratio);
    assert.equal(planRebuy(player, chips("station", 900), 0), player.stack, `ratio ${ratio}`);
  }
  assert.equal(planRebuy(seat("station", 0), 0, 0), station.buyInBB * BIG_BLIND);
});

test("岩石 is reluctant: the same short stack depends on the willingness roll", () => {
  const rock = persona("rock");
  const player = seat("rock", rock.buyInBB * 0.4); // under the 0.5 trigger
  assert.ok(planRebuy(player, 0, 0) > player.stack, "willing roll tops up");
  assert.equal(planRebuy(player, 0, 0.99), player.stack, "unwilling roll keeps playing short");
});

test("火山 reloads to stay the biggest pile, capped at its ceiling", () => {
  const maniac = persona("maniac");
  const player = seat("maniac", maniac.buyInBB * 0.9); // covered by a 400BB stack
  const to = planRebuy(player, chips("maniac", 400), 0);
  assert.ok(to > player.stack);
  assert.ok(bb(to) <= maniac.buyInBB * maniac.rebuy.ceiling + 0.5, "respects the ceiling");
});

test("the human is never topped up automatically", () => {
  const hero = seat("hero", 12); // very short, but the buy-in panel owns this decision
  assert.equal(planRebuy(hero, chips("hero", 900), 0), hero.stack);
});

test("startHand records rebuys and the stacks match the records", () => {
  let state = startHand();
  // Drain a few AI stacks so the next deal has to settle them
  state.players.forEach((player) => {
    if (player.id === "boss") player.stack = Math.round(player.persona.buyInBB * BIG_BLIND * 0.3);
    if (player.id === "short") player.stack = 0;
    if (player.id === "station") player.stack = Math.round(player.persona.buyInBB * BIG_BLIND * 0.3);
  });
  const before = new Map(state.players.map((player) => [player.id, player.stack]));
  const next = startHand(state);

  assert.ok(Array.isArray(next.rebuys));
  const byId = new Map(next.rebuys.map((record) => [record.playerId, record]));

  const bossRecord = byId.get("boss");
  assert.ok(bossRecord, "boss should top up from 30%");
  assert.equal(bossRecord.kind, "top-up");
  assert.equal(bossRecord.from, before.get("boss"));
  assert.equal(bossRecord.amount, bossRecord.to - bossRecord.from);

  const shortRecord = byId.get("short");
  assert.ok(shortRecord, "a busted seat must buy back in");
  assert.equal(shortRecord.kind, "rebuy");
  assert.equal(bb(shortRecord.to), 50);

  assert.equal(byId.has("station"), false, "老陈 does not top up a live stack");

  // Every record must be reflected in the dealt stacks (blinds are posted after the rebuy)
  for (const record of next.rebuys) {
    const player = next.players.find((candidate) => candidate.id === record.playerId);
    const posted = player.streetBet; // SB/BB already deducted
    assert.equal(player.stack + posted, record.to, `${record.playerId} stack does not match its record`);
    assert.ok(record.position.length > 0, "records carry the seat position");
  }
});

test("the hand log reports rebuys", () => {
  let state = startHand();
  state.players.forEach((player) => {
    if (player.id === "boss") player.stack = Math.round(player.persona.buyInBB * BIG_BLIND * 0.2);
  });
  const next = startHand(state);
  assert.ok(next.rebuys.some((record) => record.playerId === "boss"));
});

test("every top-up is a whole number of 100BB racks", () => {
  for (const p of PERSONAS) {
    for (const ratio of [0.05, 0.2, 0.45, 0.7, 0.95]) {
      for (const biggest of [0, 100, 400, 900]) {
        const player = seat(p.id, p.buyInBB * ratio);
        if (player.stack <= 0) continue; // busting is a buy-in, not a top-up
        const to = planRebuy(player, chips(p.id, biggest), 0);
        const added = to - player.stack;
        if (added === 0) continue;
        assert.equal(added % REBUY_RACK, 0, `${p.id} added ${bb(added)}BB`);
        assert.ok(added >= REBUY_RACK, `${p.id} added less than one rack`);
        assert.ok(
          to <= Math.round(p.buyInBB * BIG_BLIND * p.rebuy.ceiling),
          `${p.id} exceeded its ceiling`,
        );
      }
    }
  }
});

test("a rack is 100BB", () => {
  assert.equal(bb(REBUY_RACK), 100);
});

test("no persona prompt carries a board-independent value threshold", () => {
  // H#0017: 老陈 shoved a bare two pair into JcJsTs Qs 7c because its prompt said
  // "raise only obvious value (two pair or better)" — a rank threshold that ignores the board.
  const banned = [
    /two pair or better/i,
    /raise only obvious value/i,
    /commit with top pair or better when SPR/i,
  ];
  for (const p of PERSONAS) {
    for (const pattern of banned) {
      assert.ok(
        !pattern.test(p.prompt),
        `${p.id} prompt still contains the board-independent rule ${pattern}`,
      );
    }
  }
});

test("board texture is addressed somewhere in every postflop-committing persona", () => {
  for (const id of ["station", "short"]) {
    const p = persona(id);
    assert.match(p.prompt, /paired|three of a suit|four-straight|three-flush/i, id);
  }
});
