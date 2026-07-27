// Strategy guardrail engine — see CONTRACT-V2.md §一.
// SIGNATURES ARE FROZEN: route.ts, PokerTrainer.tsx and tests code against them.
//
// V2 rewrite. V1 policed every decision against a preflop range matrix and a
// postflop equity floor; measured on 700 local hands it crushed the table's
// VPIP from 39.4% to 19.2% and flattened seven personalities into one nit.
// The hands that actually needed policing (H#0003 / H#0004) were all BIG-MONEY
// spots — stacking off with ~20% equity and no implied odds against an all-in.
// So V2 scales with the cost of the mistake instead of with its style:
//
//   preflop  -> never a veto, silent size clamps only        (preflopVerdict)
//   postflop -> exactly two lethal lines:
//                 POST-CALL-ALLIN  desperate big-money call  (postflopCallVerdict)
//                 POST-JAM-EQUITY  pure-air jam with no fold equity
//               everything else passes; sizes are clamped silently.
//
// The Monte-Carlo equity engine, the outs estimator and the villain range model
// are all still here — the two surviving rules are built on them.
//
// All amounts are chips (SB = 1, BB = 2). Design-doc BB numbers are doubled here.
// Math.random() is never used on a verdict path: every rollout comes from a
// mulberry32 PRNG seeded by a stable hash of the observation.
//
// RUNTIME IMPORTS: none. `import type` is erased by both tsc and Node's
// --experimental-strip-types, so this module loads directly in `node --test`
// (tests/strategy-guardrail.test.mjs imports it as ../app/lib/strategy.ts).
// A *value* import of "./poker" cannot satisfy both toolchains: Node's ESM
// resolver will not map "./poker" to poker.ts, and tsc rejects "./poker.ts"
// with TS5097 unless tsconfig sets allowImportingTsExtensions (tsconfig is
// outside this agent's ownership). BIG_BLIND / preflopHandClass /
// preflopStrength are therefore mirrored verbatim from poker.ts below — see
// mirroredPokerHelpers() for an equality check tests can run against the
// real exports.
import type { ActionKind, BotObservation, OpponentProfile } from "./poker";

/**
 * Frozen union — route.ts types against every member. V2 only ever emits
 * POST-CALL-ALLIN and POST-JAM-EQUITY; the PF-* and other POST-* members are
 * retained so the client's rule-name handling keeps type-checking.
 */
export type RuleId =
  | "PF-OPEN-RANGE"
  | "PF-RANGE-VS-OPEN"
  | "PF-RANGE-VS-3BET"
  | "PF-COLD-VS-3BET"
  | "PF-RANGE-VS-4BET"
  | "PF-RANGE-VS-5BET"
  | "PF-RAISE-SIZE"
  | "POST-CALL-EQUITY"
  | "POST-CALL-ALLIN"
  | "POST-RAISE-VALUE"
  | "POST-RAISE-SEMIBLUFF"
  | "POST-RAISE-BLUFF"
  | "POST-JAM-EQUITY"
  | "GEN-SIZE-CLAMP";

export interface PersonaTraits {
  id: string;
  looseness: number;
  aggression: number;
  bluff: number;
}

export interface GuardrailNumbers {
  /** Effective price to call: effCall / (potWithoutVillainExcess + effCall). 0 when not facing a bet. */
  requiredEquity: number;
  /** Engine Monte-Carlo equity vs modeled ranges; null preflop (V2 never rates a preflop hand). */
  engineEquity: number | null;
  /** Conservative outs estimate; null preflop. */
  outs: number | null;
  /** Effective stack-to-pot ratio at decision time; null preflop. */
  effectiveSpr: number | null;
  /** Human-readable summary of the modeled villain range(s), English. */
  assumedRange: string;
}

export interface GuardrailVerdict {
  ok: boolean;
  /** Set when ok === false. */
  rule?: RuleId;
  /** Short English explanation with the concrete numbers; used verbatim in the retry message. */
  detail?: string;
  numbers?: GuardrailNumbers;
  /** Set when ok === true but the raise size was clamped into a sane band. */
  clampedRaiseTo?: number;
}

export interface BotDecision {
  action: ActionKind;
  raiseTo?: number;
}

/* ------------------------------------------------------------------ */
/* Mirrored from poker.ts (see the header note on why they are copied)  */
/* ------------------------------------------------------------------ */

/** Mirror of poker.ts BIG_BLIND. */
const BIG_BLIND = 2;

const RANK_CHARS = "23456789TJQKA";
const SUIT_CHARS = "shdc";

/** Card index 0..51: rankIndex * 4 + suitIndex (rank 2 => rankIndex 0). */
function rankOfIndex(index: number): number {
  return (index >> 2) + 2;
}

/** Verbatim mirror of poker.ts preflopStrength(), over card indices. */
function preflopStrengthOf(cardA: number, cardB: number): number {
  const rankA = rankOfIndex(cardA);
  const rankB = rankOfIndex(cardB);
  const high = Math.max(rankA, rankB);
  const low = Math.min(rankA, rankB);
  const pair = rankA === rankB;
  const suited = (cardA & 3) === (cardB & 3);
  const gap = high - low;
  let score = ((high - 2) / 12) * 0.46 + ((low - 2) / 12) * 0.18;
  if (pair) score += 0.27 + ((high - 2) / 12) * 0.16;
  if (suited) score += 0.06;
  if (gap <= 1) score += 0.05;
  else if (gap >= 4) score -= 0.05;
  if (high === 14) score += 0.06;
  return Math.max(0, Math.min(1, score));
}

/** Verbatim mirror of poker.ts preflopHandClass(), over card indices. */
function preflopHandClassOf(cardA: number, cardB: number): string {
  const high = rankOfIndex(cardA) >= rankOfIndex(cardB) ? cardA : cardB;
  const low = high === cardA ? cardB : cardA;
  const highRank = RANK_CHARS[high >> 2];
  const lowRank = RANK_CHARS[low >> 2];
  if (highRank === lowRank) return `${highRank}${lowRank}`;
  return `${highRank}${lowRank}${(high & 3) === (low & 3) ? "s" : "o"}`;
}

/**
 * Escape hatch for tests: lets `tests/*.test.mjs` assert the mirrored helpers
 * still agree with the real poker.ts exports (same inputs, same outputs).
 */
export function mirroredPokerHelpers(): {
  bigBlind: number;
  strength: (a: string, b: string) => number;
  handClass: (a: string, b: string) => string;
} {
  return {
    bigBlind: BIG_BLIND,
    strength: (a, b) => preflopStrengthOf(parseCardCode(a), parseCardCode(b)),
    handClass: (a, b) => preflopHandClassOf(parseCardCode(a), parseCardCode(b)),
  };
}

/* ------------------------------------------------------------------ */
/* Tuning constants (V2)                                               */
/* ------------------------------------------------------------------ */

const MC_ROLLOUTS = 1500;

/** POST-CALL-ALLIN gate 1: a call below this share of the money still at risk is cheap — never vetoed. */
const COMMITMENT_FRACTION = 0.25;
/** POST-CALL-ALLIN gate 2: hard equity margin. No persona tolerance in V2. */
const DESPERATION_MARGIN = 0.12;
/** Extra slack when a live (non-all-in) opponent can still pay off a real draw. */
const IMPLIED_ODDS_SLACK = 0.08;
/** Outs needed before the implied-odds slack applies. */
const IMPLIED_ODDS_MIN_OUTS = 8;

/** POST-JAM-EQUITY: only sizes above this multiple of the pot are in scope. */
const JAM_POT_RATIO = 1.5;
/** POST-JAM-EQUITY: "pure air" equity ceiling. */
const JAM_EQUITY_FLOOR = 0.25;
/** POST-JAM-EQUITY: "pure air" outs ceiling. */
const JAM_OUTS_FLOOR = 4;

/** Postflop silent size clamp: currentBet + this many pots (V1 used 1.5). */
const POSTFLOP_SIZE_CAP_POTS = 2.5;

/* ------------------------------------------------------------------ */
/* Card helpers                                                        */
/* ------------------------------------------------------------------ */

function parseCardCode(code: unknown): number {
  if (typeof code !== "string" || code.length < 2) return -1;
  const rank = RANK_CHARS.indexOf(code[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(code[1].toLowerCase());
  if (rank < 0 || suit < 0) return -1;
  return rank * 4 + suit;
}

function parseCardCodes(codes: unknown): number[] {
  if (!Array.isArray(codes)) return [];
  const out: number[] = [];
  for (const code of codes) {
    const index = parseCardCode(code);
    if (index >= 0 && !out.includes(index)) out.push(index);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fast 7-card evaluator (ordering-compatible with poker.ts bestScore)  */
/* ------------------------------------------------------------------ */

const scratchRankCount = new Int8Array(15);
const scratchSuitCount = new Int8Array(4);
const scratchSuitMask = new Int32Array(4);

function encodeScore(cat: number, a: number, b: number, c: number, d: number, e: number): number {
  return ((((cat * 16 + a) * 16 + b) * 16 + c) * 16 + d) * 16 + e;
}

function straightHigh(mask: number): number {
  let bits = mask;
  if (bits & (1 << 14)) bits |= 1 << 1; // wheel ace
  for (let high = 14; high >= 5; high -= 1) {
    if (((bits >> (high - 4)) & 0b11111) === 0b11111) return high;
  }
  return 0;
}

/** Numeric hand strength for 5..7 card indices; higher is better. */
function evaluateCards(cards: number[], count: number): number {
  scratchRankCount.fill(0);
  scratchSuitCount.fill(0);
  scratchSuitMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < count; i += 1) {
    const index = cards[i];
    const rank = (index >> 2) + 2;
    const suit = index & 3;
    scratchRankCount[rank] += 1;
    scratchSuitCount[suit] += 1;
    scratchSuitMask[suit] |= 1 << rank;
    rankMask |= 1 << rank;
  }

  let flushSuit = -1;
  for (let suit = 0; suit < 4; suit += 1) {
    if (scratchSuitCount[suit] >= 5) {
      flushSuit = suit;
      break;
    }
  }
  if (flushSuit >= 0) {
    // With 5 cards of one suit, quads and full houses are impossible, so an
    // early return here cannot mis-order anything.
    const mask = scratchSuitMask[flushSuit];
    const sf = straightHigh(mask);
    if (sf) return encodeScore(8, sf, 0, 0, 0, 0);
    const top: number[] = [];
    for (let rank = 14; rank >= 2 && top.length < 5; rank -= 1) {
      if (mask & (1 << rank)) top.push(rank);
    }
    return encodeScore(5, top[0], top[1], top[2], top[3], top[4]);
  }

  let quad = 0;
  let trips = 0;
  let trips2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let rank = 14; rank >= 2; rank -= 1) {
    const n = scratchRankCount[rank];
    if (n === 4) {
      if (!quad) quad = rank;
    } else if (n === 3) {
      if (!trips) trips = rank;
      else if (!trips2) trips2 = rank;
    } else if (n === 2) {
      if (!pair1) pair1 = rank;
      else if (!pair2) pair2 = rank;
    }
  }

  if (quad) {
    let kicker = 0;
    for (let rank = 14; rank >= 2; rank -= 1) {
      if (rank !== quad && scratchRankCount[rank] > 0) {
        kicker = rank;
        break;
      }
    }
    return encodeScore(7, quad, kicker, 0, 0, 0);
  }
  if (trips && (pair1 || trips2)) {
    return encodeScore(6, trips, Math.max(pair1, trips2), 0, 0, 0);
  }
  const st = straightHigh(rankMask);
  if (st) return encodeScore(4, st, 0, 0, 0, 0);
  if (trips) {
    const kickers: number[] = [];
    for (let rank = 14; rank >= 2 && kickers.length < 2; rank -= 1) {
      if (rank !== trips && scratchRankCount[rank] > 0) kickers.push(rank);
    }
    return encodeScore(3, trips, kickers[0] ?? 0, kickers[1] ?? 0, 0, 0);
  }
  if (pair1 && pair2) {
    let kicker = 0;
    for (let rank = 14; rank >= 2; rank -= 1) {
      if (rank !== pair1 && rank !== pair2 && scratchRankCount[rank] > 0) {
        kicker = rank;
        break;
      }
    }
    return encodeScore(2, pair1, pair2, kicker, 0, 0);
  }
  if (pair1) {
    const kickers: number[] = [];
    for (let rank = 14; rank >= 2 && kickers.length < 3; rank -= 1) {
      if (rank !== pair1 && scratchRankCount[rank] > 0) kickers.push(rank);
    }
    return encodeScore(1, pair1, kickers[0] ?? 0, kickers[1] ?? 0, kickers[2] ?? 0, 0);
  }
  const high: number[] = [];
  for (let rank = 14; rank >= 2 && high.length < 5; rank -= 1) {
    if (scratchRankCount[rank] > 0) high.push(rank);
  }
  return encodeScore(0, high[0], high[1], high[2], high[3], high[4]);
}

/* ------------------------------------------------------------------ */
/* Deterministic PRNG                                                  */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function observationSeed(observation: BotObservation): number {
  const hole = Array.isArray(observation.holeCards) ? observation.holeCards.join("") : "";
  const board = Array.isArray(observation.communityCards) ? observation.communityCards.join("") : "";
  return hashString(`${hole}|${board}|${finite(observation.pot, 0)}|${finite(observation.toCall, 0)}`);
}

/* ------------------------------------------------------------------ */
/* Ranked 1326 combos (built once, lazily)                             */
/* ------------------------------------------------------------------ */

let rankedComboA: Int32Array | null = null;
let rankedComboB: Int32Array | null = null;

function rankedCombos(): { a: Int32Array; b: Int32Array } {
  if (!rankedComboA || !rankedComboB) {
    const combos: Array<{ a: number; b: number; s: number }> = [];
    for (let i = 0; i < 52; i += 1) {
      for (let j = i + 1; j < 52; j += 1) {
        combos.push({ a: i, b: j, s: preflopStrengthOf(i, j) });
      }
    }
    combos.sort((x, y) => y.s - x.s || x.a - y.a || x.b - y.b);
    rankedComboA = new Int32Array(combos.length);
    rankedComboB = new Int32Array(combos.length);
    combos.forEach((combo, index) => {
      rankedComboA![index] = combo.a;
      rankedComboB![index] = combo.b;
    });
  }
  return { a: rankedComboA, b: rankedComboB };
}

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Veto details are read by the model on the retry turn, and everything the model sees is
 * denominated in big blinds. Formatting these in raw chips would put two units in one message
 * — exactly the mix-up that made it report a 64-chip stack as "64BB".
 */
function chips(value: number): string {
  const inBB = Math.round((value / BIG_BLIND) * 10) / 10;
  return `${inBB}BB`;
}

function traits(persona: PersonaTraits | null | undefined): PersonaTraits {
  return {
    id: typeof persona?.id === "string" ? persona.id : "unknown",
    looseness: finite(persona?.looseness, 0.5),
    aggression: finite(persona?.aggression, 0.5),
    bluff: finite(persona?.bluff, 0.5),
  };
}

/* ------------------------------------------------------------------ */
/* Effective-amount math                                               */
/* ------------------------------------------------------------------ */

function effectiveCall(observation: BotObservation): number {
  return Math.min(Math.max(0, finite(observation.toCall, 0)), Math.max(0, finite(observation.stack, 0)));
}

/** effCall / ((pot - villainExcess) + effCall). 0 when not facing a bet. */
function requiredEquityOf(observation: BotObservation): number {
  const toCall = Math.max(0, finite(observation.toCall, 0));
  const effCall = effectiveCall(observation);
  if (effCall <= 0) return 0;
  const excess = toCall - effCall;
  const pot = Math.max(0, finite(observation.pot, 0));
  const denominator = pot - excess + effCall;
  if (denominator <= 0) return 1;
  return Math.min(1, Math.max(0, effCall / denominator));
}

/** Effective pot the caller is actually playing for (denominator of requiredEquity). */
function effectivePotOf(observation: BotObservation): number {
  const toCall = Math.max(0, finite(observation.toCall, 0));
  const effCall = effectiveCall(observation);
  const excess = toCall - effCall;
  return Math.max(0, finite(observation.pot, 0)) - excess + effCall;
}

/**
 * Chips hero can still lose in this hand — the denominator of the
 * COMMITMENT_FRACTION gate.
 *
 * CONTRACT-V2 §一 writes this as `observation.stack` ("身后筹码"). Taken
 * literally that reading contradicts the contract's own mandatory case 9
 * (H#0003: hero has 200 behind but the whole effective stack is 53, so the
 * 45-chip call off is 22.5% of `stack` and would slip under the 25% gate while
 * being ~85% of the money actually in play). `observation.effectiveStack` is
 * the hand's effective stack from poker.ts (min of hero's and the largest live
 * opponent's starting stack), so capping by it keeps big-money spots in scope
 * without ever making the gate *stricter* than the contract's own examples.
 */
function heroMoneyAtRisk(observation: BotObservation): number {
  const behind = Math.max(0, finite(observation.stack, 0));
  const effective = Math.max(0, finite(observation.effectiveStack, behind));
  return effective > 0 ? Math.min(behind, effective) : behind;
}

interface LiveOpponent {
  position: string;
  stack: number;
  allIn: boolean;
}

function liveOpponentsOf(observation: BotObservation): LiveOpponent[] {
  const heroPosition = observation.position;
  const publicPlayers = Array.isArray(observation.publicPlayers) ? observation.publicPlayers : [];
  const fromPublic = publicPlayers
    .filter((player) => player && player.position !== heroPosition && !player.folded)
    .map((player) => ({
      position: String(player.position ?? "?"),
      stack: Math.max(0, finite(player.stack, 0)),
      allIn: Boolean(player.allIn),
    }));
  if (fromPublic.length > 0) return fromPublic;

  const profiles = Array.isArray(observation.opponentProfiles) ? observation.opponentProfiles : [];
  const fallbackStack = Math.max(0, finite(observation.effectiveStack, finite(observation.stack, 0)));
  return profiles.map((profile) => ({
    position: String(profile?.position ?? "?"),
    stack: fallbackStack,
    allIn: Boolean(profile?.allIn),
  }));
}

function largestLiveOpponentStack(opponents: LiveOpponent[]): number {
  let max = 0;
  for (const opponent of opponents) if (opponent.stack > max) max = opponent.stack;
  return max;
}

/* ------------------------------------------------------------------ */
/* Villain range modeling (feeds the Monte-Carlo engine)               */
/* ------------------------------------------------------------------ */

const LATE_POSITIONS = new Set(["BTN", "CO"]);

interface RangeSpec {
  position: string;
  percentile: number;
  label: string;
}

function rangeSpecFor(profile: OpponentProfile | undefined | null): RangeSpec {
  const position = String(profile?.position ?? "?");
  const aggression = finite(profile?.preflopAggression, 0);
  let percentile: number;
  let reason: string;
  if (aggression >= 4) {
    percentile = 0.06;
    reason = "5-bet+";
  } else if (aggression === 3) {
    percentile = 0.06;
    reason = "4-bet";
  } else if (aggression === 2) {
    percentile = 0.12;
    reason = "3-bet";
  } else if (aggression === 1) {
    percentile = LATE_POSITIONS.has(position) ? 0.4 : 0.3;
    reason = "open";
  } else if (profile?.calledRaisePreflop) {
    percentile = 0.45;
    reason = "called a raise";
  } else if (position === "BB") {
    percentile = 1;
    reason = "blind, no voluntary action";
  } else {
    percentile = 0.7;
    reason = "limp/passive";
  }
  if (profile?.bigAggressionThisStreet) {
    percentile *= 0.55;
    reason += ", big bet this street";
  }
  percentile = Math.min(1, Math.max(0.01, percentile));
  return {
    position,
    percentile,
    label: `${position} top ${(percentile * 100).toFixed(0)}% (${reason})`,
  };
}

function rangeSpecsFor(observation: BotObservation): RangeSpec[] {
  const profiles = Array.isArray(observation.opponentProfiles) ? observation.opponentProfiles : [];
  if (profiles.length === 0) {
    // Older clients do not send profiles: model a single unknown villain at 70%.
    return [{ position: "villain", percentile: 0.7, label: "villain top 70% (unknown)" }];
  }
  return profiles.slice(0, 5).map(rangeSpecFor);
}

/* ------------------------------------------------------------------ */
/* Seeded Monte-Carlo equity                                           */
/* ------------------------------------------------------------------ */

const usedStamp = new Int32Array(52);
let usedGeneration = 0;

interface EquityResult {
  equity: number;
  assumedRange: string;
}

function monteCarloEquity(
  observation: BotObservation,
  hole: number[],
  board: number[],
): EquityResult {
  const specs = rangeSpecsFor(observation);
  const assumedRange = `vs ${specs.map((spec) => spec.label).join(" + ")}`;
  if (hole.length < 2) return { equity: 0, assumedRange };

  const { a: comboA, b: comboB } = rankedCombos();
  const dead = new Uint8Array(52);
  for (const card of hole) dead[card] = 1;
  for (const card of board) dead[card] = 1;

  // Combos that do not collide with hero's hand or the board, best first.
  const available: number[] = [];
  for (let i = 0; i < comboA.length; i += 1) {
    if (!dead[comboA[i]] && !dead[comboB[i]]) available.push(i);
  }
  if (available.length === 0) return { equity: 0, assumedRange };

  const rangeSizes = specs.map((spec) =>
    Math.max(1, Math.min(available.length, Math.ceil(spec.percentile * available.length))),
  );

  const deckRest: number[] = [];
  for (let card = 0; card < 52; card += 1) if (!dead[card]) deckRest.push(card);

  const boardToCome = Math.max(0, 5 - board.length);
  const random = mulberry32(observationSeed(observation));

  const heroCards = new Array<number>(7);
  const villainCards = new Array<number>(7);
  const fullBoard = new Array<number>(5);
  const villainHoles = new Array<number>(specs.length * 2);

  if (usedGeneration > 2_000_000_000) {
    usedGeneration = 0;
    usedStamp.fill(0);
  }

  let won = 0;
  for (let rollout = 0; rollout < MC_ROLLOUTS; rollout += 1) {
    usedGeneration += 1;
    const generation = usedGeneration;
    for (const card of hole) usedStamp[card] = generation;
    for (const card of board) usedStamp[card] = generation;

    let villainCount = 0;
    for (let v = 0; v < specs.length; v += 1) {
      const size = rangeSizes[v];
      let picked = -1;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const index = available[Math.floor(random() * size) % size];
        if (usedStamp[comboA[index]] !== generation && usedStamp[comboB[index]] !== generation) {
          picked = index;
          break;
        }
      }
      if (picked < 0) continue;
      usedStamp[comboA[picked]] = generation;
      usedStamp[comboB[picked]] = generation;
      villainHoles[villainCount * 2] = comboA[picked];
      villainHoles[villainCount * 2 + 1] = comboB[picked];
      villainCount += 1;
    }

    for (let i = 0; i < board.length; i += 1) fullBoard[i] = board[i];
    for (let i = 0; i < boardToCome; i += 1) {
      let card = -1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const candidate = deckRest[Math.floor(random() * deckRest.length) % deckRest.length];
        if (usedStamp[candidate] !== generation) {
          card = candidate;
          break;
        }
      }
      if (card < 0) card = deckRest[0];
      usedStamp[card] = generation;
      fullBoard[board.length + i] = card;
    }

    heroCards[0] = hole[0];
    heroCards[1] = hole[1];
    for (let i = 0; i < 5; i += 1) heroCards[2 + i] = fullBoard[i];
    const heroScore = evaluateCards(heroCards, 7);

    let ties = 0;
    let beaten = true;
    for (let v = 0; v < villainCount; v += 1) {
      villainCards[0] = villainHoles[v * 2];
      villainCards[1] = villainHoles[v * 2 + 1];
      for (let i = 0; i < 5; i += 1) villainCards[2 + i] = fullBoard[i];
      const villainScore = evaluateCards(villainCards, 7);
      if (villainScore > heroScore) {
        beaten = false;
        break;
      }
      if (villainScore === heroScore) ties += 1;
    }
    if (beaten) won += ties > 0 ? 1 / (ties + 1) : 1;
  }

  return { equity: won / MC_ROLLOUTS, assumedRange };
}

/* ------------------------------------------------------------------ */
/* Conservative outs                                                   */
/* ------------------------------------------------------------------ */

function rankMaskOf(cards: number[]): number {
  let mask = 0;
  for (const card of cards) {
    const rank = rankOfIndex(card);
    mask |= 1 << rank;
    if (rank === 14) mask |= 1 << 1;
  }
  return mask;
}

function hasStraight(mask: number): boolean {
  return straightHigh(mask) > 0;
}

/** Conservative outs. Zero on the river — no card to come. */
function estimateOuts(hole: number[], board: number[]): number {
  if (hole.length < 2 || board.length < 3 || board.length >= 5) return 0;
  const combined = [...hole, ...board];

  const boardRankCount = new Map<number, number>();
  for (const card of board) {
    const rank = rankOfIndex(card);
    boardRankCount.set(rank, (boardRankCount.get(rank) ?? 0) + 1);
  }
  const boardPaired = [...boardRankCount.values()].some((count) => count >= 2);

  const combinedSuitCount = [0, 0, 0, 0];
  for (const card of combined) combinedSuitCount[card & 3] += 1;
  const heroSuits = new Set(hole.map((card) => card & 3));
  const boardSuitCount = [0, 0, 0, 0];
  for (const card of board) boardSuitCount[card & 3] += 1;

  let outs = 0;

  // Flush draw: exactly four to a suit, and hero holds at least one of them.
  for (let suit = 0; suit < 4; suit += 1) {
    if (combinedSuitCount[suit] === 4 && heroSuits.has(suit)) {
      outs += boardPaired ? 7 : 9;
      break;
    }
  }

  // Straight draw.
  const combinedMask = rankMaskOf(combined);
  const boardMask = rankMaskOf(board);
  if (!hasStraight(combinedMask)) {
    let completing = 0;
    for (let rank = 2; rank <= 14; rank += 1) {
      const bit = 1 << rank;
      if (combinedMask & bit) continue;
      const withCard = combinedMask | bit | (rank === 14 ? 1 << 1 : 0);
      if (!hasStraight(withCard)) continue;
      const boardOnly = boardMask | bit | (rank === 14 ? 1 << 1 : 0);
      if (hasStraight(boardOnly)) continue; // the board makes it for everyone
      completing += 1;
    }
    let straightOuts = completing >= 2 ? 8 : completing === 1 ? 4 : 0;
    // A three-suited board means one of the straight cards may complete a flush.
    if (straightOuts > 0 && boardSuitCount.some((count) => count >= 3)) straightOuts -= 1;
    outs += Math.max(0, straightOuts);
  }

  // Overcards — only for a completely unpaired hero hand, 3 outs each, max 2.
  const heroRanks = hole.map(rankOfIndex);
  const heroUnpaired =
    heroRanks[0] !== heroRanks[1] &&
    !boardRankCount.has(heroRanks[0]) &&
    !boardRankCount.has(heroRanks[1]);
  if (heroUnpaired) {
    let boardHigh = 0;
    for (const card of board) boardHigh = Math.max(boardHigh, rankOfIndex(card));
    let overcards = 0;
    for (const rank of heroRanks) if (rank > boardHigh) overcards += 1;
    outs += Math.min(2, overcards) * 3;
  }

  return Math.min(15, outs);
}

/* ------------------------------------------------------------------ */
/* Sizing clamps (never a veto)                                        */
/* ------------------------------------------------------------------ */

function clampInto(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

function legalBounds(observation: BotObservation): { min: number; max: number } {
  const max = Math.max(0, finite(observation.maximumRaiseTo, 0));
  const min = Math.min(max, Math.max(0, finite(observation.minimumRaiseTo, 0)));
  return { min, max };
}

function countLimpers(observation: BotObservation): number {
  const players = Array.isArray(observation.publicPlayers) ? observation.publicPlayers : [];
  return players.filter(
    (player) =>
      player &&
      !player.folded &&
      player.position !== observation.position &&
      player.position !== "BB" &&
      finite(player.streetBet, 0) >= BIG_BLIND,
  ).length;
}

/**
 * Preflop raise sizing: never a veto. Clamp into the band, then into the legal
 * bounds (which always win). Returns undefined when nothing needs changing.
 */
function preflopClampedRaise(
  observation: BotObservation,
  decision: BotDecision,
  raiseCount: number,
): number | undefined {
  if (decision.action !== "raise") return undefined;
  const proposed = decision.raiseTo;
  const { min, max } = legalBounds(observation);
  const currentBet = Math.max(BIG_BLIND, finite(observation.currentBet, BIG_BLIND));

  let low: number;
  let high: number;
  if (raiseCount <= 0) {
    const limpers = countLimpers(observation);
    low = 2.2 * BIG_BLIND + 2 * limpers; // 4.4 chips + 2/limper
    high = 4 * BIG_BLIND + 2 * limpers; // 8 chips + 2/limper
  } else if (raiseCount === 1) {
    low = 2.5 * currentBet;
    high = 4.5 * currentBet;
  } else if (raiseCount === 2) {
    low = 2.2 * currentBet;
    high = 2.8 * currentBet;
  } else {
    low = min;
    high = max;
  }

  const start = typeof proposed === "number" && Number.isFinite(proposed) ? proposed : min;
  const target = clampInto(Math.round(clampInto(start, low, high)), min, max);
  return target === proposed ? undefined : target;
}

/* ------------------------------------------------------------------ */
/* Preflop verdict — V2: never a veto                                  */
/* ------------------------------------------------------------------ */

const PREFLOP_ASSUMED_RANGE = "preflop: no range veto in V2 (size clamp only)";

/**
 * V2 deletes the whole preflop range matrix. Every persona plays its own
 * preflop game; only the raise size is silently pulled back into a sane band.
 */
function preflopVerdict(observation: BotObservation, decision: BotDecision): GuardrailVerdict {
  const raiseCount = Math.max(0, Math.round(finite(observation.raiseCountThisStreet, 0)));
  const verdict: GuardrailVerdict = {
    ok: true,
    numbers: {
      requiredEquity: requiredEquityOf(observation),
      engineEquity: null,
      outs: null,
      effectiveSpr: null,
      assumedRange: PREFLOP_ASSUMED_RANGE,
    },
  };
  const clamped = preflopClampedRaise(observation, decision, raiseCount);
  if (clamped !== undefined) verdict.clampedRaiseTo = clamped;
  return verdict;
}

/* ------------------------------------------------------------------ */
/* Postflop verdict — V2: two lethal lines                             */
/* ------------------------------------------------------------------ */

interface PostflopContext {
  pot: number;
  requiredEquity: number;
  equity: number;
  outs: number;
  effectiveSpr: number;
  maxOpponentStack: number;
  /** Live opponents that are not yet all-in — i.e. players who can still fold. */
  foldableOpponents: number;
  everyOpponentAllIn: boolean;
  numbers: GuardrailNumbers;
  handClass: string;
}

function postflopContext(observation: BotObservation): PostflopContext | null {
  const hole = parseCardCodes(observation.holeCards);
  const board = parseCardCodes(observation.communityCards);
  if (hole.length < 2 || board.length < 3) return null;

  const pot = Math.max(0, finite(observation.pot, 0));
  const opponents = liveOpponentsOf(observation);
  const maxOpponentStack = largestLiveOpponentStack(opponents);
  const heroStack = Math.max(0, finite(observation.stack, 0));
  const effectiveBehind = maxOpponentStack > 0 ? Math.min(heroStack, maxOpponentStack) : heroStack;
  const effectiveSpr = pot > 0 ? effectiveBehind / pot : 0;
  const outs = estimateOuts(hole, board);
  const { equity, assumedRange } = monteCarloEquity(observation, hole, board);
  const requiredEquity = requiredEquityOf(observation);

  return {
    pot,
    requiredEquity,
    equity,
    outs,
    effectiveSpr,
    maxOpponentStack,
    foldableOpponents: opponents.filter((opponent) => !opponent.allIn).length,
    everyOpponentAllIn: opponents.length > 0 && opponents.every((opponent) => opponent.allIn),
    numbers: { requiredEquity, engineEquity: equity, outs, effectiveSpr, assumedRange },
    handClass: preflopHandClassOf(hole[0], hole[1]),
  };
}

/**
 * POST-CALL-ALLIN — the desperate big-money call (H#0003 / H#0004).
 * Vetoes only when all of the following hold:
 *   1. the call costs >= 25% of the chips hero can still lose this hand;
 *   2. modeled equity is >= 12 points below the effective price;
 *   3. no implied-odds excuse — a live opponent plus 8+ outs buys 8 more points.
 * Cheap calls, thin calls and station-y calls all pass.
 */
function postflopCallVerdict(
  observation: BotObservation,
  persona: PersonaTraits,
  context: PostflopContext,
): GuardrailVerdict {
  const effCall = effectiveCall(observation);
  const atRisk = heroMoneyAtRisk(observation);

  // Gate 1 — the mistake has to be expensive.
  if (effCall < COMMITMENT_FRACTION * atRisk) return { ok: true, numbers: context.numbers };

  // Gate 2 — hard equity margin, widened by implied odds against a live opponent.
  const impliedOdds = context.foldableOpponents > 0 && context.outs >= IMPLIED_ODDS_MIN_OUTS;
  const margin = DESPERATION_MARGIN + (impliedOdds ? IMPLIED_ODDS_SLACK : 0);
  const floor = context.requiredEquity - margin;
  if (context.equity >= floor) return { ok: true, numbers: context.numbers };

  const share = atRisk > 0 ? effCall / atRisk : 1;
  return {
    ok: false,
    rule: "POST-CALL-ALLIN",
    detail:
      `Calling ${chips(effCall)} is ${pct(share)} of the ${chips(atRisk)} chips you can still lose ` +
      `this hand and needs ${pct(context.requiredEquity)} equity into an effective pot of ` +
      `${chips(effectivePotOf(observation))}; ${context.handClass} has only ~${pct(context.equity)} ` +
      `${context.numbers.assumedRange} with ${context.outs} outs — ${pct(floor - context.equity)} ` +
      `below even the ${pct(margin)} slack floor` +
      (impliedOdds ? " (implied odds already granted)." : ", and there are no implied odds here.") +
      ` Style does not buy this call, ${persona.id} included — fold.`,
    numbers: context.numbers,
  };
}

/**
 * POST-JAM-EQUITY — the pure-air overjam nobody can fold to.
 * Bluffing is legal: this only fires when every live opponent is already all-in,
 * so there is no fold equity to buy, and the jam is >1.5x pot with <25% equity
 * and <4 outs.
 */
function postflopRaiseVerdict(
  observation: BotObservation,
  persona: PersonaTraits,
  context: PostflopContext,
  decision: BotDecision,
): GuardrailVerdict {
  const { min, max } = legalBounds(observation);
  const isAllIn = decision.action === "allin";
  const proposed = decision.raiseTo;
  const raiseTo = isAllIn
    ? max
    : typeof proposed === "number" && Number.isFinite(proposed)
      ? proposed
      : min;

  const streetBet = Math.max(0, finite(observation.streetBet, 0));
  const intended = Math.max(0, raiseTo - streetBet);
  const effectiveSize =
    context.maxOpponentStack > 0 ? Math.min(intended, context.maxOpponentStack) : intended;

  if (
    context.pot > 0 &&
    context.everyOpponentAllIn &&
    effectiveSize > JAM_POT_RATIO * context.pot &&
    context.equity < JAM_EQUITY_FLOOR &&
    context.outs < JAM_OUTS_FLOOR
  ) {
    return {
      ok: false,
      rule: "POST-JAM-EQUITY",
      detail:
        `Shoving ${chips(effectiveSize)} effective into a ${chips(context.pot)} pot ` +
        `(${(effectiveSize / context.pot).toFixed(2)}x) buys no fold equity — every opponent is ` +
        `already all-in — and ${context.handClass} has ~${pct(context.equity)} ` +
        `${context.numbers.assumedRange} with only ${context.outs} outs at SPR ` +
        `${context.effectiveSpr.toFixed(1)}. That is burning chips, not bluffing (${persona.id}).`,
      numbers: context.numbers,
    };
  }

  if (isAllIn) return { ok: true, numbers: context.numbers };

  // Silent size clamp: currentBet + 2.5x pot (V1 capped at 1.5x).
  const currentBet = Math.max(0, finite(observation.currentBet, 0));
  const cap =
    context.pot > 0 ? Math.min(max, currentBet + POSTFLOP_SIZE_CAP_POTS * context.pot) : max;
  const target = Math.round(clampInto(clampInto(raiseTo, min, Math.max(cap, min)), min, max));
  if (target !== proposed) return { ok: true, clampedRaiseTo: target, numbers: context.numbers };
  return { ok: true, numbers: context.numbers };
}

function postflopVerdict(
  observation: BotObservation,
  persona: PersonaTraits,
  decision: BotDecision,
): GuardrailVerdict {
  const context = postflopContext(observation);
  if (!context) return { ok: true };
  if (decision.action === "call") {
    if (Math.max(0, finite(observation.toCall, 0)) <= 0) return { ok: true, numbers: context.numbers };
    return postflopCallVerdict(observation, persona, context);
  }
  return postflopRaiseVerdict(observation, persona, context, decision);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Audit a proposed decision against the two remaining lethal lines.
 * - fold / check are ALWAYS ok.
 * - preflop is ALWAYS ok (sizes may be silently clamped).
 * - postflop vetoes only POST-CALL-ALLIN and POST-JAM-EQUITY; sizes clamp.
 * - Deterministic for a given observation (seeded Monte-Carlo).
 */
export function checkDecision(
  observation: BotObservation,
  persona: PersonaTraits,
  decision: BotDecision,
): GuardrailVerdict {
  try {
    const action = decision?.action;
    if (action === "fold" || action === "check") return { ok: true };
    if (action !== "call" && action !== "raise" && action !== "allin") return { ok: true };
    if (!observation || typeof observation !== "object") return { ok: true };
    if (observation.street === "preflop") return preflopVerdict(observation, decision);
    if (observation.street === "showdown") return { ok: true };
    return postflopVerdict(observation, traits(persona), decision);
  } catch {
    // Fail open — the guardrail must never brick the table.
    return { ok: true };
  }
}

/**
 * Fallback used only when a model decision failed the guardrail twice. It has
 * no style of its own: call when POST-CALL-ALLIN would allow it, otherwise
 * fold; never open a pot voluntarily.
 */
export function suggestSafeAction(
  observation: BotObservation,
  persona: PersonaTraits,
): BotDecision {
  const toCall = Math.max(0, finite(observation?.toCall, 0));
  try {
    const legal: ActionKind[] = Array.isArray(observation.legalActions) ? observation.legalActions : [];
    const can = (action: ActionKind) => legal.length === 0 || legal.includes(action);
    const postflop = observation.street !== "preflop" && observation.street !== "showdown";

    if (toCall > 0) {
      if (!postflop) return { action: "fold" };
      const verdict = checkDecision(observation, persona, { action: "call" });
      if (verdict.ok && can("call")) return { action: "call" };
      return { action: "fold" };
    }
    return { action: "check" };
  } catch {
    return toCall > 0 ? { action: "fold" } : { action: "check" };
  }
}

/** "Ac","8s" -> "A8o"; "Td","Ts" -> "TT". */
export function describeHandClass(holeCards: string[]): string {
  try {
    const cards = parseCardCodes(holeCards);
    if (cards.length < 2) return "??";
    return preflopHandClassOf(cards[0], cards[1]);
  } catch {
    return "??";
  }
}
