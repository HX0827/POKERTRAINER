import type { ActionRecord, GameState, Street } from "./poker";

// Type-only import (same convention as strategy.ts): this module must stay runtime-free of
// the engine so it can be loaded from the client, the worker route and node --test alike.
/** Mirror of poker.ts SMALL_BLIND. */
const SMALL_BLIND = 1;
/** Mirror of poker.ts BIG_BLIND. */
const BIG_BLIND = 2;

/**
 * Behavioural model of the ONE human seat (CONTRACT-V2 §二).
 *
 * Deliberately *not* a win/loss reinforcement store: NLH results carry ~95BB/100 of
 * standard deviation, so a few hundred hands of chip swings teach superstition, not
 * strategy. Observable frequencies (how often he folds to a flop bet, how often he
 * 3bets) converge in a few hundred hands and are directly exploitable.
 *
 * Every counter here is derived from PUBLIC information only — betting actions, the
 * board, and the showdown reveal list. Hole cards are never read, not even the hero's,
 * so the AIs learn exactly what an attentive opponent at the table could learn.
 */
export interface HeroCounters {
  handsDealt: number;
  vpip: number;
  pfr: number;
  threeBetOpp: number;
  threeBet: number;
  foldToThreeBetOpp: number;
  foldToThreeBet: number;
  cbetFlopOpp: number;
  cbetFlop: number;
  foldToBetFlopOpp: number;
  foldToBetFlop: number;
  foldToBetTurnOpp: number;
  foldToBetTurn: number;
  foldToBetRiverOpp: number;
  foldToBetRiver: number;
  foldToAllInOpp: number;
  foldToAllIn: number;
  postflopAggro: number;
  postflopPassive: number;
  sawFlop: number;
  wentToShowdown: number;
}

export const EMPTY_HERO_COUNTERS: HeroCounters = Object.freeze({
  handsDealt: 0,
  vpip: 0,
  pfr: 0,
  threeBetOpp: 0,
  threeBet: 0,
  foldToThreeBetOpp: 0,
  foldToThreeBet: 0,
  cbetFlopOpp: 0,
  cbetFlop: 0,
  foldToBetFlopOpp: 0,
  foldToBetFlop: 0,
  foldToBetTurnOpp: 0,
  foldToBetTurn: 0,
  foldToBetRiverOpp: 0,
  foldToBetRiver: 0,
  foldToAllInOpp: 0,
  foldToAllIn: 0,
  postflopAggro: 0,
  postflopPassive: 0,
  sawFlop: 0,
  wentToShowdown: 0,
});

type CounterKey = keyof HeroCounters;

const COUNTER_KEYS = Object.keys(EMPTY_HERO_COUNTERS) as CounterKey[];

/** Counters arrive from D1 as JSON and from the client as user-shaped objects: never trust them. */
function readCounter(source: HeroCounters | undefined, key: CounterKey): number {
  const value = source ? source[key] : 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * A raise/bet in engine terms: the player moved the street's bet level up.
 * `allin` alone is not aggression — a short stack calling off all its chips records
 * `kind: "allin"` with `toAmount <= facedBet`, which is a call, not a raise.
 */
function isAggressive(action: ActionRecord): boolean {
  return (
    (action.kind === "raise" || action.kind === "allin") && action.toAmount > action.facedBet
  );
}

/** Chips the hero already has in front of him when a street opens (blinds are posted, not acted). */
function blindPosted(position: string): number {
  if (position === "SB") return SMALL_BLIND;
  if (position === "BB") return BIG_BLIND;
  return 0;
}

/**
 * Public-information increments for one FINISHED hand.
 *
 * Reads `state.actions` in order, tracking the street's bet level so that "faced a bet"
 * and "faced an all-in" are answered from the same data the villains could see.
 * Returns all-zero counters (not a throw) for any state without a hero seat.
 */
export function heroCountersForHand(state: GameState): HeroCounters {
  const counters: HeroCounters = { ...EMPTY_HERO_COUNTERS };
  const players = Array.isArray(state?.players) ? state.players : [];
  const hero = players.find((player) => player.isHero);
  if (!hero) return counters;

  const actions: ActionRecord[] = Array.isArray(state.actions) ? state.actions : [];
  const community = Array.isArray(state.community) ? state.community : [];
  const revealed = Array.isArray(state.revealed) ? state.revealed : [];
  counters.handsDealt = 1;

  let street: Street | "" = "";
  /** Bet level to match on this street (preflop opens at the big blind, which nobody "bet"). */
  let level = 0;
  /** Whether the player who set `level` is all-in behind it. */
  let levelIsAllIn = false;
  /** Chips the hero already has in on this street. */
  let heroStreetBet = 0;

  let preflopRaises = 0;
  let firstPreflopRaiserId = "";
  let lastPreflopRaiserId = "";
  let heroFoldedPreflop = false;
  let threeBetSettled = false;
  let foldToThreeBetSettled = false;
  let cbetSettled = false;

  for (const action of actions) {
    if (action.street !== street) {
      street = action.street;
      const preflop = street === "preflop";
      level = preflop ? BIG_BLIND : 0;
      levelIsAllIn = false;
      heroStreetBet = preflop ? blindPosted(hero.position) : 0;
    }

    const aggressive = isAggressive(action);

    if (action.playerId === hero.id) {
      const folded = action.kind === "fold";
      // Facing a bet means there is more to match than he already put in this street.
      const facingBet = action.facedBet > heroStreetBet;

      if (facingBet && levelIsAllIn && level === action.facedBet) {
        counters.foldToAllInOpp += 1;
        if (folded) counters.foldToAllIn += 1;
      }

      if (street === "preflop") {
        // Every preflop call requires toCall > 0 (a free option is recorded as `check`),
        // so a call is always voluntary money: the SB completion counts, the BB check does not.
        if (action.kind === "call" || action.kind === "raise" || action.kind === "allin") {
          counters.vpip = 1;
        }
        if (aggressive) counters.pfr = 1;
        if (folded) heroFoldedPreflop = true;

        if (!threeBetSettled && preflopRaises === 1 && firstPreflopRaiserId !== hero.id) {
          threeBetSettled = true;
          counters.threeBetOpp = 1;
          if (aggressive) counters.threeBet = 1;
        }
        if (!foldToThreeBetSettled && preflopRaises >= 2 && firstPreflopRaiserId === hero.id) {
          foldToThreeBetSettled = true;
          counters.foldToThreeBetOpp = 1;
          if (folded) counters.foldToThreeBet = 1;
        }
      } else {
        if (aggressive) counters.postflopAggro += 1;
        else if (action.kind === "call" || action.kind === "allin") counters.postflopPassive += 1;

        if (facingBet) {
          if (street === "flop") {
            counters.foldToBetFlopOpp += 1;
            if (folded) counters.foldToBetFlop += 1;
          } else if (street === "turn") {
            counters.foldToBetTurnOpp += 1;
            if (folded) counters.foldToBetTurn += 1;
          } else if (street === "river") {
            counters.foldToBetRiverOpp += 1;
            if (folded) counters.foldToBetRiver += 1;
          }
        }

        if (street === "flop" && !cbetSettled) {
          cbetSettled = true;
          // Only the preflop aggressor with the betting lead has a c-bet decision; if
          // somebody donked into him first, the spot is a raise decision, not a c-bet.
          if (lastPreflopRaiserId === hero.id && action.facedBet === 0) {
            counters.cbetFlopOpp = 1;
            if (aggressive) counters.cbetFlop = 1;
          }
        }
      }

      // fold/check leave `toAmount` at the street bet he already had, so this is safe for all kinds.
      heroStreetBet = action.toAmount;
    }

    if (aggressive) {
      if (street === "preflop") {
        preflopRaises += 1;
        if (!firstPreflopRaiserId) firstPreflopRaiserId = action.playerId;
        lastPreflopRaiserId = action.playerId;
      }
      level = action.toAmount;
      levelIsAllIn = action.allInAfterAction;
    }
  }

  // "Saw the flop" = did not fold before it was dealt (being all-in preflop still counts).
  counters.sawFlop = !heroFoldedPreflop && community.length >= 3 ? 1 : 0;
  // `revealed` is only populated at a real showdown, and only for players still in the hand.
  counters.wentToShowdown = counters.sawFlop === 1 && revealed.includes(hero.id) ? 1 : 0;
  return counters;
}

export function mergeHeroCounters(a: HeroCounters, b: HeroCounters): HeroCounters {
  const result = { ...EMPTY_HERO_COUNTERS };
  for (const key of COUNTER_KEYS) {
    result[key] = readCounter(a, key) + readCounter(b, key);
  }
  return result;
}

export interface HeroProfileSummary {
  handsDealt: number;
  /** 供提示词使用的一行英文，样本不足的项自动省略；无可用项时返回 "" */
  text: string;
  lines: Array<{ key: string; label: string; made: number; opp: number; pct: number }>;
}

/**
 * Stat table. `opp` is always the honest denominator so the prompt can show (made/opp)
 * and the model can discount a 2/3 sample by itself.
 */
const STAT_DEFINITIONS: Array<{
  key: string;
  label: string;
  made: (counters: HeroCounters) => number;
  opp: (counters: HeroCounters) => number;
}> = [
  { key: "vpip", label: "VPIP", made: (c) => c.vpip, opp: (c) => c.handsDealt },
  { key: "pfr", label: "PFR", made: (c) => c.pfr, opp: (c) => c.handsDealt },
  { key: "threeBet", label: "3bet", made: (c) => c.threeBet, opp: (c) => c.threeBetOpp },
  {
    key: "foldToThreeBet",
    label: "folds to 3bet",
    made: (c) => c.foldToThreeBet,
    opp: (c) => c.foldToThreeBetOpp,
  },
  { key: "cbetFlop", label: "flop cbet", made: (c) => c.cbetFlop, opp: (c) => c.cbetFlopOpp },
  {
    key: "foldToBetFlop",
    label: "folds to flop bet",
    made: (c) => c.foldToBetFlop,
    opp: (c) => c.foldToBetFlopOpp,
  },
  {
    key: "foldToBetTurn",
    label: "folds to turn bet",
    made: (c) => c.foldToBetTurn,
    opp: (c) => c.foldToBetTurnOpp,
  },
  {
    key: "foldToBetRiver",
    label: "folds to river bet",
    made: (c) => c.foldToBetRiver,
    opp: (c) => c.foldToBetRiverOpp,
  },
  {
    key: "foldToAllIn",
    label: "fold vs all-in",
    made: (c) => c.foldToAllIn,
    opp: (c) => c.foldToAllInOpp,
  },
  {
    key: "postflopAggro",
    label: "postflop aggression",
    made: (c) => c.postflopAggro,
    opp: (c) => c.postflopAggro + c.postflopPassive,
  },
  {
    key: "wtsd",
    label: "WTSD",
    made: (c) => c.wentToShowdown,
    opp: (c) => c.sawFlop,
  },
];

/** Below this many hands even VPIP is noise, so nothing is injected into the prompt. */
const MIN_HANDS_FOR_TEXT = 15;

type StatLine = HeroProfileSummary["lines"][number];

/** Every stat with a non-zero denominator, `made` clamped so no rate can exceed 100%. */
function statLines(safe: HeroCounters): StatLine[] {
  return STAT_DEFINITIONS.map((stat) => {
    const opp = stat.opp(safe);
    const made = Math.min(stat.made(safe), opp);
    return {
      key: stat.key,
      label: stat.label,
      made,
      opp,
      pct: opp > 0 ? Math.round((made / opp) * 100) : 0,
    };
  }).filter((line) => line.opp > 0);
}

export function summarizeHeroProfile(counters: HeroCounters, minSample = 8): HeroProfileSummary {
  const safe = mergeHeroCounters(counters, EMPTY_HERO_COUNTERS);
  const threshold =
    typeof minSample === "number" && Number.isFinite(minSample) ? Math.max(1, minSample) : 8;

  const lines = statLines(safe);

  const text =
    safe.handsDealt < MIN_HANDS_FOR_TEXT
      ? ""
      : lines
          .filter((line) => line.opp >= threshold)
          .map((line) => `${line.label} ${line.pct}% (${line.made}/${line.opp})`)
          .join(" | ");

  return { handsDealt: safe.handsDealt, text, lines };
}

/**
 * Hard floor on the denominator of any statistic that becomes an instruction.
 *
 * Published analysis of LLMs playing poker found that models handed opponent statistics make
 * wild exploitative adjustments off samples far too small to support them — the model reads
 * "folds to flop bets 100%" and starts bluffing every pot, when the true reading is "folded
 * twice". A rate is a directive only once its denominator reaches 12; below that the honest
 * (made/opp) line from `summarizeHeroProfile` is all the model gets, and it can discount that
 * by itself. 12 is chosen because it is the point where a 65% observed fold rate is unlikely
 * to be a 40% player having a quiet run, while still being reachable inside one sitting.
 */
const DIRECTIVE_MIN_SAMPLE = 12;

/** At most this many instructions, so the read stays a read and not a strategy document. */
const MAX_DIRECTIVES = 5;

/** A stat that cleared the sample gate. */
interface SampledStat {
  made: number;
  opp: number;
  pct: number;
}

/** Returns the stat only when its denominator clears the gate — otherwise null, and the rule
 *  that asked for it produces nothing. Every directive therefore carries a real sample. */
type StatLookup = (key: string) => SampledStat | null;

/** The sample, spelled out inside the sentence: `85% (17/20)`. */
function withSample(stat: SampledStat): string {
  return `${stat.pct}% (${stat.made}/${stat.opp})`;
}

/**
 * Exploit rules, each with the threshold's reasoning.
 *
 * `weight` ranks the rules against each other by how much money the adjustment is worth per
 * hand, because only the top few survive the cap: a leak that shows up on every flop beats one
 * that needs him to face a 3-bet first. Rules that contradict each other (folds too much /
 * folds too little) are gated on opposite sides of the same number, so they can never both fire.
 */
const DIRECTIVE_RULES: Array<{ weight: number; build: (stat: StatLookup) => string | null }> = [
  {
    // Biggest and most frequent lever at this table: it applies on every single flop.
    // A half-pot c-bet risks 0.5 to win 1, so it needs to work 33% of the time; at 65%+ folds
    // a bluff with zero equity is already profitable, and a second barrel usually is too.
    weight: 10,
    build: (stat) => {
      const fold = stat("foldToBetFlop");
      if (!fold || fold.pct < 65) return null;
      return `He folds to flop bets ${withSample(fold)} — c-bet almost every flop against him and fire again on the turn.`;
    },
  },
  {
    // Same 33% break-even from the other side: under 30% folds every bluff loses money, so the
    // adjustment is to stop bluffing and widen the value range instead.
    weight: 9,
    build: (stat) => {
      const fold = stat("foldToBetFlop");
      if (!fold || fold.pct > 30) return null;
      return `He folds to flop bets only ${withSample(fold)} — bet your made hands thin for value against him and stop bluffing.`;
    },
  },
  {
    // The 40/10 calling-station line. A wide passive preflop range is inelastic: it calls one
    // more street with hands it should fold, which pays value bets and absorbs bluffs.
    // PFR below half of VPIP is what separates a station from a loose aggressive player: 40/15
    // is a station, 40/20 is a LAG and gets no such instruction.
    weight: 8,
    build: (stat) => {
      const vpip = stat("vpip");
      const pfr = stat("pfr");
      if (!vpip || !pfr || vpip.pct < 40 || pfr.pct * 2 >= vpip.pct) return null;
      return `He enters ${withSample(vpip)} of hands but raises only ${withSample(pfr)} — he calls too wide preflop: value bet relentlessly and bluff him less.`;
    },
  },
  {
    // Under 25% WTSD means he is folding the river with hands that beat a bluff. Both extra
    // barrels and thin value bets get paid by the range he keeps.
    weight: 7,
    build: (stat) => {
      const wtsd = stat("wtsd");
      if (!wtsd || wtsd.pct >= 25) return null;
      return `He reaches showdown on only ${withSample(wtsd)} of the flops he sees — he gives up before the river, so extra barrels print.`;
    },
  },
  {
    // Above 45% he is a station to the river: the bluffs stop working long before the value
    // bets do, which is the opposite adjustment to the rule above it.
    weight: 6.5,
    build: (stat) => {
      const wtsd = stat("wtsd");
      if (!wtsd || wtsd.pct <= 45) return null;
      return `He reaches showdown on ${withSample(wtsd)} of the flops he sees — value bet thin against him and never bluff the river.`;
    },
  },
  {
    // A 3-bet risks about 2.5x to win the pot plus the open; folding two thirds of opens makes
    // 3-betting any two cards profitable before the flop is even dealt.
    weight: 6,
    build: (stat) => {
      const fold = stat("foldToThreeBet");
      if (!fold || fold.pct < 65) return null;
      return `He folds to 3-bets ${withSample(fold)} — 3-bet him light when he opens; his opening range cannot defend itself.`;
    },
  },
  {
    // Baseline 3-bet frequency is 6-8%. At or below 5% his 3-bets are the top of his range, so
    // marginal opens are drawing thin — but this is a fold instruction, worth less than the
    // aggression ones because it only saves the open.
    weight: 5.5,
    build: (stat) => {
      const threeBet = stat("threeBet");
      if (!threeBet || threeBet.pct > 5) return null;
      return `He has 3-bet only ${threeBet.made} of ${threeBet.opp} spots (${threeBet.pct}%) — his 3-bets are premium-only, so fold your marginal opens to him.`;
    },
  },
  {
    // The turn is where most players run out of hand: 60%+ folds means the second barrel is the
    // profitable one even when the first was called.
    weight: 5,
    build: (stat) => {
      const fold = stat("foldToBetTurn");
      if (!fold || fold.pct < 60) return null;
      return `He folds to turn bets ${withSample(fold)} — barrel the turn against him even when he called the flop.`;
    },
  },
  {
    // A c-bet on 80%+ of flops cannot be a range of made hands, so floating in position and
    // taking the pot on the turn beats folding to it.
    weight: 4.5,
    build: (stat) => {
      const cbet = stat("cbetFlop");
      if (!cbet || cbet.pct < 80) return null;
      return `He c-bets ${withSample(cbet)} of his flops — float him in position and take the pot away on the turn.`;
    },
  },
  {
    // Under 15% of his postflop actions are raises: his aggression is therefore almost always
    // the real thing, and his checks carry no information at all.
    weight: 4,
    build: (stat) => {
      const aggro = stat("postflopAggro");
      if (!aggro || aggro.pct > 15) return null;
      return `Only ${withSample(aggro)} of his postflop actions are aggressive — when he does bet or raise, believe it; his checks mean nothing.`;
    },
  },
  {
    // Folding to 60%+ of all-ins makes the shove a fold-equity play rather than a showdown, so
    // the stack sizes matter more than the hand does.
    weight: 3.5,
    build: (stat) => {
      const fold = stat("foldToAllIn");
      if (!fold || fold.pct < 60) return null;
      return `He folds to all-ins ${withSample(fold)} — a jam wins the pot outright often enough to be a play against him.`;
    },
  },
  {
    // A nit at 15% VPIP or tighter: his blinds are free money and his voluntary chips are not.
    weight: 3,
    build: (stat) => {
      const vpip = stat("vpip");
      if (!vpip || vpip.pct > 15) return null;
      return `He enters only ${withSample(vpip)} of hands — steal his blinds relentlessly and respect the money he does put in.`;
    },
  },
];

/**
 * Turn the hero's statistics into executable instructions, ranked by how much the adjustment is
 * worth, at most `MAX_DIRECTIVES` of them. Returns `[]` when nothing has a real sample yet.
 *
 * `minSample` may only RAISE the denominator required (a caller wanting to be more careful);
 * it can never lower it below `DIRECTIVE_MIN_SAMPLE`, because that discipline is the whole
 * point of this function. Every returned sentence quotes its own (made/opp) so the model can
 * see the sample it is acting on.
 */
export function exploitDirectives(
  counters: HeroCounters,
  minSample = DIRECTIVE_MIN_SAMPLE,
): string[] {
  const safe = mergeHeroCounters(counters, EMPTY_HERO_COUNTERS);
  const requested =
    typeof minSample === "number" && Number.isFinite(minSample) ? minSample : DIRECTIVE_MIN_SAMPLE;
  const threshold = Math.max(DIRECTIVE_MIN_SAMPLE, Math.floor(requested));

  const byKey = new Map<string, StatLine>();
  for (const line of statLines(safe)) byKey.set(line.key, line);

  const lookup: StatLookup = (key) => {
    const line = byKey.get(key);
    if (!line || line.opp < threshold) return null;
    return { made: line.made, opp: line.opp, pct: line.pct };
  };

  const fired: Array<{ weight: number; text: string }> = [];
  for (const rule of DIRECTIVE_RULES) {
    const text = rule.build(lookup);
    if (text) fired.push({ weight: rule.weight, text });
  }
  fired.sort((a, b) => b.weight - a.weight);
  return fired.slice(0, MAX_DIRECTIVES).map((entry) => entry.text);
}
